import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * اختبارات المراجعة الثانية للمالك TD-05 (PR #44) — الاستنتاج ٨:
 *
 *  **الهدف الواحد للدفعة الجديدة قاعدةٌ كانونية في خدمة القاعدة لا في الباب**:
 *  «recordPayment» نفسها (lib/db.ts) ترفض الدفعة الجديدة التي تحمل فاتورةً وخطةً
 *  معًا (multiple_payment_targets) — فالمسار المباشر (الوكيل الذكي/مسارات
 *  مستقبلية) لا يستطيع تجاوز حارس app/api/payments وحده.
 *
 *  الاستثناءات الموثَّقة:
 *   * الردّ يرث هدف سنده الأصلي حصرًا — والأصل (قسط خطة) يحمل فاتورةً وخطةً
 *     معًا قصدًا، فردُّه يرثهما معًا بنجاح.
 *   * recordPlanInstallment نفسه يبني فاتورةً من الخطة فيقيد السند بهما معًا —
 *     ربطٌ قصدي لا يمر عبر recordPayment أصلًا.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const sessionMock = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: sessionMock.requireSession }));

const {
  getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment,
  recordPlanInstallment, createPlanV2,
} = await import("../lib/db");
const { CLINIC_BASE_CURRENCY } = await import("../lib/money");
const { POST: postPayment } = await import("../app/api/payments/route");

let patientId: number;
let serviceId: number;
let yerInvoiceId: number;
let usdPlanId: number;
let sarPlanId: number;
let yerPlanId: number;
const adminSession = { userId: 1, username: "ownrev2", role: "admin" };

