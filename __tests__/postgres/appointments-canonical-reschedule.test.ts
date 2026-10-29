/** M2 slice 18: canonical rescheduling (PATCH /api/appointments/[id], action
 * "reschedule") on real PostgreSQL, synthetic data only. One admitted
 * `appointments.edit` transaction through the same cross-day capacity engine (sorted
 * day locks, judgement, guarded move on the caller's client); the reschedule and any
 * override audit rows are atomic; the appointment scope and grants decide, never a role. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-reschedule-2026");
const db = await import("../../lib/db");
const appointments = await import("../../lib/canonical-appointments");

const FROM = "2027-04-06";
const TO = "2027-04-07";
const EDIT = { "appointments.edit": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-RS-OWNER", role: "admin" },
  desk: { username: "SYN-RS-DESK", role: "admin", appointmentScope: "all", grants: EDIT },
  overrider: { username: "SYN-RS-OVERRIDE", role: "reception", appointmentScope: "all", grants: { ...EDIT, "appointments.override-capacity": true } },
  doctor: { username: "SYN-RS-DOCTOR", role: "doctor", doctor: true, appointmentScope: "own", grants: EDIT },
  other: { username: "SYN-RS-OTHER", role: "doctor", doctor: true, appointmentScope: "own", grants: EDIT },
  viewer: { username: "SYN-RS-VIEWER", role: "reception", appointmentScope: "all", grants: {} },
  patientsOnly: { username: "SYN-RS-PATIENTS", role: "reception", patientScope: "all", grants: EDIT },
  revoked: { username: "SYN-RS-REVOKED", role: "reception", appointmentScope: "all", grants: EDIT },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const patients: number[] = [];

const reschedule = async (k: Key, id: number, body: Record<string, unknown>) =>
  appointments.commandCanonicalReschedule(await fx.session(k), id, appointments.parseCanonicalReschedule({ action: "reschedule", ...body }));
const booked = async (patient: number, date: string, time: string, doctorId: number | null = null) =>
  (await fx.pool.query<{ id: number }>("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,doctor_id,duration_minutes,reminder_sent_at) VALUES($1,$2::date,$3,$4,30,NOW()) RETURNING id", [patient, date, time, doctorId])).rows[0].id;
const at = async (id: number) => (await fx.pool.query<{ slot: string; doctor_id: number | null; reminded: boolean }>(
  "SELECT to_char(scheduled_date,'YYYY-MM-DD') || ' ' || to_char(scheduled_time,'HH24:MI') AS slot, doctor_id, reminder_sent_at IS NOT NULL AS reminded FROM appointments WHERE id=$1", [id])).rows[0];
const audits = async (action: string, id: number) => (await fx.pool.query<{ actor: string }>("SELECT actor FROM audit_log WHERE action=$1 AND entity_id=$2::text ORDER BY id", [action, id])).rows.map(row => row.actor);
const setting = (key: string, value: string) => fx.pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, value]);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  for (let index = 1; index <= 8; index++) {
    patients.push((await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES($1,$2,$3) RETURNING id",
      [`SYN-RS-${index}`, `SYN Reschedule ${index}`, `05000001${index}0`])).rows[0].id);
  }
  await setting("clinic.chairs", "1");
  await setting("clinic.day_start", "08:00");
  await setting("clinic.day_end", "20:00");
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("rescheduling through the cross-day capacity engine", () => {
  it("moves with its reschedule audit row in the same transaction; the old reminder is cleared", async () => {
    const id = await booked(patients[0], FROM, "09:00");
    const moved = await reschedule("desk", id, { date: TO, time: "10:00", reason: "Synthetic: patient asked" });
    expect(moved.appointment).toMatchObject({ id, scheduledDate: TO, scheduledTime: "10:00" });
    expect(await at(id)).toMatchObject({ slot: `${TO} 10:00`, reminded: false });
    expect(await audits("appointment.reschedule", id)).toEqual(["SYN-RS-DESK"]);
  });
  it("a missing reason, a bad date or a doctor change without the return-booking context refuse with the engine's codes", async () => {
    const id = await booked(patients[1], FROM, "11:00");
    await expect(reschedule("desk", id, { date: TO, time: "11:00" })).rejects.toMatchObject({ code: "booking_refused", status: 400 });
    await expect(reschedule("desk", id, { date: "07-04-2027", time: "11:00", reason: "Synthetic" })).rejects.toMatchObject({ code: "booking_refused" });
    await expect(reschedule("desk", id, { date: TO, time: "11:00", reason: "Synthetic", doctorId: fx.parties.doctor! }))
      .rejects.toMatchObject({ code: "booking_refused", engineCode: "return_booking_context_required" });
    expect((await at(id)).slot).toBe(`${FROM} 11:00`);
  });
  it("a full chair is a conflict with its reasons; a role label never overrides; the override grant does, audited atomically", async () => {
    await booked(patients[2], TO, "12:00");
    const id = await booked(patients[3], FROM, "12:00");
    // "desk" is stored with the admin label; the canonical engine never reads it.
    const full = await reschedule("desk", id, { date: TO, time: "12:00", reason: "Synthetic", overrideReason: "Synthetic: try" }).catch(error => error);
    expect(full).toBeInstanceOf(appointments.CanonicalBookingConflict);
    expect(full.conflict.reasons.join(" ")).toContain("الكراسي ممتلئة");
    expect((await at(id)).slot).toBe(`${FROM} 12:00`);
    const overridden = await reschedule("overrider", id, { date: TO, time: "12:00", reason: "Synthetic", overrideReason: "Synthetic: urgent pain" });
    expect(overridden.overridden).toBe(true);
    expect(await audits("appointment.capacity_override", id)).toEqual(["SYN-RS-OVERRIDE"]);
  });
  it("two concurrent reschedules of one appointment: one wins, the loser's stale read is refused, never overwritten", async () => {
    const id = await booked(patients[4], FROM, "14:00");
    const results = await Promise.allSettled([
      reschedule("desk", id, { date: TO, time: "15:00", reason: "Synthetic A" }),
      reschedule("desk", id, { date: TO, time: "16:00", reason: "Synthetic B" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "appointment_move_conflict", status: 409 });
    expect(await audits("appointment.reschedule", id)).toHaveLength(1);
  });
  it("only a booked appointment moves", async () => {
    const id = await booked(patients[5], FROM, "17:00");
    await fx.pool.query("UPDATE appointments SET status='cancelled' WHERE id=$1", [id]);
    await expect(reschedule("desk", id, { date: TO, time: "17:00", reason: "Synthetic" })).rejects.toMatchObject({ code: "appointment_move_conflict", status: 409 });
  });
});

describe("scope and admission", () => {
  it("own scope moves only the clinician's appointments, on its own party; another's reads like a missing one", async () => {
    const own = await booked(patients[6], FROM, "08:00", fx.parties.doctor!);
    await reschedule("doctor", own, { date: TO, time: "08:00", reason: "Synthetic: own" });
    expect(await at(own)).toMatchObject({ slot: `${TO} 08:00`, doctor_id: fx.parties.doctor! });
    const theirs = await booked(patients[7], FROM, "08:30", fx.parties.other!);
    const outside = await reschedule("doctor", theirs, { date: TO, time: "08:30", reason: "x y z" }).catch(error => error);
    const missing = await reschedule("doctor", 999_999, { date: TO, time: "08:30", reason: "x y z" }).catch(error => error);
    expect(outside).toMatchObject({ code: "appointment_not_found", status: 404 });
    expect([outside.code, outside.message]).toEqual([missing.code, missing.message]);
    await expect(reschedule("doctor", own, { date: TO, time: "09:30", reason: "Synthetic", doctorId: fx.parties.other! })).rejects.toMatchObject({ code: "booking_doctor_not_allowed", status: 403 });
    expect((await at(theirs)).slot).toBe(`${FROM} 08:30`);
  });
  it("no appointments.edit, no appointment scope or a stale session refuse before any write", async () => {
    const id = await booked(patients[0], FROM, "18:00");
    await expect(reschedule("viewer", id, { date: TO, time: "18:00", reason: "Synthetic" })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(reschedule("patientsOnly", id, { date: TO, time: "18:00", reason: "Synthetic" })).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const session = await fx.session("revoked");
    await fx.setGrants("revoked", {}, { appointmentScope: "all" });
    await expect(appointments.commandCanonicalReschedule(session, id, appointments.parseCanonicalReschedule({ date: TO, time: "18:00", reason: "Synthetic" }))).rejects.toThrow(/^STAFF_OPERATION_/);
    expect((await at(id)).slot).toBe(`${FROM} 18:00`);
  });
  it("an audit failure leaves the appointment where it was", async () => {
    const id = await booked(patients[1], FROM, "19:00");
    await fx.pool.query("ALTER TABLE audit_log ADD CONSTRAINT syn_reschedule_audit_refuses CHECK (action <> 'appointment.reschedule') NOT VALID");
    try {
      await expect(reschedule("desk", id, { date: TO, time: "19:00", reason: "Synthetic" })).rejects.toThrow();
      expect(await at(id)).toMatchObject({ slot: `${FROM} 19:00`, reminded: true });
    } finally { await fx.pool.query("ALTER TABLE audit_log DROP CONSTRAINT syn_reschedule_audit_refuses"); }
  });
});
