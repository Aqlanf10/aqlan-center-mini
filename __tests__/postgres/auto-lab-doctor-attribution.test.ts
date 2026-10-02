import { labWorkForCategory } from "../../lib/workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query(sql, values)).rows as T[];
let serial = 0;
let fillingId: number;
let crownId: number;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  await db.openShift({ openedBy: "lab-test-cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  const service = async (category: string, price: number) => (await q<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, is_active, price_configured)
     VALUES ($1, $1, $2, TRUE, TRUE) RETURNING id`, [category, price]))[0].id;
  fillingId = await service("filling", 40000);
  crownId = await service("crown", 60000);
});
afterAll(async () => { await db.resetPoolForTesting(); });

const doctor = async (rate = 30) => (await db.createParty({
  name: `Synthetic doctor ${++serial}`, kind: "doctor", phone: null, commissionPercent: rate, note: null,
})).id;
const patient = async () => (await q<{ id: number }>(
  `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic lab attribution') RETURNING id`,
  [`LAB-DOC-${++serial}`]))[0].id;
type Line = { serviceId?: number; toothCode: number | null; doctorId: number | null; price?: number; planItemId?: number };
async function visit(patientId: number, visitDoctorId: number | null, lines: Line[]) {
  const result = await db.addVisit({ patientName: "Synthetic lab attribution", patientPhone: null, note: null, patientId });
  await q(`UPDATE visits SET doctor_id = $2, diagnosis = 'Synthetic test' WHERE id = $1`, [result.id, visitDoctorId]);
  expect(await db.setVisitProcedures({ visitId: result.id, procedures: lines.map((line) => ({
    serviceId: line.serviceId ?? crownId, toothCode: line.toothCode, doctorId: line.doctorId,
    surfaces: null, quantity: 1, unitPriceMinor: line.price ?? 60000, priceReason: "Synthetic test",
    note: null, planItemId: line.planItemId ?? null,
  })) })).toBe(true);
  return result.id;
}
const sign = (visitId: number, signerDoctorPartyId?: number) => db.signClinicalVisit({
  visitId, baseCurrency: "YER", signedBy: "lab-test-admin-finalizer", signerRole: "admin", signerDoctorPartyId,
});
const orders = (visitId: number) => q<{ id: number; doctor_id: number | null; tooth_code: number | null; source: string }>(
  `SELECT id, doctor_id, tooth_code, source FROM lab_orders WHERE visit_id = $1 ORDER BY id`, [visitId]);
async function accountAndDeliver(orderId: number) {
  await db.updateLabOrderAccounting(orderId, {
    costMinor: 20000, costCurrency: "YER", exchangeRate: 1,
    actor: "lab-test-accountant", actorRole: "accountant",
  });
  for (const status of ["sent", "received", "delivered"] as const) {
    expect((await db.setLabOrderStatus(orderId, status, {
      actor: "lab-test-reception", actorRole: "reception",
    }))?.status).toBe(status);
  }
}
const commission = async (ids: number[]) => (await db.commissionReport("1970-01-01", "2999-12-31"))
  .filter((row) => ids.includes(row.doctorId) && row.currency === "YER")
  .map((row) => ({ doctorId: row.doctorId, earnedMinor: row.earnedMinor, labCostMinor: row.labCostMinor,
    labCostNotDeductedCount: row.labCostNotDeductedCount }));

