import { Client, Pool } from "pg";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
  assertRealPostgresUrl,
  createIsolatedDatabase,
  stubPostgresEnv,
} from "./_setup";
import {
  assertPostgres18VersionNum,
  initializeGeneratedRuntimeSchema,
  OPEN_FINDINGS_MANIFEST_PATH,
  runSchemaOwnershipCharacterization,
  validateOwnershipHarnessEnvironment,
  withGeneratedDatabasePair,
} from "../../scripts/verify-schema-ownership";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { candidateOpenFindingsManifest } from "../../lib/schema-ownership-open-findings";
import { COORDINATED_MIGRATION_VERSIONS } from "../../lib/migrations";
import committedContract from "../../schema/current-schema-contract.pg18.json";
import { assertPristineDisclosureDatabase } from "../../scripts/generate-preflight-disclosure";
import { introspectSchema, type SchemaContract } from "../../scripts/schema-introspect";
import { structuralDiffs } from "../../scripts/verify-schema-contract-drift";

// Test-local, source-only diagnostic framing. Never serialize an ownership
// report, connection, error object, environment, or application row here.
const DIAGNOSTIC_LIMIT = 1024 * 1024;
const DIAGNOSTIC_LINE_LIMIT = 4 * 1024;
let candidateEmitted = false;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function diagnosticRecord(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (keys && Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0"))) {
    throw new Error("SCHEMA_DIAGNOSTIC_INVALID_DTO");
  }
  return value as Record<string, unknown>;
}

async function emitSourceCandidate(candidate: SchemaContract, postgresVersionNum: number): Promise<void> {
  if (candidateEmitted) return;
  validateCandidate(candidate);
  // Preserve the generator DTO, ordering, arrays, counts and provenance exactly.
  const bytes = Buffer.from(JSON.stringify(candidate, null, 2) + "\n", "utf8");
  if (bytes.length === 0 || bytes.length > DIAGNOSTIC_LIMIT) throw new Error("SCHEMA_DIAGNOSTIC_SIZE_LIMIT");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const git = (args: string[]) => execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024,
  }).trim();
  let sourceCommit: string;
  let sourceTree: string;
  try {
    // HEAD is the actual checked-out commit (including an Actions merge commit),
    // never the optional ownership override or a caller-supplied claimed SHA.
    sourceCommit = git(["rev-parse", "--verify", "HEAD^{commit}"]);
    sourceTree = git(["rev-parse", "--verify", "HEAD^{tree}"]);
    git(["diff", "--quiet", "HEAD", "--"]);
    if (git(["ls-files", "--others", "--", "lib", "scripts", "migrations", "schema", "__tests__/postgres/schema-ownership.test.ts"])) {
      throw new Error("untracked source");
    }
  } catch { throw new Error("SCHEMA_DIAGNOSTIC_SOURCE_UNVERIFIED"); }
  const run = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  if (!/^[0-9a-f]{40}$/.test(sourceCommit) || !/^[0-9a-f]{40}$/.test(sourceTree)
    || !run || !/^[1-9][0-9]{0,19}$/.test(run) || !attempt || !/^[1-9][0-9]{0,9}$/.test(attempt)
    || !Number.isSafeInteger(postgresVersionNum) || Math.floor(postgresVersionNum / 10000) !== 18) {
    throw new Error("SCHEMA_DIAGNOSTIC_METADATA_INVALID");
  }
  const provenance = (await loadMigrationFiles()).map(({ version, name, filename, checksum, sql }) => {
    if (!/^[0-9]{4}$/.test(version) || !/^[a-z0-9_]{1,160}$/.test(name)
      || filename !== `${version}_${name}.sql` || !/^[0-9a-f]{64}$/.test(checksum)
      || checksum !== sha256(sql)) throw new Error("SCHEMA_DIAGNOSTIC_METADATA_INVALID");
    return { version, name, filename, checksum, utf8Bytes: Buffer.byteLength(sql, "utf8") };
  });
  if (provenance.length === 0 || provenance.length > 256) throw new Error("SCHEMA_DIAGNOSTIC_SIZE_LIMIT");
  const sourceFiles = [
    "lib/db.ts", "lib/migration-files.ts", "lib/migrations.ts", "lib/schema-manifest.ts", "lib/schema-fingerprint.ts",
    "lib/verification-target-policy.mjs", "scripts/schema-introspect.ts", "scripts/generate-preflight-disclosure.ts",
    "scripts/verify-schema-ownership.ts", "scripts/verify-schema-contract-drift.ts", "__tests__/postgres/schema-ownership.test.ts",
  ];
  const sourceHashes = Object.fromEntries(sourceFiles.map((path) => [path, sha256(readFileSync(new URL(`../../${path}`, import.meta.url)))]));
  const digest = sha256(bytes);
  const migrationProvenanceSha256 = sha256(JSON.stringify(provenance));
  const id = sha256(JSON.stringify(["current-schema-contract", sourceCommit, run, attempt, digest]));
  const chunks = Array.from({ length: Math.ceil(bytes.length / 2048) }, (_, index) => bytes.subarray(index * 2048, (index + 1) * 2048));
  if (!Buffer.concat(chunks).equals(bytes)) throw new Error("SCHEMA_DIAGNOSTIC_INCOMPLETE");
  const marker = "AQLAN_SOURCE_SCHEMA_CANDIDATE_V1";
  const frames = [
    { marker, kind: "begin", id, format: "aqlan-source-schema-diagnostic", formatVersion: 1,
      candidate: "current-schema-contract", encoding: "base64", sourceCommit, sourceTree, run, attempt,
      postgresVersionNum, sourceHashes, migrationCount: provenance.length, migrationProvenanceSha256,
      utf8Bytes: bytes.length, sha256: digest, chunkCount: chunks.length },
    ...provenance.map((migration, index) => ({ marker, kind: "migration", id, index, ...migration })),
    ...chunks.map((chunk, index) => ({ marker, kind: "chunk", id, index, utf8Bytes: chunk.length,
      sha256: sha256(chunk), base64: chunk.toString("base64") })),
    { marker, kind: "end", id, utf8Bytes: bytes.length, sha256: digest, chunkCount: chunks.length,
      migrationCount: provenance.length, migrationProvenanceSha256 },
  ];
  const lines = frames.map((frame) => JSON.stringify(frame));
  if (lines.some((line) => Buffer.byteLength(line + "\n", "utf8") > DIAGNOSTIC_LINE_LIMIT)) {
    throw new Error("SCHEMA_DIAGNOSTIC_SIZE_LIMIT");
  }
  // Validate the complete payload, metadata, hashes and every line BEFORE any
  // begin/chunk marker. A receiver must reject missing end/chunks/provenance,
  // duplicate or out-of-order indexes, byte/hash mismatches and oversized lines.
  candidateEmitted = true;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(lines.join("\n") + "\n", (error) => error
      ? reject(new Error("SCHEMA_DIAGNOSTIC_OUTPUT_FAILED")) : resolve());
  });
}

