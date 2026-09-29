import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (BILL-1 — P0) خطة علاجٍ بالأقساط كانت تُفوتَر مرتين — على PostgreSQL 18.
 *
 * القسط يُصدر فاتورته (recordPlanInstallment)، وتوقيع جلسةٍ من الخطة نفسها كان يُصدر فاتورةً
 * ثانية بقاعدة فوترة البند — فعقد تقويمٍ بـ٣٠٠ ألف يصير ٦٠٠ ألف على المريض. قرار المالك (D2):
 * جلسة خطةٍ ممولة بالأقساط **مشمولة** — تُسجَّل سريريًا وتتقدّم الخطة، ولا فاتورة لها؛ المال
 * يُحصَّل بجدول الأقساط وحده. والخطة «حسب الإجراء» بلا أقساط تبقى كما هي.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { buildReport, parseFilters } = await import("../../lib/reports");
const {
  ensureSchema, getPool, resetPoolForTesting, openShift, createPlanV2, recordPlanConsent, recordPlanInstallment,
  addVisit, setVisitProcedures, signClinicalVisit, getClinicalVisit, patientLedger, patientPlanCurrencies,
  ledgerBalancesByCurrency, isPlanFundedByAgreement, recordPayment,
} = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let doctorId = 0;
let orthoServiceId = 0;
let cleaningServiceId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  ({ id: doctorId } = (await q<{ id: number }>(
    `INSERT INTO parties (kind, name, commission_percent) VALUES ('doctor', 'د. التقويم', 30) RETURNING id`))[0]);
  ({ id: orthoServiceId } = (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('تقويم ثابت', 300000, TRUE, TRUE, 'ortho') RETURNING id`))[0]);
  ({ id: cleaningServiceId } = (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('تنظيف', 20000, TRUE, TRUE, 'hygiene') RETURNING id`))[0]);
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function patient(name: string): Promise<number> {
  return (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id`, [name]))[0].id;
}

async function plan(patientId: number, billingMode: "installments" | "custom_schedule" | "per_procedure",
  installments: { dueDate: string; amountMinor: number }[]) {
  const created = await createPlanV2({
    patientId, title: "عقد تقويم", specialty: "ortho", primaryDoctorId: doctorId, billingMode,
    baseCurrency: "YER", startDate: "2026-09-01", note: null, createdBy: "admin",
    items: [{ serviceId: orthoServiceId, serviceName: "تقويم ثابت", category: "ortho", toothCode: null, surfaces: null,
      quantity: 1, unitPriceMinor: 300000, billingRule: "per_session", sessionCount: 3, note: null }],
    installments,
  });
  if (!created.ok) throw new Error(created.message);
  const consent = await recordPlanConsent({ planId: created.planId, actor: "admin", note: null });
  if (!consent.ok) throw new Error(consent.message);
  const [item] = await q<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1`, [created.planId]);
  return { planId: created.planId, itemId: item.id };
}

async function session(patientId: number, lines: { serviceId: number; planItemId: number | null; priceMinor: number }[]) {
  const visit = await addVisit({ patientName: "م", patientPhone: null, note: null, patientId });
  await q(`UPDATE visits SET doctor_id = $2, diagnosis = 'متابعة' WHERE id = $1`, [visit.id, doctorId]);
  await setVisitProcedures({
    visitId: visit.id,
    procedures: lines.map((line) => ({
      serviceId: line.serviceId, toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: line.priceMinor,
      priceReason: null, doctorId, note: null, planItemId: line.planItemId,
    })),
  });
  return visit.id;
}

async function invoicesOf(patientId: number) {
  return q<{ id: number; total_minor: string; plan_id: number | null }>(
    `SELECT id, total_minor::text, plan_id FROM invoices WHERE patient_id = $1 AND status <> 'cancelled' ORDER BY id`, [patientId]);
}

async function due(patientId: number) {
  return ledgerBalancesByCurrency(patientId, await patientLedger(patientId), await patientPlanCurrencies(patientId)).YER.dueMinor;
}

