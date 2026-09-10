import { createHash } from "node:crypto";

/**
 * إسقاط حتميّ لمخطط PostgreSQL لاستخدامه في بوابة الإنتاج النهائية.
 *
 * هذا الملف مقصود أن يكون READ-ONLY بالكامل: كل استعلاماته SELECT فقط.
 * توليد الـmanifest المتوقع من DDL خط الأساس يتم في scripts/generate-baseline-manifest.ts
 * على PostgreSQL 18 معزول، وليس داخل تطبيق الإنتاج.
 */

export interface SchemaManifestColumnProblem {
  table: string;
  column: string;
  kind: "missing" | "signature_mismatch";
  expected: string;
  actual: string;
}

export interface BaselineSchemaManifest {
  format: "aqlan-baseline-schema-manifest";
  formatVersion: 1;
  migrationVersion: "0001";
  baselineSqlSha256: string;
  postgresMajor: number;
  postgresVersion: string;
  fingerprint: string;
  checked: {
    tables: number;
    columns: number;
    constraints: number;
    indexes: number;
    triggers: number;
  };
  tables: string[];
  columns: Record<string, Record<string, string>>;
  constraints: string[];
  indexes: string[];
  triggers: string[];
}

export interface SchemaManifestDiff {
  ok: boolean;
  expectedFingerprint: string;
  actualFingerprint: string;
  checked: BaselineSchemaManifest["checked"];
  missingTables: string[];
  columnProblems: SchemaManifestColumnProblem[];
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

export interface ReadOnlyCatalogClient {
  query<T = any>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

function hashLines(lines: string[]): string {
  return createHash("sha256").update(lines.slice().sort().join("\n"), "utf8").digest("hex");
}

function normalizeCatalogText(text: string | null | undefined, schemasToStrip: string[]): string {
  let out = String(text ?? "").replace(/\s+/g, " ").trim();
  for (const schema of schemasToStrip) out = out.split(`${schema}.`).join("");
  return out;
}

function columnSignature(parts: {
  data_type: string;
  character_maximum_length: string | number | null;
  numeric_precision: string | number | null;
  numeric_scale: string | number | null;
  datetime_precision: string | number | null;
  is_nullable: string;
  column_default: string | null;
}, schemasToStrip: string[]): string {
  return [
    parts.data_type,
    parts.character_maximum_length ?? "",
    parts.numeric_precision ?? "",
    parts.numeric_scale ?? "",
    parts.datetime_precision ?? "",
    parts.is_nullable,
    normalizeCatalogText(parts.column_default, schemasToStrip),
  ].join("|");
}

/**
 * يستقرئ schema موجودًا باستعلامات SELECT فقط. لا CREATE/ALTER/SET/LOCK ولا
 * أي كتابة. هذا هو المسار الوحيد الذي سيُستخدم ضد public في الإنتاج.
 */
export async function projectSchemaReadOnly(
  client: ReadOnlyCatalogClient,
  schema: string,
  schemasToStrip: string[] = [schema],
): Promise<SchemaProjection> {
  const projection: SchemaProjection = {
    tables: new Set(), columns: new Map(), constraints: new Set(),
    indexes: new Set(), triggers: new Set(), rawLines: [],
  };

  const { rows: tableRows } = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
    [schema],
  );
  for (const row of tableRows) projection.tables.add(row.table_name);
  projection.rawLines.push(...[...projection.tables].sort().map((table) => `table:${table}`));

  const { rows: columnRows } = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    character_maximum_length: string | number | null;
    numeric_precision: string | number | null;
    numeric_scale: string | number | null;
    datetime_precision: string | number | null;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT table_name, column_name, data_type, character_maximum_length,
            numeric_precision, numeric_scale, datetime_precision,
            is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1`,
    [schema],
  );
  for (const row of columnRows) {
    const signature = columnSignature(row, schemasToStrip);
    const perTable = projection.columns.get(row.table_name) ?? new Map<string, string>();
    perTable.set(row.column_name, signature);
    projection.columns.set(row.table_name, perTable);
    projection.rawLines.push(`column:${row.table_name}.${row.column_name}=${signature}`);
  }

  const { rows: constraintRows } = await client.query<{
    table_name: string;
    conname: string;
    contype: string;
    def: string;
  }>(
    `SELECT rel.relname AS table_name, c.conname, c.contype::text AS contype,
            pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       JOIN pg_class rel ON rel.oid = c.conrelid
      WHERE n.nspname = $1`,
    [schema],
  );
  for (const row of constraintRows) {
    const entry = `${row.table_name}|${normalizeCatalogText(row.def, schemasToStrip)}`;
    projection.constraints.add(entry);
    projection.rawLines.push(`constraint:${entry}|${row.conname}|${row.contype}`);
  }

  const { rows: indexRows } = await client.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = $1`,
    [schema],
  );
  for (const row of indexRows) {
    const entry = normalizeCatalogText(row.indexdef, schemasToStrip);
    projection.indexes.add(entry);
    projection.rawLines.push(`index:${entry}`);
  }

