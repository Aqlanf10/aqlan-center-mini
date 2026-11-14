/** M2 slice 23: canonical planned-session rebooking (POST /api/planned-visits/[id]/rebook)
 * on real PostgreSQL, synthetic data only. The same atomic writer runs inside one
 * admitted `appointments.create` transaction with the canonical authority: patient
 * scope, own appointment scope on its own party, idempotent replay keyed by the
 * canonical user, old attendance never touched, refusals roll back. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-planned-rebook-2026");
const db = await import("../../lib/db");
const planned = await import("../../lib/canonical-planned-visits");
const { readReturnBookingContext } = await import("../../lib/return-booking-context");
const { addDays, clinicDateString } = await import("../../lib/schedule");

const CREATE = { "appointments.create": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-RB-OWNER", role: "admin" },
  desk: { username: "SYN-RB-DESK", role: "reception", patientScope: "all", appointmentScope: "all", grants: CREATE },
  doctor: { username: "SYN-RB-DOCTOR", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "own", grants: CREATE },
  other: { username: "SYN-RB-OTHER", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "own", grants: CREATE },
  viewer: { username: "SYN-RB-VIEWER", role: "reception", patientScope: "all", appointmentScope: "all", grants: {} },
  noAppointments: { username: "SYN-RB-NOAPPT", role: "reception", patientScope: "all", grants: CREATE },
  revoked: { username: "SYN-RB-REVOKED", role: "reception", patientScope: "all", appointmentScope: "all", grants: CREATE },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let serial = 0, base = "";
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;

/** A planned session whose booked appointment was a no-show; the case belongs to `doctorId`. */
async function fixture(doctorId: number) {
  const n = ++serial;
  const [patient] = await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN rebook patient',$2) RETURNING id", [`SYN-RB-${n}`, doctorId]);
  const [plan] = await q("INSERT INTO treatment_plans(patient_id,title,total_minor,status) VALUES ($1,'SYN plan',1000,'active') RETURNING id", [patient.id]);
  const [clinical] = await q("INSERT INTO clinical_cases(patient_id,specialty,title,responsible_party_id,created_by) VALUES ($1,'general','SYN case',$2,'synthetic') RETURNING id", [patient.id, doctorId]);
  const [item] = await q("INSERT INTO plan_items(plan_id,case_id,service_name,unit_price_minor) VALUES ($1,$2,'SYN item',1000) RETURNING id", [plan.id, clinical.id]);
  const [old] = await q(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status,ended_at,doctor_id)
    VALUES ($1,(NOW() AT TIME ZONE $2)::date - 1,'10:00','no_show',NOW(),$3) RETURNING id`, [patient.id, db.CLINIC_TIME_ZONE, doctorId]);
  const [visit] = await q("INSERT INTO planned_visits(patient_id,plan_id,sequence,title,status,appointment_id,duration_minutes) VALUES ($1,$2,1,'SYN planned session','scheduled',$3,30) RETURNING id", [patient.id, plan.id, old.id]);
  await q("UPDATE appointments SET planned_visit_id=$2 WHERE id=$1", [old.id, visit.id]);
  await q("INSERT INTO treatment_sessions(plan_item_id,sequence,planned_visit_id) VALUES ($1,1,$2)", [item.id, visit.id]);
  const context = await readReturnBookingContext(fx.pool, patient.id, { kind: "planned_visit", id: visit.id });
  if (!context.ok) throw new Error(context.message);
  const generation = (await db.listPatientPlannedVisitsWith(fx.pool, patient.id))[0].rebookGeneration;
  return {
    id: visit.id as number, oldId: old.id as number, patientId: patient.id as number,
    intent: { plannedVisitId: visit.id as number, expectedAppointmentId: old.id as number, expectedGeneration: generation,
      date: addDays(base, n), time: "10:00", reason: "المريض طلب موعدًا بديلًا", requestId: `synthetic-canonical-rebook-${n}-0000`,
      returnBookingFingerprint: context.fingerprint },
  };
}
const rebook = async (k: Key, intent: Parameters<typeof planned.commandCanonicalPlannedVisitRebook>[1]) => planned.commandCanonicalPlannedVisitRebook(await fx.session(k), intent);
const links = async (id: number) => (await q("SELECT id, status FROM appointments WHERE planned_visit_id=$1 ORDER BY id", [id]));

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  base = addDays(clinicDateString(new Date(), db.CLINIC_TIME_ZONE), 10);
  await q("INSERT INTO settings(key,value) VALUES('clinic.chairs','20') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("the atomic rebooking writer under the canonical authority", () => {
  it("books a replacement on the responsible doctor, keeps the old attendance, audits with the canonical actor; the same request replays", async () => {
    const f = await fixture(fx.parties.doctor!);
    const result = await rebook("desk", f.intent);
    expect(result).toMatchObject({ ok: true, replayed: false });
    if (!result.ok) return;
    expect((await q("SELECT status FROM appointments WHERE id=$1", [f.oldId]))[0].status).toBe("no_show");
    expect(await links(f.id)).toEqual([{ id: result.appointmentId, status: "booked" }]);
    expect((await q("SELECT doctor_id FROM appointments WHERE id=$1", [result.appointmentId]))[0].doctor_id).toBe(fx.parties.doctor!);
    const audit = await q("SELECT actor, details->>'actorUserId' AS user_id FROM audit_log WHERE action='planned_visit.rebook' AND entity_id=$1::text", [f.id]);
    expect(audit.map(row => row.actor)).toEqual(["SYN-RB-DESK"]);
    expect(await rebook("desk", f.intent)).toMatchObject({ ok: true, replayed: true, appointmentId: result.appointmentId });
    // Another actor's request id never replays someone else's receipt.
    expect(await rebook("owner", f.intent)).toMatchObject({ ok: false, status: 409 });
  });
  it("a stale expectation and a past time refuse and roll back", async () => {
    const f = await fixture(fx.parties.doctor!);
    expect(await rebook("desk", { ...f.intent, expectedAppointmentId: f.oldId + 999 })).toMatchObject({ ok: false, status: 409 });
    expect(await rebook("desk", { ...f.intent, date: "2020-01-01", requestId: "synthetic-canonical-rebook-past-0000" })).toMatchObject({ ok: false, status: 400 });
    expect(await links(f.id)).toEqual([{ id: f.oldId, status: "no_show" }]);
  });
});

describe("scope and admission", () => {
  it("own scope rebooks its own patients' sessions on its own party; another's patient is refused before any write", async () => {
    const mine = await fixture(fx.parties.doctor!);
    expect((await rebook("doctor", mine.intent)).ok).toBe(true);
    const theirs = await fixture(fx.parties.other!);
    expect(await rebook("doctor", theirs.intent)).toMatchObject({ ok: false, status: 403 });
    expect(await links(theirs.id)).toEqual([{ id: theirs.oldId, status: "no_show" }]);
  });
  it("own appointment scope never rebooks on another doctor", async () => {
    const f = await fixture(fx.parties.other!);
    await q("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1", [f.patientId, fx.parties.doctor!]);
    expect(await rebook("doctor", f.intent)).toMatchObject({ ok: false, status: 403 });
    expect(await links(f.id)).toEqual([{ id: f.oldId, status: "no_show" }]);
  });
  it("no appointments.create, no appointment scope or a stale session refuse before any write", async () => {
    const f = await fixture(fx.parties.doctor!);
    await expect(rebook("viewer", f.intent)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(rebook("noAppointments", f.intent)).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const session = await fx.session("revoked");
    await fx.setGrants("revoked", {}, { patientScope: "all", appointmentScope: "all" });
    await expect(planned.commandCanonicalPlannedVisitRebook(session, f.intent)).rejects.toThrow(/^STAFF_OPERATION_/);
    expect(await links(f.id)).toEqual([{ id: f.oldId, status: "no_show" }]);
  });
});
