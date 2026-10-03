import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionPayload } from "../../lib/auth";
import type { PlannedVisitView } from "../../lib/db";
import type { AppointmentReadScope } from "../../lib/appointment-read-scope";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

// Existing PostgreSQL-18 lifecycle only. Validate the original target before
// stubPostgresEnv removes deployment markers; never add another runtime harness.
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getPool, resetPoolForTesting, patientWorkflow, listPatientPlannedVisits, listPatientPlannedVisitReads, doctorOwnedPatientIds, CLINIC_TIME_ZONE } = await import("../../lib/db");
const { resolveAppointmentReadScope } = await import("../../lib/appointment-read-access");
const { canAccessPatient } = await import("../../lib/patient-access");
const { clinicDateString } = await import("../../lib/schedule");
const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);

async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, values)).rows as T[];
}

let readerDoctorId = 0;
let otherDoctorId = 0;
let sequence = 0;

beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString());
  await ensureSchema();
  readerDoctorId = (await q<{ id: number }>(
    "INSERT INTO parties (kind, name) VALUES ('doctor', 'Workflow calendar reader') RETURNING id"))[0].id;
  otherDoctorId = (await q<{ id: number }>(
    "INSERT INTO parties (kind, name) VALUES ('doctor', 'Other clinical provider') RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

/** Every visit/appointment has a real synthetic patient FK from initial insert. */
async function linkedFixture(owner: "none" | "primary" | "appointment" = "none") {
  sequence += 1;
  // Keep extracted digits bounded: ensureSchema seeds numeric document counters.
  const patientNumber = String(870000 + sequence);
  const patientId = (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id)
     VALUES ($1, 'Synthetic linked workflow patient', $2) RETURNING id`,
    [patientNumber, owner === "primary" ? readerDoctorId : otherDoctorId]))[0].id;
  const planId = (await q<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, primary_doctor_id, start_date)
     VALUES ($1, 'Clinical workflow plan', 0, $2, $3::date) RETURNING id`,
    [patientId, otherDoctorId, today]))[0].id;
  const earlierId = (await q<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, doctor_id, duration_minutes, status, note)
     VALUES ($1, $2::date, '09:10', $3, 45, 'arrived', 'EARLIER_CALENDAR_ONLY') RETURNING id`,
    [patientId, today, owner === "appointment" ? readerDoctorId : otherDoctorId]))[0].id;
  const later = (await q<{ id: number; date: string }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, doctor_id, duration_minutes, status, note)
     VALUES ($1, $2::date + 1, '11:20', NULL, 30, 'booked', 'LATER_READABLE_CALENDAR')
     RETURNING id, scheduled_date::text AS date`, [patientId, today]))[0];
  const visitId = (await q<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, appointment_id, doctor_id, status)
     VALUES ('Synthetic linked workflow patient', $1, $2, $3, 'waiting') RETURNING id`,
    [patientId, earlierId, otherDoctorId]))[0].id;
  const plannedRows = await q<{ id: number }>(
    `INSERT INTO planned_visits
       (patient_id, plan_id, sequence, title, doctor_id, duration_minutes, status, appointment_id, visit_id, note)
     VALUES ($1, $2, 1, 'Current clinical work', $3, 45, 'in_progress', $4, $6, 'Clinical note A'),
            ($1, $2, 2, 'Next clinical work', $3, 30, 'scheduled', $5, NULL, 'Clinical note B')
     RETURNING id`, [patientId, planId, otherDoctorId, earlierId, later.id, visitId]);
  const firstPlannedId = plannedRows[0].id;
  const laterPlannedId = plannedRows[1].id;
  await q("UPDATE visits SET planned_visit_id = $2 WHERE id = $1", [visitId, firstPlannedId]);
  await q("UPDATE appointments SET planned_visit_id = $2 WHERE id = $1", [earlierId, firstPlannedId]);
  await q("UPDATE appointments SET planned_visit_id = $2 WHERE id = $1", [later.id, laterPlannedId]);
  return { patientId, planId, earlierId, laterId: later.id, laterDate: later.date, visitId, firstPlannedId, laterPlannedId };
}

async function doctorScope(patientId: number): Promise<AppointmentReadScope> {
  return { kind: "doctor", doctorPartyId: readerDoctorId,
    ownedPatientIds: await doctorOwnedPatientIds(readerDoctorId, [patientId]) };
}

type Summary = Awaited<ReturnType<typeof patientWorkflow>>;
function clinicalRows(summary: { plannedVisits: PlannedVisitView[] }) {
  return summary.plannedVisits.map((row) => ({
    id: row.id, planId: row.planId, planTitle: row.planTitle, sequence: row.sequence,
    title: row.title, doctorId: row.doctorId, doctorName: row.doctorName,
    durationMinutes: row.durationMinutes, status: row.status, visitId: row.visitId,
    note: row.note, createdAt: row.createdAt,
  }));
}
function expectHiddenCalendar(summary: Summary) {
  expect(summary.appointmentVisibility).toBe("hidden");
  expect(summary.nextAppointment).toBeNull();
  expect(summary.plannedVisits).toHaveLength(2);
  for (const row of summary.plannedVisits) expect(row).toMatchObject({
    appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "hidden",
  });
}

describe("patient workflow calendar projection on real PostgreSQL", () => {
  it("selects the later readable row when an earlier hidden row precedes LIMIT 1", async () => {
    const fixture = await linkedFixture();
    const scope = await doctorScope(fixture.patientId);
    expect(scope).toEqual({ kind: "doctor", doctorPartyId: readerDoctorId, ownedPatientIds: new Set() });
    const full = await patientWorkflow(fixture.patientId, today, { kind: "all" });
    expect(full.nextAppointment?.id).toBe(fixture.earlierId);
    const scoped = await patientWorkflow(fixture.patientId, today, scope);
    expect(scoped.appointmentVisibility).toBe("scoped");
    expect(scoped.nextAppointment).toMatchObject({ id: fixture.laterId, date: fixture.laterDate,
      time: "11:20", durationMinutes: 30, note: "LATER_READABLE_CALENDAR", status: "booked" });
    expect(clinicalRows(scoped)).toEqual(clinicalRows(full));
    expect(scoped.plannedVisits.find((row) => row.id === fixture.firstPlannedId)).toMatchObject({
      id: fixture.firstPlannedId, planId: fixture.planId, visitId: fixture.visitId, status: "in_progress",
      appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "scoped",
    });
    expect(scoped.plannedVisits.find((row) => row.id === fixture.laterPlannedId)).toMatchObject({
      status: "scheduled", doctorId: otherDoctorId, appointmentId: fixture.laterId,
      appointmentDate: fixture.laterDate, appointmentTime: "11:20", appointmentVisibility: "scoped",
    });
    expect(JSON.stringify(scoped)).not.toContain("EARLIER_CALENDAR_ONLY");
    // A hidden joined reference cannot manufacture the original unscheduled alert.
    expect(scoped.alerts.some((alert) => alert.kind === "unscheduled_visit")).toBe(false);
  });

  it.each(["explicit-none", "omitted"])("withholds even unassigned calendar metadata for %s scope without changing clinical rows", async (kind) => {
    const fixture = await linkedFixture();
    const full = await patientWorkflow(fixture.patientId, today, { kind: "all" });
    const before = await q("SELECT id, patient_id, plan_id, status, appointment_id, visit_id FROM planned_visits WHERE patient_id = $1 ORDER BY id", [fixture.patientId]);
    const hidden = kind === "omitted" ? await patientWorkflow(fixture.patientId, today)
      : await patientWorkflow(fixture.patientId, today, { kind: "none" });
    expectHiddenCalendar(hidden);
    expect(clinicalRows(hidden)).toEqual(clinicalRows(full));
    expect(hidden.openVisit).toEqual(full.openVisit);
    expect(hidden.activePlans).toEqual(full.activePlans);
    expect(hidden.financial).toEqual(full.financial);
    expect(hidden.alerts.some((alert) => alert.kind === "unscheduled_visit")).toBe(false);
    expect(await q("SELECT id, patient_id, plan_id, status, appointment_id, visit_id FROM planned_visits WHERE patient_id = $1 ORDER BY id", [fixture.patientId])).toEqual(before);
  });

  it("keeps today's assistant patient admission separate from the canonical no-calendar scope", async () => {
    const fixture = await linkedFixture();
    const assistant: SessionPayload = { userId: 1, username: "synthetic-assistant-context", role: "assistant", expiresAt: 0 };
    expect(await canAccessPatient(assistant, fixture.patientId)).toBe(true);
    const scope = await resolveAppointmentReadScope(assistant, [fixture.patientId]);
    expect(scope).toEqual({ kind: "none" });
    expectHiddenCalendar(await patientWorkflow(fixture.patientId, today, scope));
    // Reader-only assertion: the actual GET separately strips assistant plans
    // and finance, already covered by the mocked route regression. No account is created.
  });

  it.each(["primary", "appointment"] as const)("retains canonical owned-patient visibility from the %s witness", async (owner) => {
    const fixture = await linkedFixture(owner);
    const scope = await doctorScope(fixture.patientId);
    expect(scope).toEqual({ kind: "doctor", doctorPartyId: readerDoctorId, ownedPatientIds: new Set([fixture.patientId]) });
    const summary = await patientWorkflow(fixture.patientId, today, scope);
    expect(summary.appointmentVisibility).toBe("all");
    expect(summary.nextAppointment?.id).toBe(fixture.earlierId);
    expect(summary.plannedVisits.find((row) => row.id === fixture.firstPlannedId)).toMatchObject({
      doctorId: otherDoctorId, appointmentId: fixture.earlierId, appointmentDate: today,
      appointmentTime: "09:10", appointmentVisibility: "all", status: "in_progress", visitId: fixture.visitId,
    });
  });

  it.each(["admin", "reception"])("retains the canonical %s all-calendar read without changing grants", async (role) => {
    const fixture = await linkedFixture();
    const session: SessionPayload = { userId: 1, username: "synthetic-read-context", role, expiresAt: 0 };
    const scope = await resolveAppointmentReadScope(session, [fixture.patientId]);
    expect(scope).toEqual({ kind: "all" });
    const summary = await patientWorkflow(fixture.patientId, today, scope);
    expect(summary.appointmentVisibility).toBe("all");
    expect(summary.nextAppointment?.id).toBe(fixture.earlierId);
    expect(summary.plannedVisits.map((row) => row.appointmentId)).toEqual([fixture.earlierId, fixture.laterId]);
  });
});


// Uses the same guarded PostgreSQL-18 target and fully linked synthetic fixtures
// above. No standalone privacy harness, alternative engine, or unlinked visit.
describe("patient plans shared calendar reader on real PostgreSQL", () => {
  it("returns only scoped read rows while preserving clinical content, raw semantics, and persistence", async () => {
    const fixture = await linkedFixture();
    const raw = await listPatientPlannedVisits(fixture.patientId);
    const before = await q("SELECT id, patient_id, plan_id, status, appointment_id, visit_id FROM planned_visits WHERE patient_id = $1 ORDER BY id", [fixture.patientId]);
    const read = await listPatientPlannedVisitReads(fixture.patientId, await doctorScope(fixture.patientId));
    expect(read).toHaveLength(2);
    expect(clinicalRows({ plannedVisits: read })).toEqual(clinicalRows({ plannedVisits: raw }));
    expect(read.find((row) => row.id === fixture.firstPlannedId)).toMatchObject({
      appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "scoped",
      status: "in_progress", visitId: fixture.visitId,
    });
    expect(read.find((row) => row.id === fixture.laterPlannedId)).toMatchObject({
      appointmentId: fixture.laterId, appointmentDate: fixture.laterDate, appointmentTime: "11:20", appointmentVisibility: "scoped",
      doctorId: otherDoctorId, status: "scheduled",
    });
    for (const row of read) {
      expect(row).not.toHaveProperty("source"); expect(row).not.toHaveProperty("read");
      expect(row).not.toHaveProperty("calendar_id"); expect(row).not.toHaveProperty("calendar_patient_id");
      expect(row).not.toHaveProperty("calendar_doctor_id");
    }
    expect(raw.find((row) => row.id === fixture.firstPlannedId)?.appointmentId).toBe(fixture.earlierId);
    expect(raw.every((row) => !("appointmentVisibility" in row))).toBe(true);
    expect(await listPatientPlannedVisits(fixture.patientId)).toEqual(raw);
    expect(await q("SELECT id, patient_id, plan_id, status, appointment_id, visit_id FROM planned_visits WHERE patient_id = $1 ORDER BY id", [fixture.patientId])).toEqual(before);
  });

  it.each(["omitted", "none"])("defaults %s calendar scope closed, including the unassigned appointment", async (kind) => {
    const fixture = await linkedFixture();
    const rows = kind === "omitted" ? await listPatientPlannedVisitReads(fixture.patientId)
      : await listPatientPlannedVisitReads(fixture.patientId, { kind: "none" });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({
      appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "hidden",
    });
    expect(rows.map((row) => row.id)).toEqual([fixture.firstPlannedId, fixture.laterPlannedId]);
    expect((await listPatientPlannedVisits(fixture.patientId)).map((row) => row.appointmentId))
      .toEqual([fixture.earlierId, fixture.laterId]);
  });

  it("uses the joined appointment's provider independently of the planned clinical assignment", async () => {
    const fixture = await linkedFixture("appointment");
    // Isolate the provider predicate from the independent owned-patient witness.
    const scope: AppointmentReadScope = { kind: "doctor", doctorPartyId: readerDoctorId, ownedPatientIds: new Set() };
    const rows = await listPatientPlannedVisitReads(fixture.patientId, scope);
    expect(rows[0]).toMatchObject({ doctorId: otherDoctorId, appointmentId: fixture.earlierId,
      appointmentDate: today, appointmentTime: "09:10", appointmentVisibility: "scoped" });
    expect(rows[1]).toMatchObject({ doctorId: otherDoctorId, appointmentId: fixture.laterId, appointmentVisibility: "scoped" });
  });

  it.each(["primary", "appointment"] as const)("retains complete read rows for the canonical %s ownership witness", async (owner) => {
    const fixture = await linkedFixture(owner);
    const rows = await listPatientPlannedVisitReads(fixture.patientId, await doctorScope(fixture.patientId));
    expect(rows.map((row) => row.appointmentId)).toEqual([fixture.earlierId, fixture.laterId]);
    expect(rows.every((row) => row.appointmentVisibility === "all")).toBe(true);
  });

  it.each(["admin", "reception"])("preserves the canonical %s full-calendar projection", async (role) => {
    const fixture = await linkedFixture();
    const scope = await resolveAppointmentReadScope({ userId: 1, username: "synthetic-plan-reader", role, expiresAt: 0 }, [fixture.patientId]);
    const rows = await listPatientPlannedVisitReads(fixture.patientId, scope);
    expect(rows.map((row) => row.appointmentId)).toEqual([fixture.earlierId, fixture.laterId]);
    expect(rows.every((row) => row.appointmentVisibility === "all")).toBe(true);
  });
});
