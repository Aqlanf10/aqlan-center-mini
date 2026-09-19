import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات TD-05 — العملة الأساسية الدستورية وعملات اتفاق المريض.
 *
 *  * المصدر الوحيد للعملة الأساسية: CLINIC_BASE_CURRENCY = "YER" في lib/money.ts.
 *  * عملة الاتفاق (YER/SAR/USD) تُختار عند إنشاء الخطة/الفاتورة وتُخزَّن وتعود
 *    كما هي عند إعادة القراءة — ولا يفرضها الخادم عملةً واحدة.
 *  * الأرصدة دولابٌ لكل عملة: لا تجميع صامت بين عملات، والدفعات تسوّي دلو
 *    فاتورتها، والمكافئ المسجَّل بسعر يوم الدفع هو وحده ما يدخل الحساب.
 *  * الدفع بعملةٍ مختلفة عن فاتورةٍ بعملة اتفاق (SAR/USD) يُرفض بوضوح.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const {
  getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment,
  createPlanV2, listPatientPlans, recordPlanInstallment, signClinicalVisit,
} = await import("../lib/db");
const {
  CLINIC_BASE_CURRENCY, CURRENCIES, isCurrency, patientBalance,
  patientBalancesByCurrency, toCurrencyPaymentLikes, balancesText, balanceText,
} = await import("../lib/money");

let patientId: number;

