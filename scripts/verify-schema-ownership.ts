import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { Client, Pool } from "pg";
import {
  compareDetailedSchemaCatalogs,
  projectDetailedSchemaReadOnly,
  schemaOwnershipArtifactCatalog,
  type DetailedSchemaCatalog,
} from "../lib/schema-manifest";
import { SUPPORTED_POSTGRES_MAJOR } from "../lib/env-contract";
import { validateLocalVerificationTarget } from "../lib/verification-target-policy.mjs";
import { loadMigrationFiles, migrate } from "../lib/migrations";
import { checksumOf } from "../lib/migration-files";
import { classifyOpenFindings, parseOpenFindingsManifest } from "../lib/schema-ownership-open-findings";

export const OPEN_FINDINGS_MANIFEST_PATH = fileURLToPath(new URL("../schema/schema-ownership-open-findings.pg18.json", import.meta.url));

const DB_PREFIX = "aqlan_schema_ownership_";
const DB_NAME_RE = /^aqlan_schema_ownership_[a-z0-9_]+$/;
export { RAILWAY_ENV_NAMES } from "../lib/verification-target-policy.mjs";

export interface OwnershipHarnessTarget {
  testUrl: URL;
  maintenanceUrl: URL;
}

export function validateOwnershipHarnessEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): OwnershipHarnessTarget {
  const testUrl = validateLocalVerificationTarget(environment.TEST_DATABASE_URL, environment, {
    varName: "TEST_DATABASE_URL",
    databaseName: "aqlan_p1_test",
    errorPrefix: "SCHEMA_OWNERSHIP_UNSAFE_TARGET",
  });

  const maintenanceUrl = new URL(testUrl.toString());
  maintenanceUrl.pathname = "/postgres";
  return { testUrl, maintenanceUrl };
}

export function validateGeneratedDatabaseName(name: string): void {
  if (!DB_NAME_RE.test(name)) {
    throw new Error(`SCHEMA_OWNERSHIP_UNSAFE_DATABASE_NAME: ${name}`);
  }
}

function quoteGeneratedDatabase(name: string): string {
  validateGeneratedDatabaseName(name);
  return `"${name}"`;
}

function databaseUrl(base: URL, name: string): string {
  validateGeneratedDatabaseName(name);
  const url = new URL(base.toString());
  url.pathname = `/${name}`;
  return url.toString();
}

function generatedNames(): { migrations: string; runtime: string } {
  const suffix = `${process.pid}_${Date.now().toString(36)}`.toLowerCase();
  const migrations = `${DB_PREFIX}migrations_${suffix}`;
  const runtime = `${DB_PREFIX}runtime_${suffix}`;
  validateGeneratedDatabaseName(migrations);
  validateGeneratedDatabaseName(runtime);
  return { migrations, runtime };
}

export function assertPostgres18VersionNum(versionNumRaw: string): number {
  const versionNum = Number(versionNumRaw);
  const major = Math.floor(versionNum / 10000);
  if (major !== SUPPORTED_POSTGRES_MAJOR) {
    throw new Error(`SCHEMA_OWNERSHIP_POSTGRES_MAJOR: expected ${SUPPORTED_POSTGRES_MAJOR}, got ${major || "unknown"}.`);
  }
  return major;
}

async function assertPg18(client: Client): Promise<{ major: number; version: string }> {
  const { rows } = await client.query<{ version_num: string; version: string }>(
    "SELECT current_setting('server_version_num') AS version_num, current_setting('server_version') AS version",
  );
  const major = assertPostgres18VersionNum(rows[0]?.version_num ?? "0");
  return { major, version: rows[0]?.version ?? "" };
}

export interface GeneratedDatabaseLifecycleClient {
  connect(): Promise<unknown>;
  query(queryText: string): Promise<unknown>;
  end(): Promise<void>;
}

