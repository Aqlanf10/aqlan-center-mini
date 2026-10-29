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

it("upgrades the main0087/0089 runtime registry with gaps by only adding0080; restart preserves identity and all prior registry records", async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  const q = (sql: string) => db.getPool().query(sql);
  const registryBefore = (await q("SELECT * FROM schema_migrations ORDER BY version")).rows;
  expect(registryBefore.some(row => row.version === "0087")).toBe(true);
  expect(registryBefore.some(row => row.version === "0089")).toBe(true);
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
  // A rolled-back application can leave historical registrations. This synthetic
  // marker is not the cancelled portal SQL and is never treated as an allowlist.
  // Read-only readiness must disclose it without changing any durable evidence.
  await db.getPool().query(
    "INSERT INTO schema_migrations(version,name,checksum,adopted) VALUES($1,$2,$3,false)",
    ["0090", "synthetic_unknown_history", "a".repeat(64)],
  );
  const historyBefore = (await q("SELECT * FROM schema_migrations ORDER BY version")).rows;
  const patientsBeforeReadiness = (await q("SELECT * FROM patients ORDER BY id")).rows;
  const sequenceBeforeReadiness = (await q("SELECT * FROM patient_number_seq")).rows;
  const historyReport = await preflight();
  expect(historyReport.patientNumberingReadiness).toEqual({ ready: true, ambiguousAliasGroups: 0 });
  expect(historyReport.registry.unknownVersions).toEqual(["0090"]);
  expect(historyReport.registry.matchesFiles).toBe(false);
  expect(historyReport.schemaEquivalence).toBe("NOT_ASSESSED");
  expect((await q("SELECT * FROM schema_migrations ORDER BY version")).rows).toEqual(historyBefore);
  expect((await q("SELECT * FROM patients ORDER BY id")).rows).toEqual(patientsBeforeReadiness);
  expect((await q("SELECT * FROM patient_number_seq")).rows).toEqual(sequenceBeforeReadiness);
  expect((await q("SELECT * FROM retired_patient_numbers")).rows).toEqual([]);
});