beforeAll(async () => {
  await ensureSchema();
  await openShift({ openedBy: "td05-test", opening: { YER: 0, SAR: 0, USD: 0 } });
  const { rows: [patient] } = await getPool().query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('TD05-U1', 'مريض TD-05') RETURNING id`,
  );
  patientId = patient.id;
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("TD-05: العملة الأساسية الدستورية", () => {
  it("المصدر الوحيد يقرأ YER", () => {
    expect(CLINIC_BASE_CURRENCY).toBe("YER");
  });

  it("والعملات المدعومة ثلاث: YER وSAR وUSD", () => {
    expect(CURRENCIES).toEqual(["YER", "SAR", "USD"]);
    expect(isCurrency("YER")).toBe(true);
    expect(isCurrency("SAR")).toBe(true);
    expect(isCurrency("USD")).toBe(true);
    expect(isCurrency("EUR")).toBe(false);
  });
});

describe("TD-05: عملة اتفاق المريض — إنشاء وقراءة وتخزين", () => {
  const created: number[] = [];

  it("الخطة تُنشأ بالريال اليمني وتعود كما هي", async () => {
    const result = await createPlanV2({
      patientId, title: "خطة YER", specialty: null, primaryDoctorId: null,
      billingMode: "installments", baseCurrency: "YER", startDate: "2026-01-01", note: null,
      items: [], installments: [{ dueDate: "2026-02-01", amountMinor: 50000 }],
      createdBy: "td05",
    });
    expect(result.ok).toBe(true);
    if (result.ok) created.push(result.planId);
    const plans = await listPatientPlans(patientId, "2026-01-15");
    const plan = plans.find((p) => p.title === "خطة YER");
    expect(plan?.baseCurrency).toBe("YER");
  });

  it("والخطة تُنشأ بالسعودي وتعود سعودية — لا تعود يمنيًّا", async () => {
    const result = await createPlanV2({
      patientId, title: "خطة SAR", specialty: null, primaryDoctorId: null,
      billingMode: "installments", baseCurrency: "SAR", startDate: "2026-01-01", note: null,
      items: [], installments: [{ dueDate: "2026-02-01", amountMinor: 80000 }],
      createdBy: "td05",
    });
    expect(result.ok).toBe(true);
    if (result.ok) created.push(result.planId);
    const plans = await listPatientPlans(patientId, "2026-01-15");
    const plan = plans.find((p) => p.title === "خطة SAR");
    expect(plan?.baseCurrency).toBe("SAR");
  });

  it("والخطة تُنشأ بالدولار وتعود دولارية", async () => {
    const result = await createPlanV2({
      patientId, title: "تقويم USD", specialty: "تقويم", primaryDoctorId: null,
      billingMode: "installments", baseCurrency: "USD", startDate: "2026-01-01", note: null,
      items: [], installments: [{ dueDate: "2026-02-01", amountMinor: 150000 }],
      createdBy: "td05",
    });
    expect(result.ok).toBe(true);
    if (result.ok) created.push(result.planId);
    const plans = await listPatientPlans(patientId, "2026-01-15");
    const plan = plans.find((p) => p.title === "تقويم USD");
    expect(plan?.baseCurrency).toBe("USD");
    expect(plan?.totalMinor).toBe(150000);
  });

  it("وتحرير بيانات المريض الديموغرافية لا يمسّ عملة الخطة", async () => {
    await getPool().query(
      `UPDATE patients SET full_name = $2, address = $3, medical_alert = $4 WHERE id = $1`,
      [patientId, "مريض TD-05 بعد التحرير", "تعز", "حساسية بنسلين"],
    );
    const plans = await listPatientPlans(patientId, "2026-01-15");
    expect(plans.find((p) => p.title === "تقويم USD")?.baseCurrency).toBe("USD");
    expect(plans.find((p) => p.title === "خطة SAR")?.baseCurrency).toBe("SAR");
    expect(plans.find((p) => p.title === "خطة YER")?.baseCurrency).toBe("YER");
  });

  it("وتقدُّم الخطة يُحسب بعملتها: المسدَّد بعملة الاتفاق لا بمكافئٍ أساسي", async () => {
    const plans = await listPatientPlans(patientId, "2026-01-15");
    const usdPlan = plans.find((p) => p.title === "تقويم USD");
    expect(usdPlan).toBeDefined();
    // قبل أي قبض: المدفوع صفر والإجمالي بعملة الاتفاق.
    expect(usdPlan!.progress.paidMinor).toBe(0);
    expect(usdPlan!.totalMinor).toBe(150000);

    // قبض القسط بالدولار نفسه.
    const collected = await recordPlanInstallment({
      planId: usdPlan!.id, patientId, installmentNumber: 1, planTitle: "تقويم USD",
      amountMinor: 100000, currency: "USD", baseCurrency: "YER", exchangeRate: 530,
      method: "cash", note: null, createdBy: "td05",
    });
    expect("reason" in collected && collected.reason).toBeFalsy();

    // الفاتورة المولَّدة من القسط بعملة الاتفاق — لا بعملة الدفاتر.
    const { rows: [invoice] } = await getPool().query(
      `SELECT base_currency, total_minor FROM invoices WHERE plan_id = $1`,
      [usdPlan!.id],
    );
    expect(invoice.base_currency).toBe("USD");
    expect(Number(invoice.total_minor)).toBe(100000);

    // والسند نفسه يحفظ الدولار ومكافئه الأساسي المسجَّل.
    const { rows: [payment] } = await getPool().query(
      `SELECT currency, amount_minor, base_amount_minor FROM payments WHERE plan_id = $1`,
      [usdPlan!.id],
    );
    expect(payment.currency).toBe("USD");
    expect(Number(payment.amount_minor)).toBe(100000);
    expect(Number(payment.base_amount_minor)).toBe(1000 * 530);

    // والمدفوع في تقدُّم الخطة بالدولار لا بالمكافئ.
    const after = (await listPatientPlans(patientId, "2026-01-15"))
      .find((p) => p.id === usdPlan!.id);
    expect(after!.progress.paidMinor).toBe(100000);
    expect(after!.progress.remainingMinor).toBe(50000);
  });

  it("والقسط بعملةٍ مختلفة عن خطةٍ بعملة اتفاق يُرفض بوضوح", async () => {
    const plans = await listPatientPlans(patientId, "2026-01-15");
    const sarPlan = plans.find((p) => p.title === "خطة SAR");
    const rejected = await recordPlanInstallment({
      planId: sarPlan!.id, patientId, installmentNumber: 1, planTitle: "خطة SAR",
      amountMinor: 50000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      method: "cash", note: null, createdBy: "td05",
    });
    expect("reason" in rejected && rejected.reason).toBe("cross_currency_not_supported");
  });
});

describe("TD-05: الدفع مقابل عملة الفاتورة", () => {
  it("الدفع بعملة الفاتورة يُقبل ويحفظ عملته ومكافئه", async () => {
    const { rows: [invoice] } = await getPool().query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
       VALUES ('TD05-INV-USD', $1, 200000, 0, 'USD') RETURNING id`,
      [patientId],
    );
    const { payment, reason } = await recordPayment({
      patientId, invoiceId: invoice.id, kind: "payment", amountMinor: 50000,
      currency: "USD", baseCurrency: "YER", exchangeRate: 530, method: "cash",
      note: null, createdBy: "td05",
    });
    expect(reason).toBeNull();
    expect(payment?.currency).toBe("USD");
    expect(payment?.baseAmountMinor).toBe(500 * 530);
  });

  it("والدفع بعملةٍ مختلفة عن فاتورة USD يُرفض — لا تحويل صامت", async () => {
    const { rows: [invoice] } = await getPool().query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
       VALUES ('TD05-INV-USD2', $1, 100000, 0, 'USD') RETURNING id`,
      [patientId],
    );
    const { payment, reason } = await recordPayment({
      patientId, invoiceId: invoice.id, kind: "payment", amountMinor: 53000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "td05",
    });
    expect(reason).toBe("cross_currency_not_supported");
    expect(payment).toBeNull();
    // ولا سجلَّ دفعةٍ خُلِّف وراء الرفض.
    const { rows } = await getPool().query(
      `SELECT id FROM payments WHERE invoice_id = $1`, [invoice.id],
    );
    expect(rows.length).toBe(0);
  });

  it("والدفع بعملةٍ مختلفة عن فاتورةٍ أساسية (YER) يبقى بالعقد الموثَّق: مكافئ مسجَّل بسعر يومه", async () => {
    const { rows: [invoice] } = await getPool().query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
       VALUES ('TD05-INV-YER', $1, 1000000, 0, 'YER') RETURNING id`,
      [patientId],
    );
    const { payment, reason } = await recordPayment({
      patientId, invoiceId: invoice.id, kind: "payment", amountMinor: 10000,
      currency: "USD", baseCurrency: "YER", exchangeRate: 530, method: "cash",
      note: null, createdBy: "td05",
    });
    expect(reason).toBeNull();
    expect(payment?.baseAmountMinor).toBe(100 * 530);
  });
});