export async function withGeneratedDatabasePair<T>(
  maintenance: GeneratedDatabaseLifecycleClient,
  names: { migrations: string; runtime: string },
  verifyServer: (client: GeneratedDatabaseLifecycleClient) => Promise<{ major: number; version: string }>,
  operation: (server: { major: number; version: string }) => Promise<T>,
  options: { template0?: boolean } = {},
): Promise<T> {
  validateGeneratedDatabaseName(names.migrations);
  validateGeneratedDatabaseName(names.runtime);
  let primaryFailure: unknown;
  let result: T | undefined;
  const cleanupFailures: unknown[] = [];
  let connected = false;
  try {
    await maintenance.connect();
    connected = true;
    const server = await verifyServer(maintenance);
    const template = options.template0 ? " TEMPLATE template0" : "";
    await maintenance.query(`CREATE DATABASE ${quoteGeneratedDatabase(names.migrations)}${template}`);
    await maintenance.query(`CREATE DATABASE ${quoteGeneratedDatabase(names.runtime)}${template}`);
    result = await operation(server);
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (connected) {
      for (const name of [names.migrations, names.runtime]) {
        try {
          await maintenance.query(`DROP DATABASE IF EXISTS ${quoteGeneratedDatabase(name)} WITH (FORCE)`);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    }
    try {
      await maintenance.end();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
      "SCHEMA_OWNERSHIP_CLEANUP_FAILED: generated database cleanup was incomplete.",
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  return result as T;
}

async function buildRuntimeSchemaAtValidatedUrl(url: string): Promise<void> {
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
  const mutableEnv = process.env as Record<string, string | undefined>;
  const previous = Object.fromEntries(managed.map((name) => [name, mutableEnv[name]]));
  try {
    mutableEnv.DATABASE_URL = url;
    delete mutableEnv.POSTGRES_URL;
    delete mutableEnv.POSTGRES_PRISMA_URL;
    delete mutableEnv.POSTGRES_URL_NON_POOLING;
    mutableEnv.DATABASE_ENVIRONMENT = "test";
    mutableEnv.NODE_ENV = "test";
    delete mutableEnv.USE_LOCAL_DB;
    mutableEnv.SKIP_SEED = "true";

    const db = await import("../lib/db");
    await db.resetPoolForTesting();
    await db.ensureSchema();
    await db.resetPoolForTesting();
  } finally {
    const db = await import("../lib/db");
    await db.resetPoolForTesting().catch(() => {});
    for (const name of managed) {
      const value = previous[name];
      if (value === undefined) delete mutableEnv[name];
      else mutableEnv[name] = value;
    }
  }
}

export async function initializeGeneratedRuntimeSchema(
  target: OwnershipHarnessTarget,
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const validated = validateOwnershipHarnessEnvironment(environment);
  validateGeneratedDatabaseName(name);
  if (validated.testUrl.toString() !== target.testUrl.toString()
    || validated.maintenanceUrl.toString() !== target.maintenanceUrl.toString()) {
    throw new Error("SCHEMA_OWNERSHIP_UNSAFE_TARGET: target was not derived from the supplied environment.");
  }
  await buildRuntimeSchemaAtValidatedUrl(databaseUrl(validated.testUrl, name));
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

export function assertExpectedMigrationChain(files: Awaited<ReturnType<typeof loadMigrationFiles>>): void {
  // Exact reviewed filenames, not a contiguous range of reserved branch numbers.
  // 0044–0050 are absent; keep 0001–0043 unchanged and append only reviewed files.
  const expectedFilenames = [
    "0001_baseline_schema.sql",
    "0002_confirmation_claim_ttl_index.sql",
    "0003_payment_idempotency_and_reversal.sql",
    "0004_material_rate_history.sql",
    "0005_financial_append_only.sql",
    "0006_appointment_lifecycle.sql",
    "0007_appointment_services_and_capacity.sql",
    "0008_appointment_chair_and_new_patient_snapshots.sql",
    "0009_waiting_list.sql",
    "0010_waiting_list_completion.sql",
    "0011_appointment_waiting_link.sql",
    "0012_doctor_commission_history.sql",
    "0013_supplier_payment_settlement.sql",
    "0014_shift_close_expected_difference.sql",
    "0015_saved_reports.sql",
    "0016_finance_controls.sql",
    "0017_stock_supplier_link.sql",
    "0018_patient_demographics.sql",
    "0019_audit_source.sql",
    "0020_expense_attachments.sql",
    "0021_patient_referrals.sql",
    "0022_patient_referral_source.sql",
    "0023_opening_balance_currency.sql",
    "0024_legacy_archive.sql",
    "0025_messaging_channels.sql",
    "0026_visit_currency.sql",
    "0027_medical_history.sql",
    "0028_patient_identity.sql",
    "0029_planned_visit_interval.sql",
    "0030_party_opening_balances.sql",
    "0031_journal_line_currency.sql",
    "0032_specialty_cases.sql",
    "0033_internal_referrals.sql",
    "0034_ortho_legacy_baseline.sql",
    "0035_commission_case_overrides.sql",
    "0036_visit_clearance.sql",
    "0037_patient_families.sql",
    "0038_legacy_balance_arrangements.sql",
    "0039_ortho_adjustment_billing_decision.sql",
    "0040_endodontics.sql",
    "0041_invoice_clinical_linkage.sql",
    "0042_legacy_treatment_agreements.sql",
    "0043_legacy_treatment_coverage.sql",
    "0051_ortho_treatment_strategy.sql",
  ] as const;
  const expected = expectedFilenames.map((filename) => filename.slice(0, 4));
  const actual = files.map((file) => file.version);
  if (files.length !== expectedFilenames.length || files.some((file, index) => {
    const filename = expectedFilenames[index];
    return file.filename !== filename || file.version !== filename.slice(0, 4)
      || file.name !== filename.slice(5, -4);
  })) {
    throw new Error(`SCHEMA_OWNERSHIP_MIGRATION_CHAIN: expected ${expected.join(",")}; got ${actual.join(",")}.`);
  }
  for (const file of files) {
    if (file.checksum !== checksumOf(file.sql)) {
      throw new Error(`SCHEMA_OWNERSHIP_MIGRATION_CHECKSUM: ${file.version}.`);
    }
  }
}

export function artifactContainsSensitiveText(serialized: string): boolean {
  return /(postgres(?:ql)?:\/\/|["']?(?:password|username|hostname|host|port)["']?\s*[=:]|TEST_DATABASE_URL|DATABASE_URL|POSTGRES_URL|POSTGRES_PRISMA_URL|POSTGRES_URL_NON_POOLING|RAILWAY_[A-Z0-9_]+|(?:127\.0\.0\.1|localhost):\d+|INSERT\s+INTO)/i.test(serialized);
}

export function parseOwnershipCliArgs(argv: string[]): string {
  if (argv.length === 0) return resolve("/tmp/aqlan-schema-ownership-report.json");
  if (argv.length !== 2 || argv[0] !== "--output" || !argv[1] || argv[1].startsWith("--")) {
    throw new Error("SCHEMA_OWNERSHIP_CLI: allowed arguments are exactly --output <path>.");
  }
  return resolve(argv[1]);
}

export function sourceCommitSha(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.SCHEMA_OWNERSHIP_SOURCE_COMMIT_SHA?.trim();
  if (explicit && /^[0-9a-f]{40}$/i.test(explicit)) return explicit.toLowerCase();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error("SCHEMA_OWNERSHIP_SOURCE_SHA: invalid git HEAD.");
  return head.toLowerCase();
}

export interface SchemaOwnershipReport {
  format: "aqlan-schema-ownership-characterization";
  formatVersion: 1;
  postgres: { major: number; version: string };
  sourceCommitSha: string;
  summary: {
    applicationSchemaEqual: boolean;
    characterizationOk: boolean;
    knownDifferences: number;
    openConvergenceFindings: number;
    unexpectedDifferences: number;
    openFindingsManifestMatch: boolean;
  };
  migrationProvenance: ReturnType<typeof migrationProvenance>;
  migrationRegistry: DetailedSchemaCatalog["registry"];
  comparison: ReturnType<typeof compareDetailedSchemaCatalogs>;
  migrationCatalog: DetailedSchemaCatalog;
  runtimeCatalog: DetailedSchemaCatalog;
  populatedStateCharacterization: Array<{
    finding: string;
    status: "PROVEN_BEHAVIOR" | "PROVEN_HAZARD" | "UNRESOLVED_FINDING";
    note: string;
  }>;
  assertions: {
    TD08A_COMPLETE: "NO";
    TD01A_COMPLETE: "NO";
    PRODUCTION_WRITES_ALLOWED: "NO";
  };
}

type PopulatedFinding = SchemaOwnershipReport["populatedStateCharacterization"][number];

async function characterizePopulatedState(
  target: OwnershipHarnessTarget,
  names: { migrations: string; runtime: string },
  files: Awaited<ReturnType<typeof loadMigrationFiles>>,
  environment: NodeJS.ProcessEnv,
): Promise<PopulatedFinding[]> {
  const migrationPool = new Pool({ connectionString: databaseUrl(target.testUrl, names.migrations), ssl: false });
  const runtimePool = new Pool({ connectionString: databaseUrl(target.testUrl, names.runtime), ssl: false });
  try {
    await migrationPool.query(
      "INSERT INTO material_rates (category, rate_bp, updated_by) VALUES ('schema-ownership-fixture', 1750, 'fixture')",
    );
    await migrationPool.query(files.find((file) => file.version === "0004")!.sql);
    const material = await migrationPool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM material_rate_history WHERE category = 'schema-ownership-fixture'",
    );

    const patient = await migrationPool.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name) VALUES ('SO-WAIT-1', 'Synthetic fixture') RETURNING id",
    );
    await migrationPool.query(
      "INSERT INTO waiting_list (patient_id, preferred_period) VALUES ($1, 'morning')",
      [patient.rows[0]!.id],
    );
    await migrationPool.query(files.find((file) => file.version === "0010")!.sql);
    const shift = await migrationPool.query<{ preferred_shift: string }>(
      "SELECT preferred_shift FROM waiting_list WHERE patient_id = $1",
      [patient.rows[0]!.id],
    );

    const runtimePatient = await runtimePool.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name) VALUES ('P-000123', 'Synthetic fixture') RETURNING id",
    );
    const runtimeShift = await runtimePool.query<{ id: number }>(
      "INSERT INTO cashier_shifts (opened_by) VALUES ('fixture') RETURNING id",
    );
    await runtimePool.query("INSERT INTO invoices (invoice_number, patient_id) VALUES ('INV-000456', $1)", [runtimePatient.rows[0]!.id]);
    await runtimePool.query(
      "INSERT INTO payments (receipt_number, patient_id, shift_id, amount_minor, currency, base_amount_minor) VALUES ('REC-000789', $1, $2, 100, 'YER', 100)",
      [runtimePatient.rows[0]!.id, runtimeShift.rows[0]!.id],
    );
    await runtimePool.query(
      "INSERT INTO expenses (voucher_number, category, shift_id, amount_minor, currency, base_amount_minor) VALUES ('VOU-000321', 'fixture', $1, 100, 'YER', 100)",
      [runtimeShift.rows[0]!.id],
    );
    const sequenceTargets = [
      ["patient_number_seq", 123],
      ["invoice_number_seq", 456],
      ["receipt_number_seq", 789],
      ["voucher_number_seq", 321],
    ] as const;
    const before = await Promise.all(sequenceTargets.map(async ([name, targetValue]) => {
      const result = await runtimePool.query<{ last_value: string }>(`SELECT last_value::text FROM ${name}`);
      return Number(result.rows[0]?.last_value ?? 0) < targetValue;
    }));
    await runtimePool.end();
    await initializeGeneratedRuntimeSchema(target, names.runtime, environment);
    const sequenceVerify = new Pool({ connectionString: databaseUrl(target.testUrl, names.runtime), ssl: false });
    const after = await Promise.all(sequenceTargets.map(async ([name, targetValue]) => {
      const result = await sequenceVerify.query<{ last_value: string }>(`SELECT last_value::text FROM ${name}`);
      return Number(result.rows[0]?.last_value ?? 0) === targetValue;
    }));

    const coldPatient = await sequenceVerify.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name) VALUES ('SO-COLD-1', 'Synthetic fixture') RETURNING id",
    );
    const services = await sequenceVerify.query<{ id: number }>(
      "INSERT INTO appointment_services (code, name_ar) VALUES ('so-fixture-a', 'Fixture A'), ('so-fixture-b', 'Fixture B') RETURNING id",
    );
    await sequenceVerify.query(
      "INSERT INTO waiting_list (patient_id, service_id) VALUES ($1, $2), ($1, $3)",
      [coldPatient.rows[0]!.id, services.rows[0]!.id, services.rows[1]!.id],
    );
    const waitingBefore = (await sequenceVerify.query(
      "SELECT * FROM waiting_list WHERE patient_id=$1 ORDER BY id", [coldPatient.rows[0]!.id],
    )).rows;
    await sequenceVerify.end();
    // Legitimate service-specific entries must survive every cold start. Keep
    // this a failing invariant, rather than accepting the old known hazard.
    await initializeGeneratedRuntimeSchema(target, names.runtime, environment);
    await initializeGeneratedRuntimeSchema(target, names.runtime, environment);
    const waitingVerify = new Pool({ connectionString: databaseUrl(target.testUrl, names.runtime), ssl: false });
    try {
      const waitingAfter = (await waitingVerify.query(
        "SELECT * FROM waiting_list WHERE patient_id=$1 ORDER BY id", [coldPatient.rows[0]!.id],
      )).rows;
      const { rows: obsolete } = await waitingVerify.query(
        "SELECT to_regclass('public.waiting_list_one_open_per_patient_idx') AS index_name",
      );
      if (JSON.stringify(waitingBefore) !== JSON.stringify(waitingAfter) || obsolete[0]?.index_name !== null) {
        throw new Error("SCHEMA_OWNERSHIP_WAITING_RESTART_MISMATCH: waiting rows or active uniqueness changed.");
      }
    } finally {
      await waitingVerify.end();
    }

    return [
      {
        finding: "material-rate-0004-backfill",
        status: material.rows[0]?.count === "1" ? "PROVEN_BEHAVIOR" : "UNRESOLVED_FINDING",
        note: "A synthetic current rate produced exactly one history row when migration 0004 was replayed.",
      },
      {
        finding: "preferred-period-to-shift-conversion",
        status: shift.rows[0]?.preferred_shift === "shift1" ? "PROVEN_BEHAVIOR" : "UNRESOLVED_FINDING",
        note: "A synthetic morning preference converted to shift1 under migration 0010.",
      },
      {
        finding: "business-number-sequence-state",
        status: before.every(Boolean) && after.every(Boolean) ? "PROVEN_BEHAVIOR" : "UNRESOLVED_FINDING",
        note: "All four business sequences lagged imported prefixed identifiers before runtime initialization and synchronized afterward.",
      },
      {
        finding: "waiting-list-obsolete-uniqueness-ordering",
        status: "PROVEN_BEHAVIOR",
        note: "Two service-specific open rows remain unchanged across repeated runtime initialization; the obsolete patient-only index remains absent.",
      },
    ];
  } finally {
    await Promise.allSettled([migrationPool.end(), runtimePool.end()]);
  }
}

