import { createHash } from "node:crypto";
import { projectDetailedSchemaReadOnly, type ReadOnlyCatalogClient, type DetailedSchemaCatalog } from "./schema-manifest";
import type { MigrationFile } from "./migration-files";

export interface SchemaRegistrationPreflight {
  registryExists: boolean;
  versions: string[];
  adoptedVersions: string[];
}

/**
 * فحص إنتاجي منخفض الأثر — SELECT فقط.
 *
 * لا ينشئ schema_migrations إن كان غائبًا، ولا يشغّل baseline probe ولا أي DDL.
 * الهدف في Final Production Activation هو معرفة هل قاعدة التشغيل دخلت نظام
 * الهجرات المُرقّمة قبل تعطيل ensureSchema التراكمي.
 */
export async function readSchemaRegistrationPreflight(
  pool: ReadOnlyCatalogClient,
): Promise<SchemaRegistrationPreflight> {
  const { rows: registry } = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  if (!registry[0]?.exists) {
    return { registryExists: false, versions: [], adoptedVersions: [] };
  }

  const { rows } = await pool.query<{ version: string; adopted: boolean }>(
    "SELECT version, adopted FROM schema_migrations ORDER BY version",
  );
  return {
    registryExists: true,
    versions: rows.map((row) => row.version),
    adoptedVersions: rows.filter((row) => Boolean(row.adopted)).map((row) => row.version),
  };
}

let preflightLogged = false;

/**
 * يطبع مرة واحدة فقط إلى سجل التشغيل، ولا يغيّر جواب /api/health ولا يعرّض
 * التفاصيل للعميل. لا يعمل إلا عند تفعيل العلم الصريح في بيئة إنتاجية.
 */
