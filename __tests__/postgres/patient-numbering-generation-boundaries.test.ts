import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client, type Pool, type PoolClient } from "pg";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as db from "../../lib/db";
import { parseCsv } from "../../lib/patient-import";
import { executeNumberingCommand } from "../../lib/patient-numbering-command";
import { withPatientNumberingInsertScope } from "../../lib/patient-numbering-insert-scope";
import { SyntheticNumberingWriterAdmission } from "../../lib/patient-numbering-writer-generation";
import { ownerContextFromTrustedBinding, resolveStaffCapabilities } from "../../lib/staff-capabilities";
import { validateLocalVerificationTarget } from "../../lib/verification-target-policy.mjs";
import { validatePostgresTestTarget } from "./_safe-target";
import { NumberingPgFixture } from "./fixtures/patient-numbering-adapter";

const target = validatePostgresTestTarget(process.env);
const lineage = "ba3f640b-1234-4b62-9c16-d9f49f5c8d32";
const legacy = { version: 1, lineage, mode: "LEGACY", generation: "1" } as const;
const fenced = { ...legacy, mode: "FENCED", generation: "2" } as const;
const managed = { ...legacy, mode: "MANAGED", generation: "3" } as const;
const identitySql = "SELECT oid::text, datdba::text AS owner FROM pg_database WHERE datname=$1";
const owner = () => resolveStaffCapabilities({
  subject: { userId: 99, role: "admin", isActive: true, clinicianPartyId: null },
  permissionDocument: { schemaVersion: 2, confirmation: "owner", revision: 1, patientScope: "none", appointmentScope: "none", grants: {} },
}, ownerContextFromTrustedBinding({ ownerUserId: 99, bindingVersion: "synthetic-writer-boundary" }));
type Exercise = { key: string; firstDomain: RegExp; also?: RegExp[]; act: () => Promise<unknown> };
let name: string, admin: Client, owned: { oid: string; owner: string } | undefined;
let pool: Pool, allocator: NumberingPgFixture, gate: SyntheticNumberingWriterAdmission;
let exercises: Exercise[], visit: number, booking: number;
const input = (label: string) => ({
  fullName: "SYNTHETIC GENERATION " + label, phone: null, altPhone: null, gender: "unknown" as const,
  birthYear: null, address: null, medicalAlert: null, note: null,
});

