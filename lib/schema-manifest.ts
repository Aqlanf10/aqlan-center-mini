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


/* ──────────────────────────────────────────────────────────────────────────
 * TD-01A preparation — detailed schema ownership characterization.
 *
 * This is deliberately a second projection over the SAME read-only catalog
 * owner.  BaselineSchemaManifest v1 above stays byte-compatible: none of its
 * types, queries or serialization are changed by this extension.
 * ──────────────────────────────────────────────────────────────────────── */

export type DetailedCatalogSection =
  | "tables"
  | "columns"
  | "constraints"
  | "indexes"
  | "triggers"
  | "internalTriggers"
  | "functions"
  | "sequences"
  | "ownership"
  | "extensions"
  | "extensionMembers"
  | "openFindings";

export interface DetailedCatalogEntry {
  /** Stable identity inside a section. */
  key: string;
  /** Canonical JSON string with semantic properties only. */
  value: string;
  /** Owning table where the object is table-scoped. */
  table?: string;
  /** Object name where useful to reviewers. */
  name?: string;
}

export interface MigrationRegistryEvidence {
  present: boolean;
  rows: Array<{
    version: string;
    name: string;
    checksum: string;
    adopted: boolean;
  }>;
}

export interface DetailedSchemaCatalog {
  format: "aqlan-schema-ownership-catalog";
  formatVersion: 1;
  postgresMajor: number;
  postgresVersion: string;
  ownership: {
    databaseOwner: string;
    schemaOwner: string;
    schemaAcl: string;
  };
  tables: DetailedCatalogEntry[];
  columns: DetailedCatalogEntry[];
  constraints: DetailedCatalogEntry[];
  indexes: DetailedCatalogEntry[];
  triggers: DetailedCatalogEntry[];
  internalTriggers: DetailedCatalogEntry[];
  functions: DetailedCatalogEntry[];
  sequences: DetailedCatalogEntry[];
  extensions: Array<{ name: string; version: string; schema: string }>;
  extensionMembers: DetailedCatalogEntry[];
  mutableSequenceState: Array<{
    key: string;
    lastValue: string;
    isCalled: boolean;
  }>;
  registry: MigrationRegistryEvidence;
}

export interface DetailedSchemaDifference {
  section: DetailedCatalogSection;
  key: string;
  kind: "missing_left" | "missing_right" | "definition_mismatch";
  left?: string;
  right?: string;
  classification?: "KNOWN_DIFFERENCE" | "OPEN_CONVERGENCE_FINDING" | "UNEXPECTED_DIFFERENCE";
  openFindingId?: string;
}

export interface DetailedSchemaComparison {
  characterizationOk: boolean;
  applicationSchemaEqual: boolean;
  ownershipEqual: boolean;
  extensionProvenanceEqual: boolean;
  openFindingSetMatches: boolean;
  openFindingsManifestMatch: boolean;
  rawDifferences: DetailedSchemaDifference[];
  registryDifference: {
    equal: boolean;
    left: MigrationRegistryEvidence;
    right: MigrationRegistryEvidence;
  };
  mutableSequenceState: {
    left: DetailedSchemaCatalog["mutableSequenceState"];
    right: DetailedSchemaCatalog["mutableSequenceState"];
  };
  ok: boolean;
  knownDifferences: DetailedSchemaDifference[];
  openConvergenceFindings: DetailedSchemaDifference[];
  unexpectedDifferences: DetailedSchemaDifference[];
}

type ApplicationCatalogSection = Exclude<
  DetailedCatalogSection,
  "ownership" | "extensions" | "extensionMembers" | "openFindings"
>;

const DETAILED_SECTIONS: readonly ApplicationCatalogSection[] = [
  "tables",
  "columns",
  "constraints",
  "indexes",
  "triggers",
  "internalTriggers",
  "functions",
  "sequences",
] as const;