describe("TD-05: أرصدة المريض بعملاته المستقلة", () => {
  it("لا تجميع صامت: كل عملةٍ بدلوها", () => {
    const balances = patientBalancesByCurrency(
      [
        { totalMinor: 10000, discountMinor: 0, status: "open", baseCurrency: "YER" },
        { totalMinor: 500, discountMinor: 0, status: "open", baseCurrency: "SAR" },
        { totalMinor: 100, discountMinor: 0, status: "open", baseCurrency: "USD" },
      ],
      [],
      0,
    );
    expect(balances.YER.dueMinor).toBe(10000);
    expect(balances.SAR.dueMinor).toBe(500);
    expect(balances.USD.dueMinor).toBe(100);
  });

  it("والدفع على الحساب يسوّي دلو العملة الأساسية بمكافئه المسجَّل", () => {
    const balances = patientBalancesByCurrency(
      [{ totalMinor: 100000, discountMinor: 0, status: "open", baseCurrency: "YER" }],
      [{
        amountMinor: 10000, currency: "USD", exchangeRate: 530, baseAmountMinor: 5300000,
        kind: "payment", invoiceCurrency: null,
      }],
      0,
    );
    expect(balances.YER.dueMinor).toBe(100000 - 5300000 / 100 * 100);
  });

  it("والدفع المرتبط بفاتورة يسوّي دلو عملتها — بعملتها لا بمكافئ الدفاتر", () => {
    const balances = patientBalancesByCurrency(
      [{ totalMinor: 200000, discountMinor: 0, status: "open", baseCurrency: "USD" }],
      [{
        amountMinor: 50000, currency: "USD", exchangeRate: 530, baseAmountMinor: 26500000,
        kind: "payment", invoiceCurrency: "USD",
      }],
      0,
    );
    expect(balances.USD.dueMinor).toBe(150000);
    expect(balances.YER.dueMinor).toBe(0);
  });

  it("والرصيد الافتتاحي أساسي — العمود بلا عملةٍ مخزَّنة", () => {
    const balances = patientBalancesByCurrency([], [], 75000);
    expect(balances.YER.openingMinor).toBe(75000);
    expect(balances.YER.dueMinor).toBe(75000);
    expect(balances.USD.openingMinor).toBe(0);
  });

  it("والنص يوسم كل عملةٍ بسطرها — لا رقمٌ واحد يمزجها", () => {
    const balances = patientBalancesByCurrency(
      [
        { totalMinor: 10000, discountMinor: 0, status: "open", baseCurrency: "YER" },
        { totalMinor: 500, discountMinor: 0, status: "open", baseCurrency: "SAR" },
      ],
      [],
      0,
    );
    const text = balancesText(balances);
    expect(text).toContain("ريال يمني");
    expect(text).toContain("ريال سعودي");
  });

  it("وعملةٌ واحدة تُعرض سطرًا واحدًا كما كانت الشاشة دائمًا", () => {
    const balances = patientBalancesByCurrency(
      [{ totalMinor: 12500, discountMinor: 0, status: "open", baseCurrency: "YER" }],
      [],
      0,
    );
    expect(balancesText(balances)).toBe(balanceText(balances.YER, "YER"));
  });

  it("والنظرة المفردة القديمة بقيت لدلو الأساس وحده — توافقًا لا ازدواجًا", () => {
    const invoices = [{
      totalMinor: 10000, discountMinor: 0, status: "open" as const,
      baseCurrency: "YER" as const,
    }];
    const payments = [{
      amountMinor: 2000, currency: "YER" as const, exchangeRate: 1, baseAmountMinor: 2000,
      kind: "payment" as const, invoiceId: null,
    }];
    const legacy = patientBalance(invoices, payments, 0);
    const buckets = patientBalancesByCurrency(invoices, toCurrencyPaymentLikes(1, payments, new Map()), 0);
    expect(legacy.dueMinor).toBe(buckets.YER.dueMinor);
  });
});

