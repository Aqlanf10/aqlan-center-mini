/** M2 slice 19: canonical appointment deletion (DELETE /api/appointments/[id]) and the
 * freed-slot waiting-list match (GET /api/waiting-list?date=&time=, and the `waiting`
 * summary after a cancel or no-show) on real PostgreSQL, synthetic data only. Deletion
 * is one admitted `appointments.cancel` transaction (row locked, scope checked, audit
 * atomic); the match runs in one `read:waiting-list` snapshot over the scope only. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-delete-freed-2026");
const db = await import("../../lib/db");
const appointments = await import("../../lib/canonical-appointments");
const waiting = await import("../../lib/canonical-waiting-list");
const legacyMatch = await import("../../lib/waiting-list-match");

const DESK = { "appointments.edit": true, "appointments.cancel": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-DF-OWNER", role: "admin" },
  desk: { username: "SYN-DF-DESK", role: "reception", appointmentScope: "all", grants: DESK },
  editOnly: { username: "SYN-DF-EDIT", role: "admin", appointmentScope: "all", grants: { "appointments.edit": true } },
  doctor: { username: "SYN-DF-DOCTOR", role: "doctor", doctor: true, appointmentScope: "own", grants: DESK },
  other: { username: "SYN-DF-OTHER", role: "doctor", doctor: true, appointmentScope: "own", grants: DESK },
  patientsOnly: { username: "SYN-DF-PATIENTS", role: "reception", patientScope: "all", grants: DESK },
  revoked: { username: "SYN-DF-REVOKED", role: "reception", appointmentScope: "all", grants: DESK },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let patientId = 0, tomorrow = "";
const waitingFor: Record<"doctor" | "other" | "none", number> = { doctor: 0, other: 0, none: 0 };

const remove = async (k: Key, id: number, reason: string | null = null) => appointments.commandCanonicalAppointmentDelete(await fx.session(k), id, reason);
const booked = async (time: string, doctorId: number | null = null, date = tomorrow) =>
  (await fx.pool.query<{ id: number }>("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,doctor_id,duration_minutes) VALUES($1,$2::date,$3,$4,30) RETURNING id", [patientId, date, time, doctorId])).rows[0].id;
const exists = async (id: number) => Number((await fx.pool.query("SELECT count(*) FROM appointments WHERE id=$1", [id])).rows[0].count) === 1;
const deletions = async (id: number) => (await fx.pool.query<{ actor: string; reason: string | null }>("SELECT actor, details->>'reason' AS reason FROM audit_log WHERE action='appointment.delete' AND entity_id=$1::text", [id])).rows;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  tomorrow = (await fx.pool.query<{ d: string }>("SELECT to_char((NOW() AT TIME ZONE $1)::date + 1, 'YYYY-MM-DD') AS d", [db.CLINIC_TIME_ZONE])).rows[0].d;
  patientId = (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES('SYN-DF-1','SYN Delete Patient','0500000088') RETURNING id")).rows[0].id;
  const waiter = async (number: string, doctor: number | null) => {
    const id = (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES($1,$2,'0500000089',$3) RETURNING id", [number, `SYN Waiter ${number}`, doctor])).rows[0].id;
    return (await waiting.commandCanonicalWaitingAdd(await fx.session("owner"), waiting.parseCanonicalWaitingAdd({ patientId: id, doctorId: doctor, urgency: "soon" }))).id;
  };
  waitingFor.doctor = await waiter("SYN-DF-W1", fx.parties.doctor!);
  waitingFor.other = await waiter("SYN-DF-W2", fx.parties.other!);
  waitingFor.none = await waiter("SYN-DF-W3", null);
  for (const [key, value] of [["clinic.chairs", "2"], ["clinic.day_start", "08:00"], ["clinic.day_end", "20:00"]]) {
    await fx.pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, value]);
  }
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("freed-slot match", () => {
  it("all scope ranks exactly as the legacy matcher; own scope sees only its own entries", async () => {
    const request = { date: tomorrow, time: "10:00", durationMinutes: 30 };
    const legacy = await legacyMatch.findWaitingCandidatesForSlot(request);
    const canonical = await waiting.readCanonicalFreedSlotCandidates(await fx.session("desk"), request);
    expect(legacy!.candidates.length).toBeGreaterThan(0);
    expect(canonical!.slot).toEqual(legacy!.slot);
    expect(canonical!.candidates.map(candidate => [candidate.entry.id, candidate.reason])).toEqual(legacy!.candidates.map(candidate => [candidate.entry.id, candidate.reason]));
    expect(canonical!.examined).toBe(3);
    const own = await waiting.readCanonicalFreedSlotCandidates(await fx.session("doctor"), request);
    expect(own!.examined).toBe(1);
    expect(own!.candidates.map(candidate => candidate.entry.id)).toEqual([waitingFor.doctor]);
    expect(await waiting.readCanonicalFreedSlotCandidates(await fx.session("desk"), { date: "tomorrow", time: "10:00" })).toBeNull();
  });
  it("the slot's facts come only from appointments inside the scope", async () => {
    const theirs = await booked("11:00", fx.parties.other!);
    await fx.pool.query("UPDATE appointments SET duration_minutes = 90 WHERE id = $1", [theirs]);
    const all = await waiting.readCanonicalFreedSlotCandidates(await fx.session("desk"), { date: tomorrow, time: "11:00", appointmentId: theirs });
    expect(all!.slot).toMatchObject({ durationMinutes: 90, doctorId: fx.parties.other! });
    const own = await waiting.readCanonicalFreedSlotCandidates(await fx.session("doctor"), { date: tomorrow, time: "11:00", appointmentId: theirs });
    expect(own!.slot).toMatchObject({ durationMinutes: 30, doctorId: null });
  });
  it("a cancel answers how many entries in the actor's scope fit the freed slot; a patient scope alone reads nothing", async () => {
    const id = await booked("12:00");
    const moved = await appointments.commandCanonicalAppointmentMove(await fx.session("desk"), id, appointments.parseCanonicalAppointmentMove({ action: "cancel", reason: "Synthetic" }));
    const expected = await waiting.readCanonicalFreedSlotCandidates(await fx.session("desk"), { appointmentId: id, date: tomorrow, time: "12:00" });
    expect(expected!.candidates.length).toBeGreaterThan(0);
    expect(moved.waiting).toEqual({ count: expected!.candidates.length, slot: { date: tomorrow, time: "12:00" } });
    await expect(waiting.readCanonicalFreedSlotCandidates(await fx.session("patientsOnly"), { date: tomorrow, time: "12:00" })).rejects.toThrow(/SCOPE/);
  });
});

describe("deletion", () => {
  it("deletes with the row snapshot and reason audited in the same transaction; a visit loses its link", async () => {
    const id = await booked("13:00");
    const visit = (await fx.pool.query<{ id: number }>("INSERT INTO visits(patient_name,patient_id,appointment_id,status) VALUES('SYN Delete Patient',$1,$2,'done') RETURNING id", [patientId, id])).rows[0].id;
    expect(await remove("desk", id, "Synthetic: entered twice")).toEqual({ message: "حُذف الموعد وسُجِّل في التدقيق." });
    expect(await exists(id)).toBe(false);
    expect((await fx.pool.query("SELECT appointment_id FROM visits WHERE id=$1", [visit])).rows[0].appointment_id).toBeNull();
    expect(await deletions(id)).toEqual([{ actor: "SYN-DF-DESK", reason: "Synthetic: entered twice" }]);
  });
  it("an arrived appointment is refused; a second delete reads like missing", async () => {
    const id = await booked("14:00");
    await fx.pool.query("UPDATE appointments SET status='arrived', arrived_at=NOW() WHERE id=$1", [id]);
    await expect(remove("desk", id)).rejects.toMatchObject({ code: "appointment_move_conflict", status: 409 });
    expect(await exists(id)).toBe(true);
    const gone = await booked("14:30");
    await remove("desk", gone);
    await expect(remove("desk", gone)).rejects.toMatchObject({ code: "appointment_not_found", status: 404 });
  });
  it("own scope deletes only the clinician's appointments; another's answers exactly like a missing one", async () => {
    const own = await booked("15:00", fx.parties.doctor!);
    await remove("doctor", own);
    expect(await exists(own)).toBe(false);
    const theirs = await booked("15:30", fx.parties.other!);
    const outside = await remove("doctor", theirs).catch(error => error);
    const missing = await remove("doctor", 999_999).catch(error => error);
    expect(outside).toMatchObject({ code: "appointment_not_found", status: 404 });
    expect([outside.code, outside.message]).toEqual([missing.code, missing.message]);
    expect(await exists(theirs)).toBe(true);
  });
  it("no appointments.cancel (a role label included), no appointment scope or a stale session refuse before any write", async () => {
    const id = await booked("16:00");
    await expect(remove("editOnly", id)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(remove("patientsOnly", id)).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const session = await fx.session("revoked");
    await fx.setGrants("revoked", { "appointments.edit": true }, { appointmentScope: "all" });
    await expect(appointments.commandCanonicalAppointmentDelete(session, id, null)).rejects.toThrow(/^STAFF_OPERATION_/);
    expect(await exists(id)).toBe(true);
  });
  it("an audit failure leaves the appointment in place", async () => {
    const id = await booked("17:00");
    await fx.pool.query("ALTER TABLE audit_log ADD CONSTRAINT syn_delete_audit_refuses CHECK (action <> 'appointment.delete') NOT VALID");
    try {
      await expect(remove("desk", id)).rejects.toThrow();
      expect(await exists(id)).toBe(true);
    } finally { await fx.pool.query("ALTER TABLE audit_log DROP CONSTRAINT syn_delete_audit_refuses"); }
  });
});
