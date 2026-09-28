import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (VISIT-1) الزيارة تُفتح بما يعرفه النظام: سبب الموعد ونوعه وطبيبه، والجلسة المخطَّطة
 * وطبيبها والجلسة التي بعدها بفاصلها، والطبيب الداخل إن كان طبيبًا.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { getPool, resetPoolForTesting, ensureSchema, createPlanV2, getClinicalVisit } = await import("../../lib/db");

let patientId = 0;
let rctId = 0;
let drA = 0;
let drB = 0;
let supplier = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  ({ rows: [{ id: drA }] } = await pool.query(`INSERT INTO parties (name, kind) VALUES ('د. أ', 'doctor') RETURNING id`));
  ({ rows: [{ id: drB }] } = await pool.query(`INSERT INTO parties (name, kind) VALUES ('د. ب', 'doctor') RETURNING id`));
  ({ rows: [{ id: supplier }] } = await pool.query(`INSERT INTO parties (name, kind) VALUES ('مورّد', 'supplier') RETURNING id`));
  ({ rows: [{ id: patientId }] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ('V1-1', 'مريض الزيارة', $1) RETURNING id`, [drB]));
  ({ rows: [{ id: rctId }] } = await pool.query(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('نزع عصب', 40000, TRUE, TRUE, 'rct') RETURNING id`));
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function visit(fields: { appointmentId?: number | null; plannedVisitId?: number | null } = {}) {
  const { rows: [row] } = await getPool().query<{ id: number }>(
    `INSERT INTO visits (patient_name, status, patient_id, arrived_at, appointment_id, planned_visit_id)
     VALUES ('مريض الزيارة', 'in_chair', $1, NOW(), $2::int, $3::int) RETURNING id`,
    [patientId, fields.appointmentId ?? null, fields.plannedVisitId ?? null]);
  return row.id;
}

describe("(VISIT-1) visit suggestions from what the system already knows", () => {
  it("from an appointment: its type and reason as the complaint, its doctor; the patient's own doctor otherwise", async () => {
    const { rows: [appointment] } = await getPool().query<{ id: number }>(
      `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, appointment_type, note, doctor_id)
       VALUES ($1, CURRENT_DATE, '10:00', 30, 'emergency', 'ألم شديد في الضرس السفلي', $2) RETURNING id`,
      [patientId, drA]);
    const fromAppointment = await getClinicalVisit(await visit({ appointmentId: appointment.id }));
    expect(fromAppointment?.suggestions).toEqual({
      doctorId: drA, chiefComplaint: "طوارئ — ألم شديد في الضرس السفلي", nextPlan: null,
    });

    const walkIn = await getClinicalVisit(await visit());
    expect(walkIn?.suggestions).toEqual({ doctorId: drB, chiefComplaint: null, nextPlan: null });
  });

  it("the doctor who opens it comes first — but only a doctor party, not any linked party", async () => {
    const id = await visit();
    expect((await getClinicalVisit(id, { actorPartyId: drA }))?.suggestions.doctorId).toBe(drA);
    expect((await getClinicalVisit(id, { actorPartyId: supplier }))?.suggestions.doctorId).toBe(drB);
  });

  it("a template session: complaint names it, next plan names the next session with its interval; a cancelled plan is not suggested", async () => {
    const created = await createPlanV2({
      patientId, title: "علاج عصب 36", specialty: "علاج عصب", primaryDoctorId: null,
      billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-01-01", note: null,
      items: [{
        serviceId: rctId, serviceName: "نزع عصب", category: "rct", toothCode: 36, surfaces: null,
        quantity: 1, unitPriceMinor: 40000, billingRule: "per_session", sessionCount: 3, note: null,
        sessionPlan: [
          { title: "فتح وتنظيف", minutes: 45, afterDays: 0, visitKey: "rct:0", visitTitle: "فتح وتنظيف — سن 36" },
          { title: "تشكيل وتعقيم", minutes: 45, afterDays: 7, visitKey: "rct:1", visitTitle: "تشكيل وتعقيم — سن 36" },
          { title: "حشو نهائي", minutes: 45, afterDays: 10, visitKey: "rct:2", visitTitle: "حشو نهائي — سن 36" },
        ],
      }],
      installments: [], createdBy: "v1",
    });
    if (!created.ok) throw new Error(created.message);
    const pool = getPool();
    const { rows: planned } = await pool.query<{ id: number }>(
      `SELECT id FROM planned_visits WHERE plan_id = $1 ORDER BY sequence`, [created.planId]);
    await pool.query(`UPDATE planned_visits SET doctor_id = $2 WHERE id = $1`, [planned[0].id, drA]);

    const first = await getClinicalVisit(await visit({ plannedVisitId: planned[0].id }));
    expect(first?.suggestions).toEqual({
      doctorId: drA,
      chiefComplaint: "جلسة مخطَّطة: فتح وتنظيف — سن 36",
      nextPlan: "الجلسة القادمة: تشكيل وتعقيم — سن 36 — بعد 7 أيام",
    });

    await pool.query(`UPDATE treatment_plans SET status = 'cancelled' WHERE id = $1`, [created.planId]);
    expect((await getClinicalVisit(await visit()))?.suggestions.nextPlan).toBeNull();
  });
});
