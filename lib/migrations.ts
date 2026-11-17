import { ORTHO_FOLLOWUP_COVERAGE_SQL } from "./ortho-followup-coverage-schema";
import { createHash } from "node:crypto";
import { guardOrthoRevisionMigration, validateOrthoRevisionRegistry } from "./ortho-revision-migration-guard";
import { BASELINE_VERSION, HISTORICAL_0079_SHA256, loadMigrationFiles, type MigrationFile } from "./migration-files";
export { HISTORICAL_0079_SHA256 } from "./migration-files";
import type { DbClient, DbPool } from "./db";
import { runBaselineSchemaProbe, describeBaselineDiff, type BaselineSchemaDiff } from "./baseline-probe";

export { BASELINE_VERSION, checksumOf, defaultMigrationsDir, loadMigrationFiles, type MigrationFile } from "./migration-files";

/**
 * نظام الهجرات المُرقَّمة (P1.1 + P1-FIX-1 + P1-FIX-2) — مصدر الحقيقة لتطوير
 * المخطط بعد خط الأساس.
 *
 * التصميم موثَّق بالكامل في docs/DATABASE_MIGRATIONS.md. خلاصته:
 *
 * ١) كل تغيير مخطط ملف SQL واحد في migrations/ بصيغة NNNN_اسم.sql — ترتيبٌ
 *    حتمي برقم الإصدار، وبصمة SHA-256 تُسجَّل عند التطبيق فتُكشف أي تعديل
 *    لاحق لملفٍ مرَّ تطبيقه (checksum mismatch ⇒ fail closed).
 *
 * ٢) كل هجرة تُطبَّق داخل transaction واحدة (PostgreSQL يدعم DDL المعاملات):
 *    BEGIN → تنفيذ SQL → تسجيل الصف في schema_migrations → COMMIT. فشلٌ في
 *    المنتصف يتراجع بكل شيء، فلا تبقى حالة نصف مطبَّقة، وإعادة التشغيل تعيد
 *    المحاولة من نفس النقطة بأمان.
 *
 * ٣) خط الأساس 0001 هو DDL المخطط الحالي كاملًا (مستخرج حرفيًا من ensureSchema
 *    عند دمج P0). القاعدة الموجودة في الإنتاج لا تُنفَّذ عليها 0001 — بل
 *    «تُعتمَد» (baseline adoption): **مجسّ توافق قوي** (lib/baseline-probe.ts،
 *    P1-FIX-1) ينفّذ DDL الأساس في مخطط مؤقت داخل معاملة تُتراجع، ويستقرئ
 *    الكتالوج للمخططين بنفس الاستعلامات ونفس الخادم، ثم يقارن الاتجاه الحرج:
 *    جداول، أعمدة (نوع/طول/إبطال/قيمة افتراضية)، PK، FK، UNIQUE، CHECK،
 *    فهارس (بشرطها الجزئي)، triggers. أي فرق يكسر التشغيل أو الهجرات التالية
 *    ⇒ BASELINE_SCHEMA_MISMATCH ولا يُسجَّل 0001 — القاعدة المنحرفة بأسماء
 *    مطابقة لم تعد تكفي.
 *
 * ٤) **قفل advisory للمهاجرين المتزامنين** (P1-FIX-2): migrate() يمسك
 *    pg_advisory_lock بمفتاح ثابت خاص بالمشروع على اتصال واحد مخصص يبقى
 *    ممسكًا بالقفل طوال الrun كله (قراءة الحالة → اعتماد/تطبيق → التحقق)،
 *    ويفكّه في finally دائمًا. مهاجران متزامنان ⇒ الأول يطبّق والثاني ينتظر
 *    ثم يرى الحالة محدَّثة فلا ينفّذ شيئًا — حماية قاعدة بيانات لا حماية
 *    تطبيق؛ `ON CONFLICT DO NOTHING` وحده لا يمنع تنفيذ DDL مرتين.
 *
 * ٥) ensureSchema تبقى تعمل في التطبيق كما هي (idempotent) خلال فترة الانتقال
 *    الموثَّقة — ونفس تغييرات 0002+ مضافة إليها، فالقاعدة الجديدة من أي
 *    المسارين تتطابق. التقاعد الكامل لensureSchema قرار P2 بعد إثبات المسار.
 */

