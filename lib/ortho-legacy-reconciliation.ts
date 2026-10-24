import { createHash } from "node:crypto";
import type { DbClient, DbPool } from "./db";
import { MIGRATION_ADVISORY_LOCK_KEY } from "./migrations";
import contracts from "./ortho-assessment-runtime.generated.json";
import { validateOrthoRevisionRegistry } from "./ortho-revision-migration-guard";
import type { MigrationFile } from "./migration-files";

/**
 * مصالحة صريحة لكائنات 0051 الموجودة دون تسجيل — أداة مشغّل فقط، لا تُستدعى من
 * ensureSchema ولا عند الإقلاع. الحارس العادي يبقى مغلقًا عند الفشل كما هو.
 *
 * - افتراضيًّا تقرير فقط (ROLLBACK دائمًا). التطبيق يحتاج apply=true مع بصمة الكتالوج
 *   التي راجعها المشغّل في التقرير، واسم القاعدة المقصودة.
 * - التصنيف بمطابقة الكتالوج الكاملة مع ناتج تنفيذ نص العقد المنشور حرفيًّا في مخطط
 *   مؤقت داخل نقطة حفظ تُلغى — لا بالأسماء: absent / exact / partial / conflicting.
 * - لا يؤهَّل إلا exact مع سلامة كل الصفوف الموجودة (تُعاد قواعد القيود والمحفّز
 *   النهائي قراءةً فقط — لا يُفترض صحّة الصفوف القديمة من وجود المحفّزات) وتقدّم
 *   التسلسل على أكبر معرّف.
 * - التسجيل (صف schema_migrations غير معتمَد + سجل تدقيق بالدليل) في معاملة واحدة تحت
 *   قفل الهجرات الاستشاري نفسه وقفل SHARE ROW EXCLUSIVE على الجدول، مع إعادة حساب
 *   البصمة قبل COMMIT. لا حذف ولا تعديل لأي صف أو كائن، ولا adopted=true.
 * - 0052 خارج النطاق عمدًا: لا دليل على حالته، فيبقى محجوبًا بالحارس.
 */

export const RECONCILE_VERSION = "0051";
const TABLE = "ortho_strategy_revisions";
const FUNCTIONS = ["reject_ortho_strategy_revision_mutation", "check_ortho_strategy_revision_final_state"];
const REFERENCE_SCHEMA = "ortho_reconcile_reference";

export type ReconcileClassification = "registered" | "absent" | "exact" | "partial" | "conflicting";
export type ReconcileReport = {
  version: typeof RECONCILE_VERSION;
  database: string;
  classification: ReconcileClassification;
  fingerprint: string | null;
  referenceFingerprint: string | null;
  differences: { missing: string[]; unexpected: string[] };
  rows: number | null;
  invariants: Array<{ check: string; violations: number }>;
  sequence: { ok: boolean; lastValue: string; isCalled: boolean; maxId: string } | null;
  eligible: boolean;
  applied: boolean;
  refusal: string | null;
};
export type ReconcileOptions = {
  apply: boolean;
  expectedDatabase: string;
  expectedFingerprint?: string;
  actor?: string;
  reason?: string;
  /** Test seam: runs inside the transaction after the writes, before COMMIT. */
  onBeforeCommit?: (client: DbClient) => Promise<void>;
};

function contractFile(): MigrationFile {
  const file = contracts.find(candidate => candidate.version === RECONCILE_VERSION);
  if (!file) throw new Error("ORTHO_RECONCILE_CONTRACT_MISSING");
  validateOrthoRevisionRegistry(file as MigrationFile);
  return file as MigrationFile;
}

