import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient, DbPool } from "./db";

/**
 * نظام الهجرات المُرقَّمة (P1.1) — مصدر الحقيقة لتطوير المخطط بعد خط الأساس.
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
 *    «تُعتمد» (baseline adoption): فحص توافق يثبت أن الجداول الحرجة موجودة،
 *    ثم تسجيل الصف دون تنفيذ، فلا فقد بيانات ولا إعادة إنشاء.
 *
 * ٤) ensureSchema تبقى تعمل في التطبيق كما هي (idempotent) خلال فترة الانتقال
 *    الموثَّقة — ونفس تغييرات 0002+ مضافة إليها، فالقاعدة الجديدة من أي
 *    المسارين تتطابق. التقاعد الكامل لensureSchema قرار P2 بعد إثبات المسار.
 */

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

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
  consistent: boolean;
}

export interface MigrationRunResult {
  adoptedBaseline: boolean;
  appliedVersions: string[];
  alreadyUpToDate: boolean;
}

export const BASELINE_VERSION = "0001";

const MIGRATION_FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** مجلد الهجرات مشتق من موقع هذا الملف (lib/ → ../migrations) لا من cwd. */
export function defaultMigrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
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
  { table: "payments", column: "idempotency_key", sinceVersion: "0003" },
  { table: "payments", column: "reversal_of_id", sinceVersion: "0003" },
];

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * يقرأ ملفات الهجرات ويفرض الصيغة والترتيب الحتمي.
 * ملف باسم مخالف أو نسخة مكررة ⇒ خطأ فوري — القائمة إما نظيفة أو لا شيء.
 */
export async function loadMigrationFiles(dir?: string): Promise<MigrationFile[]> {
  const resolved = dir ?? defaultMigrationsDir();
  const entries = await readdir(resolved);
  const files: MigrationFile[] = [];
  for (const filename of entries) {
    const match = MIGRATION_FILENAME_PATTERN.exec(filename);
    if (!match) continue;
    if (filename.startsWith(".")) continue;
    const sql = await readFile(path.join(resolved, filename), "utf8");
    files.push({
      version: match[1],
      name: match[2],
      filename,
      sql,
      checksum: checksumOf(sql),
    });
  }
  files.sort((a, b) => a.version.localeCompare(b.version));
  if (files.length === 0) {
    throw new Error(`لا توجد ملفات هجرات صالحة في ${resolved} — النظام يرفض التشغيل بلا مصدر مخطط.`);
  }
  if (files[0].version !== BASELINE_VERSION) {
    throw new Error(`أول هجرة يجب أن تكون خط الأساس ${BASELINE_VERSION} — وُجد ${files[0].version}.`);
  }
  const versions = new Set(files.map((file) => file.version));
  if (versions.size !== files.length) {
    throw new Error("إصدارات هجرات مكررة — الترتيب الحتمي مكسور.");
  }
  return files;
}

async function tableExists(client: DbClient, table: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public.' || quote_ident($1)) IS NOT NULL AS exists`, [table],
  );
  return Boolean(rows[0]?.exists);
}

export async function ensureSchemaMigrationsTable(pool: DbPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      adopted    BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
}

export async function listAppliedMigrations(pool: DbPool): Promise<AppliedMigrationRow[]> {
  // جدول التسجيل نفسه قد لا يكون موجودًا بعد (تشغيل أول / dry-run): قراءته
  // حينها = قائمة فارغة — لا إنشاؤه ضمن مسار القراءة.
  const { rows: tableRows } = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  if (!tableRows[0]?.exists) return [];
  const { rows } = await pool.query<{ version: string; name: string; checksum: string; applied_at: Date; adopted: boolean }>(
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
export async function databaseIsEmpty(pool: DbPool): Promise<boolean> {
  for (const table of ["patients", "users", "invoices", "payments", "settings"]) {
    if (await tableExistsLike(pool, table)) return false;
  }
  return true;
}

async function tableExistsLike(pool: DbPool, table: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.' || quote_ident($1)) IS NOT NULL AS exists`, [table],
  );
  return Boolean(rows[0]?.exists);
}

/** فحص التوافق الحرج: الجداول كلها موجودة، والأعمدة التالية للأساس موجودة إذا
 * كانت هجرتها مسجَّلة كمطبَّقة. `appliedVersions` الفارغ (وضع الاعتماد) يفحص
 * الجداول وحدها — فقاعدة قائمة على خط الأساس لا تملك أعمدة 0003 بعد. */
export async function criticalSchemaProbe(
  pool: DbPool,
  appliedVersions: ReadonlySet<string> = new Set(),
): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  const client = await pool.connect();
  try {
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
  } finally {
    client.release();
  }
  return { ok: missing.length === 0, missing };
}