describe("(BILL-1) sessions of an installment-funded plan are included, not billed again", () => {
  it("installment plan: the signed session makes no invoice — the patient owes the agreement only", async () => {
    const p = await patient("قسط-1");
    const { planId, itemId } = await plan(p, "installments", [
      { dueDate: "2026-09-01", amountMinor: 150000 }, { dueDate: "2026-10-01", amountMinor: 150000 }]);
    const paid = await recordPlanInstallment({
      planId, patientId: p, installmentNumber: 1, planTitle: "عقد تقويم", amountMinor: 150000, currency: "YER",
      baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "cashier",
    });
    expect("invoiceId" in paid).toBe(true);

    const visitId = await session(p, [{ serviceId: orthoServiceId, planItemId: itemId, priceMinor: 100000 }]);
    // السعر المحفوظ للجلسة صفر — مشمولة — مهما اقترح الطلب.
    expect((await q<{ unit_price_minor: string }>(`SELECT unit_price_minor::text FROM visit_procedures WHERE visit_id = $1`, [visitId]))[0].unit_price_minor).toBe("0");
    const preview = await getClinicalVisit(visitId);
    expect(preview?.sessionPricing[0]).toMatchObject({ priceMinor: 0 });

    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor" });
    expect(signed.reason).toBeNull();
    expect(signed.invoiceId).toBeNull();
    expect(signed.duesMinor).toBe(0);
    expect(signed.sessionsCompleted).toBe(1);

    expect(await invoicesOf(p)).toEqual([{ id: expect.any(Number), total_minor: "150000", plan_id: planId }]);
    expect(await due(p)).toBe(0);
    const [item] = await q<{ status: string; billing_status: string }>(`SELECT status, billing_status FROM plan_items WHERE id = $1`, [itemId]);
    expect(item).toEqual({ status: "in_progress", billing_status: "included_in_package" });
  });

  it("custom-schedule plan and a per-procedure plan that carries installments are included too", async () => {
    for (const [mode, name] of [["custom_schedule", "قسط-2"], ["per_procedure", "قسط-3"]] as const) {
      const p = await patient(name);
      const { itemId } = await plan(p, mode, [{ dueDate: "2026-09-01", amountMinor: 300000 }]);
      const visitId = await session(p, [{ serviceId: orthoServiceId, planItemId: itemId, priceMinor: 100000 }]);
      const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor" });
      expect({ mode, reason: signed.reason, invoiceId: signed.invoiceId }).toEqual({ mode, reason: null, invoiceId: null });
    }
  });

  it("a per-procedure plan without installments is still billed by its rule (unchanged)", async () => {
    const p = await patient("إجراء-1");
    const { itemId } = await plan(p, "per_procedure", []);
    const visitId = await session(p, [{ serviceId: orthoServiceId, planItemId: itemId, priceMinor: 0 }]);
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor" });
    expect(signed.reason).toBeNull();
    expect(signed.duesMinor).toBe(100000);
    expect((await invoicesOf(p)).map((row) => row.total_minor)).toEqual(["100000"]);
  });

  it("an included session next to a stand-alone procedure: only the stand-alone one is invoiced", async () => {
    const p = await patient("مختلط-1");
    const { itemId } = await plan(p, "installments", [{ dueDate: "2026-09-01", amountMinor: 300000 }]);
    const visitId = await session(p, [
      { serviceId: orthoServiceId, planItemId: itemId, priceMinor: 0 },
      { serviceId: cleaningServiceId, planItemId: null, priceMinor: 20000 },
    ]);
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor" });
    expect(signed.reason).toBeNull();
    expect(signed.duesMinor).toBe(20000);
    const lines = await q<{ description: string; total_minor: string }>(
      `SELECT description, total_minor::text FROM invoice_items WHERE invoice_id = $1`, [signed.invoiceId]);
    expect(lines).toEqual([{ description: "تنظيف", total_minor: "20000" }]);
  });

  it("the read-only review report lists sessions billed on top of installments before the fix — and changes nothing", async () => {
    const p = await patient("قبل-الإصلاح");
    const { planId, itemId } = await plan(p, "installments", [{ dueDate: "2026-09-01", amountMinor: 300000 }]);
    const paid = await recordPlanInstallment({
      planId, patientId: p, installmentNumber: 1, planTitle: "عقد تقويم", amountMinor: 300000, currency: "YER",
      baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "cashier",
    });
    expect("invoiceId" in paid).toBe(true);
    // ما كان التوقيع القديم يكتبه: فاتورة جلسةٍ من الخطة نفسها فوق قسطها.
    const visitId = await session(p, [{ serviceId: orthoServiceId, planItemId: itemId, priceMinor: 0 }]);
    const [procedure] = await q<{ id: number }>(`SELECT id FROM visit_procedures WHERE visit_id = $1`, [visitId]);
    const [old] = await q<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, base_currency, total_minor, discount_minor, created_by)
       VALUES ('OLD-DOUBLE-1', $1, 'YER', 100000, 0, 'legacy') RETURNING id`, [p]);
    await q(`INSERT INTO invoice_items (invoice_id, service_id, doctor_id, description, quantity, unit_price_minor, total_minor, source_type, source_id)
             VALUES ($1, $2, $3, 'تقويم ثابت (جلسة 1 من 3)', 1, 100000, 100000, 'visit_procedure', $4)`,
      [old.id, orthoServiceId, doctorId, procedure.id]);
    const before = await q(`SELECT id, status, total_minor FROM invoices ORDER BY id`);

    const report = await buildReport("plan-double-billing", parseFilters(new URLSearchParams({ preset: "today" }), "2026-09-29"));
    const mine = (report.rows ?? []).filter((row) => row.patientName === "قبل-الإصلاح");
    expect(mine).toEqual([expect.objectContaining({
      invoiceNumber: "OLD-DOUBLE-1", currency: "YER", lineMinor: 100000, installmentsMinor: 300000, planTitle: "عقد تقويم",
    })]);
    expect(report.periodLabel).toBe("كل الفترات");
    // للقراءة فقط: لا فاتورة تغيّرت.
    expect(await q(`SELECT id, status, total_minor FROM invoices ORDER BY id`)).toEqual(before);
  });

  it("isPlanFundedByAgreement: installments / custom schedule / any installment rows — not a plain per-procedure plan", async () => {
    const p = await patient("تمويل-1");
    const funded = await plan(p, "installments", [{ dueDate: "2026-09-01", amountMinor: 300000 }]);
    const plain = await plan(p, "per_procedure", []);
    expect(await isPlanFundedByAgreement(funded.planId, p)).toBe(true);
    expect(await isPlanFundedByAgreement(plain.planId, p)).toBe(false);
    // خطة مريضٍ آخر لا تُعدّ له.
    expect(await isPlanFundedByAgreement(funded.planId, p + 999)).toBe(false);
  });

  it("the review report's second section lists plan payments made without an installment invoice", async () => {
    const p = await patient("دفعة-بلا-قسط");
    const { planId } = await plan(p, "installments", [{ dueDate: "2026-09-01", amountMinor: 300000 }]);
    // المسار القديم لباب القبض العام: دفعة على الخطة بلا فاتورة.
    const paid = await recordPayment({
      patientId: p, invoiceId: null, planId, openingCurrency: null, kind: "payment", amountMinor: 50000, currency: "YER",
      baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "reception", reversalOfId: null,
    });
    expect(paid.reason).toBeNull();
    const report = await buildReport("plan-double-billing", parseFilters(new URLSearchParams({ preset: "today" }), "2026-09-29"));
    const section = report.sections?.find((part) => part.title.includes("بلا فاتورة قسط"));
    expect(section?.rows.filter((row) => row.patientName === "دفعة-بلا-قسط")).toEqual([
      expect.objectContaining({ receiptNumber: paid.payment!.receiptNumber, amountMinor: 50000, currency: "YER" }),
    ]);
  });
});
