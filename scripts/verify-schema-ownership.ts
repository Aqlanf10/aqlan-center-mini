import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Buffer } from "node:buffer";
import { Client, Pool } from "pg";
import {
  compareDetailedSchemaCatalogs,
  projectDetailedSchemaReadOnly,
  schemaOwnershipArtifactCatalog,
  type DetailedSchemaCatalog,
} from "../lib/schema-manifest";
import { SUPPORTED_POSTGRES_MAJOR, isLoopbackHost, looksLikeRailwayDatabaseHost } from "../lib/env-contract";
import { loadMigrationFiles, migrate } from "../lib/migrations";

const DB_PREFIX = "aqlan_schema_ownership_";
const DB_NAME_RE = /^aqlan_schema_ownership_[a-z0-9_]+$/;
const RAILWAY_ENV_NAMES = [
  "RAILWAY_PROJECT_ID",
  "RAILWAY_ENVIRONMENT_ID",
  "RAILWAY_SERVICE_ID",
  "RAILWAY_DEPLOYMENT_ID",
  "RAILWAY_PUBLIC_DOMAIN",
  "RAILWAY_PRIVATE_DOMAIN",
] as const;

export interface OwnershipHarnessTarget {
  testUrl: URL;
  maintenanceUrl: URL;
}

export function validateOwnershipHarnessEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): OwnershipHarnessTarget {
  const raw = environment.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error("SCHEMA_OWNERSHIP_UNSAFE_TARGET: TEST_DATABASE_URL is required.");

  if (environment.NODE_ENV === "production" || environment.DATABASE_ENVIRONMENT === "production") {
    throw new Error("SCHEMA_OWNERSHIP_UNSAFE_TARGET: production environment is forbidden.");
  }
  for (const name of RAILWAY_ENV_NAMES) {
    if (environment[name]?.trim()) {
      throw new Error(\`SCHEMA_OWNERSHIP_UNSAFE_TARGET: Railway runtime detected via \${name}.\`);
    }
  }

  let testUrl: URL;
  try {
    testUrl = new URL(raw);
  } catch {
    throw new Error("SCHEMA_OWNERSHIP_UNSAFE_TARGET: TEST_DATABASE_URL is not a valid URL.");
  }
  if (testUrl.protocol !== "postgresql:" && testUrl.protocol !== "postgres:") {
    throw new Error("SCHEMA_OWNERSHIP_UNSAFE_TARGET: PostgreSQL URL required.");
  }
  if (!isLoopbackHost(testUrl.hostname) || looksLikeRailwayDatabaseHost(testUrl.hostname)) {
    throw new Error("SCHEMA_OWNERSHIP_UNSAFE_TARGET: loopback PostgreSQL only.");
  }
  const configuredDb = decodeURIComponent(testUrl.pathname.replace(/^\/+/, ""));
  if (configuredDb !== "aqlan_p1_test") {
    throw new Error("SCHEMA_OWNERSHIP_UNSAFE_TARGET: TEST_DATABASE_URL must target aqlan_p1_test.");
  }

  const maintenanceUrl = new URL(testUrl.toString());
  maintenanceUrl.pathname = "/postgres";
  return { testUrl, maintenanceUrl };
}

export function validateGeneratedDatabaseName(name: string): void {
  if (!DB_NAME_RE.test(name)) {
    throw new Error(\`SCHEMA_OWNERSHIP_UNSAFE_DATABASE_NAME: \${name}\`);
  }
}

function quoteGeneratedDatabase(name: string): string {
  validateGeneratedDatabaseName(name);
  return \`"\${name}"\`;
}

function databaseUrl(base: URL, name: string): string {
  validateGeneratedDatabaseName(name);
  const url = new URL(base.toString());
  url.pathname = \`/\${name}\`;
  return url.toString();
}

function generatedNames(): { migrations: string; runtime: string } {
  const suffix = \`\${process.pid}_\${Date.now().toString(36)}\`.toLowerCase();
  const migrations = \`\${DB_PREFIX}migrations_\${suffix}\`;
  const runtime = \`\${DB_PREFIX}runtime_\${suffix}\`;
  validateGeneratedDatabaseName(migrations);
  validateGeneratedDatabaseName(runtime);
  return { migrations, runtime };
}

async function assertPg18(client: Client): Promise<{ major: number; version: string }> {
  const { rows } = await client.query<{ version_num: string; version: string }>(
    "SELECT current_setting('server_version_num') AS version_num, current_setting('server_version') AS version",
  );
  const versionNum = Number(rows[0]?.version_num ?? 0);
  const major = Math.floor(versionNum / 10000);
  if (major !== SUPPORTED_POSTGRES_MAJOR) {
    throw new Error(\`SCHEMA_OWNERSHIP_POSTGRES_MAJOR: expected \${SUPPORTED_POSTGRES_MAJOR}, got \${major || "unknown"}.\`);
  }
  return { major, version: rows[0]?.version ?? "" };
}

async function createDatabase(client: Client, name: string): Promise<void> {
  await client.query(\`CREATE DATABASE \${quoteGeneratedDatabase(name)}\`);
}

async function dropDatabase(client: Client, name: string): Promise<void> {
  await client.query(\`DROP DATABASE IF EXISTS \${quoteGeneratedDatabase(name)} WITH (FORCE)\`);
}

async function buildRuntimeSchema(url: string): Promise<void> {
  const managed = [
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NON_POOLING",
    "DATABASE_ENVIRONMENT",
    "NODE_ENV",
    "USE_LOCAL_DB",
    "SKIP_SEED",
  ] as const;
  const previous = Object.fromEntries(managed.map((name) => [name, process.env[name]]));
  try {
    process.env.DATABASE_URL = url;
    delete process.env.POSTGRES_URL;
    delete process.env.POSTGRES_PRISMA_URL;
    delete process.env.POSTGRES_URL_NON_POOLING;
    process.env.DATABASE_ENVIRONMENT = "test";
    process.env.NODE_ENV = "test";
    delete process.env.USE_LOCAL_DB;
    process.env.SKIP_SEED = "true";

    const db = await import("../lib/db");
    await db.resetPoolForTesting();
    await db.ensureSchema();
    await db.resetPoolForTesting();
  } finally {
    const db = await import("../lib/db");
    await db.resetPoolForTesting().catch(() => {});
    for (const name of managed) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

export function migrationProvenance(files: Awaited<ReturnType<typeof loadMigrationFiles>>) {
  return files.map((file) => ({
    version: file.version,
    name: file.name,
    filename: file.filename,
    checksum: file.checksum,
    utf8Bytes: Buffer.byteLength(file.sql, "utf8"),
  }));
}

function assertExpectedMigrationChain(files: Awaited<ReturnType<typeof loadMigrationFiles>>): void {
  const expected = Array.from({ length: 11 }, (_, index) => String(index + 1).padStart(4, "0"));
  const actual = files.map((file) => file.version);
  if (actual.join(",") !== expected.join(",")) {
    throw new Error(\`SCHEMA_OWNERSHIP_MIGRATION_CHAIN: expected \${expected.join(",")}; got \${actual.join(",")}.\`);
  }
}

export function artifactContainsSensitiveText(serialized: string): boolean {
  return /(postgres(?:ql)?:\/\/|password=|TEST_DATABASE_URL|DATABASE_URL|RAILWAY_PROJECT_ID)/i.test(serialized);
}

function parseOutputArg(argv: string[]): string {
  const index = argv.indexOf("--output");
  if (index >= 0 && argv[index + 1]) return resolve(argv[index + 1]);
  return resolve("/tmp/aqlan-schema-ownership-report.json");
}

export interface SchemaOwnershipReport {
  format: "aqlan-schema-ownership-characterization";
  formatVersion: 1;
  postgres: { major: number; version: string };
  commitSha: string | null;
  migrationProvenance: ReturnType<typeof migrationProvenance>;
  migrationRegistry: DetailedSchemaCatalog["registry"];
  comparison: ReturnType<typeof compareDetailedSchemaCatalogs>;
  migrationCatalog: DetailedSchemaCatalog;
  runtimeCatalog: DetailedSchemaCatalog;
  populatedStateCharacterization: Array<{ finding: string; status: "UNRESOLVED_FINDING"; note: string }>;
  assertions: {
    TD08A_COMPLETE: "NO";
    TD01A_COMPLETE: "NO";
    PRODUCTION_WRITES_ALLOWED: "NO";
  };
}

export async function runSchemaOwnershipCharacterization(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SchemaOwnershipReport> {
  const target = validateOwnershipHarnessEnvironment(environment);
  const maintenance = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  const names = generatedNames();
  let maintenanceConnected = false;

  try {
    await maintenance.connect();
    maintenanceConnected = true;
    const server = await assertPg18(maintenance);

    await createDatabase(maintenance, names.migrations);
    await createDatabase(maintenance, names.runtime);

    const files = await loadMigrationFiles();
    assertExpectedMigrationChain(files);

    const migrationPool = new Pool({ connectionString: databaseUrl(target.testUrl, names.migrations), ssl: false });
    try {
      await migrate(migrationPool as any, { apply: true, files });
    } finally {
      await migrationPool.end();
    }

    await buildRuntimeSchema(databaseUrl(target.testUrl, names.runtime));

    const migrationRead = new Pool({ connectionString: databaseUrl(target.testUrl, names.migrations), ssl: false });
    const runtimeRead = new Pool({ connectionString: databaseUrl(target.testUrl, names.runtime), ssl: false });
    let migrationCatalog: DetailedSchemaCatalog;
    let runtimeCatalog: DetailedSchemaCatalog;
    try {
      migrationCatalog = await projectDetailedSchemaReadOnly(migrationRead as any, "public");
      runtimeCatalog = await projectDetailedSchemaReadOnly(runtimeRead as any, "public");
    } finally {
      await Promise.all([migrationRead.end(), runtimeRead.end()]);
    }

    const provenance = migrationProvenance(files);
    const registryByVersion = new Map(migrationCatalog.registry.rows.map((row) => [row.version, row]));
    for (const item of provenance) {
      const row = registryByVersion.get(item.version);
      if (!row || row.name !== item.name || row.checksum !== item.checksum || row.adopted) {
        throw new Error(\`SCHEMA_OWNERSHIP_REGISTRY_MISMATCH: \${item.version}.\`);
      }
    }
    if (migrationCatalog.registry.rows.length !== provenance.length) {
      throw new Error("SCHEMA_OWNERSHIP_REGISTRY_MISMATCH: unexpected registry row count.");
    }

    const comparison = compareDetailedSchemaCatalogs(migrationCatalog, runtimeCatalog);

    return {
      format: "aqlan-schema-ownership-characterization",
      formatVersion: 1,
      postgres: server,
      commitSha: environment.GITHUB_SHA?.trim() || null,
      migrationProvenance: provenance,
      migrationRegistry: migrationCatalog.registry,
      comparison,
      migrationCatalog: schemaOwnershipArtifactCatalog(migrationCatalog),
      runtimeCatalog: schemaOwnershipArtifactCatalog(runtimeCatalog),
      populatedStateCharacterization: [
        {
          finding: "waiting-list-obsolete-uniqueness-ordering",
          status: "UNRESOLVED_FINDING",
          note: "Fresh-schema equality cannot prove populated cold-start/adoption behavior; isolated fixture remains required.",
        },
        {
          finding: "material-rate-0004-backfill",
          status: "UNRESOLVED_FINDING",
          note: "Fresh-schema equality does not prove historical repair/backfill semantics.",
        },
        {
          finding: "waiting-period-to-shift-conversion",
          status: "UNRESOLVED_FINDING",
          note: "Fresh-schema equality does not prove imported or pre-existing row transformation.",
        },
        {
          finding: "business-number-sequence-state",
          status: "UNRESOLVED_FINDING",
          note: "Sequence mutable state is intentionally excluded from schema identity and requires focused recovery fixtures.",
        },
      ],
      assertions: {
        TD08A_COMPLETE: "NO",
        TD01A_COMPLETE: "NO",
        PRODUCTION_WRITES_ALLOWED: "NO",
      },
    };
  } finally {
    if (maintenanceConnected) {
      await dropDatabase(maintenance, names.migrations).catch(() => {});
      await dropDatabase(maintenance, names.runtime).catch(() => {});
      await maintenance.end().catch(() => {});
    }
  }
}

async function main(): Promise<void> {
  const output = parseOutputArg(process.argv.slice(2));
  const report = await runSchemaOwnershipCharacterization();
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (artifactContainsSensitiveText(serialized)) {
    throw new Error("SCHEMA_OWNERSHIP_ARTIFACT_REDACTION: sensitive connection text detected.");
  }
  await writeFile(output, serialized, "utf8");
  console.log(\`Schema ownership characterization written: \${output}\`);
  console.log(\`Unexpected differences: \${report.comparison.unexpectedDifferences.length}\`);
  console.log(\`Known differences: \${report.comparison.knownDifferences.length}\`);
  if (!report.comparison.ok) {
    throw new Error("SCHEMA_OWNERSHIP_DRIFT: unexpected semantic schema differences detected.");
  }
}

if (import.meta.url === new URL(\`file://\${process.argv[1]}\`).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