/**
 * حالة الهجرات كاملة — أساس db:status وdb:verify (P1.2).
 * consistent تعني: لا هجرات ناقصة، ولا صفوف مجهولة، ولا بصمات مخالفة، وفحص
 * التوافق الحرج سليم. أي انحراف مهم ⇒ غير متسق ⇒ fail closed.
 */
export async function migrationStatus(pool: DbPool, files?: MigrationFile[]): Promise<MigrationStatus> {
  const migrationFiles = files ?? (await loadMigrationFiles());
  const applied = await listAppliedMigrations(pool);
  const appliedVersions = new Set(applied.map((row) => row.version));
  const fileVersions = new Map(migrationFiles.map((file) => [file.version, file]));

  const pending = migrationFiles.filter((file) => !appliedVersions.has(file.version));
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

  const emptyDatabase = await databaseIsEmpty(pool);
  const appliedVersionSet = new Set(applied.map((row) => row.version));
  const probe = await criticalSchemaProbe(pool, appliedVersionSet);

  const consistent =
    pending.length === 0
    && unknownApplied.length === 0
    && checksumMismatches.length === 0
    && probe.ok;

  return {
    applied, files: migrationFiles, pending, unknownApplied, checksumMismatches,
    emptyDatabase, probe, consistent,
  };
}

/**
 * تطبيق الهجرات حتى آخر نسخة — مع اعتماد خط الأساس لقاعدة قائمة (P1.1).
 *
 * الوسيط `apply: false` (الافتراضي) = dry-run: يُحسب ويُعرَف ما سيل دون تنفيذ.
 */
export async function migrate(
  pool: DbPool,
  options: { apply?: boolean; files?: MigrationFile[] } = {},
): Promise<MigrationRunResult> {
  const apply = options.apply === true;
  const files = options.files ?? (await loadMigrationFiles());
  let applied = await listAppliedMigrations(pool);
  const appliedVersions = new Set(applied.map((row) => row.version));
  let appliedNow: string[] = [];
  let adoptedBaseline = false;

  // الخطوة ١: خط الأساس — تطبيق جديد أو اعتماد قائم، لا ثالث لهما.
  if (!appliedVersions.has(BASELINE_VERSION)) {
    const baseline = files[0];
    if (baseline.version !== BASELINE_VERSION) {
      throw new Error("ملف خط الأساس مفقود أو في غير موضعه.");
    }
    const isEmpty = await databaseIsEmpty(pool);
    if (isEmpty) {
      // قاعدة جديدة فارغة: DDL كاملًا داخل transaction، ثم تسجيل.
      if (apply) {
        await ensureSchemaMigrationsTable(pool);
        await applyMigrationInTransaction(pool, baseline, { adopted: false });
      }
      appliedNow.push(BASELINE_VERSION);
    } else {
      // قاعدة موجودة من النظام الحالي: اعتماد بعد فحص توافق — بلا تنفيذ DDL.
      // فحص الاعتماد بالجداول وحدها (أعمدة 0003+ ليست بعد موجودة وهجرة 0003 ستطبّقها).
      const probe = await criticalSchemaProbe(pool, new Set());
      if (!probe.ok) {
        throw new Error(
          `انحراف مخطط يمنع اعتماد خط الأساس — العناصر الناقصة: ${probe.missing.join("، ")}. `
          + "القاعدة ليست فارغة ولا تطابق المخطط المعروف؛ يُرفض التسجيل الأعمى (fail closed).",
        );
      }
      if (apply) {
        await ensureSchemaMigrationsTable(pool);
        await recordMigration(pool, baseline, { adopted: true });
      }
      adoptedBaseline = true;
      appliedNow.push(BASELINE_VERSION);
    }
    if (apply) applied = await listAppliedMigrations(pool);
  }

  // الخطوة ٢: هجرات ما بعد الأساس بالترتيب الحتمي.
  for (const file of files) {
    if (file.version === BASELINE_VERSION) continue;
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
      await ensureSchemaMigrationsTable(pool);
      await applyMigrationInTransaction(pool, file, { adopted: false });
    }
    appliedNow.push(file.version);
  }

  return {
    adoptedBaseline,
    appliedVersions: appliedNow,
    alreadyUpToDate: appliedNow.length === 0,
  };
}


async function applyMigrationInTransaction(
  pool: DbPool,
  file: MigrationFile,
  meta: { adopted: boolean },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
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
  } finally {
    client.release();
  }
}

async function recordMigration(
  pool: DbPool,
  file: MigrationFile,
  meta: { adopted: boolean },
): Promise<void> {
  await pool.query(
    `INSERT INTO schema_migrations (version, name, checksum, adopted)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (version) DO NOTHING`,
    [file.version, file.name, file.checksum, meta.adopted],
  );
}