export async function logSchemaRegistrationPreflightOnce(pool: ReadOnlyCatalogClient): Promise<void> {
  const production =
    process.env.NODE_ENV === "production"
    || process.env.DATABASE_ENVIRONMENT === "production"
    || Boolean(process.env.RAILWAY_PROJECT_ID);
  if (!production || process.env.SCHEMA_PREFLIGHT_LOG_ONCE !== "true" || preflightLogged) return;

  preflightLogged = true;
  try {
    const status = await readSchemaRegistrationPreflight(pool);
    console.info(
      `[schema-preflight] registry=${status.registryExists ? "present" : "absent"} `
      + `versions=${status.versions.join(",") || "none"} `
      + `adopted=${status.adoptedVersions.join(",") || "none"}`,
    );
  } catch (error) {
    console.warn(
      `[schema-preflight] read-only preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface SchemaPreflightReport {
  format: "aqlan-read-only-schema-preflight";
  formatVersion: 1;
  postgresMajor: number;
  transaction: { readOnly: true; isolation: "repeatable read" };
  catalog: Record<string, { count: number; sha256: string }>;
  registry: {
    present: boolean;
    registeredCount: number;
    adoptedVersions: string[];
    missingVersions: string[];
    unknownVersions: string[];
    checksumMismatches: string[];
    nameMismatches: string[];
    matchesFiles: boolean;
  };
  // Observations are never permission to adopt a baseline or retire runtime DDL.
  adoptionAssessment: "NOT_PERFORMED";
  schemaEquivalence: "NOT_ASSESSED";
}

export type PreflightErrorCode =
  | "PROVENANCE_INVALID" | "PG_VERSION_UNSUPPORTED" | "READ_ONLY_NOT_ENFORCED"
  | "PUBLIC_SCHEMA_MISSING" | "REGISTRY_RELATION_INVALID" | "REGISTRY_COLUMNS_INVALID" | "REGISTRY_ROWS_INVALID"
  | "DATABASE_URL_REQUIRED" | "POSTGRES_TARGET_REQUIRED" | "CONNECTION_OPTIONS_INVALID"
  | "REMOTE_CLASSIFICATION_REQUIRED" | "TARGET_CLASSIFICATION_INVALID" | "TLS_POLICY_REJECTED"
  | "CLI_ARGUMENTS_INVALID" | "MIGRATION_FILES_INVALID" | "CLIENT_TIMEOUT" | "CLEANUP_TIMEOUT";

export class SchemaPreflightError extends Error {
  constructor(public readonly code: PreflightErrorCode, message: string) { super(message); }
}

function summarizeCatalog(catalog: DetailedSchemaCatalog): SchemaPreflightReport["catalog"] {
  const result: SchemaPreflightReport["catalog"] = {};
  for (const section of ["tables", "columns", "constraints", "indexes", "triggers",
    "internalTriggers", "functions", "sequences", "extensions", "extensionMembers"] as const) {
    const entries = catalog[section];
    result[section] = {
      count: entries.length,
      sha256: createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex"),
    };
  }
  result.ownership = {
    count: Object.keys(catalog.ownership).length,
    sha256: createHash("sha256").update(JSON.stringify(catalog.ownership), "utf8").digest("hex"),
  };
  return result;
}

/**
 * A dedicated, idle connection is required. PostgreSQL enforces read-only mode;
 * the shared catalog projector performs SELECTs only. No application row reads,
 * sequence-value reads, runtime initialization, migrationStatus or DDL probe.
 * Errors propagate with no partial success report; the CLI redacts their text.
 */
export async function inspectSchemaReadOnly(
  client: ReadOnlyCatalogClient,
  files: Pick<MigrationFile, "version" | "name" | "checksum">[],
): Promise<SchemaPreflightReport> {
  if (!files.length || new Set(files.map((file) => file.version)).size !== files.length) {
    throw new SchemaPreflightError("PROVENANCE_INVALID", "Invalid migration provenance.");
  }
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL search_path = pg_catalog");
    await client.query("SET LOCAL row_security = off");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
    const { rows } = await client.query<{ read_only: string; isolation: string; version: number }>(
      `SELECT current_setting('transaction_read_only') AS read_only,
              current_setting('transaction_isolation') AS isolation,
              current_setting('server_version_num')::int AS version`,
    );
    if (Math.floor(Number(rows[0]?.version) / 10000) !== 18) {
      throw new SchemaPreflightError("PG_VERSION_UNSUPPORTED", "Preflight requires PostgreSQL 18.");
    }
    if (rows[0]?.read_only !== "on" || rows[0]?.isolation !== "repeatable read") {
      throw new SchemaPreflightError("READ_ONLY_NOT_ENFORCED", "An enforced read-only snapshot is required.");
    }
    await client.query("SET LOCAL transaction_timeout = '30s'");
    // A drifted/view-backed registry is not trusted provenance. Validate its
    // physical shape before the shared projector normalizes catalog values.
    const { rows: registryRelations } = await client.query<{ kind: string; rls: boolean }>(
      `SELECT c.relkind::text AS kind, c.relrowsecurity AS rls FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'schema_migrations'`,
    );
    if (registryRelations.length) {
      if (registryRelations.length !== 1 || registryRelations[0].kind !== "r" || registryRelations[0].rls) {
        throw new SchemaPreflightError("REGISTRY_RELATION_INVALID", "Invalid migration registry relation.");
      }
      const { rows: columns } = await client.query<{ name: string; type: string; required: boolean }>(
        `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS required
           FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = 'public.schema_migrations'::pg_catalog.regclass
            AND a.attnum > 0 AND NOT a.attisdropped`,
      );
      for (const [name, type] of [["version", "text"], ["name", "text"], ["checksum", "text"], ["adopted", "boolean"]]) {
        if (!columns.some((column) => column.name === name && column.type === type && column.required)) {
          throw new SchemaPreflightError("REGISTRY_COLUMNS_INVALID", "Invalid migration registry columns.");
        }
      }
    }
    const catalog = await projectDetailedSchemaReadOnly(client, "public", { includeMutableSequenceState: false });
    // A missing public schema must not masquerade as an empty, valid catalog.
    if (catalog.postgresMajor !== 18) throw new SchemaPreflightError("PUBLIC_SCHEMA_MISSING", "Public schema is unavailable.");
    const registered = new Map(catalog.registry.rows.map((row) => [row.version, row]));
    if (registered.size !== catalog.registry.rows.length || catalog.registry.rows.some((row) =>
      !/^\d{4}$/.test(row.version) || !/^[a-z0-9_]+$/.test(row.name) || !/^[a-f0-9]{64}$/.test(row.checksum))) {
      throw new SchemaPreflightError("REGISTRY_ROWS_INVALID", "Invalid migration registry rows.");
    }
    const expected = new Map(files.map((file) => [file.version, file]));
    const missingVersions = files.filter((file) => !registered.has(file.version)).map((file) => file.version);
    const unknownVersions = catalog.registry.rows.filter((row) => !expected.has(row.version)).map((row) => row.version);
    const checksumMismatches = catalog.registry.rows.filter((row) => {
      const file = expected.get(row.version);
      return file && file.checksum !== row.checksum;
    }).map((row) => row.version);
    const nameMismatches = catalog.registry.rows.filter((row) => {
      const file = expected.get(row.version);
      return file && file.name !== row.name;
    }).map((row) => row.version);
    const report: SchemaPreflightReport = {
      format: "aqlan-read-only-schema-preflight", formatVersion: 1, postgresMajor: catalog.postgresMajor,
      transaction: { readOnly: true, isolation: "repeatable read" },
      catalog: summarizeCatalog(catalog),
      registry: {
        present: catalog.registry.present, registeredCount: catalog.registry.rows.length,
        adoptedVersions: catalog.registry.rows.filter((row) => row.adopted).map((row) => row.version),
        missingVersions, unknownVersions, checksumMismatches, nameMismatches,
        matchesFiles: catalog.registry.present && !missingVersions.length && !unknownVersions.length
          && !checksumMismatches.length && !nameMismatches.length,
      },
      adoptionAssessment: "NOT_PERFORMED", schemaEquivalence: "NOT_ASSESSED",
    };
    await client.query("COMMIT");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
