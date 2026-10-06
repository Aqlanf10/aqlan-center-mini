import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPostgresMajorOrThrow, postgresMajorFromVersionNum } from "../../lib/env-contract";
import { FOLLOWUP_SERVICE_REVIEW_MESSAGE } from "../../lib/ortho-booking-intent";
import type { AppointmentServiceInput } from "../../lib/appointment-services";
import type { BookAppointmentInput, BookingResult } from "../../lib/book-appointment";
import { validatePostgresTestTarget } from "./_safe-target";

// Real PostgreSQL18 only. Fresh UUID-owned database; no mocks, shared schema
// reset, Production target, connection termination, or FORCE cleanup. Actual
// wait edges (pg_blocking_pids) establish race order; delays only bound polling.
const original = { ...process.env };
const database = `aqlan_ortho_booking_${randomUUID().replace(/-/g, "")}`;
let maintenanceUrl = ""; let testUrl = ""; let created = false;
let db: typeof import("../../lib/db"); let bookAppointment: typeof import("../../lib/book-appointment")["bookAppointment"];
let observer: Client; let serviceId = 0; let sequence = 0;
const actor = { username: "synthetic-atomic-followup", role: "reception", channel: "ui" as const };
const serviceInput = (changes: Partial<AppointmentServiceInput> = {}): AppointmentServiceInput => ({
  code: "ORTHO_FOLLOW_UP", nameAr: "Synthetic periodic service", specialty: "orthodontics", defaultDurationMinutes: 10,
  bufferBeforeMinutes: 1, bufferAfterMinutes: 2, requiresProvider: false, requiresChair: true,
  allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 50, isActive: true, sortOrder: 1, ...changes,
});
async function edit(changes: Partial<AppointmentServiceInput>) {
  const result = await db.updateAppointmentService(serviceId, serviceInput(changes), { actor: actor.username, actorRole: "admin" });
  expect(result.ok).toBe(true); return result;
}
async function external() { const client = new Client({ connectionString: testUrl, ssl: false, statement_timeout: 15_000 }); await client.connect(); return client; }
beforeAll(async () => {
  const target = validatePostgresTestTarget(original);
  if (original.USE_LOCAL_DB === "true" || !/^aqlan_ortho_booking_[a-f0-9]{32}$/.test(database)) throw new Error("Unsafe atomic booking fixture target");
  maintenanceUrl = target.maintenanceUrl.toString();
  const admin = new Client({ connectionString: maintenanceUrl, ssl: false }); await admin.connect();
  try {
    const version = (await admin.query<{ version: string }>("SELECT current_setting('server_version_num') AS version")).rows[0].version;
    assertPostgresMajorOrThrow(postgresMajorFromVersionNum(version));
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    await admin.query(`ALTER DATABASE ${database} SET lock_timeout = '12s'`);
  } finally { await admin.end(); }
  target.testUrl.pathname = `/${database}`; testUrl = target.testUrl.toString();
  vi.stubEnv("DATABASE_URL", testUrl); vi.stubEnv("DATABASE_ENVIRONMENT", "test"); vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("USE_LOCAL_DB", "false"); vi.stubEnv("SKIP_SEED", "true"); vi.stubEnv("DB_POOL_MAX", "8"); vi.stubEnv("CLINIC_TIME_ZONE", "Asia/Aden");
  db = await import("../../lib/db"); await db.resetPoolForTesting(); await db.ensureSchema();
  ({ bookAppointment } = await import("../../lib/book-appointment"));
  const result = await db.createAppointmentService(serviceInput(), { actor: actor.username, actorRole: "admin" });
  if (!result.ok) throw new Error(result.message); serviceId = result.service.id;
  await db.getPool().query("UPDATE appointment_services SET legacy_type='follow_up' WHERE id=$1", [serviceId]);
  await db.saveSettings({ "clinic.day_start": "09:00", "clinic.day_end": "18:00", "clinic.chairs": "4" });
  observer = await external();
  // A fixture-only INSERT barrier pauses the actual booking writer after its
  // judge. It takes an otherwise-unused patient-scoped advisory lock.
  await observer.query(`CREATE FUNCTION synthetic_followup_insert_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(171204, NEW.patient_id); RETURN NEW; END $$;
    CREATE TRIGGER synthetic_followup_insert_barrier BEFORE INSERT ON appointments
      FOR EACH ROW EXECUTE FUNCTION synthetic_followup_insert_barrier()`);
}, 120_000);
beforeEach(async () => { await edit({}); });
afterAll(async () => {
  const errors: unknown[] = [];
  try { await observer?.end(); } catch (error) { errors.push(error); }
  try { if (db) await db.resetPoolForTesting(); } catch (error) { errors.push(error); }
  vi.unstubAllEnvs();
  if (created) {
    const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
    try {
      await admin.connect(); const deadline = performance.now() + 8_000;
      while ((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1", [database])).rows[0].n > 0) {
        if (performance.now() > deadline) throw new Error("Owned atomic booking connections did not drain");
        await delay(20);
      }
      await admin.query(`DROP DATABASE ${database}`);
    } catch (error) { errors.push(error); }
    finally { try { await admin.end(); } catch (error) { errors.push(error); } }
  }
  if (errors.length) throw new AggregateError(errors, "Atomic booking fixture cleanup failed");
});

async function fixture(): Promise<{ patientId: number; caseId: number; request: BookAppointmentInput }> {
  const serial = ++sequence;
  const patientId = (await observer.query<{ id: number }>(
    "INSERT INTO patients (patient_number,full_name) VALUES ($1,$2) RETURNING id", [`ATOMIC-${serial}`, `Synthetic atomic patient ${serial}`],
  )).rows[0].id;
  const caseId = (await observer.query<{ id: number }>(
    "INSERT INTO ortho_cases (patient_id,start_date,created_by) VALUES ($1,'2026-01-01',$2) RETURNING id", [patientId, actor.username],
  )).rows[0].id;
  return { patientId, caseId, request: { patientId, date: `2030-01-${String(serial).padStart(2, "0")}`, time: "10:00",
    durationMinutes: 15, serviceId, appointmentType: "follow_up", bookingIntent: "ortho_follow_up" } };
}
async function blockedBy(pid: number, query: string, finished?: () => boolean): Promise<number> {
  const deadline = performance.now() + 6_000;
  while (performance.now() < deadline) {
    const rows = (await observer.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE datname=$1 AND $2=ANY(pg_blocking_pids(pid)) AND query ILIKE $3", [database, pid, `%${query}%`],
    )).rows;
    if (rows.length) { expect(rows).toHaveLength(1); return rows[0].pid; }
    if (finished?.()) throw new Error("Expected lock wait did not occur before operation completed");
    await delay(10);
  }
  throw new Error(`Expected owned database lock wait was not observed for ${query}`);
}
async function pid(client: Client) { return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid; }
async function appointmentSnapshot(patientId: number) {
  return (await observer.query(`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM appointments a WHERE a.patient_id=$1) AS appointments,
    (SELECT jsonb_build_object('last',last_value,'called',is_called) FROM appointments_id_seq) AS sequence,
    (SELECT to_jsonb(p) FROM patients p WHERE p.id=$1) AS patient,
    (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM ortho_cases c WHERE c.patient_id=$1) AS cases,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM invoices i WHERE i.patient_id=$1) AS invoices,
    (SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.id),'[]'::jsonb) FROM visits v WHERE v.patient_id=$1) AS visits`, [patientId])).rows;
}
async function dayBlocker(date: string) {
  const client = await external(); await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('appointments-day:' || $1))", [date]); return client;
}

