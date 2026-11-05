import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
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

it("characterizes exact cancelled booking0090 residue on the b554 main0089 composition without adopting it into candidate provenance", async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  const q = (sql: string) => db.getPool().query(sql);
  // Test-only historical fixture from cancelled PR492 head c69c0ac04db22d0971b1aecabaf7d0e595770e10,
  // blob 598faa8f495f3f5ead642ebdf060515770c366d0. This is NOT a candidate migration
  // or evidence of the actual Stage ledger. Do not add it to runtime registrations.
  const residue=await readFile(new URL("../fixtures/patient-numbering/cancelled-booking-0090.sql",import.meta.url),"utf8");
  const checksum=createHash("sha256").update(residue).digest("hex");
  expect(checksum).toBe("608eeee37b44a59cb4d26e915bd0b2610cf619103905be1fca0c2abe77c52e25");
  await q(residue);
  await db.getPool().query("INSERT INTO schema_migrations(version,name,checksum,adopted) VALUES('0090','booking_request_preferences',$1,false)",[checksum]);
  await q("INSERT INTO booking_requests(full_name,phone,request_key,request_hash,preferences) VALUES('Synthetic historical booking','777000111','synthetic-booking-key','synthetic-hash','{\"period\":\"morning\"}'::jsonb)");
  const bookingsBefore=(await q("SELECT * FROM booking_requests ORDER BY id")).rows;
  const catalogSql="SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='booking_requests' ORDER BY ordinal_position";
  const catalogBefore=(await q(catalogSql)).rows;
  const indexesBefore=(await q("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='booking_requests' ORDER BY indexname")).rows;
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
  expect((await q("SELECT * FROM booking_requests ORDER BY id")).rows).toEqual(bookingsBefore);
  expect((await q(catalogSql)).rows).toEqual(catalogBefore);
  expect((await q("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='booking_requests' ORDER BY indexname")).rows).toEqual(indexesBefore);
  await expect(q("INSERT INTO booking_requests(full_name,phone,request_key) VALUES('Synthetic duplicate','777000112','synthetic-booking-key')")).rejects.toMatchObject({code:"23505"});
  const historyBefore=(await q("SELECT * FROM schema_migrations ORDER BY version")).rows;
  const historyReport=await preflight();
  expect(historyReport.registry.unknownVersions).toEqual(["0090"]);
  expect(historyReport.registry.matchesFiles).toBe(false);
  expect(historyReport.schemaEquivalence).toBe("NOT_ASSESSED");
  expect((await q("SELECT * FROM schema_migrations ORDER BY version")).rows).toEqual(historyBefore);
  expect(files.some(file=>file.version==="0090")).toBe(false);
});
