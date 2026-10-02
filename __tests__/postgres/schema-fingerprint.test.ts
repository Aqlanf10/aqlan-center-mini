import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import policy from "../../schema/preflight-disclosure.pg18.json";
import { generatePreflightDisclosure, assertPristineDisclosureDatabase } from "../../scripts/generate-preflight-disclosure";
import { validateOwnershipHarnessEnvironment, assertPostgres18VersionNum } from "../../scripts/verify-schema-ownership";
import { preflightConnection } from "../../scripts/db-preflight";
import { loadMigrationFiles } from "../../lib/migration-files";
import { inspectSchemaReadOnly } from "../../lib/schema-preflight";
import { fingerprint, fingerprintIdentity } from "../../lib/schema-fingerprint";
import { projectDetailedSchemaReadOnly, type ReadOnlyCatalogClient } from "../../lib/schema-manifest";

const database = `aqlan_schema_ownership_drilldown_${randomUUID().replace(/-/g, "")}`;
let client: Client;
let maintenance: string;
let url: string;
let created = false;
let files: Awaited<ReturnType<typeof loadMigrationFiles>>;
const inspect = (connection: ReadOnlyCatalogClient = client) => inspectSchemaReadOnly(connection, files, { fingerprintDrilldown: true });

beforeAll(async () => {
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
  expect(await generatePreflightDisclosure()).toEqual(policy);
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