beforeEach(async () => {
  owned = undefined;
  name = "aqlan_numbering_boundary_" + randomUUID().replaceAll("-", "");
  const url = new URL(target.testUrl);
  url.pathname = "/" + name;
  validateLocalVerificationTarget(url.toString(), process.env, { varName: "OWNED_NUMBERING_BOUNDARY", databaseName: name });
  admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  owned = (await admin.query<{ oid: string; owner: string }>(identitySql, [name])).rows[0];
  if (!owned) throw new Error("Synthetic boundary database identity not established");

  await db.resetPoolForTesting();
  vi.stubEnv("DATABASE_URL", url.toString());
  vi.stubEnv("SKIP_SEED", "true");
  pool = db.getPool() as unknown as Pool;
  expect((await pool.query(
    "SELECT current_database() AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()",
  )).rows).toEqual([{ name, ...owned }]);
  await db.ensureSchema();
  expect((await db.createPatient(input("HISTORICAL"))).patientNumber).toBe("P-07000");
  visit = (await db.addVisit({ patientName: "SYNTHETIC GENERATION WALK-IN", patientPhone: null, note: null })).id;
  booking = (await db.createBookingRequest({
    fullName: "SYNTHETIC GENERATION BOOKING", phone: "999900018", reason: null,
    preferredDate: null, preferredPeriod: "any",
  }, "synthetic-generation-boundary")).id;
  const schema = "numbering_generation_fixture_" + randomUUID().replaceAll("-", "");
  await pool.query(`
    CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.generation_state (
      id int PRIMARY KEY CHECK(id=1), version int NOT NULL CHECK(version=1), lineage uuid NOT NULL,
      phase text NOT NULL CHECK(phase IN ('LEGACY','FENCED','MANAGED')), generation bigint NOT NULL CHECK(generation>0)
    );
    CREATE TABLE ${schema}.generation_receipts (
      request_id text PRIMARY KEY, intent text NOT NULL, before_state jsonb NOT NULL, applied_state jsonb NOT NULL
    );
  `);
  await pool.query(`INSERT INTO ${schema}.generation_state VALUES(1,1,$1,'LEGACY',1)`, [lineage]);
  gate = new SyntheticNumberingWriterAdmission({
    pool, schema, lineage,
    verifyManagedHandoff: async (client, state) => state.mode === "FENCED"
      && (await client.query("SELECT current_database() AS name")).rows[0]?.name === name,
  });
  allocator = new NumberingPgFixture(pool, "numbering_fixture_" + randomUUID().replaceAll("-", ""), async () => owner());
  await allocator.initialize();
  expect(await executeNumberingCommand({
    prefix: "A", next: "1500", expectedRevision: (await allocator.preview("A")).revision,
    requestId: "synthetic_boundary_preset", reason: "Synthetic boundary setup",
  }, allocator)).toMatchObject({ ok: true });
  const csv = "الاسم,الهاتف,رقم الملف\nSYNTHETIC GENERATION IMPORT,,900000";
  const date = "2026-11-19";
  exercises = [
    { key: "ordinary", firstDomain: /pg_advisory_xact_lock_shared.*patient_import/, act: () => db.createPatient(input("ORDINARY")) },
    { key: "walk-in", firstDomain: /FROM visits WHERE id = \$1 FOR UPDATE/, also: [/pg_advisory_xact_lock_shared.*patient_import/],
      act: () => db.openVisitPatientFile(visit) },
    { key: "CSV", firstDomain: /pg_advisory_xact_lock\(hashtext\('patient_import'\)\)/, act: () => db.commitPatientImport({
      rows: parseCsv(csv), fileSha256: createHash("sha256").update(csv).digest("hex"), fileName: "synthetic-boundary.csv",
      today: date, includePossibleDuplicates: false, actor: "Synthetic import", actorRole: "admin",
    }) },
    { key: "booking", firstDomain: /appointments-day:/, also: [/FROM booking_requests .*FOR UPDATE/, /pg_advisory_xact_lock_shared.*patient_import/],
      act: () => db.writeAppointmentInDay({
        date, judge: () => ({ ok: true }),
        commit: client => db.confirmBookingRequest({ id: booking, date, time: "12:00", durationMinutes: 30 }, client),
      }) },
  ];
});
afterEach(async () => {
  const failures: unknown[] = [];
  try { await db.resetPoolForTesting(); } catch (error) { failures.push(error); }
  vi.unstubAllEnvs();
  try {
    if (owned && /^aqlan_numbering_boundary_[0-9a-f]{32}$/.test(name)) {
      for (let attempt = 0;; attempt++) {
        if (JSON.stringify((await admin.query(identitySql, [name])).rows[0]) !== JSON.stringify(owned)) {
          throw new Error("Synthetic boundary database identity changed; cleanup refused");
        }
        try { await admin.query(`DROP DATABASE "${name}"`); break; }
        catch (error) { if ((error as {code?: string}).code !== "55006" || attempt === 4) throw error; await delay(100); }
      }
    }
  } catch (error) { failures.push(error); }
  try { await admin?.end(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Owned boundary fixture cleanup failed");
});

async function fence() {
  expect(await gate.transition({ expected: legacy, target: "FENCED", requestId: "synthetic_bound_fence" })).toMatchObject({
    ok: true, value: { current: fenced },
  });
}
async function manage() {
  await fence();
  expect(await gate.transition({ expected: fenced, target: "MANAGED", requestId: "synthetic_bound_manage" })).toMatchObject({
    ok: true, value: { current: managed },
  });
}
async function invokeAtRealBoundary(exercise: Exercise, token: unknown) {
  const trace: string[] = [];
  let connects = 0;
  const appPool = db.getPool();
  const connectOriginal = (pool.connect as unknown as (...args: unknown[]) => Promise<PoolClient> | void).bind(pool);
  // Instrument only the owned fixture's explicit transactional clients. Pool
  // queries use callback connect and remain unchanged. No app import mounts it.
  const connect = (...args: unknown[]): void | Promise<db.DbClient> => {
    if (args.length > 0) return connectOriginal(...args);
    return (connectOriginal() as Promise<PoolClient>).then(real => {
      connects++;
      const client: db.DbClient = {
        release: destroy => real.release(destroy),
        async query<Row>(sql: string, values?: unknown[]): Promise<db.QueryResult<Row>> {
          trace.push(sql.trim().replace(/\s+/g, " "));
          const result = await real.query(sql, values);
          if (sql === "BEGIN") {
            try { await gate.admitExistingTransaction(client, token); }
            catch (error) {
              // BEGIN already reached PG, though its caller has not yet set
              // began=true. Roll back at the fixture seam before surfacing it.
              await client.query("ROLLBACK");
              throw error;
            }
          }
          return result as db.QueryResult<Row>;
        },
      };
      return client;
    });
  };
  const spy = vi.spyOn(appPool, "connect").mockImplementation(connect as () => Promise<db.DbClient>);
  try {
    const value = await withPatientNumberingInsertScope(client => allocator.allocateInExistingTransaction(client), exercise.act);
    return { ok: true as const, value, trace, connects };
  } catch (error) {
    return { ok: false as const, error, trace, connects };
  } finally { spy.mockRestore(); }
}
const patientNumbers = async () => (await pool.query("SELECT patient_number FROM patients ORDER BY patient_number")).rows.map(r => r.patient_number);
const isAdmission = (sql: string) => sql.startsWith("/* numbering-writer-admission */") && sql.endsWith("FOR SHARE");

it("takes shared admission before each real domain lock and allocates through all four actual transaction boundaries", async () => {
  await manage();
  for (const exercise of exercises) {
    const result = await invokeAtRealBoundary(exercise, managed);
    if (!result.ok) throw result.error;
    expect(result.connects, exercise.key).toBe(1);
    expect(result.trace[0], exercise.key).toBe("BEGIN");
    expect(isAdmission(result.trace[1]), exercise.key).toBe(true);
    const firstDomain = result.trace.findIndex(sql => exercise.firstDomain.test(sql));
    expect(firstDomain, exercise.key).toBeGreaterThan(1);
    const allocatorLock = result.trace.findIndex(sql => sql.includes(`${allocator.schema}.config WHERE id=1 FOR UPDATE`));
    expect(allocatorLock, exercise.key).toBeGreaterThan(firstDomain);
    for (const lock of exercise.also ?? []) {
      const index = result.trace.findIndex(sql => lock.test(sql));
      expect(index, exercise.key).toBeGreaterThanOrEqual(firstDomain);
      expect(index, exercise.key).toBeLessThan(allocatorLock);
    }
    expect(result.trace.at(-1), exercise.key).toBe("COMMIT");
  }
  expect(await patientNumbers()).toEqual(["A-01500", "A-01501", "A-01502", "A-01503", "P-07000"]);
  expect((await pool.query("SELECT status, appointment_id IS NOT NULL AS linked FROM booking_requests WHERE id=$1", [booking])).rows)
    .toEqual([{ status: "confirmed", linked: true }]);
});
it.each([["FENCED", "writers-fenced"], ["stale", "stale-generation"]] as const)(
  "blocks every %s path before its first domain lock and leaves rows/counters and links unchanged",
  async (mode, refused) => {
    if (mode === "FENCED") await fence(); else await manage();
    const token = mode === "FENCED" ? legacy : { ...managed, generation: "2" };
    for (const exercise of exercises) {
      const result = await invokeAtRealBoundary(exercise, token);
      expect(result.ok, exercise.key).toBe(false);
      if (result.ok) throw new Error("Synthetic writer admitted without current generation");
      expect(result.error, exercise.key).toMatchObject({ message: refused });
      expect(result.connects, exercise.key).toBe(1);
      expect(result.trace[0], exercise.key).toBe("BEGIN");
      expect(isAdmission(result.trace[1]), exercise.key).toBe(true);
      expect(result.trace.some(sql => exercise.firstDomain.test(sql)), exercise.key).toBe(false);
      expect(result.trace.some(sql => sql === "COMMIT" || sql.includes("nextval(")), exercise.key).toBe(false);
    }
    expect(await patientNumbers()).toEqual(["P-07000"]);
    expect((await allocator.preview("A")).pendingNext).toBe(1500n);
    expect((await pool.query("SELECT patient_id FROM visits WHERE id=$1", [visit])).rows).toEqual([{ patient_id: null }]);
    expect((await pool.query("SELECT status, appointment_id FROM booking_requests WHERE id=$1", [booking])).rows)
      .toEqual([{ status: "new", appointment_id: null }]);
    expect((await pool.query("SELECT count(*)::int AS n FROM appointments")).rows).toEqual([{ n: 0 }]);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='patient.import'")).rows).toEqual([{ n: 0 }]);
  },
);
it("rejects misuse with an autocommit pool before a domain callback can be offered", async () => {
  await manage();
  await expect(gate.admitExistingTransaction(pool, managed)).rejects.toThrow("writer-transaction-failed");
  expect((await allocator.preview("A")).pendingNext).toBe(1500n);
});