function stableValue(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeDetailedText(value: unknown): string {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function detailedQuoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function roleToken(value: unknown, currentUser: string): string {
  const text = normalizeDetailedText(value);
  if (!text) return "";
  if (currentUser && text === currentUser) return "$CURRENT_USER";
  if (text === "PUBLIC") return "$PUBLIC";
  if (/^pg_[a-z0-9_]+$/i.test(text)) return `$BUILTIN_ROLE:${text}`;
  return `$ROLE_SHA256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function aclToken(value: unknown, currentUser: string): string {
  const text = normalizeDetailedText(value);
  if (!text) return "";
  const currentNormalized = currentUser ? text.split(currentUser).join("$CURRENT_USER") : text;
  return `$ACL_SHA256:${createHash("sha256").update(currentNormalized, "utf8").digest("hex")}`;
}

function registryScoped(entry: DetailedCatalogEntry): boolean {
  return entry.table === "schema_migrations"
    || entry.key === "schema_migrations"
    || entry.key.startsWith("schema_migrations:");
}

/**
 * Rich SELECT-only projection used only by the ephemeral PG18 characterization
 * gate.  It intentionally does not replace the v1 baseline projection above.
 */
export async function projectDetailedSchemaReadOnly(
  client: ReadOnlyCatalogClient,
  schema = "public",
): Promise<DetailedSchemaCatalog> {
  const { rows: metaRows } = await client.query<Record<string, unknown>>(
    `SELECT current_setting('server_version_num')::int AS version_num,
            current_setting('server_version') AS postgres_version,
            current_user AS current_user,
            pg_get_userbyid(d.datdba) AS database_owner,
            pg_get_userbyid(n.nspowner) AS schema_owner,
            COALESCE(n.nspacl::text, '') AS schema_acl
       FROM pg_database d
       JOIN pg_namespace n ON n.nspname = $1
      WHERE d.datname = current_database()`,
    [schema],
  );
  const meta = metaRows[0] ?? {};
  const currentUser = String(meta.current_user ?? "");
  const postgresMajor = Math.floor(Number(meta.version_num ?? 0) / 10000);

  const tables: DetailedCatalogEntry[] = [];
  const { rows: tableRows } = await client.query<Record<string, unknown>>(
    `SELECT c.relname AS table_name, c.relpersistence, c.relkind, c.relispartition,
            pg_get_partkeydef(c.oid) AS partition_key,
            COALESCE(parent_ns.nspname || '.' || parent.relname, '') AS partition_parent,
            c.relrowsecurity, c.relforcerowsecurity,
            pg_get_userbyid(c.relowner) AS owner,
            COALESCE(c.relacl::text, '') AS acl
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_inherits inh ON inh.inhrelid = c.oid
       LEFT JOIN pg_class parent ON parent.oid = inh.inhparent
       LEFT JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p')
      ORDER BY c.relname`,
    [schema],
  );
  for (const row of tableRows) {
    const name = String(row.table_name);
    tables.push({
      key: name,
      name,
      table: name,
      value: stableValue({
        persistence: row.relpersistence,
        kind: row.relkind,
        isPartition: row.relispartition,
        partitionKey: normalizeDetailedText(row.partition_key) || null,
        partitionParent: normalizeDetailedText(row.partition_parent) || null,
        rowLevelSecurity: row.relrowsecurity,
        forceRowLevelSecurity: row.relforcerowsecurity,
        owner: roleToken(row.owner, currentUser),
        acl: aclToken(row.acl, currentUser),
      }),
    });
  }

  const columns: DetailedCatalogEntry[] = [];
  const { rows: columnRows } = await client.query<Record<string, unknown>>(
    `SELECT c.relname AS table_name, a.attnum AS ordinal_position,
            a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS format_type,
            t.typname AS internal_type,
            format_type(COALESCE(NULLIF(t.typbasetype, 0), t.oid),
              CASE WHEN t.typbasetype <> 0 THEN t.typtypmod ELSE a.atttypmod END) AS base_type,
            a.atttypmod,
            ic.character_maximum_length, ic.numeric_precision, ic.numeric_scale,
            ic.datetime_precision, NOT a.attnotnull AS is_nullable,
            pg_get_expr(ad.adbin, ad.adrelid, true) AS default_expr,
            a.attidentity, a.attgenerated,
            coll.collname AS collation
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       LEFT JOIN pg_collation coll ON coll.oid = a.attcollation AND a.attcollation <> 0
       LEFT JOIN information_schema.columns ic
         ON ic.table_schema = n.nspname
        AND ic.table_name = c.relname
        AND ic.column_name = a.attname
      WHERE n.nspname = $1
        AND c.relkind IN ('r','p')
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    [schema],
  );
  for (const row of columnRows) {
    const table = String(row.table_name);
    const name = String(row.column_name);
    columns.push({
      key: `${table}.${name}`,
      table,
      name,
      value: stableValue({
        ordinal: Number(row.ordinal_position),
        formatType: normalizeDetailedText(row.format_type),
        internalType: normalizeDetailedText(row.internal_type),
        baseType: normalizeDetailedText(row.base_type),
        typeModifier: Number(row.atttypmod ?? -1),
        characterMaximumLength: row.character_maximum_length ?? null,
        numericPrecision: row.numeric_precision ?? null,
        numericScale: row.numeric_scale ?? null,
        datetimePrecision: row.datetime_precision ?? null,
        nullable: Boolean(row.is_nullable),
        default: normalizeDetailedText(row.default_expr) || null,
        identity: normalizeDetailedText(row.attidentity),
        generated: normalizeDetailedText(row.attgenerated),
        collation: normalizeDetailedText(row.collation) || null,
      }),
    });
  }

  const constraints: DetailedCatalogEntry[] = [];
  const { rows: constraintRows } = await client.query<Record<string, unknown>>(
    `SELECT rel.relname AS table_name, c.conname, c.contype::text AS contype,
            pg_get_constraintdef(c.oid, true) AS definition,
            c.confupdtype::text AS update_action,
            c.confdeltype::text AS delete_action,
            c.confmatchtype::text AS match_type,
            c.convalidated, c.condeferrable, c.condeferred, c.conislocal, c.coninhcount, c.connoinherit,
            COALESCE(
              (SELECT string_agg(att.attname, ',' ORDER BY ord.pos)
                 FROM unnest(c.conkey) WITH ORDINALITY AS ord(attnum, pos)
                 JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = ord.attnum),
              ''
            ) AS columns,
            COALESCE(refn.nspname, '') AS referenced_schema,
            COALESCE(ref.relname, '') AS referenced_table,
            COALESCE(
              (SELECT string_agg(att.attname, ',' ORDER BY ord.pos)
                 FROM unnest(c.confkey) WITH ORDINALITY AS ord(attnum, pos)
                 JOIN pg_attribute att ON att.attrelid = c.confrelid AND att.attnum = ord.attnum),
              ''
            ) AS referenced_columns
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       JOIN pg_class rel ON rel.oid = c.conrelid
       LEFT JOIN pg_class ref ON ref.oid = c.confrelid
       LEFT JOIN pg_namespace refn ON refn.oid = ref.relnamespace
      WHERE n.nspname = $1
      ORDER BY rel.relname, c.conname`,
    [schema],
  );
  for (const row of constraintRows) {
    const table = String(row.table_name);
    const name = String(row.conname);
    constraints.push({
      key: `${table}:${name}`,
      table,
      name,
      value: stableValue({
        type: row.contype,
        definition: normalizeDetailedText(row.definition),
        columns: normalizeDetailedText(row.columns),
        referencedSchema: normalizeDetailedText(row.referenced_schema),
        referencedTable: normalizeDetailedText(row.referenced_table),
        referencedColumns: normalizeDetailedText(row.referenced_columns),
        updateAction: row.update_action,
        deleteAction: row.delete_action,
        matchType: row.match_type,
        validated: row.convalidated,
        deferrable: row.condeferrable,
        initiallyDeferred: row.condeferred,
        local: row.conislocal,
        inheritedCount: Number(row.coninhcount ?? 0),
        noInherit: row.connoinherit,
      }),
    });
  }

  const indexes: DetailedCatalogEntry[] = [];
  const { rows: indexRows } = await client.query<Record<string, unknown>>(
    `SELECT tbl.relname AS table_name, idx.relname AS index_name, am.amname AS access_method,
            i.indisunique, i.indisprimary, i.indisvalid, i.indisready, i.indislive,
            i.indnkeyatts, i.indnatts,
            pg_get_indexdef(i.indexrelid) AS definition,
            pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
            COALESCE(con.conname, '') AS constraint_name,
            COALESCE(
              (SELECT string_agg(opc.opcname, ',' ORDER BY ord.pos)
                 FROM unnest(i.indclass) WITH ORDINALITY AS ord(opcoid, pos)
                 JOIN pg_opclass opc ON opc.oid = ord.opcoid),
              ''
            ) AS opclasses,
            COALESCE(
              (SELECT string_agg(COALESCE(coll.collname, ''), ',' ORDER BY ord.pos)
                 FROM unnest(i.indcollation) WITH ORDINALITY AS ord(colloid, pos)
                 LEFT JOIN pg_collation coll ON coll.oid = ord.colloid),
              ''
            ) AS collations
       FROM pg_index i
       JOIN pg_class idx ON idx.oid = i.indexrelid
       JOIN pg_class tbl ON tbl.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = tbl.relnamespace
       JOIN pg_am am ON am.oid = idx.relam
       LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
      WHERE n.nspname = $1
      ORDER BY tbl.relname, idx.relname`,
    [schema],
  );
  for (const row of indexRows) {
    const table = String(row.table_name);
    const name = String(row.index_name);
    indexes.push({
      key: `${table}:${name}`,
      table,
      name,
      value: stableValue({
        accessMethod: row.access_method,
        unique: row.indisunique,
        primary: row.indisprimary,
        valid: row.indisvalid,
        ready: row.indisready,
        live: row.indislive,
        keyAttributes: Number(row.indnkeyatts ?? 0),
        totalAttributes: Number(row.indnatts ?? 0),
        definition: normalizeDetailedText(row.definition),
        predicate: normalizeDetailedText(row.predicate) || null,
        constraint: normalizeDetailedText(row.constraint_name) || null,
        opclasses: normalizeDetailedText(row.opclasses),
        collations: normalizeDetailedText(row.collations),
      }),
    });
  }

  const triggers: DetailedCatalogEntry[] = [];
  const internalTriggers: DetailedCatalogEntry[] = [];
  const { rows: triggerRows } = await client.query<Record<string, unknown>>(
    `SELECT rel.relname AS table_name, t.tgname AS trigger_name,
            pg_get_triggerdef(t.oid, true) AS definition,
            t.tgenabled::text AS enabled, t.tgisinternal, t.tgtype::int AS trigger_type,
            pn.nspname AS function_schema, p.proname AS function_name,
            COALESCE(con.conname, '') AS constraint_name,
            pg_get_function_identity_arguments(p.oid) AS function_arguments
       FROM pg_trigger t
       JOIN pg_class rel ON rel.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
       JOIN pg_namespace pn ON pn.oid = p.pronamespace
       LEFT JOIN pg_constraint con ON con.oid = t.tgconstraint
       WHERE n.nspname = $1
       ORDER BY rel.relname, t.tgname`,
    [schema],
  );
  for (const row of triggerRows) {
    const table = String(row.table_name);
    const name = String(row.trigger_name);
    const internal = Boolean(row.tgisinternal);
    const functionIdentity = `${normalizeDetailedText(row.function_schema)}.${normalizeDetailedText(row.function_name)}`
      + `(${normalizeDetailedText(row.function_arguments)})`;
    const normalizedDefinition = internal
      ? normalizeDetailedText(row.definition).replace(/RI_ConstraintTrigger_[a-z]_\d+/g, "$INTERNAL_TRIGGER")
      : normalizeDetailedText(row.definition);
    const target = internal ? internalTriggers : triggers;
    target.push({
      key: internal
        ? `${table}:${normalizeDetailedText(row.constraint_name)}:${functionIdentity}:${Number(row.trigger_type)}`
        : `${table}:${name}`,
      table,
      name: internal ? "$INTERNAL_TRIGGER" : name,
      value: stableValue({
        definition: normalizedDefinition,
        enabled: row.enabled,
        internal,
        constraint: normalizeDetailedText(row.constraint_name) || null,
        function: functionIdentity,
      }),
    });
  }

  const functions: DetailedCatalogEntry[] = [];
  const { rows: functionRows } = await client.query<Record<string, unknown>>(
    `SELECT p.proname AS function_name,
            pg_get_function_identity_arguments(p.oid) AS identity_arguments,
            pg_get_function_result(p.oid) AS result_type,
            l.lanname AS language,
            p.provolatile::text AS volatility,
            p.proisstrict, p.prosecdef, p.proparallel::text AS parallel_safety,
            COALESCE(array_to_string(p.proconfig, ','), '') AS configuration,
            p.prosrc AS body,
            pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = $1
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
           WHERE d.classid = 'pg_proc'::regclass
             AND d.objid = p.oid
             AND d.deptype = 'e'
        )
      ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)`,
    [schema],
  );
  for (const row of functionRows) {
    const name = String(row.function_name);
    const args = normalizeDetailedText(row.identity_arguments);
    functions.push({
      key: `${name}(${args})`,
      name,
      value: stableValue({
        resultType: normalizeDetailedText(row.result_type),
        language: row.language,
        volatility: row.volatility,
        strict: row.proisstrict,
        securityDefiner: row.prosecdef,
        parallelSafety: row.parallel_safety,
        configuration: normalizeDetailedText(row.configuration),
        body: normalizeDetailedText(row.body),
        definition: normalizeDetailedText(row.definition),
      }),
    });
  }

  const sequences: DetailedCatalogEntry[] = [];
  const { rows: sequenceRows } = await client.query<Record<string, unknown>>(
    `SELECT s.sequencename AS sequence_name, s.data_type::text AS data_type,
            s.start_value, s.min_value, s.max_value, s.increment_by,
            s.cycle, s.cache_size, s.sequenceowner AS owner,
            COALESCE(seq.relacl::text, '') AS acl,
            COALESCE(dep_table.relname, '') AS owned_table,
            COALESCE(dep_att.attname, '') AS owned_column,
            COALESCE(dep.deptype::text, '') AS dependency_type,
            COALESCE(default_link.table_name, '') AS default_table,
            COALESCE(default_link.column_name, '') AS default_column,
            COALESCE(default_link.default_expression, '') AS default_expression
       FROM pg_sequences s
       JOIN pg_class seq ON seq.relname = s.sequencename
       JOIN pg_namespace n ON n.oid = seq.relnamespace AND n.nspname = s.schemaname
       LEFT JOIN LATERAL (
         SELECT d.refobjid, d.refobjsubid, d.deptype
           FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass
            AND d.objid = seq.oid
            AND d.deptype IN ('a', 'i')
          ORDER BY d.deptype
          LIMIT 1
       ) dep ON true
       LEFT JOIN pg_class dep_table ON dep_table.oid = dep.refobjid
       LEFT JOIN pg_attribute dep_att
         ON dep_att.attrelid = dep.refobjid
         AND dep_att.attnum = dep.refobjsubid
       LEFT JOIN LATERAL (
         SELECT dc.relname AS table_name, da.attname AS column_name,
                pg_get_expr(ad.adbin, ad.adrelid, true) AS default_expression
           FROM pg_depend dd
           JOIN pg_attrdef ad ON dd.classid = 'pg_attrdef'::regclass AND ad.oid = dd.objid
           JOIN pg_class dc ON dc.oid = ad.adrelid
           JOIN pg_attribute da ON da.attrelid = ad.adrelid AND da.attnum = ad.adnum
          WHERE dd.refclassid = 'pg_class'::regclass
            AND dd.refobjid = seq.oid
          ORDER BY dc.relname, da.attname
          LIMIT 1
       ) default_link ON true
      WHERE s.schemaname = $1
      ORDER BY s.sequencename`,
    [schema],
  );
  for (const row of sequenceRows) {
    const name = String(row.sequence_name);
    sequences.push({
      key: name,
      name,
      value: stableValue({
        dataType: row.data_type,
        start: String(row.start_value ?? ""),
        min: String(row.min_value ?? ""),
        max: String(row.max_value ?? ""),
        increment: String(row.increment_by ?? ""),
        cycle: row.cycle,
        cache: String(row.cache_size ?? ""),
        owner: roleToken(row.owner, currentUser),
        acl: aclToken(row.acl, currentUser),
        ownedTable: normalizeDetailedText(row.owned_table) || null,
        ownedColumn: normalizeDetailedText(row.owned_column) || null,
        dependencyType: normalizeDetailedText(row.dependency_type) || null,
        defaultTable: normalizeDetailedText(row.default_table) || null,
        defaultColumn: normalizeDetailedText(row.default_column) || null,
        defaultExpression: normalizeDetailedText(row.default_expression) || null,
      }),
    });
  }

  const mutableSequenceState: DetailedSchemaCatalog["mutableSequenceState"] = [];
  for (const row of sequenceRows) {
    const name = String(row.sequence_name);
    const { rows } = await client.query<{ last_value: string; is_called: boolean }>(
      `SELECT last_value::text, is_called FROM ${detailedQuoteIdentifier(schema)}.${detailedQuoteIdentifier(name)}`,
    );
    if (rows[0]) {
      mutableSequenceState.push({ key: name, lastValue: rows[0].last_value, isCalled: rows[0].is_called });
    }
  }

  const { rows: extensionRows } = await client.query<Record<string, unknown>>(
    `SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema
       FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
      ORDER BY e.extname`,
  );
  const extensions = extensionRows.map((row) => ({
    name: String(row.name),
    version: String(row.version),
    schema: String(row.schema),
  }));
  const { rows: extensionMemberRows } = await client.query<Record<string, unknown>>(
    `SELECT e.extname AS extension_name,
            pg_describe_object(d.classid, d.objid, d.objsubid) AS member_identity
       FROM pg_depend d
       JOIN pg_extension e ON e.oid = d.refobjid
      WHERE d.deptype = 'e'
      ORDER BY e.extname, member_identity`,
  );
  const extensionMembers: DetailedCatalogEntry[] = extensionMemberRows.map((row) => {
    const extension = String(row.extension_name);
    const identity = normalizeDetailedText(row.member_identity);
    return {
      key: `${extension}:${identity}`,
      name: identity,
      value: stableValue({ extension, identity }),
    };
  });

  const { rows: registryPresence } = await client.query<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${schema}.schema_migrations`],
  );
  const registry: MigrationRegistryEvidence = { present: Boolean(registryPresence[0]?.present), rows: [] };
  if (registry.present) {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT version, name, checksum, adopted
         FROM ${schema === "public" ? "public" : '"' + schema.replace(/"/g, '""') + '"'}.schema_migrations
        ORDER BY version`,
    );
    registry.rows = rows.map((row) => ({
      version: String(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
      adopted: Boolean(row.adopted),
    }));
  }

  const sortEntries = (entries: DetailedCatalogEntry[]) =>
    entries.sort((a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value));

  return {
    format: "aqlan-schema-ownership-catalog",
    formatVersion: 1,
    postgresMajor,
    postgresVersion: normalizeDetailedText(meta.postgres_version),
    ownership: {
      databaseOwner: roleToken(meta.database_owner, currentUser),
      schemaOwner: roleToken(meta.schema_owner, currentUser),
      schemaAcl: aclToken(meta.schema_acl, currentUser),
    },
    tables: sortEntries(tables),
    columns: sortEntries(columns),
    constraints: sortEntries(constraints),
    indexes: sortEntries(indexes),
    triggers: sortEntries(triggers),
    internalTriggers: sortEntries(internalTriggers),
    functions: sortEntries(functions),
    sequences: sortEntries(sequences),
    extensions,
    extensionMembers: sortEntries(extensionMembers),
    mutableSequenceState: mutableSequenceState.sort((a, b) => a.key.localeCompare(b.key)),
    registry,
  };
}