export interface AppliedMigrationRow {
  version: string;
  name: string;
  checksum: string;
  applied_at: string;
  adopted: boolean;
}

export interface MigrationStatus {
  applied: AppliedMigrationRow[];
  files: MigrationFile[];
  pending: MigrationFile[];
  unknownApplied: AppliedMigrationRow[];
  checksumMismatches: Array<{
    version: string;
    appliedChecksum: string;
    fileChecksum: string;
  }>;
  emptyDatabase: boolean;
  probe: { ok: boolean; missing: string[] };
  /**
   * (P1-FIX-1) مجسّ توافق خط الأساس القوي — يعمل عندما القاعدة غير فارغة و0001
   * لم يُسجَّل بعد (مرشّح الاعتماد: سيناريو الإنتاج الحقيقي). يعرض الاختلاف
   * الحقيقي للعناصر الحرجة في db:status. null = ليس في وضع المقارنة (قاعدة
   * فارغة أو أساس مسجَّل — سلامتها تحكمها البصمات والفحص الحرج).
   */
  baselineDiff: BaselineSchemaDiff | null;
  consistent: boolean;
  historical0079Problem: string | null;
}

export interface MigrationRunResult {
  adoptedBaseline: boolean;
  appliedVersions: string[];
  alreadyUpToDate: boolean;
}

// Retired feature: keep the exact published contract to recognize old registries,
// but never install it in normal fresh migrations. Only archive restoration may
// request the historical schema after validating its source registry.
const historical0079Name = "ortho_followup_coverage";
function validateHistorical0079(file: MigrationFile | undefined, row?: AppliedMigrationRow): void {
  if (file && (file.version !== "0079" || file.name !== historical0079Name
    || file.filename !== "0079_ortho_followup_coverage.sql"
    || file.checksum !== HISTORICAL_0079_SHA256
    || createHash("sha256").update(file.sql).digest("hex") !== HISTORICAL_0079_SHA256))
    throw new Error("HISTORICAL_0079_SOURCE_MISMATCH");
  if (row && (!file || row.name !== historical0079Name || row.checksum !== HISTORICAL_0079_SHA256 || row.adopted))
    throw new Error("HISTORICAL_0079_REGISTRY_MISMATCH");
}
/** A registry alone is not proof of installed protection. Conversely, never
 * adopt a hand-installed or partial footprint when there is no registry row. */
