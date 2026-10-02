import { Client } from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateOwnershipHarnessEnvironment } from "../../scripts/verify-schema-ownership";
import { preflightConnection } from "../../scripts/db-preflight";
import { inspectSchemaReadOnly } from "../../lib/schema-preflight";
import { projectDetailedSchemaReadOnly, type ReadOnlyCatalogClient } from "../../lib/schema-manifest";
import { loadMigrationFiles } from "../../lib/migration-files";

const database = `aqlan_read_only_preflight_${randomUUID().replace(/-/g, "")}`;
const execute = promisify(execFile);
let client: Client;
let url: string;
let files: Awaited<ReturnType<typeof loadMigrationFiles>>;
let maintenanceUrl: string;
let created = false;

beforeAll(async () => {
  const target = validateOwnershipHarnessEnvironment();
  // Also reject libpq URL options that can override the validated loopback host.
  preflightConnection({ ...process.env, DATABASE_URL: target.testUrl.toString() });
  maintenanceUrl = target.maintenanceUrl.toString();
  const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${database}`); created = true; }
  finally { await admin.end(); }
  target.testUrl.pathname = `/${database}`;
  url = target.testUrl.toString();
  client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  files = await loadMigrationFiles();
  await client.query("CREATE TABLE synthetic_preflight_fixture(id serial PRIMARY KEY, label text DEFAULT 'private fixture value')");
  await client.query("INSERT INTO synthetic_preflight_fixture(label) VALUES ('synthetic unchanged')");
});

afterAll(async () => {
  await client?.end();
  if (!created) return;
  const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
  await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); }
  finally { await admin.end(); }
});

describe("PG18 enforced read-only schema preflight", () => {
  it("reports an absent registry without creating one, reading application rows or advancing sequences", async () => {
    const before = await projectDetailedSchemaReadOnly(client);
    const statements: string[] = [];
    const observed: ReadOnlyCatalogClient = { query: async <T>(sql: string, values?: unknown[]) => {
      statements.push(sql);
      return { rows: (await client.query(sql, values)).rows as T[] };
    } };
    const report = await inspectSchemaReadOnly(observed, files);
    expect(report.registry).toMatchObject({ present: false, registeredCount: 0, matchesFiles: false });
    expect(report.registry.missingVersions).toHaveLength(files.length);
    expect(report.adoptionAssessment).toBe("NOT_PERFORMED");
    expect(report.schemaEquivalence).toBe("NOT_ASSESSED");
    expect(report.transaction).toEqual({ readOnly: true, isolation: "repeatable read" });
    expect(JSON.stringify(report)).not.toContain("private fixture value");
    expect(JSON.stringify(report)).not.toContain("synthetic unchanged");
    expect(statements.some((sql) => /SELECT last_value|FROM (?:public\.)?synthetic_preflight_fixture/i.test(sql))).toBe(false);
    expect(statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(statements).toContain("SET LOCAL statement_timeout = '5s'");
    expect(statements).toContain("SET LOCAL lock_timeout = '1s'");
    expect(await projectDetailedSchemaReadOnly(client)).toEqual(before);
    expect((await client.query("SELECT label FROM synthetic_preflight_fixture")).rows).toEqual([{ label: "synthetic unchanged" }]);
  });

  it.each([
    "CREATE TABLE public.forbidden_preflight_write(id integer)",
    "UPDATE public.synthetic_preflight_fixture SET label='forbidden'",
  ])("PostgreSQL rejects an injected write and rolls back: %s", async (write) => {
    const before = await projectDetailedSchemaReadOnly(client);
    let injected = false;
    const guarded: ReadOnlyCatalogClient = { query: async <T>(sql: string, values?: unknown[]) => {
      if (!injected && sql.includes("FROM pg_database")) {
        injected = true;
        await client.query(write);
      }
      return { rows: (await client.query(sql, values)).rows as T[] };
    } };
    await expect(inspectSchemaReadOnly(guarded, files)).rejects.toMatchObject({ code: "25006" });
    expect(injected).toBe(true);
    expect(await projectDetailedSchemaReadOnly(client)).toEqual(before);
    expect((await client.query("SELECT label FROM synthetic_preflight_fixture")).rows[0].label).toBe("synthetic unchanged");
  });

  it("separates checksum/name/unknown/pending registry evidence from adoption readiness", async () => {
    await client.query("CREATE TABLE schema_migrations(version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, adopted boolean NOT NULL)");
    await client.query("INSERT INTO schema_migrations VALUES ($1,$2,$3,true),('9999','unknown',repeat('f',64),false)",
      [files[0].version, "wrong_name", "0".repeat(64)]);
    const before = await projectDetailedSchemaReadOnly(client);
    const report = await inspectSchemaReadOnly(client, files);
    expect(report.registry).toMatchObject({ present: true, registeredCount: 2, adoptedVersions: ["0001"],
      checksumMismatches: ["0001"], nameMismatches: ["0001"], unknownVersions: ["9999"], matchesFiles: false });
    expect(report.registry.missingVersions).toHaveLength(files.length - 1);
    expect(await projectDetailedSchemaReadOnly(client)).toEqual(before);
    await client.query("DELETE FROM schema_migrations WHERE version='9999'");
    await client.query("UPDATE schema_migrations SET name=$1, checksum=$2 WHERE version='0001'", [files[0].name, files[0].checksum]);
    const matching = await inspectSchemaReadOnly(client, files.slice(0, 1));
    expect(matching.registry.matchesFiles).toBe(true);
    expect(matching.adoptionAssessment).toBe("NOT_PERFORMED");
    expect(matching.schemaEquivalence).toBe("NOT_ASSESSED");
  });

  it("fails closed on registry permissions and ends the failed transaction", async () => {
    // Session role exists only in this isolated test cluster and is removed below.
    const role = `aqlan_preflight_reader_${process.pid}`;
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    try {
      await client.query(`SET ROLE ${role}`);
      await expect(inspectSchemaReadOnly(client, files)).rejects.toMatchObject({ code: "42501" });
      const { rows } = await client.query("SELECT current_setting('transaction_read_only') AS read_only");
      expect(rows[0].read_only).toBe("off");
    } finally {
      await client.query("RESET ROLE");
      await client.query(`DROP ROLE ${role}`);
    }
  });

  it("rejects duplicate or untrusted registry rows instead of collapsing or printing them", async () => {
    await client.query("ALTER TABLE schema_migrations DROP CONSTRAINT schema_migrations_pkey");
    try {
      await client.query("INSERT INTO schema_migrations SELECT * FROM schema_migrations");
      await expect(inspectSchemaReadOnly(client, files)).rejects.toThrow("Invalid migration registry rows");
      await client.query("DELETE FROM schema_migrations");
      await client.query("INSERT INTO schema_migrations VALUES ('private registry text','baseline_schema',$1,false)", [files[0].checksum]);
      await expect(execute(process.execPath, ["--import", "tsx", "scripts/db-preflight.ts"], {
        env: { ...process.env, DATABASE_URL: url, DATABASE_ENVIRONMENT: "test", USE_LOCAL_DB: "false" },
      })).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.not.stringContaining("private registry text") });
    } finally {
      await client.query("DELETE FROM schema_migrations");
      await client.query("INSERT INTO schema_migrations VALUES ($1,$2,$3,true)", [files[0].version, files[0].name, files[0].checksum]);
      await client.query("ALTER TABLE schema_migrations ADD PRIMARY KEY(version)");
    }
  });

  it("rejects registry views and altered column types", async () => {
    await client.query("ALTER TABLE schema_migrations RENAME TO saved_registry");
    try {
      await client.query("CREATE VIEW schema_migrations AS SELECT * FROM saved_registry");
      await expect(inspectSchemaReadOnly(client, files)).rejects.toThrow("Invalid migration registry relation");
      await client.query("DROP VIEW schema_migrations");
      await client.query("CREATE TABLE schema_migrations(version text NOT NULL, name text NOT NULL, checksum text NOT NULL, adopted text NOT NULL)");
      await expect(inspectSchemaReadOnly(client, files)).rejects.toThrow("Invalid migration registry columns");
      await client.query("DROP TABLE schema_migrations");
    } finally {
      await client.query("ALTER TABLE saved_registry RENAME TO schema_migrations");
    }
  });

  it("rejects an RLS-filterable registry rather than reporting partial provenance", async () => {
    const role = `aqlan_preflight_rls_${process.pid}`;
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(`GRANT SELECT ON schema_migrations TO ${role}`);
    await client.query("ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY");
    await client.query("CREATE POLICY preflight_hidden ON schema_migrations USING (false)");
    try {
      await client.query(`SET ROLE ${role}`);
      expect((await client.query("SELECT * FROM public.schema_migrations")).rows).toEqual([]);
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL row_security = off");
      // Turning row_security off is not a privilege bypass: PG refuses the read.
      await expect(client.query("SELECT * FROM public.schema_migrations")).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
      await expect(inspectSchemaReadOnly(client, files)).rejects.toMatchObject({ code: "REGISTRY_RELATION_INVALID" });
    } finally {
      await client.query("ROLLBACK");
      await client.query("RESET ROLE");
      await client.query("DROP POLICY preflight_hidden ON schema_migrations");
      await client.query("ALTER TABLE schema_migrations DISABLE ROW LEVEL SECURITY");
      await client.query(`REVOKE SELECT ON schema_migrations FROM ${role}`);
      await client.query(`DROP ROLE ${role}`);
    }
  });

  it("keeps registry evidence in the same snapshot during concurrent registration", async () => {
    const writer = new Client({ connectionString: url, ssl: false });
    await writer.connect();
    let wrote = false;
    const observed: ReadOnlyCatalogClient = { query: async <T>(sql: string, values?: unknown[]) => {
      const result = await client.query(sql, values);
      if (!wrote && sql.includes("AS read_only")) {
        wrote = true;
        await writer.query("INSERT INTO schema_migrations VALUES ('9998','concurrent',repeat('e',64),false)");
      }
      return { rows: result.rows as T[] };
    } };
    try {
      const snapshot = await inspectSchemaReadOnly(observed, files);
      expect(snapshot.registry.unknownVersions).toEqual([]);
      expect((await inspectSchemaReadOnly(client, files)).registry.unknownVersions).toEqual(["9998"]);
    } finally {
      await writer.query("DELETE FROM schema_migrations WHERE version='9998'");
      await writer.end();
    }
  });

  it("bounds a locked registry read and recovers without a partial report", async () => {
    const blocker = new Client({ connectionString: url, ssl: false });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE");
      await expect(inspectSchemaReadOnly(client, files)).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
    expect((await inspectSchemaReadOnly(client, files)).registry.present).toBe(true);
  });

  it("runs the actual CLI with redacted JSON and no catalog/data changes", async () => {
    const before = await projectDetailedSchemaReadOnly(client);
    const result = await execute(process.execPath, ["--import", "tsx", "scripts/db-preflight.ts"], {
      env: { ...process.env, DATABASE_URL: url, DATABASE_ENVIRONMENT: "test", USE_LOCAL_DB: "false" },
    });
    const report = JSON.parse(result.stdout);
    expect(report.targetEnvironment).toBe("test");
    expect(report.registry.present).toBe(true);
    expect(report.catalog.tables.count).toBe(2);
    expect(result.stdout).not.toContain("private fixture value");
    expect(result.stdout).not.toContain(database);
    expect(result.stdout).not.toContain(url);
    expect(await projectDetailedSchemaReadOnly(client)).toEqual(before);
  });
});