beforeAll(async () => {
  await ensureSchema();
  await openShift({ openedBy: "ownrev2", opening: { YER: 0, SAR: 0, USD: 0 } });
  const pool = getPool();
  const { rows: [patient] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('OWNREV2-1', 'مريض المراجعة الثانية') RETURNING id`,
  );
  patientId = patient.id;
  const { rows: [service] } = await pool.query(
    `INSERT INTO services (name, price_minor, is_active) VALUES ('تنظيف المراجعة الثانية', 15000, TRUE) RETURNING id`,
  );
  serviceId = service.id;

  /* فاتورة أساسية قائمة — هدف تسوية صالح وحده. */
  const { rows: [invoice] } = await pool.query(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
     VALUES ('OWNREV2-INV-1', $1, 60000, 0, 'YER') RETURNING id`,
    [patientId],
  );
  yerInvoiceId = invoice.id;

  /* خطتا اتفاق — أجنبية وأجنبية — لكل أهداف التسوية المستقلة. */
  const usdPlan = await createPlanV2({
    patientId, title: "اتفاق دولاري — هدف وحيد", specialty: null, primaryDoctorId: null,
    billingMode: "per_procedure", baseCurrency: "USD", startDate: "2026-01-01", note: null,
    items: [{
      serviceId, serviceName: "تنظيف المراجعة الثانية", category: "cleaning", toothCode: null, surfaces: null,
      quantity: 1, unitPriceMinor: 150000, billingRule: "on_completion", sessionCount: 1, note: null,
    }],
    installments: [], createdBy: "ownrev2",
  });
  expect(usdPlan.ok).toBe(true);
  if (usdPlan.ok) usdPlanId = usdPlan.planId;
  const sarPlan = await createPlanV2({
    patientId, title: "اتفاق سعودي — هدف وحيد", specialty: null, primaryDoctorId: null,
    billingMode: "per_procedure", baseCurrency: "SAR", startDate: "2026-01-01", note: null,
    items: [{
      serviceId, serviceName: "تنظيف المراجعة الثانية", category: "cleaning", toothCode: null, surfaces: null,
      quantity: 1, unitPriceMinor: 90000, billingRule: "on_completion", sessionCount: 1, note: null,
    }],
    installments: [], createdBy: "ownrev2",
  });
  expect(sarPlan.ok).toBe(true);
  if (sarPlan.ok) sarPlanId = sarPlan.planId;

  /* خطة أساسية — لتقاطع الهدفين المتوافقَي عملةً: الحالتان فرديتان صالحتان
     وحدهما، والجمع بينهما هو الغموض المرفوض. */
  const yerPlan = await createPlanV2({
    patientId, title: "خطة أساسية — هدف وحيد", specialty: null, primaryDoctorId: null,
    billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-01-01", note: null,
    items: [{
      serviceId, serviceName: "تنظيف المراجعة الثانية", category: "cleaning", toothCode: null, surfaces: null,
      quantity: 1, unitPriceMinor: 40000, billingRule: "on_completion", sessionCount: 1, note: null,
    }],
    installments: [], createdBy: "ownrev2",
  });
  expect(yerPlan.ok).toBe(true);
  if (yerPlan.ok) yerPlanId = yerPlan.planId;

  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('finance.rate.SAR', '140'), ('finance.rate.USD', '530')`,
  );
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.requireSession.mockResolvedValue(adminSession);
});

function payment(overrides: Record<string, unknown> = {}) {
  return {
    patientId, invoiceId: null, kind: "payment" as const, amountMinor: 5000,
    currency: "YER" as const, baseCurrency: CLINIC_BASE_CURRENCY as "YER", exchangeRate: 1,
    method: "cash", note: null, createdBy: "ownrev2", ...overrides,
  };
}

/* ═══════════ الاستنتاج ٨: الهدف الكانوني الواحد ═══════════ */

describe("المراجعة الثانية ٨: خدمة القاعدة ترفض الهدفين معًا (multiple_payment_targets)", () => {
  it("فاتورة + خطة معًا (متوافقتا عملة) ⇒ رفض كانوني من recordPayment مباشرة — التجاوز مستحيل", async () => {
    /* على الكود الحالي تُقبل هذه الدفعة وتُخزَّن بهدفين — الغموض الذي يستدعي الرفض. */
    const dual = await recordPayment(payment({ invoiceId: yerInvoiceId, planId: yerPlanId, amountMinor: 3000 }));
    expect(dual.payment).toBeNull();
    expect(dual.reason).toBe("multiple_payment_targets");
  });

  it("فاتورة أساسية + خطة سعودية بعملة سعودية ⇒ الرفض الكانوني نفسه لا سبق فحص العملة", async () => {
    const dual = await recordPayment(payment({
      invoiceId: yerInvoiceId, planId: sarPlanId,
      currency: "SAR", baseCurrency: "YER", exchangeRate: 140, amountMinor: 500,
    }));
    expect(dual.payment).toBeNull();
    expect(dual.reason).toBe("multiple_payment_targets");
  });

  it("لا سند خلف الرفض — القاعدة لم تُقيَّد شيئًا", async () => {
    const before = await paymentCount();
    await recordPayment(payment({ invoiceId: yerInvoiceId, planId: usdPlanId }));
    expect(await paymentCount()).toBe(before);
  });

  it("فاتورة وحدها ⇒ صالحة كما كانت دائمًا", async () => {
    const result = await recordPayment(payment({ invoiceId: yerInvoiceId, amountMinor: 3000 }));
    expect(result.reason).toBeNull();
    expect(result.payment).not.toBeNull();
    expect(result.payment!.invoiceId).toBe(yerInvoiceId);
    expect(result.payment!.planId ?? null).toBeNull();
  });

  it("خطة وحدها ⇒ صالحة — الدفع المقدَّم على خطتها بعملتها", async () => {
    const result = await recordPayment(payment({
      planId: usdPlanId, currency: "USD", baseCurrency: "YER", exchangeRate: 530, amountMinor: 25000,
    }));
    expect(result.reason).toBeNull();
    expect(result.payment).not.toBeNull();
    expect(result.payment!.planId).toBe(usdPlanId);
    expect(result.payment!.invoiceId).toBeNull();
  });

  it("بلا هدف بالأساس ⇒ صالحة كما كانت دائمًا", async () => {
    const result = await recordPayment(payment({ amountMinor: 2000 }));
    expect(result.reason).toBeNull();
    expect(result.payment).not.toBeNull();
  });

  it("أجنبي بلا هدف ⇒ مرفوض — foreign_on_account_requires_target قائم", async () => {
    const result = await recordPayment(payment({
      currency: "USD", baseCurrency: "YER", exchangeRate: 530, amountMinor: 1000,
    }));
    expect(result.payment).toBeNull();
    expect(result.reason).toBe("foreign_on_account_requires_target");
  });

  it("سعودي بلا هدف ⇒ مرفوض كذلك", async () => {
    const result = await recordPayment(payment({
      currency: "SAR", baseCurrency: "YER", exchangeRate: 140, amountMinor: 500,
    }));
    expect(result.payment).toBeNull();
    expect(result.reason).toBe("foreign_on_account_requires_target");
  });
});

/* ═══════════ الاستنتاج ٨: استثناء الردّ — وراثة الهدفين معًا ═══════════ */

describe("المراجعة الثانية ٨: ردُّ قسط الخطة يرث فاتورته وخطته معًا", () => {
  it("recordPlanInstallment يسند السند بالفاتورة والخطة معًا (ربطٌ قصدي)", async () => {
    const installment = await recordPlanInstallment({
      planId: usdPlanId, patientId, installmentNumber: 1,
      planTitle: "اتفاق دولاري — هدف وحيد",
      amountMinor: 50000, currency: "USD",
      baseCurrency: "YER", exchangeRate: 530,
      method: "cash", note: null, createdBy: "ownrev2",
    });
    expect((installment as { reason?: string }).reason).toBeUndefined();
    expect((installment as { invoiceId: number }).invoiceId).toBeGreaterThan(0);
    expect((installment as { paymentId: number }).paymentId).toBeGreaterThan(0);

    const { rows: [row] } = await getPool().query<{ invoice_id: number | null; plan_id: number | null }>(
      `SELECT invoice_id, plan_id FROM payments WHERE id = $1`,
      [(installment as { paymentId: number }).paymentId],
    );
    expect(row.invoice_id).not.toBeNull();
    expect(row.plan_id).toBe(usdPlanId);
  });

  it("ردُّ سند القسط يرث الفاتورة والخطة معًا — لا يُرفض multiple_payment_targets", async () => {
    const { rows: [origin] } = await getPool().query<{ id: number }>(
      `SELECT id FROM payments WHERE plan_id = $1 AND kind = 'payment' ORDER BY id DESC LIMIT 1`,
      [usdPlanId],
    );
    expect(origin).toBeTruthy();

    const refund = await recordPayment({
      patientId, invoiceId: null, planId: null, kind: "refund",
      amountMinor: 20000, currency: "USD", baseCurrency: "YER", exchangeRate: 530,
      method: "cash", note: "رد جزئي لقسط دولاري", createdBy: "ownrev2",
      reversalOfId: origin.id,
    });
    expect(refund.reason).toBeNull();
    expect(refund.payment).not.toBeNull();

    const { rows: [row] } = await getPool().query<{ invoice_id: number | null; plan_id: number | null }>(
      `SELECT invoice_id, plan_id FROM payments WHERE id = $1`,
      [refund.payment!.id],
    );
    expect(row.invoice_id).not.toBeNull();
    expect(row.plan_id).toBe(usdPlanId);
  });

  it("ردٌّ بذكر الهدفين مطابقين لأصلهما ⇒ مسموح — التوريث لا التعارض", async () => {
    const { rows: [origin] } = await getPool().query<{ id: number; invoice_id: number | null; plan_id: number | null }>(
      `SELECT id, invoice_id, plan_id FROM payments WHERE plan_id = $1 AND kind = 'payment' ORDER BY id DESC LIMIT 1`,
      [usdPlanId],
    );
    const refund = await recordPayment({
      patientId, invoiceId: origin.invoice_id, planId: origin.plan_id, kind: "refund",
      amountMinor: 10000, currency: "USD", baseCurrency: "YER", exchangeRate: 530,
      method: "cash", note: null, createdBy: "ownrev2",
      reversalOfId: origin.id,
    });
    expect(refund.reason).toBeNull();
    expect(refund.payment).not.toBeNull();
  });

  it("ردٌّ بذكر الهدفين وخطةٍ غير خطته ⇒ تعارض صريح لا ربطٌ صامت", async () => {
    const { rows: [origin] } = await getPool().query<{ id: number; invoice_id: number | null }>(
      `SELECT id, invoice_id FROM payments WHERE plan_id = $1 AND kind = 'payment' ORDER BY id DESC LIMIT 1`,
      [usdPlanId],
    );
    const refund = await recordPayment({
      patientId, invoiceId: origin.invoice_id, planId: sarPlanId, kind: "refund",
      amountMinor: 1000, currency: "USD", baseCurrency: "YER", exchangeRate: 530,
      method: "cash", note: null, createdBy: "ownrev2",
      reversalOfId: origin.id,
    });
    expect(refund.payment).toBeNull();
    expect(refund.reason).toBe("reversal_target_conflict");
  });
});

/* ═══════════ الاستنتاج ٨: الباب يبقى حارسًا أولًا ═══════════ */

describe("المراجعة الثانية ٨: مسار الواجهة البرمجية يرفض الهدفين من الباب", () => {
  it("POST /api/payments بفاتورةٍ وخطةٍ معًا ⇒ 400 — والحارس الكانوني تحته", async () => {
    const response = await postPayment(new Request("http://localhost/api/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patientId, invoiceId: yerInvoiceId, planId: usdPlanId,
        amount: "50", currency: "YER", kind: "payment", method: "cash",
      }),
    }));
    expect(response.status).toBe(400);
  });
});

async function paymentCount(): Promise<number> {
  const { rows: [row] } = await getPool().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM payments WHERE patient_id = $1`, [patientId],
  );
  return row.n;
}