async function validateHistorical0079Footprint(client: DbClient, row?: AppliedMigrationRow): Promise<void> {
  const { rows: [state] } = await client.query<{ tables: number; columns: number; column_types: number; triggers: number }>(`SELECT
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname IN ('ortho_followup_coverage_revisions','ortho_followup_coverage_rejections')) AS tables,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND
       ((table_name='ortho_adjustments' AND column_name='followup_coverage_revision_id') OR
        (table_name='visits' AND column_name='ortho_followup_coverage_proof'))) AS columns,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND is_nullable='YES' AND
       ((table_name='ortho_adjustments' AND column_name='followup_coverage_revision_id' AND data_type='bigint') OR
        (table_name='visits' AND column_name='ortho_followup_coverage_proof' AND data_type='jsonb'))) AS column_types,
    (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgenabled='O'
       AND (c.relname,t.tgname) IN (('visits','ortho_followup_visit_manifest'),('visits','ortho_followup_manifest_children'),('visits','ortho_followup_visit_no_truncate'),
         ('ortho_adjustments','ortho_followup_adjustment_proof'),('ortho_adjustments','ortho_followup_proof_parent'),('ortho_adjustments','ortho_followup_adjustment_no_truncate'),
         ('ortho_followup_coverage_revisions','ortho_followup_coverage_no_rewrite'),('ortho_followup_coverage_revisions','ortho_followup_coverage_no_truncate'),
         ('ortho_followup_coverage_revisions','ortho_followup_coverage_chain'),('ortho_followup_coverage_revisions','ortho_followup_coverage_00_command'),
         ('ortho_followup_coverage_rejections','ortho_followup_rejection_immutable'),('ortho_followup_coverage_rejections','ortho_followup_rejection_no_truncate'))) AS triggers`);
  if (!state || (row ? state.tables !== 2 || state.columns !== 2 || state.column_types !== 2 || state.triggers !== 12
    : state.tables !== 0 || state.columns !== 0 || state.triggers !== 0))
    throw new Error("HISTORICAL_0079_FOOTPRINT_MISMATCH");
  if (!row) return;
  // Compare the exact function bodies from the checksum-pinned published SQL,
  // plus language, signature and invoker privileges. A same-named no-op guard
  // must never count as the immutable history contract.
  const expected = new Map<string, string>();
  const pattern = /CREATE FUNCTION ([a-z_]+)\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/g;
  for (const match of ORTHO_FOLLOWUP_COVERAGE_SQL.matchAll(pattern)) expected.set(match[1], match[2]);
  if (expected.size !== 7 || createHash("sha256").update(ORTHO_FOLLOWUP_COVERAGE_SQL).digest("hex") !== HISTORICAL_0079_SHA256)
    throw new Error("HISTORICAL_0079_SOURCE_MISMATCH");
  const { rows: functions } = await client.query<{ name: string; body: string; language: string; return_type: string; arguments: number; security_definer: boolean }>(
    `SELECT p.proname AS name,p.prosrc AS body,l.lanname AS language,pg_catalog.format_type(p.prorettype,NULL) AS return_type,
       p.pronargs::int AS arguments,p.prosecdef AS security_definer
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
       JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.proname=ANY($1::text[])`, [[...expected.keys()]]);
  if (functions.length !== expected.size || functions.some(fn => fn.body !== expected.get(fn.name) || fn.language !== "plpgsql"
    || fn.return_type !== "trigger" || fn.arguments !== 0 || fn.security_definer))
    throw new Error("HISTORICAL_0079_FOOTPRINT_MISMATCH");
  const bindings: Record<string, [string, number, boolean]> = {
    ortho_followup_coverage_no_rewrite: ["guard_ortho_followup_coverage_append_only", 27, false],
    ortho_followup_coverage_no_truncate: ["guard_ortho_followup_coverage_append_only", 34, false],
    ortho_followup_visit_manifest: ["guard_ortho_followup_visit_manifest", 31, false],
    ortho_followup_adjustment_proof: ["guard_ortho_followup_adjustment_proof", 31, false],
    ortho_followup_manifest_children: ["check_ortho_followup_manifest_children", 21, true],
    ortho_followup_proof_parent: ["check_ortho_followup_manifest_children", 21, true],
    ortho_followup_coverage_chain: ["guard_ortho_followup_coverage_chain", 7, false],
    ortho_followup_adjustment_no_truncate: ["guard_ortho_followup_proof_truncate", 34, false],
    ortho_followup_visit_no_truncate: ["guard_ortho_followup_proof_truncate", 34, false],
    ortho_followup_coverage_00_command: ["guard_ortho_followup_command_terminal", 7, false],
    ortho_followup_rejection_immutable: ["guard_ortho_followup_command_terminal", 31, false],
    ortho_followup_rejection_no_truncate: ["guard_ortho_followup_command_terminal", 34, false],
  };
  const { rows: triggers } = await client.query<{ name: string; fn: string; namespace: string; type: number; deferrable: boolean; deferred: boolean; args: number; condition: string | null }>(
    `SELECT t.tgname AS name,p.proname AS fn,nf.nspname AS namespace,t.tgtype::int AS type,
       t.tgdeferrable AS deferrable,t.tginitdeferred AS deferred,t.tgnargs::int AS args,t.tgqual::text AS condition
     FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
       JOIN pg_catalog.pg_namespace nf ON nf.oid=p.pronamespace
     WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgname=ANY($1::text[])`, [[...Object.keys(bindings)]]);
  if (triggers.length !== 12 || triggers.some(t => {
    const contract = bindings[t.name];
    return !contract || t.namespace !== "public" || t.fn !== contract[0] || t.type !== contract[1]
      || t.deferrable !== contract[2] || t.deferred !== contract[2] || t.args !== 0 || t.condition !== null;
  })) throw new Error("HISTORICAL_0079_FOOTPRINT_MISMATCH");
}
/** Check the retired runtime contract without applying or adopting it. */
export async function validateRuntimeHistorical0079(pool: DbPool, file: MigrationFile): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    try {
      const row = (await listAppliedMigrations(client)).find(item => item.version === "0079");
      validateHistorical0079(file, row);
      await validateHistorical0079Footprint(client, row);
    }
    finally { await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => {}); }
  } finally { client.release(); }
}

