import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * اختبارات TD-05 على PostgreSQL حقيقي — ثبات عملة الاتفاق عبر الإنشاء والقراءة.
 *
 *  * الخطة تُنشأ بعملة اتفاق (YER/SAR/USD) وتعود بعملتها بعد إعادة القراءة.
 *  * القسط المحصَّل بعملة الخطة يولّد فاتورةً بعملة الخطة — لا بعملة الدفاتر.
 *  * القسط بعملةٍ مختلفة عن خطة اتفاق يُرفض بوضوح ولا يخلّف سجلًّا.
 *  * توقيع زيارةٍ بنودها من خطة دولارية يفطر بعملتها؛ ومزج عملات خططٍ مختلفة
 *    في زيارةٍ واحدة يُرفض — لا فاتورة تمزج العملات.
 *  * الرصيد دولابٌ لكل عملة من المصدر نفسه الذي تقرأ منه الشاشة.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, openShift, createPlanV2,
  listPatientPlans, recordPlanInstallment, signClinicalVisit, patientLedger,
} = await import("../../lib/db");
const { patientBalancesByCurrency, toCurrencyPaymentLikes, CLINIC_BASE_CURRENCY } = await import("../../lib/money");

let patientId: number;
let serviceId: number;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "td05-pg", opening: { YER: 0, SAR: 0, USD: 0 } });
  const pool = getPool();
  const { rows: [patient] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('TD05-PG-1', 'مريض TD-05 الحقيقي') RETURNING id`,
  );
  patientId = patient.id;
  const { rows: [service] } = await pool.query(
    `INSERT INTO services (name, price_minor, is_active) VALUES ('تنظيف', 15000, TRUE) RETURNING id`,
  );
  serviceId = service.id;
}, 180_000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("TD-05 على PostgreSQL حقيقي: ثبات عملة الاتفاق", () => {
  it("خطة USD تُخزَّن دولارية وتعود كذلك بعد إعادة القراءة", async () => {
    const created = await createPlanV2({
      patientId, title: "تقويم ثابت — دولار", specialty: "تقويم", primaryDoctorId: null,
      billingMode: "installments", baseCurrency: "USD", startDate: "2026-01-01", note: null,
      items: [{
        serviceId, serviceName: "تقويم", category: "ortho", toothCode: null, surfaces: null,
        quantity: 1, unitPriceMinor: 150000, billingRule: "on_completion", sessionCount: 1, note: null,
      }],
      installments: [
        { dueDate: "2026-02-01", amountMinor: 50000 },
        { dueDate: "2026-03-01", amountMinor: 100000 },
      ],
      createdBy: "td05-pg",
    });
    expect(created.ok).toBe(true);

    const reloaded = (await listPatientPlans(patientId, "2026-01-15"))
      .find((plan) => plan.title === "تقويم ثابت — دولار");
    expect(reloaded?.baseCurrency).toBe("USD");
    expect(reloaded?.totalMinor).toBe(150000);
    expect(reloaded?.installments.map((part) => part.amountMinor)).toEqual([50000, 100000]);
  });

  it("خطة SAR تُخزَّن سعودية وتعود كذلك", async () => {
    const created = await createPlanV2({
      patientId, title: "تركيبات — سعودي", specialty: "تركيبات", primaryDoctorId: null,
      billingMode: "installments", baseCurrency: "SAR", startDate: "2026-01-01", note: null,
      items: [],
      installments: [{ dueDate: "2026-02-01", amountMinor: 60000 }],
      createdBy: "td05-pg",
    });
    expect(created.ok).toBe(true);
    const reloaded = (await listPatientPlans(patientId, "2026-01-15"))
      .find((plan) => plan.title === "تركيبات — سعودي");
    expect(reloaded?.baseCurrency).toBe("SAR");
  });

  it("خطة YER تبقى يمنية — لا يتغير السلوك القائم", async () => {
    const created = await createPlanV2({
      patientId, title: "حشوات — يمني", specialty: "علاج عام", primaryDoctorId: null,
      billingMode: "installments", baseCurrency: "YER", startDate: "2026-01-01", note: null,
      items: [{
        serviceId, serviceName: "تنظيف", category: "cleaning", toothCode: null, surfaces: null,
        quantity: 1, unitPriceMinor: 30000, billingRule: "on_completion", sessionCount: 1, note: null,
      }],
      installments: [{ dueDate: "2026-02-01", amountMinor: 30000 }],
      createdBy: "td05-pg",
    });
    expect(created.ok).toBe(true);
    const reloaded = (await listPatientPlans(patientId, "2026-01-15"))
      .find((plan) => plan.title === "حشوات — يمني");
    expect(reloaded?.baseCurrency).toBe("YER");
  });

  it("تحرير بيانات المريض لا يمسّ عملة خطة التقويم الدولارية", async () => {
    await getPool().query(
      `UPDATE patients SET full_name = $2, address = $3 WHERE id = $1`,
      [patientId, "الاسم بعد التحرير", "عدن"],
    );
    const reloaded = (await listPatientPlans(patientId, "2026-01-15"))
      .find((plan) => plan.title === "تقويم ثابت — دولار");
    expect(reloaded?.baseCurrency).toBe("USD");
  });

  it("قبض قسط الخطة الدولارية بالدولار: فاتورة USD وسند USD ومكافئ أساسي مسجَّل", async () => {
    const usdPlan = (await listPatientPlans(patientId, "2026-01-15"))
      .find((plan) => plan.title === "تقويم ثابت — دولار");
    const collected = await recordPlanInstallment({
      planId: usdPlan!.id, patientId, installmentNumber: 1, planTitle: "تقويم ثابت — دولار",
      amountMinor: 50000, currency: "USD", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 530,
      method: "cash", note: null, createdBy: "td05-pg",
    });
    expect("reason" in collected && collected.reason).toBeFalsy();

    const pool = getPool();
    const { rows: [invoice] } = await pool.query(
      `SELECT base_currency, total_minor FROM invoices WHERE plan_id = $1`, [usdPlan!.id],
    );
    expect(invoice.base_currency).toBe("USD");
    expect(Number(invoice.total_minor)).toBe(50000);
    const { rows: [payment] } = await pool.query(
      `SELECT currency, amount_minor, base_amount_minor, base_currency FROM payments WHERE plan_id = $1`,
      [usdPlan!.id],
    );
    expect(payment.currency).toBe("USD");
    expect(Number(payment.amount_minor)).toBe(50000);
    expect(Number(payment.base_amount_minor)).toBe(500 * 530);
    expect(payment.base_currency).toBe("YER");

    // التقدُّم بعملة الاتفاق لا بالمكافئ الأساسي.
    const progress = (await listPatientPlans(patientId, "2026-01-15"))
      .find((plan) => plan.id === usdPlan!.id);
    expect(progress!.progress.paidMinor).toBe(50000);
    expect(progress!.progress.remainingMinor).toBe(100000);
  });

  it("قبض قسط الخطة السعودية باليمني يُرفض ولا يخلّف سجلًّا", async () => {
    const sarPlan = (await listPatientPlans(patientId, "2026-01-15"))
      .find((plan) => plan.title === "تركيبات — سعودي");
    const before = (await getPool().query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM invoices WHERE patient_id = $1`, [patientId],
    )).rows[0].c;
    const rejected = await recordPlanInstallment({
      planId: sarPlan!.id, patientId, installmentNumber: 1, planTitle: "تركيبات — سعودي",
      amountMinor: 20000, currency: "YER", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 1,
      method: "cash", note: null, createdBy: "td05-pg",
    });
    expect("reason" in rejected && rejected.reason).toBe("cross_currency_not_supported");
    const after = (await getPool().query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM invoices WHERE patient_id = $1`, [patientId],
    )).rows[0].c;
    expect(after).toBe(before);
  });

  it("توقيع زيارةٍ بنودها من الخطة الدولارية يفطر بعملتها", async () => {
    const pool = getPool();
    await pool.query(`UPDATE treatment_plans SET consent_at = NOW() WHERE title = $1`, ["تقويم ثابت — دولار"]);
    const usdPlan = (await listPatientPlans(patientId, "2026-01-15"))
      .find((plan) => plan.title === "تقويم ثابت — دولار");
    const { rows: [item] } = await pool.query<{ id: number }>(
      `SELECT id FROM plan_items WHERE plan_id = $1 LIMIT 1`, [usdPlan!.id],
    );
    const { rows: [visit] } = await pool.query<{ id: number }>(
      `INSERT INTO visits (patient_name, status, patient_id, arrived_at)
       VALUES ('مريض TD-05 الحقيقي', 'seated', $1, NOW()) RETURNING id`,
      [patientId],
    );
    await pool.query(
      `INSERT INTO visit_procedures (visit_id, service_id, plan_item_id, quantity, unit_price_minor)
       VALUES ($1, $2, $3, 1, 150000)`,
      [visit.id, serviceId, item.id],
    );

    const signed = await signClinicalVisit({
      visitId: visit.id, baseCurrency: CLINIC_BASE_CURRENCY, signedBy: "td05-pg",
    });
    expect(signed.reason).toBeNull();
    expect(signed.invoiceId).not.toBeNull();
    const { rows: [invoice] } = await pool.query<{ base_currency: string; total_minor: string }>(
      `SELECT base_currency, total_minor FROM invoices WHERE id = $1`, [signed.invoiceId],
    );
    expect(invoice.base_currency).toBe("USD");
    expect(Number(invoice.total_minor)).toBe(150000);
  });

  it("زيارةٌ تمزج بنود خططٍ بعملتين تُرفض توقيعها — لا فاتورة تمزج العملات", async () => {
    const pool = getPool();
    // خطتان جديدتان بعملتين مختلفتين وبندان جديدان — بند الخطة المستهلَك في
    // توقيعٍ سابق لا يصلح لهذا الفحص (حالته done فلا يُسعَّر).
    const planUsd = await createPlanV2({
      patientId, title: "مزج PG — دولار", specialty: null, primaryDoctorId: null,
      billingMode: "per_procedure", baseCurrency: "USD", startDate: "2026-01-01", note: null,
      items: [{
        serviceId, serviceName: "تنظيف", category: "cleaning", toothCode: null, surfaces: null,
        quantity: 1, unitPriceMinor: 50000, billingRule: "on_completion", sessionCount: 1, note: null,
      }],
      installments: [], createdBy: "td05-pg",
    });
    const planYer = await createPlanV2({
      patientId, title: "مزج PG — يمني", specialty: null, primaryDoctorId: null,
      billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-01-01", note: null,
      items: [{
        serviceId, serviceName: "تنظيف", category: "cleaning", toothCode: null, surfaces: null,
        quantity: 1, unitPriceMinor: 10000, billingRule: "on_completion", sessionCount: 1, note: null,
      }],
      installments: [], createdBy: "td05-pg",
    });
    expect(planUsd.ok && planYer.ok).toBe(true);
    await pool.query(
      `UPDATE treatment_plans SET consent_at = NOW() WHERE id IN ($1, $2)`,
      [planUsd.ok ? planUsd.planId : 0, planYer.ok ? planYer.planId : 0],
    );
    const { rows: [usdItem] } = await pool.query<{ id: number }>(
      `SELECT id FROM plan_items WHERE plan_id = $1 LIMIT 1`, [planUsd.ok ? planUsd.planId : 0],
    );
    const { rows: [yerItem] } = await pool.query<{ id: number }>(
      `SELECT id FROM plan_items WHERE plan_id = $1 LIMIT 1`, [planYer.ok ? planYer.planId : 0],
    );
    const { rows: [visit] } = await pool.query<{ id: number }>(
      `INSERT INTO visits (patient_name, status, patient_id, arrived_at)
       VALUES ('مريض TD-05 الحقيقي', 'seated', $1, NOW()) RETURNING id`,
      [patientId],
    );
    await pool.query(
      `INSERT INTO visit_procedures (visit_id, service_id, plan_item_id, quantity, unit_price_minor)
       VALUES ($1, $2, $3, 1, 50000), ($1, $2, $4, 1, 10000)`,
      [visit.id, serviceId, usdItem.id, yerItem.id],
    );
    const rejected = await signClinicalVisit({
      visitId: visit.id, baseCurrency: CLINIC_BASE_CURRENCY, signedBy: "td05-pg",
    });
    expect(rejected.reason).toBe("mixed_plan_currencies");
    // والزيارة بقيت غير موقَّعة — المعاملة كلها أو لا شيء.
    const { rows: [still] } = await pool.query<{ signed_at: Date | null }>(
      `SELECT signed_at FROM visits WHERE id = $1`, [visit.id],
    );
    expect(still.signed_at).toBeNull();
  });

  it("الرصيد دولابٌ لكل عملة من المصدر نفسه الذي تقرأ منه الشاشة", async () => {
    const ledger = await patientLedger(patientId);
    const balances = patientBalancesByCurrency(
      ledger.invoices.map((invoice) => ({
        totalMinor: invoice.totalMinor, discountMinor: invoice.discountMinor,
        status: invoice.status, baseCurrency: invoice.baseCurrency,
      })),
      toCurrencyPaymentLikes(
        patientId,
        ledger.payments.map((payment) => ({
          amountMinor: payment.amountMinor, currency: payment.currency,
          exchangeRate: payment.exchangeRate, baseAmountMinor: payment.baseAmountMinor,
          kind: payment.kind, invoiceId: payment.invoiceId,
        })),
        new Map(ledger.invoices.map((invoice) => [invoice.id, { patientId, currency: invoice.baseCurrency }])),
      ),
      ledger.opening?.amountMinor ?? 0,
    );
    // فاتورة الزيارة الدولارية (150,000 سنت) بعد قسط الدولار (50,000): 100,000 دولارية.
    expect(balances.USD.billedMinor).toBe(150000 + 50000);
    expect(balances.USD.collectedMinor).toBe(50000);
    expect(balances.USD.dueMinor).toBe(150000);
    // ولا وجود لنشاطٍ يمنيّ مختلط في رصيد الدولار.
    expect(balances.YER.billedMinor).toBe(0);
  });
});
