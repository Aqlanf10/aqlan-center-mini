import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (DOCATTR-1) الطبيب المعالج على كل سطر عمل — على PostgreSQL 18.
 *
 * F-2: إجراءٌ بلا طبيب كان يُفوتر بـ doctor_id فارغ فتضيع عمولته بصمت.
 * F-3: قسط خطة الأقساط كان سطرًا بلا طبيب ولا خدمة، فلا عمولة لأحد على أكثر عقود التقويم.
 * قرار المالك D1: القسط يُنسب إلى أطباء بنود الخطة بنسبة قيمتها، وإلا للطبيب الأساسي.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, openShift, createPlanV2, recordPlanConsent, recordPlanInstallment,
  addVisit, setVisitProcedures, signClinicalVisit, commissionReport,
} = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let orthodontist = 0;
let endodontist = 0;
let orthoServiceId = 0;
let endoServiceId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  const doctor = async (name: string) => (await q<{ id: number }>(
    `INSERT INTO parties (kind, name, commission_percent) VALUES ('doctor', $1, 10) RETURNING id`, [name]))[0].id;
  orthodontist = await doctor("د. عقلان");
  endodontist = await doctor("د. محمد");
  const service = async (name: string, category: string) => (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 100000, TRUE, TRUE, $2) RETURNING id`,
    [name, category]))[0].id;
  orthoServiceId = await service("تقويم ثابت", "ortho");
  endoServiceId = await service("علاج عصب", "endo");
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function patient(name: string): Promise<number> {
  return (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id`, [name]))[0].id;
}

async function visitWith(patientId: number, visitDoctor: number | null, lines: { priceMinor: number; doctorId: number | null }[]) {
  const visit = await addVisit({ patientName: "م", patientPhone: null, note: null, patientId });
  await q(`UPDATE visits SET doctor_id = $2, diagnosis = 'فحص' WHERE id = $1`, [visit.id, visitDoctor]);
  await setVisitProcedures({
    visitId: visit.id,
    procedures: lines.map((line) => ({
      serviceId: endoServiceId, toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: line.priceMinor,
      priceReason: "اختبار", doctorId: line.doctorId, note: null, planItemId: null,
    })),
  });
  return visit.id;
}

const itemDoctors = (invoiceId: number | null) => q<{ doctor_id: number | null; total_minor: string }>(
  `SELECT doctor_id, total_minor::text FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [invoiceId]);

describe("(DOCATTR-1 · F-2) the treating doctor is set and frozen at sign", () => {
  it("a line without a doctor takes the visit doctor — on the procedure and on the invoice line", async () => {
    const p = await patient("سطر-بلا-طبيب");
    const visitId = await visitWith(p, endodontist, [{ priceMinor: 40000, doctorId: null }]);
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor" });
    expect(signed.reason).toBeNull();
    expect(await itemDoctors(signed.invoiceId)).toEqual([{ doctor_id: endodontist, total_minor: "40000" }]);
    expect(await q(`SELECT doctor_id FROM visit_procedures WHERE visit_id = $1`, [visitId])).toEqual([{ doctor_id: endodontist }]);
  });

  it("a line's own doctor is kept (never overwritten by the visit doctor)", async () => {
    const p = await patient("سطر-بطبيبه");
    const visitId = await visitWith(p, orthodontist, [{ priceMinor: 40000, doctorId: endodontist }]);
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor" });
    expect(await itemDoctors(signed.invoiceId)).toEqual([{ doctor_id: endodontist, total_minor: "40000" }]);
  });

  it("an admin finalizer is recorded as signer but never becomes the treating doctor", async () => {
    const p = await patient("إغلاق-المدير");
    const visitId = await visitWith(p, orthodontist, [{ priceMinor: 40000, doctorId: endodontist }]);
    const signed = await signClinicalVisit({
      visitId, baseCurrency: "YER", signedBy: "admin-user", signerRole: "admin",
    });
    expect(signed.reason).toBeNull();
    expect(await itemDoctors(signed.invoiceId)).toEqual([{ doctor_id: endodontist, total_minor: "40000" }]);
    expect(await q(`SELECT signed_by, doctor_id FROM visits WHERE id = $1`, [visitId]))
      .toEqual([{ signed_by: "admin-user", doctor_id: orthodontist }]);
  });

  it("no visit doctor: the signing doctor becomes the treating doctor", async () => {
    const p = await patient("الموقّع");
    const visitId = await visitWith(p, null, [{ priceMinor: 25000, doctorId: null }]);
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr", signerDoctorPartyId: endodontist });
    expect(signed.reason).toBeNull();
    expect(await itemDoctors(signed.invoiceId)).toEqual([{ doctor_id: endodontist, total_minor: "25000" }]);
  });

  it("priced work with no doctor anywhere is refused — nothing is written", async () => {
    const p = await patient("بلا-طبيب");
    const visitId = await visitWith(p, null, [{ priceMinor: 25000, doctorId: null }]);
    // موقِّعٌ ليس طبيبًا (جهة غير طبيب) لا يصير طبيبًا معالجًا.
    const [supplier] = await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('supplier', 'مورّد') RETURNING id`);
    const refused = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "admin", signerDoctorPartyId: supplier.id });
    expect(refused.reason).toBe("no_treating_doctor");
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [p])).toEqual([]);
    expect(await q(`SELECT signed_at FROM visits WHERE id = $1`, [visitId])).toEqual([{ signed_at: null }]);
    expect(await q(`SELECT doctor_id FROM visit_procedures WHERE visit_id = $1`, [visitId])).toEqual([{ doctor_id: null }]);
  });

  it("free work (price 0) with no doctor is not blocked", async () => {
    const p = await patient("مجاني");
    const visitId = await visitWith(p, null, [{ priceMinor: 0, doctorId: null }]);
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "admin" });
    expect(signed.reason).toBeNull();
  });
});

