/** M2 slice 22: canonical planned-visit scheduling (POST /api/planned-visits/[id]/schedule)
 * on real PostgreSQL, synthetic data only. One admitted `appointments.create`
 * transaction running the route's own capacity-engine door on the admitted client:
 * patient inside the patient scope (outside = missing), own appointment scope books only
 * on its own party, override only by grant, every audit row atomic, refusals roll back. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-planned-schedule-2026");
const db = await import("../../lib/db");
const planned = await import("../../lib/canonical-planned-visits");
const door = await import("../../lib/planned-visit-schedule");
const { readReturnBookingContext } = await import("../../lib/return-booking-context");

const DATE = "2027-07-06";
const CREATE = { "appointments.create": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-PS-OWNER", role: "admin" },
  desk: { username: "SYN-PS-DESK", role: "admin", patientScope: "all", appointmentScope: "all", grants: CREATE },
  overrider: { username: "SYN-PS-OVERRIDE", role: "reception", patientScope: "all", appointmentScope: "all", grants: { ...CREATE, "appointments.override-capacity": true } },
  doctor: { username: "SYN-PS-DOCTOR", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "own", grants: CREATE },
  other: { username: "SYN-PS-OTHER", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "own", grants: CREATE },
  noAppointments: { username: "SYN-PS-NOAPPT", role: "reception", patientScope: "all", grants: CREATE },
  viewer: { username: "SYN-PS-VIEWER", role: "reception", patientScope: "all", appointmentScope: "all", grants: {} },
  revoked: { username: "SYN-PS-REVOKED", role: "reception", patientScope: "all", appointmentScope: "all", grants: CREATE },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;

/** A planned session of a case whose responsible doctor is `doctorId`. */
async function fixture(doctorId: number) {
  const n = ++serial;
  const [patient] = await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN Planned patient',$2) RETURNING id", [`SYN-PS-${n}`, doctorId]);
  const [plan] = await q("INSERT INTO treatment_plans(patient_id,title,total_minor,status) VALUES ($1,'SYN plan',1000,'active') RETURNING id", [patient.id]);
  const [clinical] = await q("INSERT INTO clinical_cases(patient_id,specialty,title,responsible_party_id,created_by) VALUES ($1,'general','SYN case',$2,'synthetic') RETURNING id", [patient.id, doctorId]);
  const [item] = await q("INSERT INTO plan_items(plan_id,case_id,service_name,unit_price_minor) VALUES ($1,$2,'SYN item',1000) RETURNING id", [plan.id, clinical.id]);
  const [visit] = await q("INSERT INTO planned_visits(patient_id,plan_id,sequence,title,status,duration_minutes) VALUES ($1,$2,1,'SYN planned session','planned',30) RETURNING id", [patient.id, plan.id]);
  await q("INSERT INTO treatment_sessions(plan_item_id,sequence,planned_visit_id) VALUES ($1,1,$2)", [item.id, visit.id]);
  const context = await readReturnBookingContext(fx.pool, patient.id, { kind: "planned_visit", id: visit.id });
  if (!context.ok) throw new Error(context.message);
  return { id: visit.id as number, patientId: patient.id as number, fingerprint: context.fingerprint };
}
const schedule = async (k: Key, id: number, body: Record<string, unknown>) =>
  planned.commandCanonicalPlannedVisitSchedule(await fx.session(k), id, ({ client, patientId, actor, audit }) =>
    door.schedulePlannedVisitThroughEngine(id, patientId, body, actor, { client, audit }));