/**
 * مفتاح advisory lock للمهاجرين (P1-FIX-2) — قيمة bigint ثابتة مشتقة حتميًّا
 * من هوية المشروع، لا رقم مرتجل: كل عمليات الترحيل في aqlan-center-mini
 * تتنافس على القفل نفسه مهما اختلفت النسخ/الأجهزة التي تشغّلها.
 * (48 بت من SHA-256 — ضمن حدود الأعداد الآمنة في JS.)
 */
export const MIGRATION_ADVISORY_LOCK_KEY = parseInt(
  createHash("sha256").update("aqlan-center-mini:schema-migrations:v1", "utf8")
    .digest("hex").slice(0, 12),
  16,
);

/** Register additive runtime extensions under the very same lock and per-file
 * transaction as the CLI migrator. Legacy runtime DDL remains unregistered:
 * startup must not replay historical financial/data backfills merely to add HR.
 * Pre-existing unregistered extension tables fail their CREATE, never get adopted.
 */
export async function applyRuntimeMigrationFiles(pool: DbPool, files: MigrationFile[]): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    try {
      const applied = await listAppliedMigrations(client);
      // Check every supplied contract before making any extension change.
      for (const file of files) {
        if (createHash('sha256').update(file.sql).digest('hex') !== file.checksum) throw new Error(`RUNTIME_MIGRATION_SOURCE_MISMATCH: ${file.version}`);
        const row = applied.find(item => item.version === file.version);
        if (row && (row.name !== file.name || row.checksum !== file.checksum || row.adopted)) {
          throw new Error(`RUNTIME_MIGRATION_REGISTRY_MISMATCH: ${file.version}`);
        }
      }
      await ensureSchemaMigrationsTable(client);
      const appliedNow: string[] = [];
      for (const file of files) {
        if (applied.some(row => row.version === file.version)) continue;
        await applyMigrationInTransaction(client, file, { adopted: false });
        appliedNow.push(file.version);
      }
      return appliedNow;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } finally { client.release(); }
}

/** الجداول والأعمدة التي لا يقوم النظام بدونها — قائمة فحص الانحراف الحرج (P1.2). */
export const CRITICAL_SCHEMA_TABLES = [
  "ai_confirmation_claims",
  "audit_log",
  "cashier_shifts",
  "expenses",
  "inventory_items",
  "inventory_movements",
  "invoice_items",
  "invoices",
  "lab_orders",
  "material_rates",
  "parties",
  "patient_documents",
  "patient_opening_balances",
  "patients",
  "payments",
  "prescriptions",
  "services",
  "settings",
  "treatment_plans",
  "users",
  "visits",
] as const;