function reportDiagnosticFailure(error: unknown): void {
  const code = error instanceof Error && /^SCHEMA_DIAGNOSTIC_[A-Z_]+$/.test(error.message)
    ? error.message : "SCHEMA_DIAGNOSTIC_FAILED";
  console.error(`${code}: current-schema-contract was not emitted as a complete accepted catalog; original assertion follows.`);
}

function validateCandidate(candidate: SchemaContract): void {
  const root = diagnosticRecord(candidate, ["format", "formatVersion", "generatedBy", "generatedOnServerVersion", "counts", "tables"]);
  if (root.format !== "aqlan-current-schema-contract" || root.formatVersion !== 1 || root.generatedBy !== "ensureSchema()"
    || typeof root.generatedOnServerVersion !== "string"
    || !/^18(?:\.[0-9]+)?(?: \([A-Za-z0-9.+~ _-]{1,160}\))?$/.test(root.generatedOnServerVersion)) {
    throw new Error("SCHEMA_DIAGNOSTIC_INVALID_DTO");
  }
  const identifier = (value: unknown) => {
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(value)) throw new Error("SCHEMA_DIAGNOSTIC_INVALID_DTO");
  };
  const identifiers = (value: unknown) => {
    if (!Array.isArray(value)) throw new Error("SCHEMA_DIAGNOSTIC_INVALID_DTO");
    value.forEach(identifier);
  };
  const counts = diagnosticRecord(root.counts, ["tables", "columns", "constraints", "indexes", "triggers"]);
  for (const count of Object.values(counts)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("SCHEMA_DIAGNOSTIC_INVALID_DTO");
  }
  const tables = diagnosticRecord(root.tables);
  if (counts.tables !== Object.keys(tables).length || counts.tables === 0) throw new Error("SCHEMA_DIAGNOSTIC_INVALID_DTO");
  let columns = 0; let indexes = 0; let triggers = 0;
  for (const [name, value] of Object.entries(tables)) {
    identifier(name);
    const table = diagnosticRecord(value, ["columns", "primaryKey", "unique", "checks", "foreignKeys", "indexes", "triggers"]);
    for (const [name, value] of Object.entries(diagnosticRecord(table.columns))) {
      identifier(name); columns++;
      const column = diagnosticRecord(value, ["type", "nullable"]);
      identifier(column.type);
      if (typeof column.nullable !== "boolean") throw new Error("SCHEMA_DIAGNOSTIC_INVALID_DTO");
    }
    identifiers(table.primaryKey); identifiers(table.checks);
    if (!Array.isArray(table.unique) || !Array.isArray(table.foreignKeys)) throw new Error("SCHEMA_DIAGNOSTIC_INVALID_DTO");
    table.unique.forEach(identifiers);
    for (const value of table.foreignKeys) {
      const key = diagnosticRecord(value, ["columns", "refTable", "refColumns"]);
      identifiers(key.columns); identifier(key.refTable); identifiers(key.refColumns);
    }
    for (const [name, value] of Object.entries(diagnosticRecord(table.indexes))) {
      identifier(name); indexes++;
      const index = diagnosticRecord(value, ["columns", "unique"]);
      identifiers(index.columns);
      if (typeof index.unique !== "boolean") throw new Error("SCHEMA_DIAGNOSTIC_INVALID_DTO");
    }
    for (const [name, value] of Object.entries(diagnosticRecord(table.triggers))) {
      identifier(name); triggers++;
      const trigger = diagnosticRecord(value, ["timing", "events"]);
      if (!["BEFORE", "AFTER", "INSTEAD OF"].includes(String(trigger.timing)) || !Array.isArray(trigger.events)
        || trigger.events.some((event) => !["INSERT", "DELETE", "UPDATE", "TRUNCATE"].includes(event))) {
        throw new Error("SCHEMA_DIAGNOSTIC_INVALID_DTO");
      }
    }
  }
  if (counts.columns !== columns || counts.indexes !== indexes || counts.triggers !== triggers) throw new Error("SCHEMA_DIAGNOSTIC_INVALID_DTO");
}

