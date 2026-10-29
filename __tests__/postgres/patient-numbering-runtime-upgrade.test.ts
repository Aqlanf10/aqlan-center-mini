import { afterAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
// Reproduce the real main runtime registry (including its intentional legacy gaps),
// not a fully CLI-migrated database. The sole excluded startup change is new 0080.
const phase = vi.hoisted(() => ({ beforeNumbering: true }));
vi.mock("../../lib/migrations", async importOriginal => {
  const actual = await importOriginal<typeof import("../../lib/migrations")>();
  return {
    ...actual,
    applyRuntimeMigrationFiles: (pool: Parameters<typeof actual.applyRuntimeMigrationFiles>[0], files: Parameters<typeof actual.applyRuntimeMigrationFiles>[1]) =>
      actual.applyRuntimeMigrationFiles(pool, phase.beforeNumbering ? files.filter(file => file.version !== "0080") : files),
  };
});
const db = await import("../../lib/db");
const { loadMigrationFiles } = await import("../../lib/migration-files");
const { inspectSchemaReadOnly } = await import("../../lib/schema-preflight");
afterAll(async () => { await db.resetPoolForTesting(); });

it("upgrades the main0087 runtime registry with gaps by only adding0080; restart preserves identity and all prior registry records", async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  const q = (sql: string) => db.getPool().query(sql);
  const registryBefore = (await q("SELECT * FROM schema_migrations ORDER BY version")).rows;
  expect(registryBefore.some(row => row.version === "0087")).toBe(true);
  expect(registryBefore.some(row => row.version === "0080")).toBe(false);
  await q("INSERT INTO patients(patient_number,full_name) VALUES('P-00012','Synthetic pre-numbering paper file')");
  const before = (await q("SELECT id,patient_number,full_name FROM patients ORDER BY id")).rows;
  const files = await loadMigrationFiles();
  const preflight = async () => {
    const client = await db.getPool().connect();
    try { return await inspectSchemaReadOnly(client, files, { patientNumberingReadiness: true }); }
    finally { client.release(); }
  };
  const oldReport = await preflight();
  expect(oldReport.registry.missingVersions).toContain("0080");
  // Missing legacy registrations remain visible; numbering cannot silently adopt them.
  expect(oldReport.registry.missingVersions.length).toBeGreaterThan(1);
  expect(oldReport.patientNumberingReadiness).toEqual({ ready: true, ambiguousAliasGroups: 0 });
  phase.beforeNumbering = false;
  await db.resetPoolForTesting();
  await db.ensureSchema();
  expect((await q("SELECT * FROM schema_migrations WHERE version<>'0080' ORDER BY version")).rows).toEqual(registryBefore);
  expect((await q("SELECT id,patient_number,full_name FROM patients ORDER BY id")).rows).toEqual(before);
  expect((await q("SELECT * FROM retired_patient_numbers")).rows).toEqual([]);
  const newReport = await preflight();
  expect(newReport.registry.missingVersions).toEqual(oldReport.registry.missingVersions.filter(version => version !== "0080"));
  expect(newReport.registry.unknownVersions).toEqual(oldReport.registry.unknownVersions);
  expect(newReport.registry.checksumMismatches).toEqual([]);
  const registryAfter = (await q("SELECT * FROM schema_migrations ORDER BY version")).rows;
  await db.resetPoolForTesting();
  await db.ensureSchema();
  expect((await q("SELECT * FROM schema_migrations ORDER BY version")).rows).toEqual(registryAfter);
  expect((await q("SELECT id,patient_number,full_name FROM patients ORDER BY id")).rows).toEqual(before);
  expect((await q("SELECT aqlan_allocate_patient_number() AS number")).rows).toEqual([{ number: "P-07000" }]);
});
