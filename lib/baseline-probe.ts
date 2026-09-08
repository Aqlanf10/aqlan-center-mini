import { createHash } from "node:crypto";
import type { DbPool } from "./db";

/**
 * مجسّ توافق خط الأساس (P1-FIX-1) — إثبات أن قاعدة قائمة «تطابق» DDL خط
 * الأساس 0001 فعليًا قبل تسجيل اعتمادها، لا مجرد أن أسماء جداولها موجودة.
 *
 * المشكلة التي يغلقها: الاعتماد القديم كان يفحص أسماء الجداول فقط تقريبًا،
 * فقاعدة منحرفة (drifted) بنفس الأسماء كانت تُسجَّل كخط أساس سليم — ثم تنكسر
 * الهجرات 0002+ أو وقت التشغيل فوق مخطط لم يُفهم قط.
 *
 * الطريقة (deterministic probe):
 *
 *  ١) داخل **معاملة تُتراجَع دائمًا** على قاعدة الهدف نفسها: يُنشأ مخطط مؤقت
 *     فريد الاسم، ويُنفَّذ فيه DDL خط الأساس 0001 حرفيًّا (search_path إليه).
 *  ٢) تُستقرأ الحقيقة من كتالوج PostgreSQL نفسه للمخططين (المؤقت = المتوقَّع،
 *     public = الفعلي) **بنفس الاستعلامات ونفس نسخة الخادم** — فلا فرق عرض
 *     (rendering) ممكن بين الجانبين: هذه هي حتمية المقارنة.
 *  ٣) تُقارن العناصر الحرجة اتجاهًا واحدًا: كل ما يتطلبه خط الأساس يجب أن
 *     يوجد في الفعلي **بنفس التوقيع**:
 *       - الجداول، والأعمدة (النوع/الطول/الدقة/الإبطال/القيمة الافتراضية
 *         حيث يعرفها الأساس)، والمفاتيح الأساسية، والمفاتيح الأجنبية
 *         (مع سلوك الحذف/التحديث)، وقيود UNIQUE وCHECK، والفهارس (بما فيها
 *         الفهارس الجزئية بشرطها)، والـtriggers الحرجة.
 *     أما الكائنات **الإضافية** في المخطط الفعلي (أنشأتها ensureSchema أو
 *     هجرات لاحقة) فليست مانعًا: المبدأ المحاسبي «مجموعة فوق مجموعة» —
 *     الإضافات لا تكسر وقت التشغيل ولا الهجرات التالية؛ الناقص/المغاير هو
 *     ما يكسر.
 *  ٤) أي فرق في الاتجاه المحظور ⇒ `BASELINE_SCHEMA_MISMATCH` بقائمة فروق
 *     مقروءة، ولا يُسجَّل الاعتماد (fail closed).
 *
 *  ٥) بعد الاستقراء تُتراجع المعاملة — المخطط المؤقت يختفي بلا أثر: لا
 *     DDL يبقى، ولا قفل على جداول public (الإنشاء في مخطط آخر لا يمسّها)،
 *     والدالة صالحة حتى لمسار القراءة (db:status).
 *
 * ملاحظة استقلال: `pg_advisory_lock` للهجرات (P1-FIX-2) يُمسك من مستوى
 * أعلى (migrate)؛ المجسّ نفسه لا يحتاج القفل لأنه لا يكتب شيئًا يبقى.
 */

export interface ColumnProblem {
  table: string;
  column: string;
  kind: "missing" | "type_mismatch" | "nullability_mismatch" | "default_mismatch";
  expected: string;
  actual: string;
}

export interface BaselineSchemaDiff {
  ok: boolean;
  /** بصمة SHA-256 للمخطط المتوقَّع من ملف خط الأساس (للعرض والتوثيق). */
  expectedFingerprint: string;
  /** بصمة المخطط الفعلي كما استُقرئ من الكتالوج. */
  actualFingerprint: string;
  checked: {
    tables: number;
    columns: number;
    constraints: number;
    indexes: number;
    triggers: number;
  };
  missingTables: string[];
  columnProblems: ColumnProblem[];
  missingConstraints: string[];
  missingIndexes: string[];
  missingTriggers: string[];
}

