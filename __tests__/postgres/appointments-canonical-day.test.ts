/** M2 slice 15: canonical appointment reads (GET /api/appointments?date=, GET
 * /api/appointments/mine) on real PostgreSQL, synthetic data only. Rows follow the
 * appointment scope (own = assigned to the clinician party); lab readiness only with the
 * operational summary; the personal schedule is the actor's own clinician party only. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-appointment-day-2026");
const db = await import("../../lib/db");
const appointments = await import("../../lib/canonical-appointments");

const DAY = "2026-11-03";
const ACCOUNTS = {
  owner: { username: "SYN-AD-OWNER", role: "admin" },
  reception: { username: "SYN-AD-RECEPTION", role: "reception", appointmentScope: "all", grants: { "patients.operational-summary.view": true } },
  plain: { username: "SYN-AD-PLAIN", role: "reception", appointmentScope: "all", grants: {} },
  doctor: { username: "SYN-AD-DOCTOR", role: "doctor", doctor: true, appointmentScope: "own", patientScope: "own", grants: { "clinical.plans.view": true } },
  other: { username: "SYN-AD-OTHER", role: "doctor", doctor: true, appointmentScope: "own", grants: {} },
  patientsOnly: { username: "SYN-AD-PATIENTS", role: "reception", patientScope: "all", grants: {} },
  unlinked: { username: "SYN-AD-UNLINKED", role: "reception", appointmentScope: "all", grants: {} },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let mine = 0, theirs = 0, unassigned = 0;

const day = async (k: Key, date = DAY) => appointments.readCanonicalAppointmentDay(await fx.session(k), date);
const mineSchedule = async (k: Key, date = DAY) => appointments.readCanonicalMySchedule(await fx.session(k), date);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES($1,$2,'0500000000',$3) RETURNING id", [number, `SYN Day ${number}`, doctor])).rows[0].id;
  const p1 = await patient("SYN-AD-1", fx.parties.doctor!);
  const p2 = await patient("SYN-AD-2", null);
  const appointment = async (patientId: number, doctorId: number | null, time: string) =>
    (await fx.pool.query<{ id: number }>("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,doctor_id) VALUES($1,$2,$3,$4) RETURNING id", [patientId, DAY, time, doctorId])).rows[0].id;
  mine = await appointment(p1, fx.parties.doctor!, "09:00");
  theirs = await appointment(p2, fx.parties.other!, "10:00");
  unassigned = await appointment(p1, null, "11:00");
  await fx.pool.query("INSERT INTO lab_orders (patient_id, lab_name, work_type, status, due_date) VALUES ($1,'Synthetic lab','تاج تجريبي','sent',$2)", [p1, DAY]);
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("day list", () => {
  it("all scope lists every appointment; lab readiness only with the operational summary", async () => {
    const withSummary = await day("reception");
    expect(withSummary.appointments.map(row => row.id)).toEqual([mine, theirs, unassigned]);
    expect(withSummary.projection.labReadiness).toBe(true);
    expect(withSummary.appointments[0].labReadiness).toEqual([expect.objectContaining({ workType: "تاج تجريبي" })]);
    const plain = await day("plain");
    expect(plain.projection.labReadiness).toBe(false);
    for (const row of plain.appointments) expect(row).not.toHaveProperty("labReadiness");
  });
  it("own scope lists only the appointments assigned to the clinician — not unassigned ones, not other doctors'", async () => {
    expect((await day("doctor")).appointments.map(row => row.id)).toEqual([mine]);
    expect((await day("other")).appointments.map(row => row.id)).toEqual([theirs]);
  });
  it("a patient scope alone does not open the schedule; a bad date refuses", async () => {
    await expect(day("patientsOnly")).rejects.toThrow(/RECORD_SCOPE_DENIED/);
    await expect(day("reception", "03/11/2026")).rejects.toMatchObject({ code: "invalid_appointment_query", status: 400 });
  });
});

describe("personal schedule", () => {
  it("lists the actor's own clinician schedule; the file link follows the patient scope", async () => {
    const schedule = await mineSchedule("doctor");
    expect(schedule.appointments.map(row => row.appointmentId)).toEqual([mine]);
    expect(schedule.appointments[0].patientHref).toMatch(/^\/patients\/\d+$/);
    const other = await mineSchedule("other");
    expect(other.appointments.map(row => row.appointmentId)).toEqual([theirs]);
    expect(other.appointments[0].patientHref).toBeNull();
  });
  it("an account without a clinician link is refused; dates are validated", async () => {
    await expect(mineSchedule("unlinked")).rejects.toMatchObject({ code: "clinician_link_required", status: 403 });
    await expect(mineSchedule("doctor", "yesterday")).rejects.toMatchObject({ code: "invalid_appointment_query" });
  });
});