// Use the real writers all the way to commissions: a direct INSERT lab fixture
// would conceal the lost provenance at sign-off that caused this regression.
describe.each([21, null])("auto-lab treating doctor (tooth %s)", (toothCode) => {
  it("sign → lab cost → delivery → payment charges only the actual crown provider", async () => {
    const a = await doctor(30), b = await doctor(40), signer = await doctor(90);
    const p = await patient();
    const v = await visit(p, a, [
      { serviceId: fillingId, toothCode: 11, doctorId: a, price: 40000 },
      { toothCode, doctorId: b },
    ]);
    const signed = await sign(v, signer);
    expect(signed.reason).toBeNull();
    expect(signed.labOrdersCreated).toBe(1);
    expect(signed.invoiceId).not.toBeNull();
    expect(await q(`SELECT doctor_id FROM visit_procedures WHERE visit_id = $1 ORDER BY id`, [v]))
      .toEqual([{ doctor_id: a }, { doctor_id: b }]);
    expect(await q(`SELECT doctor_id, total_minor::text FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [signed.invoiceId]))
      .toEqual([{ doctor_id: a, total_minor: "40000" }, { doctor_id: b, total_minor: "60000" }]);
    const [order] = await orders(v);
    // Run the complete financial flow before checking the new field, so the
    // pre-fix failure demonstrates the monetary consequence, not only NULL.
    await accountAndDeliver(order.id);
    expect((await db.recordPayment({ patientId: p, invoiceId: signed.invoiceId, kind: "payment",
      amountMinor: 100000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      method: "cash", note: "Synthetic lab test", createdBy: "lab-test-cashier" })).reason).toBeNull();
    expect(await commission([a, b, signer])).toEqual(expect.arrayContaining([
      { doctorId: a, earnedMinor: 12000, labCostMinor: 0, labCostNotDeductedCount: 0 },
      { doctorId: b, earnedMinor: 16000, labCostMinor: 20000, labCostNotDeductedCount: 0 },
    ]));
    expect((await commission([a, b, signer])).reduce((sum, row) => sum + row.earnedMinor, 0)).toBe(28000);
    expect(order).toMatchObject({ doctor_id: b, tooth_code: toothCode, source: "auto" });
    expect(await q(`SELECT doctor_id, signed_by FROM visits WHERE id = $1`, [v]))
      .toEqual([{ doctor_id: a, signed_by: "lab-test-admin-finalizer" }]);
    expect((await sign(v, signer)).reason).toBe("already_signed");
    expect(await orders(v)).toEqual([order]);
    expect(await q(`SELECT (SELECT COUNT(*) FROM invoices WHERE patient_id=$1)::int AS invoices,
      (SELECT COUNT(*) FROM payments WHERE patient_id=$1)::int AS payments`, [p]))
      .toEqual([{ invoices: 1, payments: 1 }]);
  });

  it("preserves the visit-doctor fallback already resolved by sign-off", async () => {
    const a = await doctor(), signer = await doctor();
    const v = await visit(await patient(), a, [{ toothCode, doctorId: null }]);
    expect((await sign(v, signer)).reason).toBeNull();
    expect((await orders(v)).map((row) => row.doctor_id)).toEqual([a]);
  });

  it("preserves the signing-doctor fallback only when the caller resolves it", async () => {
    const signer = await doctor();
    const v = await visit(await patient(), null, [{ toothCode, doctorId: null }]);
    expect((await sign(v, signer)).reason).toBeNull();
    expect((await orders(v)).map((row) => row.doctor_id)).toEqual([signer]);
  });

  it("keeps a resolved inactive zero-commission doctor, rather than replacing them", async () => {
    const a = await doctor(), b = await doctor(0);
    const p = await patient();
    const v = await visit(p, a, [{ toothCode, doctorId: b }]);
    await q(`UPDATE parties SET is_active = FALSE WHERE id = $1`, [b]);
    const signed = await sign(v);
    expect(signed.reason).toBeNull();
    const [order] = await orders(v);
    expect(order.doctor_id).toBe(b);
    await accountAndDeliver(order.id);
    expect((await db.recordPayment({ patientId: p, invoiceId: signed.invoiceId, kind: "payment",
      amountMinor: 60000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      method: "cash", note: null, createdBy: "lab-test-cashier" })).reason).toBeNull();
    expect((await commission([a, b])).every((row) => row.earnedMinor === 0)).toBe(true);
    expect((await orders(v))[0].doctor_id).toBe(b);
  });

  it("leaves free unattributed work NULL and still refuses priced unattributed work", async () => {
    const p = await patient();
    const free = await visit(p, null, [{ toothCode, doctorId: null, price: 0 }]);
    expect((await sign(free)).reason).toBeNull();
    expect((await orders(free)).map((row) => row.doctor_id)).toEqual([null]);
    const priced = await visit(await patient(), null, [{ toothCode, doctorId: null }]);
    expect((await sign(priced)).reason).toBe("no_treating_doctor");
    expect(await orders(priced)).toEqual([]);
    expect(await q(`SELECT signed_at FROM visits WHERE id = $1`, [priced])).toEqual([{ signed_at: null }]);
  });

  it("two simultaneous signs create only one attributed order and invoice", async () => {
    const b = await doctor();
    const p = await patient(), v = await visit(p, null, [{ toothCode, doctorId: b }]);
    const results = await Promise.all([sign(v), sign(v)]);
    expect(results.map((result) => result.reason).sort()).toEqual(["already_signed", null].sort());
    expect((await orders(v)).map((row) => row.doctor_id)).toEqual([b]);
    expect(await q(`SELECT COUNT(*)::int AS count FROM invoices WHERE patient_id = $1`, [p]))
      .toEqual([{ count: 1 }]);
  });

  it("an existing NULL auto order stays untouched with the legacy visit-doctor cost fallback", async () => {
    const a = await doctor(30), b = await doctor(40);
    const p = await patient(), v = await visit(p, a, [
      { serviceId: fillingId, toothCode: 11, doctorId: a, price: 40000 }, { toothCode, doctorId: b },
    ]);
    await q(`INSERT INTO lab_orders (patient_id, lab_name, work_type, status, visit_id, tooth_code, source, due_date)
      VALUES ($1, 'Synthetic historical lab', $4, 'needed', $2, $3, 'auto', CURRENT_DATE)`, [p, v, toothCode, labWorkForCategory("crown")]);
    const before = await orders(v);
    const signed = await sign(v);
    expect(signed.reason).toBeNull();
    expect(signed.labOrdersCreated).toBe(0);
    expect(await orders(v)).toEqual(before);
    await accountAndDeliver(before[0].id);
    expect((await db.recordPayment({ patientId: p, invoiceId: signed.invoiceId, kind: "payment",
      amountMinor: 100000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      method: "cash", note: null, createdBy: "lab-test-cashier" })).reason).toBeNull();
    expect(await commission([a, b])).toEqual(expect.arrayContaining([
      { doctorId: a, earnedMinor: 6000, labCostMinor: 20000, labCostNotDeductedCount: 0 },
      { doctorId: b, earnedMinor: 24000, labCostMinor: 0, labCostNotDeductedCount: 0 },
    ]));
    expect((await orders(v))[0].doctor_id).toBeNull();
  });
});

async function crownPlan(patientId: number, installments: boolean) {
  const result = await db.createPlanV2({ patientId, title: "Synthetic crown", specialty: "prostho",
    primaryDoctorId: null, billingMode: installments ? "installments" : "per_procedure",
    baseCurrency: "YER", startDate: "2026-01-01", note: null, createdBy: "lab-test-admin-finalizer",
    items: [{ serviceId: crownId, serviceName: "crown", category: "crown", toothCode: 21, surfaces: null,
      quantity: 1, unitPriceMinor: 60000, billingRule: "on_start", sessionCount: 3, note: null }],
    installments: installments ? [{ dueDate: "2026-01-01", amountMinor: 60000 }] : [],
  });
  if (!result.ok) throw new Error(result.message);
  expect((await db.recordPlanConsent({ planId: result.planId, actor: "lab-test-admin-finalizer", note: null })).ok).toBe(true);
  return (await q<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1`, [result.planId]))[0].id;
}

it("included plan work with no resolved doctor remains unattributed and unbilled", async () => {
  const p = await patient(), item = await crownPlan(p, true);
  const v = await visit(p, null, [{ toothCode: 21, doctorId: null, planItemId: item }]);
  const signed = await sign(v);
  expect(signed.reason).toBeNull();
  expect(signed.invoiceId).toBeNull();
  expect((await orders(v)).map((row) => row.doctor_id)).toEqual([null]);
});

it("later crown sessions preserve the first order's provider even when the treating doctor changes", async () => {
  const p = await patient(), a = await doctor(), b = await doctor(), item = await crownPlan(p, false);
  const first = await visit(p, a, [{ toothCode: 21, doctorId: b, planItemId: item }]);
  expect((await sign(first)).labOrdersCreated).toBe(1);
  const before = await orders(first);
  expect(before[0].doctor_id).toBe(b);
  const later = await visit(p, a, [{ toothCode: 21, doctorId: a, planItemId: item }]);
  expect((await sign(later)).labOrdersCreated).toBe(0);
  expect(await orders(later)).toEqual([]);
  expect(await orders(first)).toEqual(before);
});

it("does not change a pre-existing manual tooth order or its provider", async () => {
  const a = await doctor(), b = await doctor(), p = await patient();
  const v = await visit(p, a, [{ toothCode: 21, doctorId: b }]);
  await q(`INSERT INTO lab_orders (patient_id, lab_name, work_type, status, visit_id, tooth_code, source, doctor_id, due_date)
    VALUES ($1, 'Synthetic manual lab', 'crown', 'needed', $2, 21, 'manual', $3, CURRENT_DATE)`, [p, v, a]);
  const before = await orders(v);
  expect((await sign(v)).labOrdersCreated).toBe(0);
  expect(await orders(v)).toEqual(before);
});
