/** M2 slice 17: canonical appointment moves (PATCH /api/appointments/[id]) on real
 * PostgreSQL, synthetic data only. One admitted `appointments.edit` transaction per move:
 * the branch capability (visits.manage to arrive or close, appointments.cancel to cancel
 * or mark absent), the appointment inside the CURRENT appointment scope (outside =
 * missing), the domain writers and status log on the caller's client, the audit row
 * atomic, every refusal rolled back. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-appointment-moves-2026");
const db = await import("../../lib/db");
const appointments = await import("../../lib/canonical-appointments");

const DESK = { "appointments.edit": true, "visits.manage": true, "appointments.cancel": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-AM-OWNER", role: "admin" },
  desk: { username: "SYN-AM-DESK", role: "reception", appointmentScope: "all", grants: DESK },
  editOnly: { username: "SYN-AM-EDIT", role: "admin", appointmentScope: "all", grants: { "appointments.edit": true } },
  noEdit: { username: "SYN-AM-NOEDIT", role: "admin", appointmentScope: "all", grants: { "visits.manage": true, "appointments.cancel": true } },
  doctor: { username: "SYN-AM-DOCTOR", role: "doctor", doctor: true, appointmentScope: "own", grants: DESK },
  other: { username: "SYN-AM-OTHER", role: "doctor", doctor: true, appointmentScope: "own", grants: DESK },
  patientsOnly: { username: "SYN-AM-PATIENTS", role: "reception", patientScope: "all", grants: DESK },
  revoked: { username: "SYN-AM-REVOKED", role: "reception", appointmentScope: "all", grants: DESK },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let patientId = 0, today = "", yesterday = "", tomorrow = "";

const move = async (k: Key, id: number, body: Record<string, unknown>) =>
  appointments.commandCanonicalAppointmentMove(await fx.session(k), id, appointments.parseCanonicalAppointmentMove(body));
const booked = async (date: string, time = "09:00", doctorId: number | null = null) =>
  (await fx.pool.query<{ id: number }>("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,doctor_id) VALUES($1,$2::date,$3,$4) RETURNING id", [patientId, date, time, doctorId])).rows[0].id;
const row = async (id: number) => (await fx.pool.query("SELECT status, cancel_reason, reminder_sent_at FROM appointments WHERE id=$1", [id])).rows[0];
const visitsFor = async (id: number) => Number((await fx.pool.query("SELECT count(*) FROM visits WHERE appointment_id=$1", [id])).rows[0].count);
const statusLog = async (id: number) => (await fx.pool.query<{ to_status: string; actor: string; reason: string | null }>("SELECT to_status, actor, reason FROM appointment_status_log WHERE appointment_id=$1 ORDER BY id", [id])).rows;
const audits = async (id: number) => (await fx.pool.query<{ actor: string; details: Record<string, string> }>("SELECT actor, details FROM audit_log WHERE action='appointment.update' AND entity='appointment' AND entity_id=$1::text ORDER BY id", [id])).rows;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const { rows: [dates] } = await fx.pool.query<{ today: string; yesterday: string; tomorrow: string }>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS today, to_char(d - 1, 'YYYY-MM-DD') AS yesterday, to_char(d + 1, 'YYYY-MM-DD') AS tomorrow
       FROM (SELECT (NOW() AT TIME ZONE $1)::date AS d) t`, [db.CLINIC_TIME_ZONE]);
  ({ today, yesterday, tomorrow } = dates);
  patientId = (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES('SYN-AM-1','SYN Moves Patient','0500000077') RETURNING id")).rows[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("moves through the domain writers", () => {
  it("arrive opens the queue row with the status log and audit under the canonical actor; a second arrive conflicts", async () => {
    const id = await booked(today);
    expect(await move("desk", id, { action: "arrive" })).toEqual({ ok: true, waiting: null });
    expect((await row(id)).status).toBe("arrived");
    expect(await visitsFor(id)).toBe(1);
    expect((await audits(id)).map(audit => [audit.actor, audit.details["الإجراء"], audit.details["إلى"]])).toEqual([["SYN-AM-DESK", "arrive", "arrived"]]);
    await expect(move("desk", id, { action: "arrive" })).rejects.toMatchObject({ code: "appointment_move_conflict", status: 409 });
    expect(await visitsFor(id)).toBe(1);
    // The visit is closed so the next arrival for this patient opens its own queue row.
    await fx.pool.query("UPDATE visits SET status='done', finished_at=NOW() WHERE appointment_id=$1", [id]);
  });
  it("cancel keeps the reason (or the legacy default) in the appointment and its status log", async () => {
    const withReason = await booked(tomorrow, "10:00");
    await move("desk", withReason, { action: "cancel", reason: "Synthetic: travel" });
    expect(await row(withReason)).toMatchObject({ status: "cancelled", cancel_reason: "Synthetic: travel" });
    expect(await statusLog(withReason)).toEqual([{ to_status: "cancelled", actor: "SYN-AM-DESK", reason: "Synthetic: travel" }]);
    const defaulted = await booked(tomorrow, "11:00");
    await move("desk", defaulted, { action: "cancel" });
    expect((await row(defaulted)).cancel_reason).toBe("أُلغي من شاشة اليوم");
  });
  it("no_show only after the appointment's time; close_done only for a past booking", async () => {
    const future = await booked(tomorrow, "12:00");
    await expect(move("desk", future, { action: "no_show" })).rejects.toMatchObject({ code: "appointment_move_conflict" });
    await expect(move("desk", future, { action: "close_done" })).rejects.toMatchObject({ code: "appointment_move_conflict" });
    expect((await row(future)).status).toBe("booked");
    const absent = await booked(yesterday, "09:00");
    await move("desk", absent, { action: "no_show" });
    expect((await row(absent)).status).toBe("no_show");
    const pending = await booked(yesterday, "10:00");
    await move("desk", pending, { action: "close_done" });
    expect((await row(pending)).status).toBe("done");
    expect((await statusLog(pending)).map(entry => entry.to_status)).toEqual(["done"]);
  });
  it("reminded needs only appointments.edit and the displayed snapshot; a stale snapshot records nothing", async () => {
    const id = await booked(tomorrow, "13:00");
    const snapshot = { patientId, patientName: "SYN Moves Patient", patientPhone: "0500000077", scheduledDate: tomorrow, scheduledTime: "13:00", status: "booked" };
    await expect(move("editOnly", id, { action: "reminded", snapshot: { ...snapshot, scheduledTime: "13:30" } })).rejects.toMatchObject({ code: "appointment_move_conflict" });
    expect((await row(id)).reminder_sent_at).toBeNull();
    await expect(move("editOnly", id, { action: "reminded", snapshot: { patientId } })).rejects.toMatchObject({ code: "invalid_booking_input", status: 400 });
    await move("editOnly", id, { action: "reminded", snapshot });
    expect(await row(id)).toMatchObject({ status: "booked", reminder_sent_at: expect.any(Date) });
    expect((await audits(id)).map(audit => audit.details["إلى"])).toEqual(["booked"]);
  });
  it("unknown actions refuse (rescheduling is its own command, slice 18)", async () => {
    expect(() => appointments.parseCanonicalAppointmentMove({ action: "delete" })).toThrow(expect.objectContaining({ code: "invalid_booking_input", status: 400 }));
    expect(() => appointments.parseCanonicalAppointmentMove({ action: "reschedule" })).toThrow(expect.objectContaining({ code: "invalid_booking_input" }));
  });
});

describe("scope, capabilities and atomicity", () => {
  it("own scope moves only the clinician's appointments; another's answers exactly like a missing one", async () => {
    const own = await booked(tomorrow, "14:00", fx.parties.doctor!);
    await move("doctor", own, { action: "cancel", reason: "Synthetic: own" });
    expect((await row(own)).status).toBe("cancelled");
    const theirs = await booked(tomorrow, "15:00", fx.parties.other!);
    const unassigned = await booked(tomorrow, "16:00");
    const outside = await move("doctor", theirs, { action: "cancel", reason: "x" }).catch(error => error);
    const missing = await move("doctor", 999_999, { action: "cancel", reason: "x" }).catch(error => error);
    expect(outside).toMatchObject({ code: "appointment_not_found", status: 404 });
    expect([outside.code, outside.message]).toEqual([missing.code, missing.message]);
    await expect(move("doctor", unassigned, { action: "cancel", reason: "x" })).rejects.toMatchObject({ code: "appointment_not_found" });
    expect([(await row(theirs)).status, (await row(unassigned)).status]).toEqual(["booked", "booked"]);
  });
  it("each branch needs its capability; no appointments.edit, no appointment scope or a stale session refuse before any write", async () => {
    const id = await booked(tomorrow, "17:00");
    await expect(move("editOnly", id, { action: "arrive" })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(move("editOnly", id, { action: "cancel", reason: "x" })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(move("noEdit", id, { action: "cancel", reason: "x" })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(move("patientsOnly", id, { action: "cancel", reason: "x" })).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const session = await fx.session("revoked");
    await fx.setGrants("revoked", { "appointments.edit": true }, { appointmentScope: "all" });
    await expect(appointments.commandCanonicalAppointmentMove(session, id, appointments.parseCanonicalAppointmentMove({ action: "cancel", reason: "x" }))).rejects.toThrow(/^STAFF_OPERATION_/);
    expect(await row(id)).toMatchObject({ status: "booked", cancel_reason: null });
    expect(await statusLog(id)).toEqual([]);
  });
  it("an audit failure rolls back the arrival: no queue row, no status change", async () => {
    const id = await booked(today, "18:00");
    await fx.pool.query("ALTER TABLE audit_log ADD CONSTRAINT syn_move_audit_refuses CHECK (action <> 'appointment.update') NOT VALID");
    try {
      await expect(move("desk", id, { action: "arrive" })).rejects.toThrow();
      expect((await row(id)).status).toBe("booked");
      expect(await visitsFor(id)).toBe(0);
    } finally { await fx.pool.query("ALTER TABLE audit_log DROP CONSTRAINT syn_move_audit_refuses"); }
  });
});