function ownershipEntries(catalog: DetailedSchemaCatalog): DetailedCatalogEntry[] {
  return [
    { key: "databaseOwner", value: catalog.ownership.databaseOwner },
    { key: "schemaOwner", value: catalog.ownership.schemaOwner },
    { key: "schemaAcl", value: catalog.ownership.schemaAcl },
  ];
}

function compareEntrySets(
  section: DetailedCatalogSection,
  leftEntries: DetailedCatalogEntry[],
  rightEntries: DetailedCatalogEntry[],
  unexpectedDifferences: DetailedSchemaDifference[],
): boolean {
  let equal = true;
  const leftMap = new Map(leftEntries.map((entry) => [entry.key, entry]));
  const rightMap = new Map(rightEntries.map((entry) => [entry.key, entry]));
  const keys = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();
  for (const key of keys) {
    const left = leftMap.get(key);
    const right = rightMap.get(key);
    if (left?.value === right?.value) continue;
    equal = false;
    unexpectedDifferences.push({
      section,
      key,
      kind: !left ? "missing_left" : !right ? "missing_right" : "definition_mismatch",
      left: left?.value,
      right: right?.value,
    });
  }
  return equal;
}

export function compareDetailedSchemaCatalogs(
  left: DetailedSchemaCatalog,
  right: DetailedSchemaCatalog,
): DetailedSchemaComparison {
  const unexpectedDifferences: DetailedSchemaDifference[] = [];

  for (const section of DETAILED_SECTIONS) {
    const leftMap = new Map(
      left[section].filter((entry) => !registryScoped(entry)).map((entry) => [entry.key, entry]),
    );
    const rightMap = new Map(
      right[section].filter((entry) => !registryScoped(entry)).map((entry) => [entry.key, entry]),
    );
    const keys = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();
    for (const key of keys) {
      const l = leftMap.get(key);
      const r = rightMap.get(key);
      if (!l) {
        unexpectedDifferences.push({ section, key, kind: "missing_left", right: r?.value });
        continue;
      }
      if (!r) {
        unexpectedDifferences.push({ section, key, kind: "missing_right", left: l.value });
        continue;
      }
      if (l.value === r.value) continue;
      const difference: DetailedSchemaDifference = {
        section,
        key,
        kind: "definition_mismatch",
        left: l.value,
        right: r.value,
      };
      unexpectedDifferences.push(difference);
    }
  }

  const applicationUnexpectedCount = unexpectedDifferences.length;
  const ownershipEqual = compareEntrySets(
    "ownership",
    ownershipEntries(left),
    ownershipEntries(right),
    unexpectedDifferences,
  );
  const extensionsEqual = compareEntrySets(
    "extensions",
    left.extensions.map((entry) => ({ key: entry.name, value: stableValue(entry) })),
    right.extensions.map((entry) => ({ key: entry.name, value: stableValue(entry) })),
    unexpectedDifferences,
  );
  const extensionMembersEqual = compareEntrySets(
    "extensionMembers",
    left.extensionMembers,
    right.extensionMembers,
    unexpectedDifferences,
  );
  const extensionProvenanceEqual = extensionsEqual && extensionMembersEqual;

  const characterizationOk = unexpectedDifferences.length === 0;

  return {
    ok: characterizationOk,
    characterizationOk,
    applicationSchemaEqual: applicationUnexpectedCount === 0,
    ownershipEqual,
    extensionProvenanceEqual,
    openFindingSetMatches: false,
    openFindingsManifestMatch: false,
    rawDifferences: [...unexpectedDifferences],
    registryDifference: {
      equal: stableValue(left.registry) === stableValue(right.registry),
      left: left.registry,
      right: right.registry,
    },
    mutableSequenceState: {
      left: left.mutableSequenceState,
      right: right.mutableSequenceState,
    },
    knownDifferences: [],
    openConvergenceFindings: [],
    unexpectedDifferences,
  };
}

/**
 * Schema-only artifact helper.  Catalog rows contain no application data and
 * user/owner names are replaced by stable tokens during projection.
 */
export function schemaOwnershipArtifactCatalog(catalog: DetailedSchemaCatalog): DetailedSchemaCatalog {
  return JSON.parse(JSON.stringify(catalog)) as DetailedSchemaCatalog;
}
