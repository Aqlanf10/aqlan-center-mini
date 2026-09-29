import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signerDoctorPartyId } from "./_signer";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (SPEC-T3) طلب مختبرٍ واحد للتاج الواحد — لا طلبٌ عند كل جلسة.
 *
 * التاج في الخطة ثلاث جلسات (تحضير وطبعة ← تجربة ← تركيب). وتوقيع كل زيارةٍ فيها إجراء
 * التاج كان يُنشئ طلب مختبرٍ «لم يُرسل بعد» جديدًا — فالحارس الفريد على (الزيارة، السن)
 * لا يرى أن الزيارات الثلاث لبندٍ واحد: ثلاثة طلباتٍ لتاجٍ واحد، واثنان منها وهميّان في
 * لوحة المختبر ومتابعة التأخير. الآن: الطلب يُنشأ عند أول جلسةٍ للبند، ولا يُكرَّر ما دام
 * للبند نفسه طلبٌ قائم غير ملغى.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, createPlanV2, setVisitProcedures, signClinicalVisit,
} = await import("../../lib/db");
const { CLINIC_BASE_CURRENCY } = await import("../../lib/money");

let patientId = 0;
let crownId = 0;
let fillingId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  ({ rows: [{ id: patientId }] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('T3-1', 'مريض التاج') RETURNING id`));
  ({ rows: [{ id: crownId }] } = await pool.query(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('تاج زركونيا', 100000, TRUE, TRUE, 'crown') RETURNING id`));
  ({ rows: [{ id: fillingId }] } = await pool.query(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('حشوة', 20000, TRUE, TRUE, 'filling') RETURNING id`));
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function crownPlan(toothCode: number) {
  const created = await createPlanV2({
    patientId, title: `تاج ${toothCode}`, specialty: "تركيبات", primaryDoctorId: null,
    billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-01-01", note: null,
    items: [{
      serviceId: crownId, serviceName: "تاج زركونيا", category: "crown", toothCode, surfaces: null,
      quantity: 1, unitPriceMinor: 100000, billingRule: "on_start", sessionCount: 3, note: null,
    }],
    installments: [], createdBy: "t3",
  });
  if (!created.ok) throw new Error(created.message);
  // المريض وافق على الخطة — شرط ربط إجراء الزيارة ببندها.
  await getPool().query(`UPDATE treatment_plans SET consent_at = NOW(), consent_by = 't3' WHERE id = $1`, [created.planId]);
  const { rows: [item] } = await getPool().query<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1`, [created.planId]);
  return item.id;
}

async function signSession(planItemId: number | null, serviceId: number, toothCode: number) {
  const { rows: [visit] } = await getPool().query<{ id: number }>(
    `INSERT INTO visits (patient_name, status, patient_id, arrived_at) VALUES ('مريض التاج', 'seated', $1, NOW()) RETURNING id`,
    [patientId]);
  await setVisitProcedures({
    visitId: visit.id,
    procedures: [{ serviceId, toothCode, surfaces: null, quantity: 1, unitPriceMinor: serviceId === crownId ? 100000 : 20000, priceReason: null, doctorId: null, note: null, planItemId }],
  });
  const signed = await signClinicalVisit({ visitId: visit.id, baseCurrency: CLINIC_BASE_CURRENCY, signedBy: "t3", signerDoctorPartyId: await signerDoctorPartyId() });
  expect(signed.reason).toBeNull();
  return visit.id;
}

async function labOrders(toothCode: number) {
  const { rows } = await getPool().query<{ status: string; visit_id: number }>(
    `SELECT status, visit_id FROM lab_orders WHERE patient_id = $1 AND tooth_code = $2 ORDER BY id`, [patientId, toothCode]);
  return rows;
}

describe("(SPEC-T3) one lab order per crown, not one per session", () => {
  it("prep → try-in → cementation of one planned crown creates exactly one lab order, at the first session", async () => {
    const itemId = await crownPlan(16);
    const prepVisit = await signSession(itemId, crownId, 16);
    await signSession(itemId, crownId, 16);
    await signSession(itemId, crownId, 16);
    expect(await labOrders(16)).toEqual([{ status: "needed", visit_id: prepVisit }]);
  });

  it("a cancelled order does not block a new one for the next session (a remake is a real new order)", async () => {
    const itemId = await crownPlan(26);
    await signSession(itemId, crownId, 26);
    await getPool().query(`UPDATE lab_orders SET status = 'cancelled' WHERE patient_id = $1 AND tooth_code = 26`, [patientId]);
    const secondVisit = await signSession(itemId, crownId, 26);
    expect((await labOrders(26)).map((order) => [order.status, order.visit_id])).toEqual([
      ["cancelled", expect.any(Number)],
      ["needed", secondVisit],
    ]);
  });

  it("unchanged: a crown outside any plan still gets its order at signing; non-lab work gets none", async () => {
    const visitId = await signSession(null, crownId, 36);
    expect(await labOrders(36)).toEqual([{ status: "needed", visit_id: visitId }]);
    await signSession(null, fillingId, 46);
    expect(await labOrders(46)).toEqual([]);
  });

  it("two different planned crowns on two teeth each get their own order", async () => {
    const a = await crownPlan(14);
    const b = await crownPlan(15);
    await signSession(a, crownId, 14);
    await signSession(b, crownId, 15);
    expect(await labOrders(14)).toHaveLength(1);
    expect(await labOrders(15)).toHaveLength(1);
  });
});