// Promise outcomes are retained for finally cleanup; no unhandled rejection can
// escape while the test deliberately holds the transaction's progress barrier.
function observe<T>(promise: Promise<T>) {
  let done = false;
  const result = promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })).finally(() => { done = true; });
  return { result, done: () => done, unwrap: async () => { const value = await result; if (!value.ok) throw value.error; return value.value; } };
}

describe("protected follow-up service admission is atomic with booking", () => {
  it.each(["inactive", "specialty"])("rejects an editor winning after preflight but before the day lock: %s", async (change) => {
    const f = await fixture(); const blocker = await dayBlocker(f.request.date); const booking = observe(bookAppointment(f.request, actor));
    try {
      await blockedBy(await pid(blocker), "appointments-day:", booking.done);
      await edit(change === "inactive" ? { isActive: false } : { specialty: "endodontics" });
      const before = await appointmentSnapshot(f.patientId);
      await blocker.query("COMMIT");
      expect(await booking.unwrap()).toEqual({ ok: false, status: 400, message: FOLLOWUP_SERVICE_REVIEW_MESSAGE });
      expect(await appointmentSnapshot(f.patientId)).toEqual(before);
    } finally { await blocker.query("ROLLBACK"); await blocker.end(); await booking.result; }
  }, 30_000);

  it.each([undefined, 45])("refreshes valid locked metadata, using the new default only when duration is omitted (%s)", async (durationMinutes) => {
    const f = await fixture(); const blocker = await dayBlocker(f.request.date);
    const booking = observe(bookAppointment({ ...f.request, durationMinutes }, actor));
    try {
      await blockedBy(await pid(blocker), "appointments-day:", booking.done);
      await edit({ defaultDurationMinutes: 20, bufferBeforeMinutes: 4, bufferAfterMinutes: 7, requiresChair: false });
      await blocker.query("COMMIT"); expect(await booking.unwrap()).toMatchObject({ ok: true });
      expect((await observer.query("SELECT duration_minutes,buffer_before_minutes,buffer_after_minutes,occupies_chair FROM appointments WHERE patient_id=$1", [f.patientId])).rows)
        .toEqual([{ duration_minutes: durationMinutes ?? 20, buffer_before_minutes: 4, buffer_after_minutes: 7, occupies_chair: false }]);
      const row = (await db.orthoFollowupBoard("2026-10-05")).find((row) => row.caseId === f.caseId)!;
      expect(row.nextAppointment).toMatchObject({ date: f.request.date, appointmentType: "follow_up", matchBasis: "designated_service" });
    } finally { await blocker.query("ROLLBACK"); await blocker.end(); await booking.result; }
  }, 30_000);

  it("holds the checked service against the normal editor until booking commits", async () => {
    const f = await fixture(); const blocker = await external(); await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(171204,$1)", [f.patientId]);
    const booking = observe(bookAppointment(f.request, actor)); let editing: ReturnType<typeof observe<Awaited<ReturnType<typeof edit>>>> | undefined;
    try {
      const bookingPid = await blockedBy(await pid(blocker), "INSERT INTO appointments", booking.done);
      editing = observe(edit({ specialty: "endodontics", defaultDurationMinutes: 60, bufferBeforeMinutes: 9, bufferAfterMinutes: 11, requiresChair: false }));
      await blockedBy(bookingPid, "UPDATE appointment_services", editing.done);
      expect(editing.done()).toBe(false); expect(booking.done()).toBe(false);
      expect((await observer.query("SELECT specialty FROM appointment_services WHERE id=$1", [serviceId])).rows).toEqual([{ specialty: "orthodontics" }]);
      await blocker.query("COMMIT");
      expect(await booking.unwrap()).toMatchObject({ ok: true }); expect(await editing.unwrap()).toMatchObject({ ok: true });
      expect((await observer.query("SELECT duration_minutes,buffer_before_minutes,buffer_after_minutes,occupies_chair FROM appointments WHERE patient_id=$1", [f.patientId])).rows)
        .toEqual([{ duration_minutes: 15, buffer_before_minutes: 1, buffer_after_minutes: 2, occupies_chair: true }]);
      // The later editor is permitted after commit. Historical classification
      // can then reflect the edit; this contract guarantees transaction order.
      expect((await observer.query("SELECT specialty FROM appointment_services WHERE id=$1", [serviceId])).rows).toEqual([{ specialty: "endodontics" }]);
    } finally { await blocker.query("ROLLBACK"); await blocker.end(); await booking.result; await editing?.result; }
  }, 30_000);

  it("lets two different-day bookings hold compatible service read locks concurrently", async () => {
    const fixtures = [await fixture(), await fixture()];
    const blockers = [await external(), await external()];
    const bookings: Array<ReturnType<typeof observe<BookingResult>>> = [];
    try {
      for (let index = 0; index < blockers.length; index++) {
        await blockers[index].query("BEGIN");
        await blockers[index].query("SELECT pg_advisory_xact_lock(171204,$1)", [fixtures[index].patientId]);
        bookings.push(observe(bookAppointment(fixtures[index].request, actor)));
      }
      // Both writers must reach INSERT while the other service SHARE lock is
      // still held. An unnecessarily exclusive row lock would deadlock this proof.
      const pids = await Promise.all(blockers.map(async (blocker, index) =>
        blockedBy(await pid(blocker), "INSERT INTO appointments", bookings[index].done)));
      expect(new Set(pids).size).toBe(2);
      await Promise.all(blockers.map((blocker) => blocker.query("COMMIT")));
      for (const booking of bookings) expect(await booking.unwrap()).toMatchObject({ ok: true });
      expect((await observer.query("SELECT count(*)::int AS n FROM appointments WHERE patient_id=ANY($1::int[])", [fixtures.map((f) => f.patientId)])).rows[0].n).toBe(2);
    } finally {
      await Promise.all(blockers.map(async (blocker) => { await blocker.query("ROLLBACK"); await blocker.end(); }));
      await Promise.all(bookings.map((booking) => booking.result));
    }
  }, 30_000);

  it("releases the service row after capacity rejection without a leaked transaction", async () => {
    const f = await fixture(); await db.saveSettings({ "clinic.chairs": "1" });
    try {
      const first = await bookAppointment({ ...f.request, durationMinutes: 60 }, actor); expect(first.ok).toBe(true);
      const other = await fixture(); const before = await appointmentSnapshot(other.patientId);
      const refused: BookingResult = await bookAppointment({ ...other.request, date: f.request.date }, actor);
      expect(refused).toMatchObject({ ok: false, status: 409 }); expect(await appointmentSnapshot(other.patientId)).toEqual(before);
      expect(await edit({ isActive: false })).toMatchObject({ ok: true });
      expect((await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND state='idle in transaction'", [database])).rows[0].n).toBe(0);
    } finally { await db.saveSettings({ "clinic.chairs": "4" }); }
  }, 30_000);
});