/** Normalised catalog items for the 0051 object set in one schema. Owners and ACLs are not compared. */
async function catalogItems(client: DbClient, schema: string): Promise<string[]> {
  const { rows } = await client.query<{ item: string }>(`
    WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname = $1),
    rel AS (SELECT c.* FROM pg_class c, ns WHERE c.relnamespace = ns.oid AND c.relname LIKE 'ortho\\_strategy\\_%')
    SELECT 'rel:' || relname || ':' || relkind::text || ':' || relpersistence::text || ':' || coalesce(array_to_string(reloptions, ','), '') AS item FROM rel
    UNION ALL
    SELECT 'col:' || r.relname || ':' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':'
      || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ':' || a.attidentity::text || ':' || a.attgenerated::text
    FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = r.oid AND d.adnum = a.attnum WHERE r.relkind = 'r'
    UNION ALL
    SELECT 'con:' || r.relname || ':' || con.conname || ':' || con.contype::text || ':' || pg_get_constraintdef(con.oid) || ':'
      || con.condeferrable::text || ':' || con.condeferred::text || ':' || con.convalidated::text || ':' || con.conislocal::text
    FROM rel r JOIN pg_constraint con ON con.conrelid = r.oid
    UNION ALL
    SELECT 'idx:' || ic.relname || ':' || regexp_replace(pg_get_indexdef(i.indexrelid), ' ON [a-z_]+\\.', ' ON ') || ':'
      || i.indisvalid::text || ':' || i.indisready::text || ':' || i.indislive::text
    FROM rel r JOIN pg_index i ON i.indrelid = r.oid JOIN pg_class ic ON ic.oid = i.indexrelid
    UNION ALL
    SELECT 'trg:' || r.relname || ':' || t.tgname || ':' || regexp_replace(pg_get_triggerdef(t.oid), ' ON [a-z_]+\\.', ' ON ') || ':' || t.tgenabled::text
    FROM rel r JOIN pg_trigger t ON t.tgrelid = r.oid AND NOT t.tgisinternal
    UNION ALL
    SELECT 'fn:' || p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || format_type(p.prorettype, NULL) || ':'
      || l.lanname || ':' || p.provolatile::text || ':' || p.prosecdef::text || ':' || md5(p.prosrc) || ':' || coalesce(array_to_string(p.proconfig, ','), '')
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang, ns WHERE p.pronamespace = ns.oid AND p.proname = ANY($2)
    UNION ALL
    SELECT 'seq:' || r.relname || ':' || format_type(s.seqtypid, NULL) || ':' || s.seqstart || ':' || s.seqincrement || ':' || s.seqmin || ':'
      || s.seqmax || ':' || s.seqcache || ':' || s.seqcycle::text || ':owned_by=' || coalesce((
        SELECT oc.relname || '.' || oa.attname FROM pg_depend dep JOIN pg_class oc ON oc.oid = dep.refobjid
        JOIN pg_attribute oa ON oa.attrelid = dep.refobjid AND oa.attnum = dep.refobjsubid
        WHERE dep.classid = 'pg_class'::regclass AND dep.objid = r.oid AND dep.deptype IN ('a', 'i') LIMIT 1), '')
    FROM rel r JOIN pg_sequence s ON s.seqrelid = r.oid
    UNION ALL
    SELECT 'type:' || t.typname || ':' || t.typtype::text FROM pg_type t, ns
    WHERE t.typnamespace = ns.oid AND t.typname::text IN ($3::text, '_' || $3::text)
    ORDER BY 1`, [schema, FUNCTIONS, TABLE]);
  return rows.map(row => row.item);
}
const fingerprintOf = (items: string[]) => createHash("sha256").update(items.join("\n")).digest("hex");

/** Executes the exact published contract SQL in a throwaway schema inside a savepoint that is always
 * rolled back (its locks and objects vanish with it), and returns the normalised catalog items. */
async function referenceItems(client: DbClient, file: MigrationFile): Promise<string[]> {
  await client.query("SAVEPOINT ortho_reconcile_reference");
  try {
    await client.query(`CREATE SCHEMA ${REFERENCE_SCHEMA}`);
    await client.query(`SET LOCAL search_path = ${REFERENCE_SCHEMA}, public`);
    await client.query(file.sql);
    return await catalogItems(client, REFERENCE_SCHEMA);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT ortho_reconcile_reference");
    await client.query("RELEASE SAVEPOINT ortho_reconcile_reference");
  }
}

