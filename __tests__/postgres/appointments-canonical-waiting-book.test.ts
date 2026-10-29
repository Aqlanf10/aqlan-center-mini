/** M2 slice 20: canonical booking from the waiting list (PATCH /api/waiting-list/[id],
 * action "book") on real PostgreSQL, synthetic data only. One admitted
 * `appointments.edit` transaction plus `appointments.create`: entry locked and
 * scope-checked, recovery of an appointment already carrying the entry, the same
 * capacity engine on the caller's client, the entry marked booked and every audit row
 * in the same transaction; a refusal leaves neither an appointment nor a claim. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-waiting-book-2026");
const db = await import("../../lib/db");
const appointments = await import("../../lib/canonical-appointments");

const DATE = "2027-05-04";
const BOOK = { "appointments.edit": true, "appointments.create": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-WB-OWNER", role: "admin" },
  desk: { username: "SYN-WB-DESK", role: "admin", appointmentScope: "all", grants: BOOK },
  overrider: { username: "SYN-WB-OVERRIDE", role: "reception", appointmentScope: "all", grants: { ...BOOK, "appointments.override-capacity": true } },
  editOnly: { username: "SYN-WB-EDIT", role: "admin", appointmentScope: "all", grants: { "appointments.edit": true } },
  doctor: { username: "SYN-WB-DOCTOR", role: "doctor", doctor: true, appointmentScope: "own", grants: BOOK },
  other: { username: "SYN-WB-OTHER", role: "doctor", doctor: true, appointmentScope: "own", grants: BOOK },
  patientsOnly: { username: "SYN-WB-PATIENTS", role: "reception", patientScope: "all", grants: BOOK },
  revoked: { username: "SYN-WB-REVOKED", role: "reception", appointmentScope: "all", grants: BOOK },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let counter = 0;

const book = async (k: Key, id: number, body: Record<string, unknown>) =>
  appointments.commandCanonicalWaitingBook(await fx.session(k), id, appointments.parseCanonicalWaitingBook({ action: "book", ...body }));
const entry = async (doctorId: number | null = null) => {
  counter += 1;
  const patient = (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES($1,$2,$3,$4) RETURNING id",
    [`SYN-WB-${counter}`, `SYN Waiting Book ${counter}`, `05000002${String(counter).padStart(2, "0")}`, doctorId])).rows[0].id;
  return (await fx.pool.query<{ id: number }>("INSERT INTO waiting_list(patient_id,doctor_id,urgency,preferred_period,created_by,duration_minutes) VALUES($1,$2,'soon','any','synthetic',30) RETURNING id", [patient, doctorId])).rows[0].id;
};
const state = async (id: number) => (await fx.pool.query<{ status: string; appointment_id: number | null; claim: boolean }>(
  "SELECT status, appointment_id, booking_claim_at IS NOT NULL AS claim FROM waiting_list WHERE id=$1", [id])).rows[0];
const appointmentsFor = async (id: number) => Number((await fx.pool.query("SELECT count(*) FROM appointments WHERE waiting_list_id=$1", [id])).rows[0].count);
const audit = async (action: string, entityId: number) => (await fx.pool.query<{ actor: string }>("SELECT actor FROM audit_log WHERE action=$1 AND entity_id=$2::text", [action, entityId])).rows.map(row => row.actor);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  for (const [key, value] of [["clinic.chairs", "1"], ["clinic.day_start", "08:00"], ["clinic.day_end", "20:00"]]) {
    await fx.pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, value]);
  }
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("booking an entry", () => {
  it("books, links and closes the entry in one transaction with every audit row; a second press returns the same appointment", async () => {
    const id = await entry();
    const booked = await book("desk", id, { date: DATE, time: "09:00" });
    expect(booked.alreadyBooked).toBeNull();
    const appointmentId = Number(booked.appointment!.id);
    expect(await state(id)).toEqual({ status: "booked", appointment_id: appointmentId, claim: false });
    expect(await audit("appointment.create", appointmentId)).toEqual(["SYN-WB-DESK"]);
    expect(await audit("waiting_list.book", id)).toEqual(["SYN-WB-DESK"]);
    const again = await book("desk", id, { date: DATE, time: "10:00" });
    expect(again).toMatchObject({ appointment: null, alreadyBooked: appointmentId });
    expect(await appointmentsFor(id)).toBe(1);
  });
  it("a full chair is a conflict that leaves no appointment and no claim; the override grant books past it, audited", async () => {
    const id = await entry();
    const full = await book("desk", id, { date: DATE, time: "09:00", overrideReason: "Synthetic: try" }).catch(error => error);
    expect(full).toBeInstanceOf(appointments.CanonicalBookingConflict);
    expect(await state(id)).toEqual({ status: "waiting", appointment_id: null, claim: false });
    expect(await appointmentsFor(id)).toBe(0);
    const overridden = await book("overrider", id, { date: DATE, time: "09:00", overrideReason: "Synthetic: urgent" });
    expect(await audit("appointment.capacity_override", Number(overridden.appointment!.id))).toEqual(["SYN-WB-OVERRIDE"]);
  });
  it("recovery: an appointment already carrying the entry is linked, never doubled", async () => {
    const id = await entry();
    const patient = (await fx.pool.query<{ patient_id: number }>("SELECT patient_id FROM waiting_list WHERE id=$1", [id])).rows[0].patient_id;
    const orphan = (await fx.pool.query<{ id: number }>("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,waiting_list_id) VALUES($1,$2,'11:00',$3) RETURNING id", [patient, DATE, id])).rows[0].id;
    const linked = await book("desk", id, { date: DATE, time: "12:00" });
    expect(Number(linked.appointment!.id)).toBe(orphan);
    expect(await state(id)).toMatchObject({ status: "booked", appointment_id: orphan });
    expect(await appointmentsFor(id)).toBe(1);
  });
  it("a closed entry refuses; a live legacy claim refuses so the two doors never book one entry twice", async () => {
    const closed = await entry();
    await fx.pool.query("UPDATE waiting_list SET status='cancelled' WHERE id=$1", [closed]);
    await expect(book("desk", closed, { date: DATE, time: "13:00" })).rejects.toMatchObject({ code: "waiting_conflict", status: 409 });
    const claimed = await entry();
    await fx.pool.query("UPDATE waiting_list SET booking_claim_at=NOW(), booking_claim_by='legacy-user' WHERE id=$1", [claimed]);
    await expect(book("desk", claimed, { date: DATE, time: "13:00" })).rejects.toMatchObject({ code: "waiting_conflict", status: 409 });
    await fx.pool.query("UPDATE waiting_list SET booking_claim_at=NOW() - INTERVAL '3 minutes' WHERE id=$1", [claimed]);
    await book("desk", claimed, { date: DATE, time: "13:00" });
    expect((await state(claimed)).status).toBe("booked");
  });
  it("two concurrent presses on one entry: one appointment", async () => {
    const id = await entry();
    const results = await Promise.allSettled([book("desk", id, { date: DATE, time: "14:00" }), book("desk", id, { date: DATE, time: "15:00" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    expect(await appointmentsFor(id)).toBe(1);
  });
  it("invalid date or time refuses before admission", () => {
    expect(() => appointments.parseCanonicalWaitingBook({ action: "book", date: "04/05/2027", time: "09:00" })).toThrow(expect.objectContaining({ code: "invalid_waiting_input", status: 400 }));
  });
});

describe("scope and admission", () => {
  it("own scope books its own entries on its own party; another's entry reads like a missing one", async () => {
    const own = await entry(fx.parties.doctor!);
    const booked = await book("doctor", own, { date: DATE, time: "16:00" });
    expect(booked.appointment!.doctorId).toBe(fx.parties.doctor!);
    const theirs = await entry(fx.parties.other!);
    const outside = await book("doctor", theirs, { date: DATE, time: "17:00" }).catch(error => error);
    const missing = await book("doctor", 999_999, { date: DATE, time: "17:00" }).catch(error => error);
    expect(outside).toMatchObject({ code: "waiting_not_found", status: 404 });
    expect([outside.code, outside.message]).toEqual([missing.code, missing.message]);
    const mine = await entry(fx.parties.doctor!);
    await expect(book("doctor", mine, { date: DATE, time: "17:00", doctorId: fx.parties.other! })).rejects.toMatchObject({ code: "booking_doctor_not_allowed", status: 403 });
    expect(await appointmentsFor(theirs) + await appointmentsFor(mine)).toBe(0);
  });
  it("no appointments.create (an admin label included), no appointment scope or a stale session refuse before any write", async () => {
    const id = await entry();
    await expect(book("editOnly", id, { date: DATE, time: "18:00" })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(book("patientsOnly", id, { date: DATE, time: "18:00" })).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const session = await fx.session("revoked");
    await fx.setGrants("revoked", { "appointments.edit": true }, { appointmentScope: "all" });
    await expect(appointments.commandCanonicalWaitingBook(session, id, appointments.parseCanonicalWaitingBook({ date: DATE, time: "18:00" }))).rejects.toThrow(/^STAFF_OPERATION_/);
    expect(await state(id)).toEqual({ status: "waiting", appointment_id: null, claim: false });
  });
  it("an audit failure leaves the entry open and no appointment", async () => {
    const id = await entry();
    await fx.pool.query("ALTER TABLE audit_log ADD CONSTRAINT syn_waiting_book_refuses CHECK (action <> 'waiting_list.book') NOT VALID");
    try {
      await expect(book("desk", id, { date: DATE, time: "19:00" })).rejects.toThrow();
      expect(await state(id)).toEqual({ status: "waiting", appointment_id: null, claim: false });
      expect(await appointmentsFor(id)).toBe(0);
    } finally { await fx.pool.query("ALTER TABLE audit_log DROP CONSTRAINT syn_waiting_book_refuses"); }
  });
});
