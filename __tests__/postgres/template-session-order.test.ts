import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (SPEC-T1 review) زيارات القالب مُعيَّنة جلسةً جلسة — فزيارةٌ عنوانها «حشو القنوات النهائي» لا
 * تُسجِّل «فتح وتنظيف» لأن أحدهم فتحها قبل سابقتها. تُرفض برسالة عربية تسمّي الجلسة التالية.
 * والزيارة غير المربوطة بزيارةٍ مخطَّطة (المسار القديم) تبقى كما كانت.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { getPool, resetPoolForTesting, ensureSchema, createPlanV2, setVisitProcedures, ClinicalPlanConflict } = await import("../../lib/db");

let patientId = 0;
let rctId = 0;
let itemId = 0;
let visits: { id: number }[] = [];

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  ({ rows: [{ id: patientId }] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('ORD-1', 'مريض الترتيب') RETURNING id`));
  ({ rows: [{ id: rctId }] } = await pool.query(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('نزع عصب', 40000, TRUE, TRUE, 'rct') RETURNING id`));
  const created = await createPlanV2({
    patientId, title: "عصب 46", specialty: "علاج عصب", primaryDoctorId: null,
    billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-01-01", note: null,
    items: [{
      serviceId: rctId, serviceName: "نزع عصب", category: "rct", toothCode: 46, surfaces: null,
      quantity: 1, unitPriceMinor: 40000, billingRule: "per_session", sessionCount: 3, note: null,
      sessionPlan: [
        { title: "فتح وتنظيف", minutes: 45, visitKey: "rct:0", visitTitle: "فتح وتنظيف — سن 46" },
        { title: "تشكيل وتعقيم", minutes: 45, visitKey: "rct:1", visitTitle: "تشكيل وتعقيم — سن 46" },
        { title: "حشو نهائي", minutes: 45, visitKey: "rct:2", visitTitle: "حشو نهائي — سن 46" },
      ],
    }],
    installments: [], createdBy: "ord",
  });
  if (!created.ok) throw new Error(created.message);
  await pool.query(`UPDATE treatment_plans SET consent_at = NOW() WHERE id = $1`, [created.planId]);
  ({ rows: [{ id: itemId }] } = await pool.query(`SELECT id FROM plan_items WHERE plan_id = $1`, [created.planId]));
  ({ rows: visits } = await pool.query(`SELECT id FROM planned_visits WHERE plan_id = $1 ORDER BY sequence`, [created.planId]));
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function visitFor(plannedVisitId: number | null) {
  const { rows: [visit] } = await getPool().query<{ id: number }>(
    `INSERT INTO visits (patient_name, status, patient_id, arrived_at, planned_visit_id)
     VALUES ('مريض الترتيب', 'seated', $1, NOW(), $2::int) RETURNING id`, [patientId, plannedVisitId]);
  return visit.id;
}
const save = (visitId: number) => setVisitProcedures({
  visitId,
  procedures: [{ serviceId: rctId, toothCode: 46, surfaces: null, quantity: 1, unitPriceMinor: 0, priceReason: null, doctorId: null, note: null, planItemId: itemId }],
});

describe("(SPEC-T1 review) template sessions are done in order", () => {
  it("the final-obturation visit opened before the cleaning visit is refused, naming the next session", async () => {
    const error = await save(await visitFor(visits[2].id)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClinicalPlanConflict);
    expect((error as Error).message).toBe("هذه الزيارة لجلسةٍ لاحقة من الخطة — الجلسة التالية هي «فتح وتنظيف — سن 46»؛ أنجزها أولًا بترتيب الخطة.");
  });

  it("the first visit is accepted; a visit not linked to a planned visit keeps the old behaviour", async () => {
    expect(await save(await visitFor(visits[0].id))).toBe(true);
    expect(await save(await visitFor(null))).toBe(true);
  });
});