async function sourceSnapshot<T>(connection: Client, database: string, read: () => Promise<T>): Promise<{ value: T; postgresVersionNum: number }> {
  await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await connection.query("SET LOCAL search_path = pg_catalog");
    await connection.query("SET LOCAL row_security = off");
    const { rows } = await connection.query<{ database: string; version_num: string; read_only: string; isolation: string }>(
      "SELECT current_database() AS database, current_setting('server_version_num') AS version_num, "
      + "current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation",
    );
    if (rows.length !== 1 || rows[0].database !== database || !/^18[0-9]{4}$/.test(rows[0].version_num)
      || rows[0].read_only !== "on" || rows[0].isolation !== "repeatable read") {
      throw new Error("SCHEMA_DIAGNOSTIC_SNAPSHOT_INVALID");
    }
    assertPostgres18VersionNum(rows[0].version_num);
    const value = await read();
    await connection.query("COMMIT");
    return { value, postgresVersionNum: Number(rows[0].version_num) };
  } catch (error) {
    try { await connection.query("ROLLBACK"); }
    catch { throw new AggregateError([error, new Error("SCHEMA_DIAGNOSTIC_ROLLBACK_FAILED")], "SCHEMA_DIAGNOSTIC_SNAPSHOT_FAILED"); }
    throw error;
  }
}

async function dropIsolatedDatabase(name: string): Promise<void> {
  const admin = adminClient("postgres");
  await admin.connect();
  try {
    await admin.query("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)");
  } finally {
    await admin.end();
  }
}

async function resetPublic(url: string): Promise<void> {
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
}

async function migrateThrough(url: string, count: number): Promise<void> {
  const files = await loadMigrationFiles();
  const pool = new Pool({ connectionString: url, ssl: false });
  try {
    await migrate(pool as any, { apply: true, files: files.slice(0, count) });
  } finally {
    await pool.end();
  }
}

async function businessSequenceState(url: string): Promise<Record<string, number>> {
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    const names = [
      "patient_number_seq",
      "invoice_number_seq",
      "receipt_number_seq",
      "voucher_number_seq",
    ];
    const state: Record<string, number> = {};
    for (const name of names) {
      const { rows } = await client.query<{ last_value: string }>(
        "SELECT last_value::text FROM " + name,
      );
      state[name] = Number(rows[0]?.last_value ?? 0);
    }
    return state;
  } finally {
    await client.end();
  }
}

