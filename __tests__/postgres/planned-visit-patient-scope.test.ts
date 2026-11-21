import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";

const sessionCookie = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => sessionCookie.value ? { name, value: sessionCookie.value } : undefined }),
  headers: async () => new Headers(),
}));

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getClinicalVisit, getPool, listPatientPlannedVisits, patientWorkflow, resetPoolForTesting } =
  await import("../../lib/db");

beforeAll(async () => { await ensureSchema(); });
afterAll(async () => { await resetPoolForTesting(); });

const q = async (sql: string, values: unknown[]) => getPool().query<{ id: number }>(sql, values);
const id = async (sql: string, values: unknown[]) => (await q(sql, values)).rows[0].id;
const patient = () => id("INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic') RETURNING id", [`SYN-PS-${randomUUID()}`]);
const plan = (patientId: number, title = "Own plan", status = "active") =>
  id("INSERT INTO treatment_plans (patient_id, title, status, total_minor) VALUES ($1, $2, $3, 100) RETURNING id", [patientId, title, status]);
const appointment = (patientId: number) =>
  id("INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, status) VALUES ($1, '2026-09-15', '09:25', 'no_show') RETURNING id", [patientId]);
const visit = (patientId: number, plannedId: number | null = null) =>
  id("INSERT INTO visits (patient_id, patient_name, planned_visit_id) VALUES ($1, 'Own visit', $2) RETURNING id", [patientId, plannedId]);
const planned = (patientId: number, planId: number | null, appointmentId: number | null, status = "planned") =>
  id(`INSERT INTO planned_visits (patient_id, plan_id, appointment_id, sequence, title, status)
    VALUES ($1, $2, $3, 1, 'Planned fixture', $4) RETURNING id`, [patientId, planId, appointmentId, status]);
const item = (planId: number) =>
  id("INSERT INTO plan_items (plan_id, service_name, unit_price_minor) VALUES ($1, 'Own service', 100) RETURNING id", [planId]);

async function fixture() {
  const a = await patient();
  const b = await patient();
  const ownPlan = await plan(a);
  const foreignPlan = await plan(b, "Other synthetic plan");
  const ownAppointment = await appointment(a);
  const plannedId = await planned(a, ownPlan, ownAppointment);
  const visitId = await visit(a, plannedId);
  await q("UPDATE appointments SET planned_visit_id = $1 WHERE id = $2", [plannedId, ownAppointment]);
  return { a, b, ownPlan, foreignPlan, ownAppointment, plannedId, visitId };
}