interface SchemaProjection {
  tables: Set<string>;
  columns: Map<string, Map<string, string>>;
  constraints: Set<string>;
  indexes: Set<string>;
  triggers: Set<string>;
  rawLines: string[];
}

const PROBE_SCHEMA_PREFIX = "aqlan_baseline_probe";
const PROBE_SCHEMA_PATTERN = /^[a-z0-9_]+$/;

function hashLines(lines: string[]): string {
  return createHash("sha256").update(lines.slice().sort().join("\n"), "utf8").digest("hex");
}

/** تطبيع نص الكتالوج: مسافة واحدة + إزالة تأهيل المخططين المعروفين. */
function normalize(text: string | null, schemas: string[]): string {
  if (text === null || text === undefined) return "";
  let out = String(text).replace(/\s+/g, " ").trim();
  for (const schema of schemas) {
    out = out.split(`${schema}.`).join("");
  }
  return out;
}

function columnSignature(parts: {
  data_type: string; character_maximum_length: string | null;
  numeric_precision: string | number | null; numeric_scale: string | number | null;
  is_nullable: string; column_default: string | null;
}): string {
  const length = parts.character_maximum_length ?? "";
  const precision = parts.numeric_precision ?? "";
  const scale = parts.numeric_scale ?? "";
  return [
    parts.data_type, length, precision, scale,
    parts.is_nullable, parts.column_default ?? "",
  ].join("|");
}