/** Read-only re-evaluation of the contract's row rules on every existing row; counts only. */
async function invariantViolations(client: DbClient): Promise<Array<{ check: string; violations: number }>> {
  const checks: Array<[string, string]> = [
    ["column_rules", `NOT (recorded_patient_id > 0 AND schema_version = 1 AND version > 0
      AND length(btrim(created_by)) BETWEEN 1 AND 200 AND length(btrim(reason)) BETWEEN 1 AND 500
      AND recording_context IN ('current', 'retrospective') AND command_id ~ '^[a-zA-Z0-9_-]{16,80}$'
      AND request_fingerprint ~ '^[a-f0-9]{64}$' AND jsonb_typeof(rows) = 'array'
      AND jsonb_array_length(rows) BETWEEN 1 AND 30 AND octet_length(rows::text) <= 1048576)`],
    ["first_revision", `(version = 1) <> (supersedes_revision_id IS NULL)`],
    ["not_self", `supersedes_revision_id = id`],
    ["references_exist", `NOT EXISTS (SELECT 1 FROM patients p WHERE p.id = r.patient_id)
      OR NOT EXISTS (SELECT 1 FROM ortho_cases o WHERE o.id = r.ortho_case_id)
      OR NOT EXISTS (SELECT 1 FROM clinical_cases c WHERE c.id = r.clinical_case_id)
      OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.actor_user_id)`],
    ["owner_bridge", `NOT EXISTS (SELECT 1 FROM ortho_cases o JOIN clinical_cases c ON c.ortho_case_id = o.id
      WHERE o.id = r.ortho_case_id AND c.id = r.clinical_case_id AND o.patient_id = r.patient_id AND c.patient_id = r.patient_id)`],
    ["predecessor_exact", `supersedes_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${TABLE} p
      WHERE p.id = r.supersedes_revision_id AND p.ortho_case_id = r.ortho_case_id
        AND p.clinical_case_id = r.clinical_case_id AND p.version = r.version - 1)`],
    ["case_version_duplicate", `EXISTS (SELECT 1 FROM ${TABLE} d WHERE d.id <> r.id AND d.ortho_case_id = r.ortho_case_id AND d.version = r.version)`],
    ["successor_duplicate", `supersedes_revision_id IS NOT NULL AND EXISTS (SELECT 1 FROM ${TABLE} d WHERE d.id <> r.id AND d.supersedes_revision_id = r.supersedes_revision_id)`],
    ["command_duplicate", `EXISTS (SELECT 1 FROM ${TABLE} d WHERE d.id <> r.id AND d.ortho_case_id = r.ortho_case_id
      AND d.actor_user_id = r.actor_user_id AND d.command_id = r.command_id)`],
  ];
  const out = [];
  for (const [check, predicate] of checks) {
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE} r WHERE ${predicate}`);
    out.push({ check, violations: rows[0].n });
  }
  return out;
}

async function sequenceState(client: DbClient) {
  const { rows } = await client.query<{ last_value: string; is_called: boolean; max_id: string }>(
    `SELECT s.last_value::text, s.is_called, (SELECT coalesce(max(id), 0)::text FROM ${TABLE}) AS max_id FROM ortho_strategy_revisions_id_seq s`);
  const { last_value: lastValue, is_called: isCalled, max_id: maxId } = rows[0];
  const ok = BigInt(maxId) === 0n || (isCalled ? BigInt(lastValue) >= BigInt(maxId) : BigInt(lastValue) > BigInt(maxId));
  return { ok, lastValue, isCalled, maxId };
}

function refuse(report: ReconcileReport, refusal: string): ReconcileReport {
  return { ...report, eligible: false, applied: false, refusal };
}

export async function reconcileOrthoStrategyLegacy(pool: DbPool, options: ReconcileOptions): Promise<ReconcileReport> {
  const file = contractFile();
  const client = await pool.connect();
  let report: ReconcileReport = {
    version: RECONCILE_VERSION, database: "", classification: "absent", fingerprint: null, referenceFingerprint: null,
    differences: { missing: [], unexpected: [] }, rows: null, invariants: [], sequence: null, eligible: false, applied: false, refusal: null,
  };
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    try {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '120s'");
        await client.query("SET LOCAL search_path = public");
        report.database = (await client.query<{ db: string }>("SELECT current_database() AS db")).rows[0].db;
        if (report.database !== options.expectedDatabase) return refuse(report, "database_mismatch");
        const registered = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [RECONCILE_VERSION]);
        if (registered.rowCount) return refuse({ ...report, classification: "registered" }, "already_registered");

        const reference = await referenceItems(client, file);
        report.referenceFingerprint = fingerprintOf(reference);
        const tableExists = (await client.query("SELECT to_regclass('public.ortho_strategy_revisions') IS NOT NULL AS e")).rows[0].e;
        // Freeze writes to the revision table (reads continue) for the classification, checks and registration.
        if (tableExists) await client.query(`LOCK TABLE ${TABLE} IN SHARE ROW EXCLUSIVE MODE`);
        const live = await catalogItems(client, "public");
        report.fingerprint = live.length ? fingerprintOf(live) : null;
        const referenceSet = new Set(reference);
        const liveSet = new Set(live);
        report.differences = { missing: reference.filter(item => !liveSet.has(item)), unexpected: live.filter(item => !referenceSet.has(item)) };
        report.classification = !live.length ? "absent"
          : !report.differences.missing.length && !report.differences.unexpected.length ? "exact"
          : !report.differences.unexpected.length ? "partial" : "conflicting";
        if (report.classification !== "exact") return refuse(report, `classification_${report.classification}`);

        report.rows = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n;
        report.invariants = await invariantViolations(client);
        report.sequence = await sequenceState(client);
        if (report.invariants.some(check => check.violations > 0)) return refuse(report, "row_invariants_violated");
        if (!report.sequence.ok) return refuse(report, "sequence_behind_rows");
        report.eligible = true;
        if (!options.apply) return report;

        if (options.expectedFingerprint !== report.fingerprint) return refuse(report, "fingerprint_not_confirmed");
        const actor = options.actor?.trim() ?? "";
        const reason = options.reason?.trim() ?? "";
        if (actor.length < 1 || actor.length > 200 || reason.length < 3 || reason.length > 300) return refuse(report, "actor_or_reason_invalid");
        const evidence = createHash("sha256").update(JSON.stringify({ ...report, applied: true })).digest("hex");
        await client.query(
          `INSERT INTO audit_log (action, entity, entity_id, summary, details, actor)
           VALUES ('schema.migration_reconciled', 'schema_migrations', $1, $2, $3::jsonb, $4)`,
          [RECONCILE_VERSION, `مصالحة صريحة لهجرة ${RECONCILE_VERSION} بعد مطابقة الكتالوج وسلامة الصفوف`,
            JSON.stringify({ version: RECONCILE_VERSION, name: file.name, checksum: file.checksum, fingerprint: report.fingerprint,
              referenceFingerprint: report.referenceFingerprint, evidenceSha256: evidence, rows: report.rows, sequence: report.sequence, reason }),
            actor]);
        await client.query("INSERT INTO schema_migrations (version, name, checksum, adopted) VALUES ($1, $2, $3, FALSE)",
          [RECONCILE_VERSION, file.name, file.checksum]);
        // Transaction-time revalidation: the catalog must still be exactly what was classified.
        if (fingerprintOf(await catalogItems(client, "public")) !== report.fingerprint) throw new Error("ORTHO_RECONCILE_CATALOG_CHANGED");
        await options.onBeforeCommit?.(client);
        await client.query("COMMIT");
        report = { ...report, applied: true };
        return report;
      } finally {
        if (!report.applied) await client.query("ROLLBACK").catch(() => {});
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } finally { client.release(); }
}

/** Operator CLI arguments. Report-only unless --apply; --database is always required. */
export function parseReconcileArgs(argv: string[]): Omit<ReconcileOptions, "onBeforeCommit"> {
  const values = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") { apply = true; continue; }
    if (!["--database", "--expect-fingerprint", "--actor", "--reason"].includes(arg) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
      throw new Error(`ORTHO_RECONCILE_USAGE: ${arg.startsWith("--") ? arg : "unexpected argument"}`);
    }
    values.set(arg, argv[++i]);
  }
  const expectedDatabase = values.get("--database");
  if (!expectedDatabase) throw new Error("ORTHO_RECONCILE_USAGE: --database is required");
  return { apply, expectedDatabase, expectedFingerprint: values.get("--expect-fingerprint"), actor: values.get("--actor"), reason: values.get("--reason") };
}