export async function runSchemaOwnershipCharacterization(
  environment: NodeJS.ProcessEnv = process.env,
  options: { candidateOnly?: boolean } = {},
): Promise<SchemaOwnershipReport> {
  const target = validateOwnershipHarnessEnvironment(environment);
  const maintenance = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  const names = generatedNames();
  return withGeneratedDatabasePair(
    maintenance,
    names,
    async (client) => assertPg18(client as unknown as Client),
    async (server) => {
    const files = await loadMigrationFiles();
    assertExpectedMigrationChain(files);

    const migrationPool = new Pool({ connectionString: databaseUrl(target.testUrl, names.migrations), ssl: false });
    try {
      await migrate(migrationPool as any, { apply: true, files });
    } finally {
      await migrationPool.end();
    }

    await initializeGeneratedRuntimeSchema(target, names.runtime, environment);

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
        throw new Error(`SCHEMA_OWNERSHIP_REGISTRY_MISMATCH: ${item.version}.`);
      }
    }
    if (migrationCatalog.registry.rows.length !== provenance.length) {
      throw new Error("SCHEMA_OWNERSHIP_REGISTRY_MISMATCH: unexpected registry row count.");
    }

    const rawComparison = compareDetailedSchemaCatalogs(migrationCatalog, runtimeCatalog);
    let comparison = rawComparison;
    if (!options.candidateOnly) {
      const manifest = parseOpenFindingsManifest(JSON.parse(await readFile(OPEN_FINDINGS_MANIFEST_PATH, "utf8")));
      if (manifest.findings.length !== 16) throw new Error("OPEN_FINDINGS_MANIFEST_INVALID: expected exactly 16 reviewed findings.");
      comparison = classifyOpenFindings(rawComparison, manifest);
    }
    const populatedStateCharacterization = await characterizePopulatedState(target, names, files, environment);

    return {
      format: "aqlan-schema-ownership-characterization",
      formatVersion: 1,
      postgres: server,
      sourceCommitSha: sourceCommitSha(environment),
      summary: {
        applicationSchemaEqual: comparison.applicationSchemaEqual,
        characterizationOk: comparison.characterizationOk,
        knownDifferences: comparison.knownDifferences.length,
        openConvergenceFindings: comparison.openConvergenceFindings.length,
        unexpectedDifferences: comparison.unexpectedDifferences.length,
        openFindingsManifestMatch: comparison.openFindingsManifestMatch,
      },
      migrationProvenance: provenance,
      migrationRegistry: migrationCatalog.registry,
      comparison,
      migrationCatalog: schemaOwnershipArtifactCatalog(migrationCatalog),
      runtimeCatalog: schemaOwnershipArtifactCatalog(runtimeCatalog),
      populatedStateCharacterization,
      assertions: {
        TD08A_COMPLETE: "NO",
        TD01A_COMPLETE: "NO",
        PRODUCTION_WRITES_ALLOWED: "NO",
      },
    };
    },
  );
}

async function main(): Promise<void> {
  const output = parseOwnershipCliArgs(process.argv.slice(2));
  const report = await runSchemaOwnershipCharacterization();
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (artifactContainsSensitiveText(serialized)) {
    throw new Error("SCHEMA_OWNERSHIP_ARTIFACT_REDACTION: sensitive connection text detected.");
  }
  await writeFile(output, serialized, "utf8");
  console.log(`Schema ownership characterization written: ${output}`);
  console.log(`Unexpected differences: ${report.comparison.unexpectedDifferences.length}`);
  console.log(`Known differences: ${report.comparison.knownDifferences.length}`);
  console.log(`Open convergence findings: ${report.comparison.openConvergenceFindings.length}`);
  console.log(`Application schema equal: ${report.comparison.applicationSchemaEqual}`);
  if (!report.comparison.characterizationOk) {
    throw new Error("SCHEMA_OWNERSHIP_DRIFT: unexpected semantic schema differences detected.");
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