/** يستقرئ مخططًا واحدًا إلى إسقاط قابل للمقارنة الحتمية. */
async function projectSchema(
  client: { query<T = any>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> },
  schema: string,
  schemasToStrip: string[],
): Promise<SchemaProjection> {
  const projection: SchemaProjection = {
    tables: new Set(),
    columns: new Map(),
    constraints: new Set(),
    indexes: new Set(),
    triggers: new Set(),
    rawLines: [],
  };

  const { rows: tableRows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
    [schema],
  );
  for (const row of tableRows) projection.tables.add(row.table_name);
  projection.rawLines.push(...[...projection.tables].sort().map((t) => `table:${t}`));

  const { rows: columnRows } = await client.query<{
    table_name: string; column_name: string; data_type: string;
    character_maximum_length: string | null; numeric_precision: string | number | null;
    numeric_scale: string | number | null; is_nullable: string; column_default: string | null;
  }>(
    `SELECT table_name, column_name, data_type, character_maximum_length,
            numeric_precision, numeric_scale, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = $1`,
    [schema],
  );
  for (const row of columnRows) {
    const perTable = projection.columns.get(row.table_name) ?? new Map<string, string>();
    // القيمة الافتراضية تُطبَّع أولًا: أسماء السلاسل تُخزَّن مؤهَّلة باسم المخطط
    // حين لا يكون في search_path — التطبيع يجعل الجانبين متطابقين حتميًّا.
    perTable.set(row.column_name, columnSignature({ ...row, column_default: normalize(row.column_default, schemasToStrip) }));
    projection.columns.set(row.table_name, perTable);
    projection.rawLines.push(`column:${row.table_name}.${row.column_name}=${columnSignature({ ...row, column_default: normalize(row.column_default, schemasToStrip) })}`);
  }

  const { rows: constraintRows } = await client.query<{ table_name: string; conname: string; contype: string; def: string }>(
    `SELECT conrelid::regclass::text AS table_name, c.conname, c.contype::text AS contype,
            pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = $1`,
    [schema],
  );
  for (const row of constraintRows) {
    const entry = `${normalize(row.table_name, schemasToStrip)}|${normalize(row.def, schemasToStrip)}`;
    projection.constraints.add(entry);
    projection.rawLines.push(`constraint:${entry}|${row.conname}`);
  }

  const { rows: indexRows } = await client.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = $1`,
    [schema],
  );
  for (const row of indexRows) {
    const entry = normalize(row.indexdef, schemasToStrip);
    projection.indexes.add(entry);
    projection.rawLines.push(`index:${entry}`);
  }

  const { rows: triggerRows } = await client.query<{
    trigger_name: string; event_object_table: string; action_timing: string;
    event_manipulation: string; action_statement: string;
  }>(
    `SELECT trigger_name, event_object_table, action_timing, event_manipulation, action_statement
       FROM information_schema.triggers WHERE trigger_schema = $1`,
    [schema],
  );
  const triggerEvents = new Map<string, { table: string; timing: string; events: Set<string>; statement: string }>();
  for (const row of triggerRows) {
    const key = `${row.event_object_table}|${row.trigger_name}`;
    const entry = triggerEvents.get(key) ?? {
      table: row.event_object_table, timing: row.action_timing,
      events: new Set<string>(), statement: row.action_statement,
    };
    entry.events.add(row.event_manipulation);
    triggerEvents.set(key, entry);
  }
  for (const [key, entry] of triggerEvents) {
    const line = `${key}|${entry.timing}|${[...entry.events].sort().join(",")}|${normalize(entry.statement, schemasToStrip)}`;
    projection.triggers.add(line);
    projection.rawLines.push(`trigger:${line}`);
  }

  return projection;
}

/** يفكّ توقيع العمود إلى مكوناته للمقارنة التفصيلية. */
function signatureParts(signature: string): { type: string; nullable: string; default: string } {
  const [type, , , , nullable, ...defaultParts] = signature.split("|");
  return { type, nullable, default: defaultParts.join("|") };
}

/**
 * تنفيذ المجسّ كاملًا: معاملة → مخطط مؤقت → DDL خط الأساس → استقراء الطرفين →
 * مقارنة → تراجع دائم. يعيد الفرق الحتمي (ok=false ⇒ لا اعتماد).
 *
 * `baselineSql` هو نص ملف 0001 كما هو (المصدر الوحيد للحقيقة المتوقَّعة).
 */
export async function runBaselineSchemaProbe(
  pool: DbPool,
  baselineSql: string,
): Promise<BaselineSchemaDiff> {
  const suffix = `${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const probeSchema = `${PROBE_SCHEMA_PREFIX}_${suffix}`;
  if (!PROBE_SCHEMA_PATTERN.test(probeSchema)) {
    throw new Error("اسم مخطط المجسّ غير صالح — عطل داخلي.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(`CREATE SCHEMA ${probeSchema}`);
      await client.query(`SET LOCAL search_path TO ${probeSchema}`);
      // DDL خط الأساس في المخطط المؤقت — نصًّا كما هو، بلا معاملات (simple query).
      await client.query(baselineSql);
      // إعادة search_path إلى public ليكون عرض regclass متسقًا للجانبين.
      await client.query(`SET LOCAL search_path TO public`);
      const expected = await projectSchema(client, probeSchema, [probeSchema]);
      const actual = await projectSchema(client, "public", [probeSchema, "public"]);

      const diff = compareProjections(expected, actual);
      return diff;
    } finally {
      // التراجع دائمًا — المخطط المؤقت يختفي كأنه لم يكن.
      await client.query("ROLLBACK").catch(() => {});
    }
  } finally {
    client.release();
  }
}

function compareProjections(expected: SchemaProjection, actual: SchemaProjection): BaselineSchemaDiff {
  const missingTables = [...expected.tables].filter((table) => !actual.tables.has(table)).sort();

  const columnProblems: ColumnProblem[] = [];
  for (const [table, expectedColumns] of [...expected.columns.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const actualColumns = actual.columns.get(table);
    if (!actualColumns) continue; // الجدول كله ناقص — مُبلَّغ في missingTables
    for (const [column, expectedSignature] of [...expectedColumns.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const actualSignature = actualColumns.get(column);
      if (actualSignature === undefined) {
        columnProblems.push({ table, column, kind: "missing", expected: expectedSignature, actual: "(غير موجود)" });
        continue;
      }
      if (actualSignature === expectedSignature) continue;
      const expectedParts = signatureParts(expectedSignature);
      const actualParts = signatureParts(actualSignature);
      if (expectedParts.type !== actualParts.type) {
        columnProblems.push({
          table, column, kind: "type_mismatch",
          expected: expectedParts.type, actual: actualParts.type,
        });
      } else if (expectedParts.nullable !== actualParts.nullable) {
        columnProblems.push({
          table, column, kind: "nullability_mismatch",
          expected: expectedParts.nullable === "YES" ? "nullable" : "NOT NULL",
          actual: actualParts.nullable === "YES" ? "nullable" : "NOT NULL",
        });
      } else {
        // النوع والإبطال متطابقان — الفرق في القيمة الافتراضية (لا نبلّغ عنها إلا
        // إذا عرّفها خط الأساس — الفروق هنا تؤثر على الإدراج/القراءة).
        columnProblems.push({
          table, column, kind: "default_mismatch",
          expected: expectedParts.default || "(بلا قيمة افتراضية)",
          actual: actualParts.default || "(بلا قيمة افتراضية)",
        });
      }
    }
  }

  const missingConstraints = [...expected.constraints]
    .filter((constraint) => !actual.constraints.has(constraint)).sort();
  const missingIndexes = [...expected.indexes]
    .filter((index) => !actual.indexes.has(index)).sort();
  const missingTriggers = [...expected.triggers]
    .filter((trigger) => !actual.triggers.has(trigger)).sort();

  return {
    ok: missingTables.length === 0
      && columnProblems.length === 0
      && missingConstraints.length === 0
      && missingIndexes.length === 0
      && missingTriggers.length === 0,
    expectedFingerprint: hashLines(expected.rawLines),
    actualFingerprint: hashLines(actual.rawLines),
    checked: {
      tables: expected.tables.size,
      columns: [...expected.columns.values()].reduce((sum, columns) => sum + columns.size, 0),
      constraints: expected.constraints.size,
      indexes: expected.indexes.size,
      triggers: expected.triggers.size,
    },
    missingTables,
    columnProblems,
    missingConstraints,
    missingIndexes,
    missingTriggers,
  };
}

/** أسطر مقروءة للفروق — لرسالة الخطأ وdb:status (بلا كشف أكثر من اللازم). */
export function describeBaselineDiff(diff: BaselineSchemaDiff, maxEntries = 12): string[] {
  const lines: string[] = [];
  if (diff.missingTables.length) {
    lines.push(`جداول ناقصة (${diff.missingTables.length}): ${diff.missingTables.slice(0, maxEntries).join("، ")}${diff.missingTables.length > maxEntries ? " …" : ""}`);
  }
  for (const problem of diff.columnProblems.slice(0, maxEntries)) {
    const label = {
      missing: "عمود ناقص",
      type_mismatch: "نوع مختلف",
      nullability_mismatch: "إبطال مختلف",
      default_mismatch: "قيمة افتراضية مختلفة",
    }[problem.kind];
    lines.push(`${label}: ${problem.table}.${problem.column} — المتوقَّع «${problem.expected}» / الفعلي «${problem.actual}»`);
  }
  if (diff.columnProblems.length > maxEntries) {
    lines.push(`… ومشاكل أعمدة أخرى (${diff.columnProblems.length - maxEntries}).`);
  }
  if (diff.missingConstraints.length) {
    lines.push(`قيود ناقصة (${diff.missingConstraints.length}):`);
    lines.push(...diff.missingConstraints.slice(0, maxEntries).map((entry) => `  • ${entry.replace(/\|/, " — ")}`));
  }
  if (diff.missingIndexes.length) {
    lines.push(`فهارس ناقصة (${diff.missingIndexes.length}):`);
    lines.push(...diff.missingIndexes.slice(0, maxEntries).map((entry) => `  • ${entry}`));
  }
  if (diff.missingTriggers.length) {
    lines.push(`triggers ناقصة (${diff.missingTriggers.length}):`);
    lines.push(...diff.missingTriggers.slice(0, maxEntries).map((entry) => `  • ${entry.replace(/\|/g, " — ")}`));
  }
  return lines;
}