  const { rows: triggerRows } = await client.query<{
    trigger_name: string;
    event_object_table: string;
    action_timing: string;
    event_manipulation: string;
    action_statement: string;
  }>(
    `SELECT trigger_name, event_object_table, action_timing,
            event_manipulation, action_statement
       FROM information_schema.triggers
      WHERE trigger_schema = $1`,
    [schema],
  );
  const triggerEvents = new Map<string, {
    table: string; timing: string; events: Set<string>; statement: string;
  }>();
  for (const row of triggerRows) {
    const key = `${row.event_object_table}|${row.trigger_name}`;
    const current = triggerEvents.get(key) ?? {
      table: row.event_object_table,
      timing: row.action_timing,
      events: new Set<string>(),
      statement: row.action_statement,
    };
    current.events.add(row.event_manipulation);
    triggerEvents.set(key, current);
  }
  for (const [key, entry] of triggerEvents) {
    const line = `${key}|${entry.timing}|${[...entry.events].sort().join(",")}|${normalizeCatalogText(entry.statement, schemasToStrip)}`;
    projection.triggers.add(line);
    projection.rawLines.push(`trigger:${line}`);
  }

  return projection;
}

export function manifestFromProjection(
  projection: SchemaProjection,
  metadata: {
    baselineSql: string;
    postgresMajor: number;
    postgresVersion: string;
  },
): BaselineSchemaManifest {
  const tables = [...projection.tables].sort();
  const columns: Record<string, Record<string, string>> = {};
  for (const [table, perTable] of [...projection.columns.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    columns[table] = Object.fromEntries([...perTable.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  }
  const checked = {
    tables: tables.length,
    columns: Object.values(columns).reduce((sum, perTable) => sum + Object.keys(perTable).length, 0),
    constraints: projection.constraints.size,
    indexes: projection.indexes.size,
    triggers: projection.triggers.size,
  };
  return {
    format: "aqlan-baseline-schema-manifest",
    formatVersion: 1,
    migrationVersion: "0001",
    baselineSqlSha256: createHash("sha256").update(metadata.baselineSql, "utf8").digest("hex"),
    postgresMajor: metadata.postgresMajor,
    postgresVersion: metadata.postgresVersion,
    fingerprint: hashLines(projection.rawLines),
    checked,
    tables,
    columns,
    constraints: [...projection.constraints].sort(),
    indexes: [...projection.indexes].sort(),
    triggers: [...projection.triggers].sort(),
  };
}

function projectionFromManifest(manifest: BaselineSchemaManifest): SchemaProjection {
  const columns = new Map<string, Map<string, string>>();
  for (const [table, perTable] of Object.entries(manifest.columns)) {
    columns.set(table, new Map(Object.entries(perTable)));
  }
  const rawLines = [
    ...manifest.tables.map((table) => `table:${table}`),
    ...Object.entries(manifest.columns).flatMap(([table, perTable]) =>
      Object.entries(perTable).map(([column, signature]) => `column:${table}.${column}=${signature}`)),
    // أسماء القيود لا تدخل المقارنة؛ فقط table|definition كما في set.
    ...manifest.constraints.map((entry) => `constraint:${entry}`),
    ...manifest.indexes.map((entry) => `index:${entry}`),
    ...manifest.triggers.map((entry) => `trigger:${entry}`),
  ];
  return {
    tables: new Set(manifest.tables),
    columns,
    constraints: new Set(manifest.constraints),
    indexes: new Set(manifest.indexes),
    triggers: new Set(manifest.triggers),
    rawLines,
  };
}

function compareProjections(expected: SchemaProjection, actual: SchemaProjection, manifest: BaselineSchemaManifest): SchemaManifestDiff {
  const missingTables = [...expected.tables].filter((table) => !actual.tables.has(table)).sort();
  const columnProblems: SchemaManifestColumnProblem[] = [];
  for (const [table, expectedColumns] of expected.columns) {
    const actualColumns = actual.columns.get(table);
    if (!actualColumns) continue;
    for (const [column, expectedSignature] of expectedColumns) {
      const actualSignature = actualColumns.get(column);
      if (actualSignature === undefined) {
        columnProblems.push({ table, column, kind: "missing", expected: expectedSignature, actual: "(missing)" });
      } else if (actualSignature !== expectedSignature) {
        columnProblems.push({ table, column, kind: "signature_mismatch", expected: expectedSignature, actual: actualSignature });
      }
    }
  }
  const missingConstraints = [...expected.constraints].filter((entry) => !actual.constraints.has(entry)).sort();
  const missingIndexes = [...expected.indexes].filter((entry) => !actual.indexes.has(entry)).sort();
  const missingTriggers = [...expected.triggers].filter((entry) => !actual.triggers.has(entry)).sort();
  return {
    ok: missingTables.length === 0
      && columnProblems.length === 0
      && missingConstraints.length === 0
      && missingIndexes.length === 0
      && missingTriggers.length === 0,
    expectedFingerprint: manifest.fingerprint,
    actualFingerprint: hashLines(actual.rawLines),
    checked: manifest.checked,
    missingTables,
    columnProblems,
    missingConstraints,
    missingIndexes,
    missingTriggers,
  };
}

/**
 * مقارنة production public مع manifest ثابت. هذه الدالة نفسها لا تنفذ إلا
 * SELECT عبر projectSchemaReadOnly، وتسمح بالكائنات الإضافية؛ المطلوب ⊆ الفعلي.
 */
export async function comparePublicSchemaToManifest(
  client: ReadOnlyCatalogClient,
  manifest: BaselineSchemaManifest,
): Promise<SchemaManifestDiff> {
  if (manifest.format !== "aqlan-baseline-schema-manifest" || manifest.formatVersion !== 1) {
    throw new Error("Baseline schema manifest format is unsupported.");
  }
  const actual = await projectSchemaReadOnly(client, "public", ["public"]);
  return compareProjections(projectionFromManifest(manifest), actual, manifest);
}