/** أعمدة ما بعد خط الأساس: وجودها دليل أن هجرتها طُبِّقت فعلًا. absence = انحراف فقط
 *  إذا كانت الهجرة المسجَّلة مطبَّقة؛ أما وهي ناقصة (pending) فغيابها متوقَّع لا انحراف. */
export const CRITICAL_SCHEMA_COLUMNS: Array<{ table: string; column: string; sinceVersion: string }> = [
  ...[
    ["lab_work_intents", "revision"], ["lab_work_members", "created_revision"],
    ["lab_prescription_source_memberships", "member_id"],
    ["lab_work_commands", "request_hash"], ["lab_work_intent_schema", "version"],
    ["visit_procedures", "lab_work_member_id"], ["lab_orders", "lab_work_intent_id"],
  ].map(([table, column]) => ({ table, column, sinceVersion: "0074" })),
  ...[
    ["invoice_corrections","original_currency"],
    ["invoice_settlement_reclassifications","correction_id"],["invoice_settlement_reclassifications","source_invoice_ids"],
    ["invoice_settlement_reclassifications","patient_id"],["invoice_settlement_reclassifications","source_currency"],["invoice_settlement_reclassifications","target_currency"],
    ["invoice_settlement_reclassification_events","payment_id"],["invoice_settlement_reclassification_events","reclassification_id"],
    ["invoice_settlement_reclassification_events","source_minor"],["invoice_settlement_reclassification_events","target_minor"],
    ["invoice_settlement_reclassification_events","direction"],["invoice_settlement_reclassification_events","payment_snapshot"],
  ].map(([table,column])=>({table,column,sinceVersion:"0063"})),
  { table: "payments", column: "idempotency_key", sinceVersion: "0003" },
  { table: "payments", column: "reversal_of_id", sinceVersion: "0003" },
];

async function tableExists(client: DbClient, table: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public.' || quote_ident($1)) IS NOT NULL AS exists`, [table],
  );
  return Boolean(rows[0]?.exists);
}

export async function ensureSchemaMigrationsTable(client: DbClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      adopted    BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
}

export async function listAppliedMigrations(client: DbClient): Promise<AppliedMigrationRow[]> {
  // جدول التسجيل نفسه قد لا يكون موجودًا بعد (تشغيل أول / dry-run): قراءته
  // حينها = قائمة فارغة — لا إنشاؤه ضمن مسار القراءة.
  const { rows: tableRows } = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  if (!tableRows[0]?.exists) return [];
  const { rows } = await client.query<{ version: string; name: string; checksum: string; applied_at: Date; adopted: boolean }>(
    `SELECT version, name, checksum, applied_at, adopted FROM schema_migrations ORDER BY version`,
  );
  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    applied_at: new Date(row.applied_at).toISOString(),
    adopted: Boolean(row.adopted),
  }));
}

/** قاعدة فارغة = لا أثر لأي جدول من جداول النظام (قاعدة جديدة فعلًا). */
export async function databaseIsEmpty(client: DbClient): Promise<boolean> {
  for (const table of ["patients", "users", "invoices", "payments", "settings"]) {
    if (await tableExists(client, table)) return false;
  }
  return true;
}

/** فحص التوافق الحرج السريع: الجداول كلها موجودة، والأعمدة التالية للأساس موجودة
 *  إذا كانت هجرتها مسجَّلة كمطبَّقة. (المجسّ القوي في baselineDiff هو بوابة الاعتماد.) */
