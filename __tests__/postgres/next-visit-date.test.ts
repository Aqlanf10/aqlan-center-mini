import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signerDoctorPartyId } from "./_signer";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (SPEC-T4) بعد توقيع جلسةٍ من خطة القالب تُقترح الزيارة القادمة **بتاريخها**: اليوم + فاصل
 * القالب (تشكيل القنوات بعد ٧ أيام). كانت خطة القالب — وزياراتها كلها منشأةٌ سلفًا — تُجاب
 * بـ«لا جلسة قادمة — اكتمل العلاج» بعد أول جلسة، وهو خطأ.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, createPlanV2, setVisitProcedures, signClinicalVisit, CLINIC_TIME_ZONE,
} = await import("../../lib/db");
const { CLINIC_BASE_CURRENCY } = await import("../../lib/money");
const { addDays, clinicDateString } = await import("../../lib/schedule");

let patientId = 0;
let rctId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  ({ rows: [{ id: patientId }] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('T4-1', 'مريض العصب') RETURNING id`));
  ({ rows: [{ id: rctId }] } = await pool.query(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('نزع عصب', 40000, TRUE, TRUE, 'rct') RETURNING id`));
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function consented(planId: number) {
  await getPool().query(`UPDATE treatment_plans SET consent_at = NOW(), consent_by = 't4' WHERE id = $1`, [planId]);
}

async function sign(planItemId: number, plannedVisitId: number | null) {
  const { rows: [visit] } = await getPool().query<{ id: number }>(
    `INSERT INTO visits (patient_name, status, patient_id, arrived_at, planned_visit_id)
     VALUES ('مريض العصب', 'seated', $1, NOW(), $2::int) RETURNING id`, [patientId, plannedVisitId]);
  await setVisitProcedures({
    visitId: visit.id,
    procedures: [{ serviceId: rctId, toothCode: 36, surfaces: null, quantity: 1, unitPriceMinor: 40000, priceReason: null, doctorId: null, note: null, planItemId }],
  });
  const signed = await signClinicalVisit({ visitId: visit.id, baseCurrency: CLINIC_BASE_CURRENCY, signedBy: "t4", signerDoctorPartyId: await signerDoctorPartyId() });
  expect(signed.reason).toBeNull();
  return signed.nextPlannedVisit;
}

describe("(SPEC-T4) the next visit is suggested with its date", () => {
  it("template plan: after session 1 the next planned visit comes with today + 7 days; after the last, none", async () => {
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
      installments: [], createdBy: "t4",
    });
    if (!created.ok) throw new Error(created.message);
    await consented(created.planId);
    const pool = getPool();
    const { rows: visits } = await pool.query<{ id: number; after_days: number | null }>(
      `SELECT id, after_days FROM planned_visits WHERE plan_id = $1 ORDER BY sequence`, [created.planId]);
    expect(visits.map((visit) => visit.after_days)).toEqual([0, 7, 10]);
    const { rows: [item] } = await pool.query<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1`, [created.planId]);

    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const afterFirst = await sign(item.id, visits[0].id);
    expect(afterFirst).toMatchObject({ id: visits[1].id, title: "تشكيل وتعقيم — سن 36", afterDays: 7, suggestedDate: addDays(today, 7) });

    const afterSecond = await sign(item.id, visits[1].id);
    expect(afterSecond).toMatchObject({ id: visits[2].id, afterDays: 10, suggestedDate: addDays(today, 10) });

    expect(await sign(item.id, visits[2].id)).toBeNull();
  });

  it("unchanged for a plan without template sessions: the next session gets a new planned visit, no date", async () => {
    const created = await createPlanV2({
      patientId, title: "عصب يدوي", specialty: null, primaryDoctorId: null,
      billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-01-01", note: null,
      items: [{
        serviceId: rctId, serviceName: "نزع عصب", category: "rct", toothCode: 36, surfaces: null,
        quantity: 1, unitPriceMinor: 40000, billingRule: "per_session", sessionCount: 2, note: null,
      }],
      installments: [], createdBy: "t4",
    });
    if (!created.ok) throw new Error(created.message);
    await consented(created.planId);
    const pool = getPool();
    const { rows: [first] } = await pool.query<{ id: number }>(`SELECT id FROM planned_visits WHERE plan_id = $1`, [created.planId]);
    const { rows: [item] } = await pool.query<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1`, [created.planId]);
    const next = await sign(item.id, first.id);
    expect(next).toMatchObject({ suggestedDate: null, afterDays: null });
    expect(next?.id).not.toBe(first.id);
  });
});
