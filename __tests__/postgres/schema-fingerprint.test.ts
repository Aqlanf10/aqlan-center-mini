import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import policy from "../../schema/preflight-disclosure.pg18.json";
import { generatePreflightDisclosure, assertPristineDisclosureDatabase } from "../../scripts/generate-preflight-disclosure";
import { validateOwnershipHarnessEnvironment, assertPostgres18VersionNum } from "../../scripts/verify-schema-ownership";
import { preflightConnection } from "../../scripts/db-preflight";
import { loadMigrationFiles } from "../../lib/migration-files";
import { inspectSchemaReadOnly } from "../../lib/schema-preflight";
import { FINGERPRINT_FIELDS, FINGERPRINT_SECTIONS, fingerprint, fingerprintIdentity } from "../../lib/schema-fingerprint";
import { projectDetailedSchemaReadOnly, type ReadOnlyCatalogClient } from "../../lib/schema-manifest";

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

async function emitSourceCandidate(candidate: Awaited<ReturnType<typeof generatePreflightDisclosure>>, postgresVersionNum: number): Promise<void> {
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
    if (git(["ls-files", "--others", "--", "lib", "scripts", "migrations", "schema", "__tests__/postgres/schema-fingerprint.test.ts"])) {
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
    "scripts/verify-schema-ownership.ts", "scripts/verify-schema-contract-drift.ts", "__tests__/postgres/schema-fingerprint.test.ts",
  ];
  const sourceHashes = Object.fromEntries(sourceFiles.map((path) => [path, sha256(readFileSync(new URL(`../../${path}`, import.meta.url)))]));
  const digest = sha256(bytes);
  const migrationProvenanceSha256 = sha256(JSON.stringify(provenance));
  const id = sha256(JSON.stringify(["preflight-disclosure", sourceCommit, run, attempt, digest]));
  const chunks = Array.from({ length: Math.ceil(bytes.length / 2048) }, (_, index) => bytes.subarray(index * 2048, (index + 1) * 2048));
  if (!Buffer.concat(chunks).equals(bytes)) throw new Error("SCHEMA_DIAGNOSTIC_INCOMPLETE");
  const marker = "AQLAN_SOURCE_SCHEMA_CANDIDATE_V1";
  const frames = [
    { marker, kind: "begin", id, format: "aqlan-source-schema-diagnostic", formatVersion: 1,
      candidate: "preflight-disclosure", encoding: "base64", sourceCommit, sourceTree, run, attempt,
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
  console.error(`${code}: preflight-disclosure was not emitted as a complete accepted catalog; original assertion follows.`);
}

function validateCandidate(candidate: Awaited<ReturnType<typeof generatePreflightDisclosure>>): void {
  const root = diagnosticRecord(candidate, ["format", "formatVersion", "sections"]);
  if (root.format !== "aqlan-preflight-disclosure" || root.formatVersion !== 1) throw new Error("SCHEMA_DIAGNOSTIC_INVALID_DTO");
  const sections = diagnosticRecord(root.sections, FINGERPRINT_SECTIONS);
  const hashes = (value: unknown) => {
    if (!Array.isArray(value) || value.some((entry, index) => typeof entry !== "string" || !/^[0-9a-f]{64}$/.test(entry)
      || (index > 0 && value[index - 1] >= entry))) throw new Error("SCHEMA_DIAGNOSTIC_INVALID_DTO");
  };
  for (const section of FINGERPRINT_SECTIONS) {
    const entry = diagnosticRecord(sections[section], ["identities", "textValues"]);
    hashes(entry.identities);
    const fields = Object.entries(FINGERPRINT_FIELDS[section]).filter(([, kind]) => kind === "text").map(([field]) => field);
    const text = diagnosticRecord(entry.textValues, fields);
    for (const value of Object.values(text)) hashes(value);
  }
}

// Keep the full UUID within PostgreSQL's 63-byte identifier limit so the
// diagnostic guard can compare current_database() with the exact fixture name.
const database = `aqlan_schema_ownership_drill_${randomUUID().replace(/-/g, "")}`;
let client: Client;
let maintenance: string;
let url: string;
let created = false;
let files: Awaited<ReturnType<typeof loadMigrationFiles>>;
const inspect = (connection: ReadOnlyCatalogClient = client) => inspectSchemaReadOnly(connection, files, { fingerprintDrilldown: true });

beforeAll(async () => {
  expect(Buffer.byteLength(database, "utf8")).toBeLessThanOrEqual(63);
  const target = validateOwnershipHarnessEnvironment();
  preflightConnection({ ...process.env, DATABASE_URL: target.testUrl.toString() });
  maintenance = target.maintenanceUrl.toString();
  const admin = new Client({ connectionString: maintenance, ssl: false }); await admin.connect();
  try {
    assertPostgres18VersionNum((await admin.query("SHOW server_version_num")).rows[0].server_version_num);
    await admin.query(`CREATE DATABASE ${database}`); created = true;
  } finally { await admin.end(); }
  target.testUrl.pathname = `/${database}`; url = target.testUrl.toString();
  client = new Client({ connectionString: url, ssl: false }); await client.connect();
  files = await loadMigrationFiles();
});
beforeEach(async () => {
  await client.query("DROP TABLE IF EXISTS appointments,patients CASCADE");
  await client.query("CREATE TABLE patients(id serial PRIMARY KEY,full_name text NOT NULL)");
  await client.query("CREATE TABLE appointments(id serial PRIMARY KEY,patient_id integer NOT NULL REFERENCES patients(id) ON DELETE CASCADE)");
});
afterAll(async () => {
  await client?.end();
  if (!created) return;
  const admin = new Client({ connectionString: maintenance, ssl: false }); await admin.connect();
  try { await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); } finally { await admin.end(); }
});

it("reproduces the reviewed policy solely from fresh numbered/runtime source schemas", async () => {
  const generated = await generatePreflightDisclosure();
  try {
    expect(generated).toEqual(policy);
  } catch (comparisonFailure) {
    try {
      // This is the existing synthetic drilldown connection, not either source
      // catalog. The generator itself validates PG18 on its source pair.
      const { rows } = await client.query<{ database: string; version_num: string }>(
        "SELECT current_database() AS database, current_setting('server_version_num') AS version_num",
      );
      if (rows.length !== 1 || rows[0].database !== database || !/^18[0-9]{4}$/.test(rows[0].version_num)) {
        throw new Error("SCHEMA_DIAGNOSTIC_METADATA_INVALID");
      }
      await emitSourceCandidate(generated, Number(rows[0].version_num));
    } catch (diagnosticFailure) { reportDiagnosticFailure(diagnosticFailure); }
    throw comparisonFailure;
  }
});

it("cannot learn a private template1 object, and rejects a nonempty builder target", async () => {
  const templateUrl = new URL(maintenance); templateUrl.pathname = "/template1";
  const template = new Client({ connectionString: templateUrl.toString(), ssl: false }); await template.connect();
  // This generated identifier exists only in the validated disposable CI/local
  // cluster. Delete only this test's object in finally; never touch other data.
  const canary = `synthetic_private_template_${randomUUID().replace(/-/g, "")}`;
  try {
    await template.query(`CREATE TABLE "${canary}" ("private_column" text DEFAULT 'private default')`);
    expect(await generatePreflightDisclosure()).toEqual(policy);
    await expect(assertPristineDisclosureDatabase(client)).rejects.toThrow("pristine source-only database");
  } finally { await template.query(`DROP TABLE IF EXISTS "${canary}"`); await template.end(); }
});

it("preserves the default report exactly and exposes exact numeric server version only on request", async () => {
  const baseline = await inspectSchemaReadOnly(client, files);
  expect(baseline).not.toHaveProperty("fingerprintDrilldown");
  const { fingerprintDrilldown, ...report } = await inspect();
  expect(report).toEqual(baseline);
  expect(fingerprintDrilldown!.postgresVersionNum).toBe(Number((await client.query("SHOW server_version_num")).rows[0].server_version_num));
  expect(Object.keys(fingerprintDrilldown!.sections)).toEqual(["columns", "constraints", "internalTriggers"]);
  for (const section of Object.values(fingerprintDrilldown!.sections)) {
    expect(section.withheldIdentityCount).toBe(0);
    expect(section.entries).toHaveLength(section.count);
    expect(section.entries.every((entry) => entry.withheldPropertyCount === 0)).toBe(true);
  }
});

it("localizes dropped-column history to the exact ordinal without normalizing it away", async () => {
  const before = await inspect();
  await client.query("ALTER TABLE patients DROP COLUMN full_name");
  await client.query("ALTER TABLE patients ADD COLUMN full_name text NOT NULL");
  const after = await inspect();
  expect(after.catalog.columns.count).toBe(before.catalog.columns.count);
  expect(after.catalog.columns.sha256).not.toBe(before.catalog.columns.sha256);
  const id = fingerprintIdentity("columns", { key: "patients.full_name", table: "patients", name: "full_name", value: "" });
  const left = before.fingerprintDrilldown!.sections.columns.entries.find((entry) => entry.identitySha256 === id)!;
  const right = after.fingerprintDrilldown!.sections.columns.entries.find((entry) => entry.identitySha256 === id)!;
  expect(right.entrySha256).not.toBe(left.entrySha256);
  expect(Object.keys(left.properties).filter((field) => left.properties[field] !== right.properties[field])).toEqual(["ordinal"]);
});

it("preserves constraint renames and the associated internal-trigger identity differences", async () => {
  const before = await inspect();
  await client.query('ALTER TABLE appointments RENAME CONSTRAINT appointments_patient_id_fkey TO "private_renamed_constraint"');
  const after = await inspect();
  for (const section of ["constraints", "internalTriggers"] as const) {
    expect(after.catalog[section].count).toBe(before.catalog[section].count);
    expect(after.catalog[section].sha256).not.toBe(before.catalog[section].sha256);
  }
  expect(after.fingerprintDrilldown!.sections.constraints.withheldIdentityCount).toBe(1);
  expect(after.fingerprintDrilldown!.sections.internalTriggers.withheldIdentityCount).toBe(4);
  expect(JSON.stringify(after)).not.toContain("private_renamed_constraint");
});

it("localizes changed structural constraint flags while withholding unknown trigger/constraint definitions", async () => {
  const before = await inspect();
  await client.query("ALTER TABLE appointments ALTER CONSTRAINT appointments_patient_id_fkey DEFERRABLE INITIALLY DEFERRED");
  const after = await inspect();
  const id = fingerprintIdentity("constraints", { key: "appointments:appointments_patient_id_fkey", table: "appointments", name: "appointments_patient_id_fkey", value: "" });
  const left = before.fingerprintDrilldown!.sections.constraints.entries.find((entry) => entry.identitySha256 === id)!;
  const right = after.fingerprintDrilldown!.sections.constraints.entries.find((entry) => entry.identitySha256 === id)!;
  expect(right.properties.deferrable).not.toBe(left.properties.deferrable);
  expect(right.properties.initiallyDeferred).not.toBe(left.properties.initiallyDeferred);
  expect(right.properties.definition).toBe("WITHHELD");
  expect(right.entrySha256).toBeNull();
  expect(after.fingerprintDrilldown!.sections.internalTriggers.entries.some((entry) => entry.properties.definition === "WITHHELD")).toBe(true);
});

it("does not disclose unexpected names, literals, individual hashes, application rows or sequence values", async () => {
  const secret = "synthetic_private_patient_phrase";
  await client.query(`ALTER TABLE patients ALTER COLUMN full_name SET DEFAULT '${secret}'`);
  await client.query(`CREATE TABLE "${secret}" ("${secret}" text)`);
  await client.query("INSERT INTO patients(full_name) VALUES ('synthetic private row')");
  const before = await projectDetailedSchemaReadOnly(client);
  const statements: string[] = [];
  const wrapped: ReadOnlyCatalogClient = { query: async <T>(sql: string, values?: unknown[]) => {
    statements.push(sql); return { rows: (await client.query(sql, values)).rows as T[] };
  } };
  try {
    const report = await inspect(wrapped);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("synthetic private row");
    expect(serialized).not.toContain(fingerprint("property", "columns", "default", `'${secret}'::text`));
    const unknown = before.columns.find((entry) => entry.table === secret)!;
    expect(serialized).not.toContain(fingerprintIdentity("columns", unknown));
    expect(serialized).not.toContain(fingerprint("entry", "columns", unknown));
    expect(report.fingerprintDrilldown!.sections.columns.withheldIdentityCount).toBe(1);
    expect(statements.some((sql) => /SELECT last_value|FROM (?:public\.)?patients\b/i.test(sql))).toBe(false);
    expect(await projectDetailedSchemaReadOnly(client)).toEqual(before);
  } finally { await client.query(`DROP TABLE "${secret}"`); }
});

it("enforces read-only rejection with the optional mode and rolls back cleanly", async () => {
  const wrapped: ReadOnlyCatalogClient = { query: async <T>(sql: string, values?: unknown[]) => {
    if (sql.includes("FROM pg_database")) await client.query("INSERT INTO public.patients(full_name) VALUES ('forbidden')");
    return { rows: (await client.query(sql, values)).rows as T[] };
  } };
  await expect(inspect(wrapped)).rejects.toMatchObject({ code: "25006" });
  expect((await client.query("SELECT count(*)::int AS count FROM patients")).rows[0].count).toBe(0);
  expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("off");
});

it("retains a repeatable snapshot while another session changes a known property's default", async () => {
  const writer = new Client({ connectionString: url, ssl: false }); await writer.connect();
  const baseline = await inspect();
  let changed = false;
  const wrapped: ReadOnlyCatalogClient = { query: async <T>(sql: string, values?: unknown[]) => {
    const result = await client.query(sql, values);
    if (!changed && sql.includes("AS read_only")) {
      changed = true;
      await writer.query("ALTER TABLE patients ALTER COLUMN full_name SET DEFAULT 'private concurrent text'");
    }
    return { rows: result.rows as T[] };
  } };
  try {
    expect((await inspect(wrapped)).fingerprintDrilldown).toEqual(baseline.fingerprintDrilldown);
    expect((await inspect()).fingerprintDrilldown).not.toEqual(baseline.fingerprintDrilldown);
  } finally { await writer.end(); }
});

it("fails closed on registry permission denial in the optional mode", async () => {
  const role = `drilldown_reader_${process.pid}`;
  await client.query(`CREATE ROLE ${role} NOLOGIN`);
  await client.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,name text NOT NULL,checksum text NOT NULL,adopted boolean NOT NULL)");
  try {
    await client.query(`SET ROLE ${role}`);
    await expect(inspect()).rejects.toMatchObject({ code: "42501" });
    expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("off");
  } finally {
    await client.query("RESET ROLE");
    await client.query("DROP TABLE schema_migrations");
    await client.query(`DROP ROLE ${role}`);
  }
});