export async function criticalSchemaProbe(
  client: DbClient,
  appliedVersions: ReadonlySet<string> = new Set(),
): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const table of CRITICAL_SCHEMA_TABLES) {
    if (!(await tableExists(client, table))) missing.push(`جدول ${table}`);
  }
  for (const { table, column, sinceVersion } of CRITICAL_SCHEMA_COLUMNS) {
    if (missing.some((entry) => entry === `جدول ${table}`)) continue;
    if (!appliedVersions.has(sinceVersion)) continue;
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
         ) AS exists`, [table, column],
    );
    if (!rows[0]?.exists) missing.push(`عمود ${table}.${column}`);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * حالة الهجرات كاملة — أساس db:status وdb:verify (P1.2 + P1-FIX-1).
 *
 * consistent تعني: لا هجرات ناقصة، ولا صفوف مجهولة، ولا بصمات مخالفة، وفحص
 * التوافق الحرج سليم، **ومجسّ خط الأساس (إن كان في وضع المقارنة) سليم**.
 * أي انحراف مهم ⇒ غير متسق ⇒ fail closed.
 */
export async function migrationStatus(pool: DbPool, files?: MigrationFile[]): Promise<MigrationStatus> {
  const migrationFiles = files ?? (await loadMigrationFiles());
  const client = await pool.connect();
  let applied: AppliedMigrationRow[] = [];
  let emptyDatabase = false;
  let probe = { ok: true, missing: [] as string[] };
  let baselineDiff: BaselineSchemaDiff | null = null;
  let historicalFootprintInvalid = false;
  try {
    applied = await listAppliedMigrations(client);
    try { await validateHistorical0079Footprint(client, applied.find(row => row.version === "0079")); }
    catch { historicalFootprintInvalid = true; }
    emptyDatabase = await databaseIsEmpty(client);
    const appliedVersionSet = new Set(applied.map((row) => row.version));
    probe = await criticalSchemaProbe(client, appliedVersionSet);

    // (P1-FIX-1) المجسّ القوي في وضع المرشّح للاعتماد فقط: قاعدة غير فارغة ولم
    // يُسجَّل الأساس بعد — هذا سيناريو «قاعدة إنتاج قائمة» حيث يعرض db:status
    // الاختلاف الحقيقي بدل «الجداول موجودة تقريبًا». القاعدة الفارغة ستنشأ من
    // الأساس نفسه، والأساس المسجَّل تحكمه البصمات والفحص الحرج أعلاه.
    if (!emptyDatabase && !appliedVersionSet.has(BASELINE_VERSION)) {
      baselineDiff = await runBaselineSchemaProbe(pool, migrationFiles[0].sql);
    }
  } finally {
    client.release();
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  const fileVersions = new Map(migrationFiles.map((file) => [file.version, file]));

  let historical0079Problem: string | null = historicalFootprintInvalid ? "HISTORICAL_0079_FOOTPRINT_MISMATCH" : null;
  try { validateHistorical0079(migrationFiles.find(file => file.version === "0079"), applied.find(row => row.version === "0079")); }
  catch (error) { historical0079Problem = error instanceof Error ? error.message : "HISTORICAL_0079_INVALID"; }
  const pending = migrationFiles.filter((file) => file.version !== "0079" && !appliedVersions.has(file.version));
  const unknownApplied = applied.filter((row) => !fileVersions.has(row.version));
  const checksumMismatches = [];
  for (const row of applied) {
    const file = fileVersions.get(row.version);
    if (file && file.checksum !== row.checksum) {
      checksumMismatches.push({
        version: row.version,
        appliedChecksum: row.checksum,
        fileChecksum: file.checksum,
      });
    }
  }

  const consistent =
    historical0079Problem === null
    && pending.length === 0
    && unknownApplied.length === 0
    && checksumMismatches.length === 0
    && probe.ok
    && (baselineDiff === null || baselineDiff.ok);

  return {
    applied, files: migrationFiles, pending, unknownApplied, checksumMismatches,
    emptyDatabase, probe, baselineDiff, consistent, historical0079Problem,
  };
}

/**
 * تطبيق الهجرات حتى آخر نسخة — مع اعتماد خط الأساس لقاعدة قائمة (P1.1)،
 * ومجسّ التوافق القوي (P1-FIX-1)، وقفل advisory للمهاجرين المتزامنين
 * (P1-FIX-2) على اتصال واحد محفوظ طوال الrun.
 *
 * التدفق البنيوي:
 *   connect (اتصال مخصص واحد)
 *   → pg_advisory_lock(MIGRATION_ADVISORY_LOCK_KEY)
 *   → قراءة حالة الهجرات
 *   → اعتماد الأساس (بعد مجسّ قوي) أو تطبيقه
 *   → هجرات 0002+ بالترتيب داخل معاملات
 *   → تحقق نهائي
 *   → pg_advisory_unlock (في finally دائمًا)
 *   → release
 *
 * الوسيط `apply: false` (الافتراضي) = dry-run: يُحسب ويُعرَف ما سيل دون تنفيذ.
 */
export async function migrate(
  pool: DbPool,
  options: { apply?: boolean; files?: MigrationFile[]; historical0079?: true } = {},
): Promise<MigrationRunResult> {
  const apply = options.apply === true;
  const files = options.files ?? (await loadMigrationFiles());
  const client = await pool.connect();
  try {
    // (P1-FIX-2) القفل على هذا الاتصال تحديدًا — كل عمل الrun يجري عليه،
    // ويفكّ في finally حتى مع الخطأ أو التراجع. قفل الجلسة يُفك تلقائيًّا أيضًا
    // لو مات الاتصال — لا تعليق دائم للمهاجرين.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    try {
      return await migrateHoldingLock(client, files, apply, options.historical0079 === true);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => {
        /* الاتصال سيُغلق بعد لحظة في كل الأحوال — فكّ القفل هناك تلقائيًّا. */
      });
    }
  } finally {
    client.release();
  }
}

async function migrateHoldingLock(
  client: DbClient,
  files: MigrationFile[],
  apply: boolean,
  historical0079: boolean,
): Promise<MigrationRunResult> {
  let applied = await listAppliedMigrations(client);
  const historicalFile = files.find(file => file.version === "0079");
  const historicalRow = applied.find(row => row.version === "0079");
  validateHistorical0079(historicalFile, historicalRow);
  await validateHistorical0079Footprint(client, historicalRow);
  if (historical0079 && !historicalFile) throw new Error("HISTORICAL_0079_SOURCE_MISSING");
  // Validate only the two pinned Ortho contracts before skipping applied files.
  for (const file of files) {
    if (file.version === "0051" || file.version === "0052") validateOrthoRevisionRegistry(file, applied.find(row => row.version === file.version));
  }
  const appliedVersions = new Set(applied.map((row) => row.version));
  const appliedNow: string[] = [];
  let adoptedBaseline = false;

  // الخطوة ١: خط الأساس — تطبيق جديد أو اعتماد قائم، لا ثالث لهما.
  if (!appliedVersions.has(BASELINE_VERSION)) {
    const baseline = files[0];
    if (baseline.version !== BASELINE_VERSION) {
      throw new Error("ملف خط الأساس مفقود أو في غير موضعه.");
    }
    const isEmpty = await databaseIsEmpty(client);
    if (isEmpty) {
      // قاعدة جديدة فارغة: DDL كاملًا داخل transaction، ثم تسجيل.
      if (apply) {
        await ensureSchemaMigrationsTable(client);
        await applyMigrationInTransaction(client, baseline, { adopted: false });
      }
      appliedNow.push(BASELINE_VERSION);
    } else {
      // قاعدة موجودة من النظام الحالي: اعتماد بعد **مجسّ توافق قوي** (P1-FIX-1)
      // — بلا تنفيذ DDL عليها. القاعدة المنحرفة ولو بأسماء مطابقة تُرفض.
      const diff = await runBaselineSchemaProbe(poolOf(client), baseline.sql);
      if (!diff.ok) {
        const details = describeBaselineDiff(diff).map((line) => `  • ${line}`).join("\n");
        throw new Error(
          `BASELINE_SCHEMA_MISMATCH — المخطط الفعلي لا يطابق خط الأساس 0001 على العناصر الحرجة `
          + `(فُحص: ${diff.checked.tables} جدولًا / ${diff.checked.columns} عمودًا / ${diff.checked.constraints} قيدًا / `
          + `${diff.checked.indexes} فهرسًا / ${diff.checked.triggers} trigger). الفروق:\n${details}\n`
          + `الاعتماد مرفوض (fail closed): القاعدة ليست فارغة ولا تطابق المخطط المعروف. `
          + `افحص الفروق أعلاه وصحّح المخطط أو استعد قاعدة معروفة — لا يُسجَّل 0001 اعتباطًا.`,
        );
      }
      if (apply) {
        await ensureSchemaMigrationsTable(client);
        await recordMigration(client, baseline, { adopted: true });
      }
      adoptedBaseline = true;
      appliedNow.push(BASELINE_VERSION);
    }
    if (apply) applied = await listAppliedMigrations(client);
  }

  // الخطوة ٢: هجرات ما بعد الأساس بالترتيب الحتمي.
  for (const file of files) {
    if (file.version === BASELINE_VERSION) continue;
    if (file.version === "0079" && !historical0079 && !applied.some(row => row.version === "0079")) continue;
    if (applied.some((row) => row.version === file.version)) {
      // مطبَّقة سابقًا: تحقق البصمة — أي تعديل لملفٍ مرَّ تطبيقه يوقف كل شيء.
      const row = applied.find((entry) => entry.version === file.version);
      if (row && row.checksum !== file.checksum) {
        throw new Error(
          `بصمة الهجرة ${file.version} لا تطابق المسجَّلة — الملف عُدِّل بعد التطبيق. `
          + "استعد الملف الأصلي أو اكتب هجرة جديدة؛ لا يُعدَّل ما طُبِّق أبدًا.",
        );
      }
      continue;
    }
    if (apply) {
      await ensureSchemaMigrationsTable(client);
      await applyMigrationInTransaction(client, file, { adopted: false });
    }
    appliedNow.push(file.version);
  }

  return {
    adoptedBaseline,
    appliedVersions: appliedNow,
    alreadyUpToDate: appliedNow.length === 0,
  };
}

/** غلاف pool-شكلي حول client — لمجسّ خط الأساس الذي يطلب pool.connect().
 * release() لا-عملية عمدًا: الاتصال مملوك لمستوى أعلى (migrate) ولا يجوز
 * للمجسّ أن يحرّره من تحته. */
function poolOf(client: DbClient): DbPool {
  const nonReleasingClient: DbClient = {
    query: <T = any>(sql: string, values?: any[]) => client.query<T>(sql, values),
    release: () => {},
  };
  return {
    query: <T = any>(sql: string, values?: any[]) => client.query<T>(sql, values),
    connect: async () => nonReleasingClient,
  };
}

async function applyMigrationInTransaction(
  client: DbClient,
  file: MigrationFile,
  meta: { adopted: boolean },
): Promise<void> {
  await client.query("BEGIN");
  try {
    if (file.version === "0051" || file.version === "0052") {
      validateOrthoRevisionRegistry(file, (await listAppliedMigrations(client)).find(row => row.version === file.version));
      await guardOrthoRevisionMigration(client, file);
    }
    await client.query(file.sql);
    await client.query(
      `INSERT INTO schema_migrations (version, name, checksum, adopted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (version) DO NOTHING`,
      [file.version, file.name, file.checksum, meta.adopted],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function recordMigration(
  client: DbClient,
  file: MigrationFile,
  meta: { adopted: boolean },
): Promise<void> {
  await client.query(
    `INSERT INTO schema_migrations (version, name, checksum, adopted)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (version) DO NOTHING`,
    [file.version, file.name, file.checksum, meta.adopted],
  );
}
