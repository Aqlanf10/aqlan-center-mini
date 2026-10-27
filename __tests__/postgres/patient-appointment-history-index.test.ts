import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool } from "pg";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { applyRuntimeMigrationFiles, loadMigrationFiles, migrate } from "../../lib/migrations";
import { checksumOf, type MigrationFile } from "../../lib/migration-files";
import { PATIENT_APPOINTMENT_HISTORY_SQL } from "../../lib/patient-appointment-history-schema";
import { compareDetailedSchemaCatalogs, projectDetailedSchemaReadOnly } from "../../lib/schema-manifest";
import { classifyOpenFindings, parseOpenFindingsManifest } from "../../lib/schema-ownership-open-findings";
import openFindings from "../../schema/schema-ownership-open-findings.pg18.json";
import { RESET_KEEP_TABLES, RESET_WIPE_TABLES } from "../../lib/clinic-reset";

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let files: MigrationFile[], index: MigrationFile;
let db: typeof import("../../lib/db");
const saved = { DATABASE_URL: process.env.DATABASE_URL, SKIP_SEED: process.env.SKIP_SEED };
const definition = "CREATE INDEX appointments_patient_history_idx ON public.appointments USING btree (patient_id, scheduled_date, scheduled_time, id)";
const rows = async (pool: Pool) => {
  const out: Record<string, unknown[]> = {};
  for (const table of ["patients", "appointments", "invoices", "invoice_items", "payments", "cashier_shifts"]) {
    out[table] = (await pool.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY id`)).rows;
  }
  return out;
};
const registry = async (pool: Pool) => (await pool.query("SELECT version,name,checksum,adopted FROM schema_migrations WHERE version='0067'")).rows;
const catalog = async (pool: Pool) => (await pool.query(`SELECT pg_get_indexdef(i.indexrelid) AS definition,
  i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique, i.indpred IS NULL AS unfiltered
  FROM pg_index i WHERE i.indexrelid=to_regclass('public.appointments_patient_history_idx')`)).rows;
const expectedRegistry = () => [{ version: index.version, name: index.name, checksum: index.checksum, adopted: false }];
async function runtimeAt(pool: Pool) {
  await db.resetPoolForTesting();
  process.env.DATABASE_URL = pool.options.connectionString!; process.env.SKIP_SEED = "true";
  await db.ensureSchema(); await db.resetPoolForTesting();
}
async function seed(pool: Pool) {
  const patient = (await pool.query("INSERT INTO patients(patient_number,full_name) VALUES('INDEX-SYNTHETIC','Synthetic index patient') RETURNING id")).rows[0];
  await pool.query(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status)
    SELECT $1,'2026-10-22'::date-n,'09:00'::time+(n%3)*interval '0.000001 second',
      CASE WHEN n%2=0 THEN 'booked' ELSE 'done' END FROM generate_series(-30,45) n`, [patient.id]);
  const invoice = (await pool.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency) VALUES('INDEX-SYNTHETIC',$1,12000,'YER') RETURNING id", [patient.id])).rows[0];
  await pool.query("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Synthetic existing treatment',1,12000,12000)", [invoice.id]);
  const shift = (await pool.query("INSERT INTO cashier_shifts(opened_by) VALUES('synthetic-index-test') RETURNING id")).rows[0];
  await pool.query("INSERT INTO payments(receipt_number,shift_id,invoice_id,patient_id,amount_minor,currency,base_amount_minor,method) VALUES('INDEX-SYNTHETIC',$3,$1,$2,3000,'YER',3000,'cash')", [invoice.id, patient.id, shift.id]);
}
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  files = await loadMigrationFiles(); index = files.find(file => file.version === "0067")!;
  expect(index.sql).toBe(PATIENT_APPOINTMENT_HISTORY_SQL);
  for (const pool of [fixture.source, fixture.sqlTarget]) {
    await migrate(pool, { apply: true, files: files.filter(file => file.version <= "0065") });
    await seed(pool);
  }
  db = await import("../../lib/db");
});
afterAll(async () => {
  try { await db?.resetPoolForTesting(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fixture?.close();
  }
});

it("rolls back ordinary index lock timeout and later SQL failure without changing rows or registration", async () => {
  const pool = fixture.source, before = await rows(pool);
  const writer = new Pool({ connectionString: pool.options.connectionString!, ssl: false, max: 1 });
  try {
    await writer.query("BEGIN"); await writer.query("UPDATE appointments SET note=note WHERE id=1");
    // Test-only bound. The production SQL does not change lock/timeout settings.
    await pool.query("SET lock_timeout='100ms'");
    await expect(applyRuntimeMigrationFiles(pool, [index])).rejects.toMatchObject({ code: "55P03" });
  } finally {
    await writer.query("ROLLBACK"); await writer.end(); await pool.query("RESET lock_timeout");
  }
  expect(await catalog(pool)).toEqual([]); expect(await registry(pool)).toEqual([]);
  const sql = `${index.sql}\nSELECT 1 / 0;\n`;
  await expect(applyRuntimeMigrationFiles(pool, [{ ...index, sql, checksum: checksumOf(sql) }])).rejects.toThrow("division by zero");
  expect(await catalog(pool)).toEqual([]); expect(await registry(pool)).toEqual([]);
  expect(await rows(pool)).toEqual(before);
});

it("refuses a conflicting unregistered index without replacing or adopting it", async () => {
  const pool = fixture.source, before = await rows(pool);
  await pool.query("CREATE INDEX appointments_patient_history_idx ON appointments (scheduled_date)");
  const existing = await catalog(pool);
  try {
    await expect(applyRuntimeMigrationFiles(pool, [index])).rejects.toMatchObject({ code: "42P07" });
    expect(await catalog(pool)).toEqual(existing); expect(await registry(pool)).toEqual([]);
    expect(await rows(pool)).toEqual(before);
  } finally { await pool.query("DROP INDEX appointments_patient_history_idx"); } // This test's synthetic collision only.
});

it("serializes numbered/runtime racers and retries idempotently on a populated 0065 schema", async () => {
  const pool = fixture.source, before = await rows(pool);
  const competitor = new Pool({ connectionString: pool.options.connectionString!, ssl: false });
  try {
    const [runtime, numbered] = await Promise.all([applyRuntimeMigrationFiles(pool, [index]), migrate(competitor, { apply: true, files })]);
    expect([...runtime, ...numbered.appliedVersions].sort()).toEqual(["0066", "0067", "0068", "0069", "0078", "0087"]);
  } finally { await competitor.end(); }
  const oid = (await pool.query("SELECT 'appointments_patient_history_idx'::regclass::oid AS oid")).rows;
  expect(await applyRuntimeMigrationFiles(pool, [index])).toEqual([]);
  expect((await migrate(pool, { apply: true, files })).appliedVersions).toEqual([]);
  expect((await pool.query("SELECT 'appointments_patient_history_idx'::regclass::oid AS oid")).rows).toEqual(oid);
  expect(await registry(pool)).toEqual(expectedRegistry()); expect(await rows(pool)).toEqual(before);
});

it("upgrades through actual runtime and fresh runtime with the exact index, no financial or patient row changes", async () => {
  const before = await rows(fixture.sqlTarget);
  await runtimeAt(fixture.sqlTarget); await runtimeAt(fixture.sqlTarget);
  expect(await rows(fixture.sqlTarget)).toEqual(before);
  await runtimeAt(fixture.archiveTarget);
  for (const pool of [fixture.source, fixture.sqlTarget, fixture.archiveTarget]) {
    expect(await registry(pool)).toEqual(expectedRegistry());
    expect(await catalog(pool)).toEqual([{ definition, valid: true, ready: true, unique: false, unfiltered: true }]);
    expect((await pool.query("SELECT to_regclass('public.agreement_delta_amendments') AS name")).rows[0].name).toBe("agreement_delta_amendments");
  }
  const comparison = compareDetailedSchemaCatalogs(await projectDetailedSchemaReadOnly(fixture.source), await projectDetailedSchemaReadOnly(fixture.archiveTarget));
  const classified = classifyOpenFindings(comparison, parseOpenFindingsManifest(openFindings));
  expect(classified.characterizationOk).toBe(true);
  expect(classified.openConvergenceFindings).toHaveLength(16); expect(classified.unexpectedDifferences).toEqual([]);
});

it("adds no reset ownership, and keeps the index and registry through backup-protected synthetic reset", async () => {
  await runtimeAt(fixture.sqlTarget);
  const tables = (await fixture.sqlTarget.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
  expect([...RESET_KEEP_TABLES, ...RESET_WIPE_TABLES].sort()).toEqual(tables);
  const prior = await catalog(fixture.sqlTarget), registration = await registry(fixture.sqlTarget);
  let backup = "";
  const result = await db.resetClinicData({ actor: "synthetic-index-test", actorRole: "admin" }, async client => {
    for await (const line of db.backupSqlLines(client)) backup += line;
    return { ok: true, backupId: "synthetic-index-reset-backup" };
  });
  expect(result).toMatchObject({ ok: true, backupId: "synthetic-index-reset-backup", counts: { patients: 1, appointments: 76 } });
  expect(backup).toContain("INDEX-SYNTHETIC"); expect(backup).toContain("Synthetic existing treatment");
  expect(await catalog(fixture.sqlTarget)).toEqual(prior); expect(await registry(fixture.sqlTarget)).toEqual(registration);
  expect((await fixture.sqlTarget.query("SHOW session_replication_role")).rows[0].session_replication_role).toBe("origin");
});