const state = async (id: number) => (await q("SELECT status, appointment_id FROM planned_visits WHERE id=$1", [id]))[0];
const audits = async (action: string, entityId: number) => (await q("SELECT actor FROM audit_log WHERE action=$1 AND entity_id=$2::text", [action, entityId])).map(row => row.actor);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  for (const [key, value] of [["clinic.chairs", "1"], ["clinic.day_start", "08:00"], ["clinic.day_end", "20:00"]]) {
    await q("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, value]);
  }
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("scheduling through the capacity engine", () => {
  it("books on the case's responsible doctor and links the planned visit, audited in the same transaction; a second press refuses", async () => {
    const f = await fixture(fx.parties.doctor!);
    const result = await schedule("desk", f.id, { date: DATE, time: "09:00", returnBookingFingerprint: f.fingerprint });
    expect(result).toMatchObject({ ok: true, doctorId: fx.parties.doctor! });
    if (!result.ok) return;
    expect(await state(f.id)).toEqual({ status: "scheduled", appointment_id: result.appointmentId });
    expect(await audits("appointment.create", result.appointmentId)).toEqual(["SYN-PS-DESK"]);
    expect(await schedule("desk", f.id, { date: DATE, time: "10:00", returnBookingFingerprint: f.fingerprint })).toMatchObject({ ok: false, kind: "rejected", reason: "already_scheduled" });
  });
  it("engine refusals keep their codes and write nothing", async () => {
    const f = await fixture(fx.parties.doctor!);
    expect(await schedule("desk", f.id, { date: DATE, time: "11:00" })).toMatchObject({ ok: false, kind: "conflict", conflict: { code: "return_booking_context_required" } });
    expect(await schedule("desk", f.id, { date: "06/07/2027", time: "11:00", returnBookingFingerprint: f.fingerprint })).toMatchObject({ ok: false, kind: "invalid" });
    expect(await state(f.id)).toEqual({ status: "planned", appointment_id: null });
  });
  it("a full chair is a conflict; an admin label never overrides; the override grant does, audited atomically", async () => {
    const f = await fixture(fx.parties.other!);
    const full = await schedule("desk", f.id, { date: DATE, time: "09:00", returnBookingFingerprint: f.fingerprint, overrideReason: "Synthetic: try" });
    expect(full).toMatchObject({ ok: false, kind: "conflict" });
    expect(await state(f.id)).toEqual({ status: "planned", appointment_id: null });
    const overridden = await schedule("overrider", f.id, { date: DATE, time: "09:00", returnBookingFingerprint: f.fingerprint, overrideReason: "Synthetic: urgent" });
    expect(overridden.ok).toBe(true);
    if (overridden.ok) expect(await audits("appointment.capacity_override", overridden.appointmentId)).toEqual(["SYN-PS-OVERRIDE"]);
  });
  it("two concurrent presses: one appointment", async () => {
    const f = await fixture(fx.parties.doctor!);
    const results = await Promise.all([
      schedule("desk", f.id, { date: DATE, time: "14:00", returnBookingFingerprint: f.fingerprint }),
      schedule("desk", f.id, { date: DATE, time: "15:00", returnBookingFingerprint: f.fingerprint }),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(Number((await q("SELECT count(*) FROM appointments WHERE planned_visit_id=$1", [f.id]))[0].count)).toBe(1);
  });
});

describe("scope and admission", () => {
  it("own scope schedules its own patients' sessions on its own party; another's patient reads like a missing one", async () => {
    const mine = await fixture(fx.parties.doctor!);
    expect((await schedule("doctor", mine.id, { date: DATE, time: "16:00", returnBookingFingerprint: mine.fingerprint })).ok).toBe(true);
    const theirs = await fixture(fx.parties.other!);
    const outside = await schedule("doctor", theirs.id, { date: DATE, time: "17:00", returnBookingFingerprint: theirs.fingerprint }).catch(error => error);
    const missing = await schedule("doctor", 999_999, { date: DATE, time: "17:00" }).catch(error => error);
    expect(outside).toMatchObject({ code: "planned_visit_not_found", status: 404 });
    expect([outside.code, outside.message]).toEqual([missing.code, missing.message]);
    expect(await state(theirs.id)).toEqual({ status: "planned", appointment_id: null });
  });
  it("own appointment scope never books on another doctor: a patient it owns whose case belongs to someone else rolls back", async () => {
    const f = await fixture(fx.parties.other!);
    await q("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1", [f.patientId, fx.parties.doctor!]);
    await expect(schedule("doctor", f.id, { date: DATE, time: "18:00", returnBookingFingerprint: f.fingerprint })).rejects.toMatchObject({ code: "planned_visit_doctor_not_allowed", status: 403 });
    expect(await state(f.id)).toEqual({ status: "planned", appointment_id: null });
  });
  it("no appointments.create, no appointment scope or a stale session refuse before any write", async () => {
    const f = await fixture(fx.parties.doctor!);
    await expect(schedule("viewer", f.id, { date: DATE, time: "19:00", returnBookingFingerprint: f.fingerprint })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(schedule("noAppointments", f.id, { date: DATE, time: "19:00", returnBookingFingerprint: f.fingerprint })).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const session = await fx.session("revoked");
    await fx.setGrants("revoked", {}, { patientScope: "all", appointmentScope: "all" });
    await expect(planned.commandCanonicalPlannedVisitSchedule(session, f.id, async () => ({ ok: false as const }))).rejects.toThrow(/^STAFF_OPERATION_/);
    expect(await state(f.id)).toEqual({ status: "planned", appointment_id: null });
  });
  it("an audit failure leaves the planned visit unscheduled", async () => {
    const f = await fixture(fx.parties.doctor!);
    await q("ALTER TABLE audit_log ADD CONSTRAINT syn_planned_schedule_refuses CHECK (action <> 'appointment.create') NOT VALID");
    try {
      await expect(schedule("desk", f.id, { date: DATE, time: "19:30", returnBookingFingerprint: f.fingerprint })).rejects.toThrow();
      expect(await state(f.id)).toEqual({ status: "planned", appointment_id: null });
    } finally { await q("ALTER TABLE audit_log DROP CONSTRAINT syn_planned_schedule_refuses"); }
  });
});
