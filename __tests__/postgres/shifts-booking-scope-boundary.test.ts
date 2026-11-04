/** Synthetic cross-capability reproduction: appointment authority must not mint
 * access to another patient's receipts. No real accounts or financial data. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool, type PoolConfig } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { waitForBlockedBy } from "./_canonical-ready-fixture";
assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-shift-booking-scope-20261030");
const db = await import("../../lib/db");
const shifts = await import("../../lib/canonical-shifts");
const appointments = await import("../../lib/canonical-appointments");
const GRANTS = { "appointments.create": true, "appointments.edit": true, "finance.shifts.view": true, "finance.payments.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-SCOPE-OWNER", role: "admin" },
  hybrid: { username: "SYN-SCOPE-HYBRID", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "all", grants: GRANTS },
  scheduler: { username: "SYN-SCOPE-SCHEDULER", role: "reception", appointmentScope: "all", grants: { "appointments.create": true } },
  other: { username: "SYN-SCOPE-OTHER", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "own", grants: GRANTS },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, outside: number, receiptId: number, own: number;
const book = async (key: Key, patientId: number, doctorId: number | null, time: string, date = "2027-03-03") =>
  appointments.commandCanonicalBooking(await fx.session(key), appointments.parseCanonicalBooking({ patientId, doctorId, date, time, durationMinutes: 30 }));
const totals = async () => (await fx.pool.query(`SELECT
  (SELECT count(*)::int FROM appointments) AS appointments,
  (SELECT count(*)::int FROM audit_log WHERE action LIKE 'appointment.%' OR action='waiting_list.book') AS audits`)).rows[0];
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  side = new Pool({ ...(fx.pool as unknown as { options: PoolConfig }).options, max: 3 });
  outside = (await fx.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-SCOPE-OUT','SYN-OUTSIDE-RECEIPT-PATIENT') RETURNING id")).rows[0].id;
  own = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-SCOPE-OWN','SYN-OWN-PATIENT',$1) RETURNING id", [fx.parties.hybrid])).rows[0].id;
  for (const [key, value] of [["clinic.chairs", "2"], ["clinic.day_start", "08:00"], ["clinic.day_end", "20:00"]])
    await fx.pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [key,value]);
  await shifts.commandCanonicalShiftOpen(await fx.session("owner"), { opening: { YER: "100" } });
  const paid = await db.recordPayment({ patientId: outside, invoiceId: null, kind: "payment", amountMinor: 75, currency: "YER", exchangeRate: 1, baseCurrency: "YER", method: "cash", note: "SYN-OUTSIDE-RECEIPT-NOTE", createdBy: "synthetic-scope-fixture" });
  expect(paid.reason).toBeNull(); receiptId = paid.payment!.id;
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });

it("blocks the reproduced own-patient/all-appointment self-booking chain, with no appointment, audit or receipt disclosure", async () => {
  const session = await fx.session("hybrid");
  const before = await shifts.readCanonicalShifts(session), counts = await totals();
  expect(before.payments).toEqual([]);
  expect(await db.patientInDoctorScopeWith(fx.pool, fx.parties.hybrid!, outside)).toBe(false);
  await expect(appointments.commandCanonicalBooking(session, appointments.parseCanonicalBooking({
    patientId: outside, doctorId: fx.parties.hybrid, date: "2027-03-03", time: "09:00", durationMinutes: 30,
  }))).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const after = await shifts.readCanonicalShifts(session);
  expect(after.payments).toEqual([]);
  expect(after.receiptProvenance).not.toHaveProperty(String(receiptId));
  expect(JSON.stringify(after)).not.toContain("SYN-OUTSIDE-RECEIPT");
  expect(after.drawer).toEqual(before.drawer);
  expect(await totals()).toEqual(counts);
  expect(await db.patientInDoctorScopeWith(fx.pool, fx.parties.hybrid!, outside)).toBe(false);
});

it("keeps clinic-wide booking for another doctor and unassigned scheduling, without granting the booking actor the patient's receipts", async () => {
  const other = await book("hybrid", outside, fx.parties.other!, "10:00");
  expect(other.appointment.doctorId).toBe(fx.parties.other);
  const unassigned = await book("hybrid", outside, null, "10:00", "2027-03-10");
  expect(unassigned.appointment.doctorId).toBeNull();
  const feed = await shifts.readCanonicalShifts(await fx.session("hybrid"));
  expect(feed.payments).toEqual([]); expect(feed.drawer?.expected.YER).toBe(175);
});

it("keeps existing own-patient self-booking and the protected owner's whole-scope booking", async () => {
  expect((await book("hybrid", own, fx.parties.hybrid!, "11:00")).appointment.patientId).toBe(own);
  // Owner creates a legitimate appointment for another doctor, not a hidden
  // assignment to this restricted actor that would change the later fixtures.
  expect((await book("owner", outside, fx.parties.other!, "11:00", "2027-03-17")).appointment.patientId).toBe(outside);
  expect((await shifts.readCanonicalShifts(await fx.session("owner"))).payments?.map(row => row.id)).toEqual([receiptId]);
});

it("closes the waiting-list route to the same self-assignment chain, but preserves a permitted booking for another clinician", async () => {
  const id = (await fx.pool.query("INSERT INTO waiting_list(patient_id,urgency,preferred_period,created_by,duration_minutes) VALUES($1,'soon','any','synthetic',30) RETURNING id", [outside])).rows[0].id;
  const before = await totals();
  await expect(appointments.commandCanonicalWaitingBook(await fx.session("hybrid"), id, appointments.parseCanonicalWaitingBook({
    date: "2027-03-24", time: "09:00", doctorId: fx.parties.hybrid,
  }))).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  expect(await totals()).toEqual(before);
  expect((await fx.pool.query("SELECT status,appointment_id,booking_claim_at FROM waiting_list WHERE id=$1", [id])).rows[0])
    .toEqual({ status: "waiting", appointment_id: null, booking_claim_at: null });
  const booked = await appointments.commandCanonicalWaitingBook(await fx.session("hybrid"), id, appointments.parseCanonicalWaitingBook({
    date: "2027-03-24", time: "09:00", doctorId: fx.parties.other,
  }));
  expect(booked.appointment?.doctorId).toBe(fx.parties.other);
  expect((await shifts.readCanonicalShifts(await fx.session("hybrid"))).payments).toEqual([]);
});

it("checks membership after the day-lock wait, before its own insert could turn a stale relationship into authority", async () => {
  const patientId = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-SCOPE-WAIT','SYN-SCOPE-WAIT',$1) RETURNING id", [fx.parties.hybrid])).rows[0].id;
  const holder = await side.connect(), before = await totals(), date = "2027-04-06";
  try {
    await holder.query("BEGIN");
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtext('appointments-day:' || $1))", [date]);
    const pending = book("hybrid", patientId, fx.parties.hybrid!, "09:00", date); pending.catch(() => undefined);
    try {
      expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0);
      await holder.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [patientId]);
    } finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    expect(await totals()).toEqual(before);
  } finally { await holder.query("ROLLBACK"); holder.release(); }
});

it("two concurrent attempts cannot bootstrap the relationship for each other", async () => {
  const before = await totals();
  const results = await Promise.allSettled([
    book("hybrid", outside, fx.parties.hybrid!, "09:00", "2027-04-07"),
    book("hybrid", outside, fx.parties.hybrid!, "10:00", "2027-04-07"),
  ]);
  expect(results.every(result => result.status === "rejected" && /RECORD_SCOPE_DENIED/.test(String(result.reason)))).toBe(true);
  expect(await totals()).toEqual(before);
  expect((await shifts.readCanonicalShifts(await fx.session("hybrid"))).payments).toEqual([]);
});