let ownershipEnvironmentValidated = false;

describe("PG18 schema ownership characterization", () => {
  beforeAll(() => {
    // Reject production/Railway and unsafe targets BEFORE the legacy stub can
    // clear markers or replace URLs. Also verify its import-time cached target.
    const target = validateOwnershipHarnessEnvironment(process.env);
    assertRealPostgresUrl();
    if (new URL(assertRealPostgresUrl()).toString() !== target.testUrl.toString()) {
      throw new Error("SCHEMA_DIAGNOSTIC_TARGET_MISMATCH");
    }
    stubPostgresEnv();
    ownershipEnvironmentValidated = true;
  });

  afterAll(async () => {
    // afterAll also runs when beforeAll rejects. No connection is permissible
    // until original/cached target validation and the legacy stub both succeed.
    if (!ownershipEnvironmentValidated) return;
    const admin = adminClient("postgres");
    await admin.connect();
    try {
      const { rows } = await admin.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname LIKE 'aqlan_schema_ownership_%' ORDER BY datname",
      );
      expect(rows).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it("builds migrations and ensureSchema independently, compares them, and leaves no generated databases", async () => {
    const report = await runSchemaOwnershipCharacterization(process.env);

    expect(report.postgres.major).toBe(18);
    expect(report.migrationProvenance.map((item) => item.version)).toEqual([...COORDINATED_MIGRATION_VERSIONS]);
    expect(report.migrationRegistry.present).toBe(true);
    expect(report.migrationRegistry.rows).toHaveLength(COORDINATED_MIGRATION_VERSIONS.length);
    expect(report.migrationRegistry.rows.every((row) => row.adopted === false)).toBe(true);

    const migrationApplicationTables = report.migrationCatalog.tables
      .filter((entry) => entry.table !== "schema_migrations");
    const runtimeApplicationTables = report.runtimeCatalog.tables
      .filter((entry) => entry.table !== "schema_migrations");

    // 88 قاعدة main (بعد دمج سلسلة الفواتير) + 7 جداول HR-1/HR-2 + 12 جدولًا HR-3..HR-6 = 107.
    expect(migrationApplicationTables).toHaveLength(107);
    expect(runtimeApplicationTables).toHaveLength(107);
    expect(report.runtimeCatalog.registry.present).toBe(false);

    expect(report.comparison.characterizationOk).toBe(true);
    expect(report.comparison.applicationSchemaEqual).toBe(false);
    expect(report.comparison.openFindingsManifestMatch).toBe(true);
    expect(report.comparison.unexpectedDifferences).toEqual([]);
    expect(report.comparison.knownDifferences).toEqual([]);
    expect(report.comparison.openConvergenceFindings).toHaveLength(16);
    expect(candidateOpenFindingsManifest(report.comparison)).toEqual(
      JSON.parse(readFileSync(OPEN_FINDINGS_MANIFEST_PATH, "utf8")),
    );
    expect(report.comparison.openConvergenceFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: "columns", key: "appointments.doctor_id", classification: "OPEN_CONVERGENCE_FINDING" }),
      expect.objectContaining({ section: "functions", key: "aqlan_payments_append_only_guard()", classification: "OPEN_CONVERGENCE_FINDING" }),
      expect.objectContaining({ section: "functions", key: "aqlan_financial_delete_guard()", classification: "OPEN_CONVERGENCE_FINDING" }),
    ]));
    expect(report.summary).toEqual({
      applicationSchemaEqual: false,
      characterizationOk: true,
      knownDifferences: 0,
      openConvergenceFindings: 16,
      unexpectedDifferences: 0,
      openFindingsManifestMatch: true,
    });

    expect(report.assertions).toEqual({
      TD08A_COMPLETE: "NO",
      TD01A_COMPLETE: "NO",
      PRODUCTION_WRITES_ALLOWED: "NO",
    });
    expect(report.populatedStateCharacterization).toEqual(expect.arrayContaining([
      expect.objectContaining({ finding: "material-rate-0004-backfill", status: "PROVEN_BEHAVIOR" }),
      expect.objectContaining({ finding: "preferred-period-to-shift-conversion", status: "PROVEN_BEHAVIOR" }),
      expect.objectContaining({ finding: "business-number-sequence-state", status: "PROVEN_BEHAVIOR" }),
      expect.objectContaining({ finding: "waiting-list-obsolete-uniqueness-ordering", status: "PROVEN_BEHAVIOR" }),
    ]));
  }, 180_000);

  it("cleans both generated databases after an induced primary failure", async () => {
    const names = {
      migrations: "aqlan_schema_ownership_migrations_failure_fixture",
      runtime: "aqlan_schema_ownership_runtime_failure_fixture",
    };
    const admin = adminClient("postgres");
    await expect(withGeneratedDatabasePair(
      admin,
      names,
      async () => ({ major: 18, version: "18 fixture" }),
      async () => { throw new Error("induced-operation-failure"); },
    )).rejects.toThrow("induced-operation-failure");

    const verify = adminClient("postgres");
    await verify.connect();
    try {
      const { rows } = await verify.query(
        "SELECT datname FROM pg_database WHERE datname = ANY($1::text[])",
        [[names.migrations, names.runtime]],
      );
      expect(rows).toEqual([]);
    } finally {
      await verify.end();
    }
  }, 120_000);

  it("characterizes migration 0004 repair and history backfill on populated synthetic data", async () => {
    const name = "aqlan_schema_ownership_material";
    const url = await createIsolatedDatabase(name);
    try {
      await migrateThrough(url, 3);
      const client = new Client({ connectionString: url, ssl: false });
      await client.connect();
      try {
        await client.query(
          "INSERT INTO material_rates (category, rate_bp, updated_by) VALUES ('fixture-ortho', 1750, 'fixture')",
        );
      } finally {
        await client.end();
      }

      await migrateThrough(url, 4);
      const verify = new Client({ connectionString: url, ssl: false });
      await verify.connect();
      try {
        const { rows } = await verify.query<{
          history_count: string;
          data_type: string;
          column_default: string | null;
        }>(
          "SELECT " +
          "(SELECT COUNT(*)::text FROM material_rate_history WHERE category = 'fixture-ortho') AS history_count, " +
          "c.data_type, c.column_default " +
          "FROM information_schema.columns c " +
          "WHERE c.table_schema='public' AND c.table_name='material_rate_history' AND c.column_name='effective_from'",
        );
        expect(rows[0]?.history_count).toBe("1");
        expect(rows[0]?.data_type).toBe("timestamp with time zone");
        expect(String(rows[0]?.column_default ?? "").toLowerCase()).toContain("now()");
      } finally {
        await verify.end();
      }
    } finally {
      await dropIsolatedDatabase(name);
    }
  }, 120_000);

  it("characterizes migration 0010 preferred-period to shift conversion", async () => {
    const name = "aqlan_schema_ownership_waitshift";
    const url = await createIsolatedDatabase(name);
    try {
      await migrateThrough(url, 9);
      const client = new Client({ connectionString: url, ssl: false });
      await client.connect();
      try {
        const { rows } = await client.query<{ id: number }>(
          "INSERT INTO patients (patient_number, full_name) VALUES ('FIX-WAIT-1', 'Synthetic waiting fixture') RETURNING id",
        );
        await client.query(
          "INSERT INTO waiting_list (patient_id, preferred_period) VALUES ($1, 'morning')",
          [rows[0]?.id],
        );
      } finally {
        await client.end();
      }

      await migrateThrough(url, 10);
      const verify = new Client({ connectionString: url, ssl: false });
      await verify.connect();
      try {
        const { rows } = await verify.query<{ preferred_period: string; preferred_shift: string }>(
          "SELECT preferred_period, preferred_shift FROM waiting_list ORDER BY id LIMIT 1",
        );
        expect(rows[0]).toEqual({ preferred_period: "morning", preferred_shift: "shift1" });
      } finally {
        await verify.end();
      }
    } finally {
      await dropIsolatedDatabase(name);
    }
  }, 120_000);

  it("proves all four business-number sequences lag imported prefixed rows until runtime initialization synchronizes them", async () => {
    const name = "aqlan_schema_ownership_sequences";
    const url = await createIsolatedDatabase(name);
    try {
      await migrateThrough(url, 11);
      const client = new Client({ connectionString: url, ssl: false });
      await client.connect();
      try {
        const { rows: patients } = await client.query<{ id: number }>(
          "INSERT INTO patients (patient_number, full_name) VALUES ('P-000123', 'Synthetic sequence fixture') RETURNING id",
        );
        const { rows: shifts } = await client.query<{ id: number }>(
          "INSERT INTO cashier_shifts (opened_by) VALUES ('fixture') RETURNING id",
        );
        await client.query(
          "INSERT INTO invoices (invoice_number, patient_id) VALUES ('INV-000456', $1)",
          [patients[0]?.id],
        );
        await client.query(
          "INSERT INTO payments (receipt_number, patient_id, shift_id, amount_minor, currency, base_amount_minor) " +
          "VALUES ('REC-000789', $1, $2, 100, 'YER', 100)",
          [patients[0]?.id, shifts[0]?.id],
        );
        await client.query(
          "INSERT INTO expenses (voucher_number, category, shift_id, amount_minor, currency, base_amount_minor) " +
          "VALUES ('VOU-000321', 'fixture', $1, 100, 'YER', 100)",
          [shifts[0]?.id],
        );
      } finally {
        await client.end();
      }

      const before = await businessSequenceState(url);
      expect(before.patient_number_seq).toBeLessThan(123);
      expect(before.invoice_number_seq).toBeLessThan(456);
      expect(before.receipt_number_seq).toBeLessThan(789);
      expect(before.voucher_number_seq).toBeLessThan(321);

      await initializeGeneratedRuntimeSchema(validateOwnershipHarnessEnvironment(process.env), name, process.env);
      expect(await businessSequenceState(url)).toEqual({
        patient_number_seq: 123,
        invoice_number_seq: 456,
        receipt_number_seq: 789,
        voucher_number_seq: 321,
      });
    } finally {
      await dropIsolatedDatabase(name);
    }
  }, 120_000);

  it("preserves legitimate service-specific waiting rows on cold start", async () => {
    const name = "aqlan_schema_ownership_waitcold";
    const url = await createIsolatedDatabase(name);
    let generatedSnapshot: { value: SchemaContract; postgresVersionNum: number } | undefined;
    try {
      // The existing fixture comes from template1. Refuse any inherited
      // operator objects before runtime initialization, rather than exporting
      // them or silently resetting the fixture to make it appear pristine.
      const fresh = new Client({ connectionString: url, ssl: false });
      await fresh.connect();
      try {
        await sourceSnapshot(fresh, name, () => assertPristineDisclosureDatabase(fresh));
      } finally { await fresh.end(); }
      await initializeGeneratedRuntimeSchema(validateOwnershipHarnessEnvironment(process.env), name, process.env);
      const client = new Client({ connectionString: url, ssl: false });
      await client.connect();
      try {
        // Full ensureSchema output, captured before any synthetic test inserts.
        // Never use schema-fingerprint.test.ts's two-table fixture as a contract.
        generatedSnapshot = await sourceSnapshot(client, name, () => introspectSchema(client));
        const { rows: patients } = await client.query<{ id: number }>(
          "INSERT INTO patients (patient_number, full_name) VALUES ('FIX-COLD-1', 'Synthetic cold-start fixture') RETURNING id",
        );
        const { rows: services } = await client.query<{ id: number }>(
          "INSERT INTO appointment_services (code, name_ar) " +
          "VALUES ('fixture-a', 'Fixture A'), ('fixture-b', 'Fixture B') RETURNING id",
        );
        await client.query(
          "INSERT INTO waiting_list (patient_id, service_id) VALUES ($1, $2), ($1, $3)",
          [patients[0]?.id, services[0]?.id, services[1]?.id],
        );
        const before = (await client.query("SELECT * FROM waiting_list ORDER BY id")).rows;
        expect(before).toHaveLength(2);
        await initializeGeneratedRuntimeSchema(validateOwnershipHarnessEnvironment(process.env), name, process.env);
        expect((await client.query("SELECT * FROM waiting_list ORDER BY id")).rows).toEqual(before);
      } finally {
        await client.end();
      }
    } finally {
      await dropIsolatedDatabase(name);
    }
    // All original business assertions, client shutdown and fixture removal
    // must succeed before any diagnostic candidate can be emitted. A failed
    // cleanup retains its existing failure and cannot leave an accepted frame.
    if (!generatedSnapshot) throw new Error("SCHEMA_DIAGNOSTIC_SNAPSHOT_INVALID");
    const { value: generatedContract, postgresVersionNum } = generatedSnapshot;
    try {
      expect(structuralDiffs(committedContract as SchemaContract, generatedContract)).toEqual([]);
    } catch (comparisonFailure) {
      try { await emitSourceCandidate(generatedContract, postgresVersionNum); }
      catch (diagnosticFailure) { reportDiagnosticFailure(diagnosticFailure); }
      throw comparisonFailure;
    }
  }, 120_000);
});