describe("TD-05: توقيع الزيارة يرث عملة الاتفاق", () => {
  let serviceId: number;

  beforeAll(async () => {
    const { rows: [service] } = await getPool().query(
      `INSERT INTO services (name, price_minor, is_active) VALUES ('تنظيف TD05', 15000, TRUE) RETURNING id`,
    );
    serviceId = service.id;
  });

  it("زيارة بنودها من خطة دولارية تُفطر دولارية", async () => {
    const pool = getPool();
    const created = await createPlanV2({
      patientId, title: "زيارة USD", specialty: null, primaryDoctorId: null,
      billingMode: "per_procedure", baseCurrency: "USD", startDate: "2026-01-01", note: null,
      items: [{
        serviceId, serviceName: "تنظيف TD05", category: "cleaning", toothCode: null, surfaces: null,
        quantity: 1, unitPriceMinor: 120000, billingRule: "on_completion", sessionCount: 1, note: null,
      }],
      installments: [],
      createdBy: "td05",
    });
    expect(created.ok).toBe(true);
    await pool.query(`UPDATE treatment_plans SET consent_at = NOW() WHERE title = $1`, ["زيارة USD"]);
    const { rows: [item] } = await pool.query<{ id: number }>(
      `SELECT id FROM plan_items WHERE plan_id = $1 LIMIT 1`, [created.ok ? created.planId : 0],
    );
    const { rows: [visit] } = await pool.query<{ id: number }>(
      `INSERT INTO visits (patient_name, status, patient_id, arrived_at)
       VALUES ('مريض TD-05', 'seated', $1, NOW()) RETURNING id`, [patientId],
    );
    await pool.query(
      `INSERT INTO visit_procedures (visit_id, service_id, plan_item_id, quantity, unit_price_minor)
       VALUES ($1, $2, $3, 1, 120000)`, [visit.id, serviceId, item.id],
    );
    const signed = await signClinicalVisit({
      visitId: visit.id, baseCurrency: CLINIC_BASE_CURRENCY, signedBy: "td05",
    });
    expect(signed.reason).toBeNull();
    expect(signed.invoiceId).not.toBeNull();
    const { rows: [invoice] } = await pool.query<{ base_currency: string }>(
      `SELECT base_currency FROM invoices WHERE id = $1`, [signed.invoiceId],
    );
    expect(invoice.base_currency).toBe("USD");
  });

  it("وزيارة تمزج بنود خطط بعملتين تُرفض — لا فاتورة تمزج العملات", async () => {
    const pool = getPool();
    const planA = await createPlanV2({
      patientId, title: "مزج أ USD", specialty: null, primaryDoctorId: null,
      billingMode: "per_procedure", baseCurrency: "USD", startDate: "2026-01-01", note: null,
      items: [{
        serviceId, serviceName: "تنظيف TD05", category: "cleaning", toothCode: null, surfaces: null,
        quantity: 1, unitPriceMinor: 90000, billingRule: "on_completion", sessionCount: 1, note: null,
      }],
      installments: [], createdBy: "td05",
    });
    const planB = await createPlanV2({
      patientId, title: "مزج ب YER", specialty: null, primaryDoctorId: null,
      billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-01-01", note: null,
      items: [{
        serviceId, serviceName: "تنظيف TD05", category: "cleaning", toothCode: null, surfaces: null,
        quantity: 1, unitPriceMinor: 5000, billingRule: "on_completion", sessionCount: 1, note: null,
      }],
      installments: [], createdBy: "td05",
    });
    expect(planA.ok && planB.ok).toBe(true);
    await pool.query(
      `UPDATE treatment_plans SET consent_at = NOW() WHERE title IN ($1, $2)`,
      ["مزج أ USD", "مزج ب YER"],
    );
    const { rows: [itemA] } = await pool.query<{ id: number }>(
      `SELECT id FROM plan_items WHERE plan_id = $1 LIMIT 1`, [planA.ok ? planA.planId : 0],
    );
    const { rows: [itemB] } = await pool.query<{ id: number }>(
      `SELECT id FROM plan_items WHERE plan_id = $1 LIMIT 1`, [planB.ok ? planB.planId : 0],
    );
    const { rows: [visit] } = await pool.query<{ id: number }>(
      `INSERT INTO visits (patient_name, status, patient_id, arrived_at)
       VALUES ('مريض TD-05', 'seated', $1, NOW()) RETURNING id`, [patientId],
    );
    await pool.query(
      `INSERT INTO visit_procedures (visit_id, service_id, plan_item_id, quantity, unit_price_minor)
       VALUES ($1, $2, $3, 1, 90000), ($1, $2, $4, 1, 5000)`,
      [visit.id, serviceId, itemA.id, itemB.id],
    );
    const rejected = await signClinicalVisit({
      visitId: visit.id, baseCurrency: CLINIC_BASE_CURRENCY, signedBy: "td05",
    });
    expect(rejected.reason).toBe("mixed_plan_currencies");
    const { rows: [still] } = await pool.query<{ signed_at: Date | null }>(
      `SELECT signed_at FROM visits WHERE id = $1`, [visit.id],
    );
    expect(still.signed_at).toBeNull();
  });
});
