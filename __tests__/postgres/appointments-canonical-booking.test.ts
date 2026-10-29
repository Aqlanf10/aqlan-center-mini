/** M2 slice 16: canonical booking (POST /api/appointments) on real PostgreSQL, synthetic
 * data only. One admitted `appointments.create` transaction through the same capacity
 * engine (day locks, judgement, insert on the caller's client); the creation and any
 * override audit rows are atomic; the appointment scope and grants decide, never a role. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-booking-2026");
const db = await import("../../lib/db");
const appointments = await import("../../lib/canonical-appointments");

const DATE = "2027-03-02";
const CREATE = { "appointments.create": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-BK-OWNER", role: "admin" },
  reception: { username: "SYN-BK-RECEPTION", role: "admin", appointmentScope: "all", grants: CREATE },
  overrider: { username: "SYN-BK-OVERRIDE", role: "reception", appointmentScope: "all", grants: { ...CREATE, "appointments.override-capacity": true } },
  doctor: { username: "SYN-BK-DOCTOR", role: "doctor", doctor: true, appointmentScope: "own", grants: CREATE },
  other: { username: "SYN-BK-OTHER", role: "doctor", doctor: true, appointmentScope: "own", grants: CREATE },
  viewer: { username: "SYN-BK-VIEWER", role: "reception", appointmentScope: "all", grants: {} },
  patientsOnly: { username: "SYN-BK-PATIENTS", role: "reception", patientScope: "all", grants: CREATE },
  revoked: { username: "SYN-BK-REVOKED", role: "reception", appointmentScope: "all", grants: CREATE },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let mine = 0, stranger = 0, a = 0, b = 0, c = 0;

const book = async (k: Key, body: Record<string, unknown>) => appointments.commandCanonicalBooking(await fx.session(k), appointments.parseCanonicalBooking(body));
const count = async (where = "TRUE", values: unknown[] = []) => Number((await fx.pool.query(`SELECT count(*) FROM appointments WHERE ${where}`, values)).rows[0].count);
const audits = async (action: string) => (await fx.pool.query<{ actor: string; entity_id: string }>("SELECT actor, entity_id FROM audit_log WHERE action=$1 ORDER BY id", [action])).rows;
const setting = (key: string, value: string) => fx.pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, value]);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES($1,$2,$3,$4) RETURNING id", [number, `SYN Book ${number}`, `05${number.replace(/\D/g, "").padStart(8, "0")}`, doctor])).rows[0].id;
  mine = await patient("SYN-BK-1", fx.parties.doctor!);
  stranger = await patient("SYN-BK-2", null);
  a = await patient("SYN-BK-3", null);
  b = await patient("SYN-BK-4", null);
  c = await patient("SYN-BK-5", null);
  await setting("clinic.chairs", "1");
  await setting("clinic.day_start", "08:00");
  await setting("clinic.day_end", "20:00");
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("booking through the capacity engine", () => {
  it("books with its creation audit row in the same transaction; a role label never overrides capacity", async () => {
    const booked = await book("reception", { patientId: a, date: DATE, time: "09:00", durationMinutes: 30 });
    expect(booked.appointment).toMatchObject({ patientId: a, scheduledDate: DATE, scheduledTime: "09:00" });
    expect(await audits("appointment.create")).toEqual([{ actor: "SYN-BK-RECEPTION", entity_id: String(booked.appointment.id) }]);
    // "reception" is stored with the admin label; the canonical engine never reads it.
    const full = await book("reception", { patientId: b, date: DATE, time: "09:00", durationMinutes: 30, overrideReason: "Synthetic: try" }).catch(error => error);
    expect(full).toBeInstanceOf(appointments.CanonicalBookingConflict);
    expect(full.conflict.reasons.join(" ")).toContain("الكراسي ممتلئة");
    expect(await count("patient_id = $1", [b])).toBe(0);
  });
  it("appointments.override-capacity books past capacity with the override audited atomically", async () => {
    const overridden = await book("overrider", { patientId: b, date: DATE, time: "09:00", durationMinutes: 30, overrideReason: "Synthetic: urgent pain" });
    expect(overridden.overridden).toBe(true);
    expect(await audits("appointment.capacity_override")).toEqual([{ actor: "SYN-BK-OVERRIDE", entity_id: String(overridden.appointment.id) }]);
  });
  it("engine refusals roll back and keep their codes", async () => {
    await expect(book("reception", { patientId: c, date: "02-03-2027", time: "09:00" })).rejects.toMatchObject({ code: "booking_refused", status: 400 });
    await expect(book("reception", { patientId: c, date: DATE, time: "10:00", appointmentType: "follow_up" }))
      .rejects.toMatchObject({ code: "booking_refused", engineCode: "return_booking_context_required" });
    expect(await count("patient_id = $1", [c])).toBe(0);
  });
  it("two concurrent bookings for the last chair: one wins, the loser writes nothing", async () => {
    const results = await Promise.allSettled([
      book("reception", { patientId: c, date: DATE, time: "14:00", durationMinutes: 30 }),
      book("reception", { patientId: stranger, date: DATE, time: "14:00", durationMinutes: 30 }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await count("scheduled_date = $1 AND scheduled_time = '14:00'", [DATE])).toBe(1);
  });
});

describe("scope and admission", () => {
  it("own scope books its own patients on its own party; another patient reads like a missing one", async () => {
    const own = await book("doctor", { patientId: mine, date: DATE, time: "16:00", durationMinutes: 30 });
    expect(own.appointment.doctorId).toBe(fx.parties.doctor!);
    const outside = await book("doctor", { patientId: stranger, date: DATE, time: "17:00" }).catch(error => error);
    const missing = await book("doctor", { patientId: 999_999, date: DATE, time: "17:00" }).catch(error => error);
    expect(outside).toMatchObject({ code: "patient_not_found", status: 404 });
    expect([outside.code, outside.message]).toEqual([missing.code, missing.message]);
    await expect(book("doctor", { patientId: mine, date: DATE, time: "17:00", doctorId: fx.parties.other! })).rejects.toMatchObject({ code: "booking_doctor_not_allowed", status: 403 });
  });
  it("no appointments.create, an appointment scope missing, or a stale session refuse before any write", async () => {
    const before = await count();
    await expect(book("viewer", { patientId: a, date: DATE, time: "18:00" })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(book("patientsOnly", { patientId: a, date: DATE, time: "18:00" })).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const session = await fx.session("revoked");
    await fx.setGrants("revoked", {}, { appointmentScope: "all" });
    await expect(appointments.commandCanonicalBooking(session, appointments.parseCanonicalBooking({ patientId: a, date: DATE, time: "18:00" }))).rejects.toThrow(/^STAFF_OPERATION_/);
    expect(await count()).toBe(before);
  });
  it("an audit failure leaves no appointment", async () => {
    const before = await count();
    await fx.pool.query("ALTER TABLE audit_log ADD CONSTRAINT syn_booking_audit_refuses CHECK (action <> 'appointment.create') NOT VALID");
    try {
      await expect(book("reception", { patientId: stranger, date: DATE, time: "19:00", durationMinutes: 30 })).rejects.toThrow();
      expect(await count()).toBe(before);
    } finally { await fx.pool.query("ALTER TABLE audit_log DROP CONSTRAINT syn_booking_audit_refuses"); }
  });
});