describe("(DOCATTR-1 · F-3 / D1) installment lines are attributed to the plan-item doctors", () => {
  async function masterPlan(patientId: number, primaryDoctorId: number | null) {
    const created = await createPlanV2({
      patientId, title: "خطة شاملة", specialty: "ortho", primaryDoctorId, billingMode: "installments",
      baseCurrency: "YER", startDate: "2026-09-01", note: null, createdBy: "admin",
      items: [
        { serviceId: orthoServiceId, serviceName: "تقويم ثابت", category: "ortho", toothCode: null, surfaces: null,
          quantity: 1, unitPriceMinor: 600000, billingRule: "per_session", sessionCount: 6, note: null },
        { serviceId: endoServiceId, serviceName: "علاج عصب", category: "endo", toothCode: 21, surfaces: null,
          quantity: 1, unitPriceMinor: 300000, billingRule: "on_completion", sessionCount: 1, note: null },
      ],
      installments: [{ dueDate: "2026-09-01", amountMinor: 450000 }, { dueDate: "2026-10-01", amountMinor: 450000 }],
    });
    if (!created.ok) throw new Error(created.message);
    const consent = await recordPlanConsent({ planId: created.planId, actor: "admin", note: null });
    if (!consent.ok) throw new Error(consent.message);
    return created.planId;
  }

  const pay = (planId: number, patientId: number, amountMinor: number) => recordPlanInstallment({
    planId, patientId, installmentNumber: 1, planTitle: "خطة شاملة", amountMinor, currency: "YER",
    baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "cashier",
  });

  it("splits the installment by item value: 2/3 orthodontist, 1/3 endodontist — exact total, services kept", async () => {
    const p = await patient("قسط-موزع");
    const planId = await masterPlan(p, orthodontist);
    await q(`UPDATE plan_items SET doctor_id = $2 WHERE plan_id = $1 AND service_id = $3`, [planId, endodontist, endoServiceId]);
    await q(`UPDATE plan_items SET doctor_id = $2 WHERE plan_id = $1 AND service_id = $3`, [planId, orthodontist, orthoServiceId]);
    const paid = await pay(planId, p, 90000);
    if (!("invoiceId" in paid)) throw new Error(paid.reason);
    const lines = await q<{ doctor_id: number; service_id: number; total_minor: string }>(
      `SELECT doctor_id, service_id, total_minor::text FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [paid.invoiceId]);
    expect(lines).toEqual([
      { doctor_id: orthodontist, service_id: orthoServiceId, total_minor: "60000" },
      { doctor_id: endodontist, service_id: endoServiceId, total_minor: "30000" },
    ]);
    const [invoice] = await q<{ total_minor: string }>(`SELECT total_minor::text FROM invoices WHERE id = $1`, [paid.invoiceId]);
    expect(invoice.total_minor).toBe("90000");

    // المحرك نفسه يرى الحصتين: كلٌّ على بنوده (١٠٪ من المحصَّل).
    const report = await commissionReport("2000-01-01", "2099-12-31");
    const earned = (doctorId: number) => report.filter((row) => row.doctorId === doctorId && row.currency === "YER")
      .reduce((sum, row) => sum + row.earnedMinor, 0);
    expect(earned(orthodontist)).toBe(6000);
    expect(earned(endodontist)).toBe(3000);
  });

  it("items without a doctor fall back to the plan's primary doctor", async () => {
    const p = await patient("قسط-أساسي");
    const planId = await masterPlan(p, orthodontist);
    const paid = await pay(planId, p, 90000);
    if (!("invoiceId" in paid)) throw new Error(paid.reason);
    const lines = await q<{ doctor_id: number }>(
      `SELECT doctor_id FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [paid.invoiceId]);
    expect(lines.map((line) => line.doctor_id)).toEqual([orthodontist, orthodontist]);
  });

  it("a non-doctor party on an item or as primary is never attributed — falls back to a real doctor or none", async () => {
    const [lab] = await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('lab', 'معمل') RETURNING id`);
    const p = await patient("قسط-جهة-ليست-طبيبًا");
    const planId = await masterPlan(p, orthodontist);
    await q(`UPDATE plan_items SET doctor_id = $2 WHERE plan_id = $1`, [planId, lab.id]);
    const paid = await pay(planId, p, 90000);
    if (!("invoiceId" in paid)) throw new Error(paid.reason);
    const lines = await q<{ doctor_id: number | null }>(
      `SELECT doctor_id FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [paid.invoiceId]);
    expect(lines.map((line) => line.doctor_id)).toEqual([orthodontist, orthodontist]);

    const p2 = await patient("أساسي-ليس-طبيبًا");
    const planId2 = await masterPlan(p2, lab.id);
    const paid2 = await pay(planId2, p2, 90000);
    if (!("invoiceId" in paid2)) throw new Error(paid2.reason);
    const lines2 = await q<{ doctor_id: number | null }>(
      `SELECT doctor_id FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [paid2.invoiceId]);
    expect(lines2.map((line) => line.doctor_id)).toEqual([null, null]);
  });

  it("frozen at issue: editing the plan later does not re-attribute an issued installment", async () => {
    const p = await patient("قسط-مجمد");
    const planId = await masterPlan(p, orthodontist);
    const paid = await pay(planId, p, 90000);
    if (!("invoiceId" in paid)) throw new Error(paid.reason);
    const before = await q(`SELECT doctor_id, total_minor FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [paid.invoiceId]);
    await q(`UPDATE plan_items SET doctor_id = $2 WHERE plan_id = $1`, [planId, endodontist]);
    expect(await q(`SELECT doctor_id, total_minor FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [paid.invoiceId])).toEqual(before);
  });
});