describe("same-patient projection of legacy planned visits", () => {
  it("keeps normal own context, terminal appointment rebooking hint and valid null-plan rows", async () => {
    const { a, ownPlan, ownAppointment, plannedId, visitId } = await fixture();
    const optionalId = await planned(a, null, null);
    expect(await listPatientPlannedVisits(a)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: plannedId, planId: ownPlan, appointmentId: ownAppointment,
        appointmentDate: "2026-09-15", appointmentTime: "09:25", appointmentStatus: "no_show", canRebook: false }),
      expect.objectContaining({ id: optionalId, planId: null, planTitle: null, appointmentId: null, visitId: null }),
    ]));
    expect((await getClinicalVisit(visitId))?.plannedVisit).toMatchObject({ id: plannedId, planTitle: "Own plan" });
    expect((await patientWorkflow(a, "2026-09-15")).openVisit).toMatchObject({ id: visitId, plannedTitle: "Planned fixture" });
    const optionalVisit = await visit(a, optionalId);
    expect((await getClinicalVisit(optionalVisit))?.plannedVisit).toMatchObject({ id: optionalId, planTitle: null });

    // Valid historical context is preserved even though completed rows leave the active list.
    await q("UPDATE planned_visits SET status = 'completed', visit_id = $2 WHERE id = $1", [plannedId, visitId]);
    await q("UPDATE visits SET signed_at = NOW(), status = 'done' WHERE id = $1", [visitId]);
    expect(await listPatientPlannedVisits(a)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: plannedId })]));
    expect(await getClinicalVisit(visitId)).toMatchObject({ status: "signed", plannedVisit: { id: plannedId, planTitle: "Own plan" } });
  });

  it("keeps upcoming and cancelled-appointment context without reviving an ended planned row", async () => {
    const patientId = await patient();
    const ownPlan = await plan(patientId);
    const booked = await appointment(patientId);
    const cancelled = await appointment(patientId);
    const completedBooking = await appointment(patientId);
    const upcomingId = await planned(patientId, ownPlan, booked, "scheduled");
    const cancelledBookingId = await planned(patientId, ownPlan, cancelled, "scheduled");
    const endedPlanId = await planned(patientId, ownPlan, null, "cancelled");
    const completedId = await planned(patientId, ownPlan, completedBooking, "completed");
    const historyVisitId = await visit(patientId, completedId);
    await q("UPDATE appointments SET status = 'booked', planned_visit_id = $2, scheduled_date = CURRENT_DATE + 7 WHERE id = $1", [booked, upcomingId]);
    await q("UPDATE appointments SET status = 'cancelled', planned_visit_id = $2, scheduled_date = CURRENT_DATE - 2 WHERE id = $1", [cancelled, cancelledBookingId]);
    await q("UPDATE appointments SET status = 'done', planned_visit_id = $2, scheduled_date = CURRENT_DATE - 7 WHERE id = $1", [completedBooking, completedId]);
    await q("UPDATE planned_visits SET visit_id = $2 WHERE id = $1", [completedId, historyVisitId]);
    await q("UPDATE visits SET status = 'done', signed_at = NOW(), appointment_id = $2 WHERE id = $1", [historyVisitId, completedBooking]);

    const read = await listPatientPlannedVisits(patientId);
    expect(read.map(row => row.id)).toEqual([upcomingId, cancelledBookingId]);
    expect(read).toMatchObject([
      { id: upcomingId, appointmentId: booked, appointmentStatus: "booked", canRebook: false },
      { id: cancelledBookingId, appointmentId: cancelled, appointmentStatus: "cancelled", canRebook: true },
    ]);
    expect(read.find(row => row.id === endedPlanId)).toBeUndefined();
    expect((await patientWorkflow(patientId, "2026-09-15")).plannedVisits).toEqual(read);
    expect(await getClinicalVisit(historyVisitId)).toMatchObject({ status: "signed", plannedVisit: { id: completedId, planTitle: "Own plan" } });

    // The actual GET handlers check a signed session against the owned PG user.
    // Only the framework request-cookie adapter is mocked; no auth or DB stub.
    const username = `synthetic-planned-${randomUUID()}`;
    const passwordHash = "synthetic-planned-fixture-hash";
    const userId = await id(`INSERT INTO users (username, display_name, password_hash, role, is_active)
      VALUES ($1, 'Synthetic staff', $2, 'admin', true) RETURNING id`, [username, passwordHash]);
    vi.stubEnv("SESSION_SECRET", randomUUID() + randomUUID());
    try {
      const { createSessionToken, sessionCredentialVersion } = await import("../../lib/auth");
      sessionCookie.value = createSessionToken({
        userId, username, role: "admin", expiresAt: Date.now() + 60_000,
        credentialVersion: sessionCredentialVersion(passwordHash),
      });
      const plansRoute = await import("../../app/api/patients/[id]/plans/route");
      const workflowRoute = await import("../../app/api/patients/[id]/workflow/route");
      const clinicalRoute = await import("../../app/api/visits/[id]/clinical/route");
      type ReadHandler = (request: Request, context: Parameters<typeof plansRoute.GET>[1]) => Promise<Response>;
      const call = async (get: ReadHandler, pathname: string, recordId: number) => {
        const response = await get(new Request(`http://localhost${pathname}`), {
          params: Promise.resolve({ id: String(recordId) }),
        });
        expect(response.status).toBe(200);
        return await response.json();
      };
      for (const [route, segment] of [[plansRoute, "plans"], [workflowRoute, "workflow"]] as const) {
        const payload = await call(route.GET, `/api/patients/${patientId}/${segment}`, patientId);
        expect(payload.plannedVisits).toMatchObject([
          { id: upcomingId, appointmentStatus: "booked", canRebook: false },
          { id: cancelledBookingId, appointmentStatus: "cancelled", canRebook: true },
        ]);
      }
      expect(await call(clinicalRoute.GET, `/api/visits/${historyVisitId}/clinical`, historyVisitId))
        .toMatchObject({ status: "signed", plannedVisit: { id: completedId, planTitle: "Own plan" } });
    } finally {
      sessionCookie.value = null;
      vi.unstubAllEnvs();
    }
  });

  it("does not attribute a foreign planned visit to an otherwise valid current visit", async () => {
    const { a, b, foreignPlan, visitId } = await fixture();
    const foreignPlanned = await planned(b, foreignPlan, null);
    await q("UPDATE visits SET planned_visit_id = $2 WHERE id = $1", [visitId, foreignPlanned]);
    expect(await getClinicalVisit(visitId)).toMatchObject({ id: visitId, patientId: a, plannedVisit: null });
    expect((await patientWorkflow(a, "2026-09-15")).openVisit).toMatchObject({ id: visitId, plannedTitle: null });
  });

  it("suggests only the appointment belonging to the recorded patient", async () => {
    const a = await patient();
    const b = await patient();
    const own = await appointment(a);
    const other = await appointment(b);
    const visitId = await visit(a);
    const doctor = await id("INSERT INTO parties (kind, name) VALUES ('doctor', 'Synthetic clinician') RETURNING id", []);
    await q("UPDATE appointments SET note = 'Own appointment note' WHERE id = $1", [own]);
    await q("UPDATE appointments SET note = 'Other synthetic note', doctor_id = $2 WHERE id = $1", [other, doctor]);
    await q("UPDATE visits SET appointment_id = $2 WHERE id = $1", [visitId, own]);
    expect((await getClinicalVisit(visitId))?.suggestions).toMatchObject({ chiefComplaint: "Own appointment note" });
    await q("UPDATE visits SET appointment_id = $2 WHERE id = $1", [visitId, other]);
    expect((await getClinicalVisit(visitId))?.suggestions).toMatchObject({ chiefComplaint: null, doctorId: null });
  });

  it("ignores an inconsistent next suggestion and still suggests a valid own one", async () => {
    const { a, b, ownPlan, foreignPlan, plannedId, visitId } = await fixture();
    const candidate = await planned(a, foreignPlan, null);
    const accepted = await planned(a, ownPlan, null);
    const foreignAnchor = await planned(b, foreignPlan, null);
    await q("UPDATE planned_visits SET title = 'Inconsistent suggestion', sequence = 2 WHERE id = $1", [candidate]);
    await q("UPDATE planned_visits SET title = 'Own next', sequence = 3, after_days = 7 WHERE id = $1", [accepted]);
    expect((await getClinicalVisit(visitId))?.suggestions.nextPlan).toContain("Own next");
    await q("UPDATE planned_visits SET status = 'completed' WHERE id = $1", [plannedId]);
    await q("UPDATE visits SET planned_visit_id = $2 WHERE id = $1", [visitId, foreignAnchor]);
    expect((await getClinicalVisit(visitId))?.suggestions.nextPlan).toContain("Own next");
    await q("UPDATE planned_visits SET status = 'completed' WHERE id = $1", [accepted]);
    expect((await getClinicalVisit(visitId))?.suggestions.nextPlan).toBeNull();
  });

  it.each(["plan", "appointment", "linked visit", "session item", "session visit", "referral"] as const)(
    "omits only the inconsistent planned projection when the %s links to another patient",
    async (relation) => {
      const { a, b, ownPlan, foreignPlan, ownAppointment, plannedId, visitId } = await fixture();
      const unaffectedId = await planned(a, null, null);
      if (relation === "plan") await q("UPDATE planned_visits SET plan_id = $2 WHERE id = $1", [plannedId, foreignPlan]);
      if (relation === "appointment") await q("UPDATE planned_visits SET appointment_id = $2 WHERE id = $1", [plannedId, await appointment(b)]);
      if (relation === "linked visit") await q("UPDATE planned_visits SET visit_id = $2 WHERE id = $1", [plannedId, await visit(b)]);
      if (relation === "session item" || relation === "session visit") {
        await q(`INSERT INTO treatment_sessions (plan_item_id, sequence, planned_visit_id, visit_id)
          VALUES ($1, 1, $2, $3)`, [
          await item(relation === "session item" ? foreignPlan : ownPlan), plannedId, relation === "session visit" ? await visit(b) : null,
        ]);
      }
      if (relation === "referral") {
        const referralId = await id(`INSERT INTO patient_referrals (patient_id, to_name, to_specialty, reason, created_by)
          VALUES ($1, 'Synthetic clinician', 'Synthetic specialty', 'Synthetic reason', 'test') RETURNING id`, [b]);
        await q("UPDATE appointments SET referral_id = $2 WHERE id = $1", [ownAppointment, referralId]);
      }
      expect((await listPatientPlannedVisits(a)).map(row => row.id)).toEqual([unaffectedId]);
      expect(await getClinicalVisit(visitId)).toMatchObject({ id: visitId, patientId: a, plannedVisit: null });
      const workflow = await patientWorkflow(a, "2026-09-15");
      expect(workflow.openVisit).toMatchObject({ id: visitId, plannedTitle: null });
      expect(workflow.plannedVisits.map(row => row.id)).toEqual([unaffectedId]);
    },
  );
});
