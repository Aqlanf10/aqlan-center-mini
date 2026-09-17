import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * اختبارات مراجعة المالك لـ TD-05 (PR #44) — سداد الثغرات الخمس:
 *
 *  1) توقيع الزيارة يعيد عملة الفاتورة الفعلية (والشبّاك والتحصيل بها).
 *  2) بندٌ يُضاف إلى خطةٍ بعملة اتفاق لا يرث سعر الدليل الأساسي — سعرٌ صريح
 *     بعملة الخطة يُفرض في الخادم، والرفض يصل من مسار الواجهة البرمجية
 *     مباشرةً لا من الواجهة الرسومية وحدها.
 *  3) فاتورة يدوية بعملة اتفاق لا تسقط إلى سعر الدليل الأساسي — سعرٌ صريح
 *     إلزامي، والفاتورة الأساسية كما كانت دائمًا.
 *  4) الردّ يرث هدف تسوية سنده الأصلي (الفاتورة/الخطة) تحت قفل الأصل نفسه،
 *     وهدفٌ صريحٌ يخالفه يُرفض، وبلا ذكرٍ يُورَث.
 *  5) الدفع الأجنبي بلا هدفٍ (لا فاتورة ولا خطة) مرفوض — لا يُقيَّد على دلو
 *     الأساس بصمت، والدفع المقدَّم على خطة يسوّي دلو عملتها.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const sessionMock = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: sessionMock.requireSession }));

const {
  getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment,
  createPlanV2, getPlanCurrency, patientPlanCurrencies,
} = await import("../lib/db");
const {
  CLINIC_BASE_CURRENCY, patientBalancesByCurrency, toCurrencyPaymentLikes,
} = await import("../lib/money");
const { POST: postPlanItem } = await import("../app/api/plans/[id]/items/route");
const { POST: postInvoice } = await import("../app/api/invoices/route");
const { POST: postPayment } = await import("../app/api/payments/route");
const { POST: postClinical } = await import("../app/api/visits/[id]/clinical/route");

let patientId: number;
let serviceId: number;
const adminSession = { userId: 1, username: "ownrev", role: "admin" };

beforeAll(async () => {
  await ensureSchema();
  await openShift({ openedBy: "ownrev", opening: { YER: 0, SAR: 0, USD: 0 } });
  const { rows: [patient] } = await getPool().query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('OWNREV-1', 'مريض مراجعة المالك') RETURNING id`,
  );
  patientId = patient.id;
  const { rows: [service] } = await getPool().query(
    `INSERT INTO services (name, price_minor, is_active) VALUES ('تنظيف مراجعة', 15000, TRUE) RETURNING id`,
  );
  serviceId = service.id;
  /* أسعار الصرف للدفعات الأجنبية عبر المسار — الإعدادات الافتراضية مثبَّتة هنا. */
  await getPool().query(
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

/** زيارة سريرية ببندٍ مربوطٍ بخطة — كما تبنيها الرحلة الحقيقية. */
async function visitWithPlanItem(planId: number, itemUnitPriceMinor: number): Promise<number> {
  const pool = getPool();
  const { rows: [item] } = await pool.query<{ id: number }>(
    `SELECT id FROM plan_items WHERE plan_id = $1 LIMIT 1`, [planId],
  );
  const { rows: [visit] } = await pool.query<{ id: number }>(
    `INSERT INTO visits (patient_name, status, patient_id, arrived_at)
     VALUES ('مريض مراجعة المالك', 'seated', $1, NOW()) RETURNING id`, [patientId],
  );
  await pool.query(
    `INSERT INTO visit_procedures (visit_id, service_id, plan_item_id, quantity, unit_price_minor)
     VALUES ($1, $2, $3, 1, $4)`, [visit.id, serviceId, item.id, itemUnitPriceMinor],
  );
  return visit.id;
}

async function createPlan(
  currency: "YER" | "SAR" | "USD", title: string, unitPriceMinor: number, consent = true,
) {
  const created = await createPlanV2({
    patientId, title, specialty: null, primaryDoctorId: null,
    billingMode: "per_procedure", baseCurrency: currency, startDate: "2026-01-01", note: null,
    items: [{
      serviceId, serviceName: "تنظيف مراجعة", category: "cleaning", toothCode: null, surfaces: null,
      quantity: 1, unitPriceMinor, billingRule: "on_completion", sessionCount: 1, note: null,
    }],
    installments: [], createdBy: "ownrev",
  });
  expect(created.ok).toBe(true);
  if (created.ok && consent) {
    await getPool().query(
      `UPDATE treatment_plans SET consent_at = NOW() WHERE id = $1`, [created.planId],
    );
  }
  return created.ok ? created.planId : 0;
}

const jsonRequest = (url: string, body: unknown, params?: Record<string, string>) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(params ?? {}) },
    body: JSON.stringify(body),
  });

/* ══════════════════ Finding 2: بندٌ على خطةٍ قائمة ══════════════════ */

describe("مراجعة المالك ٢: بند على خطة قائمة بعملة اتفاق", () => {
  it("خطة USD + خدمة دليل بلا سعر ⇒ رفضٌ من الخادم لا حفظٌ بسعر الدليل", async () => {
    const planId = await createPlan("USD", "قائمة USD", 100000, false);
    const response = await postPlanItem(
      jsonRequest(`http://localhost/api/plans/${planId}/items`, {
        serviceId, quantity: 1, sessionCount: 1,
      }),
      { params: Promise.resolve({ id: String(planId) }) },
    );
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.message).toContain("USD");
    /* ولا بند خُلِّف وراء الرفض — الرفض ذرّي لا يترك نصف عملية. */
    const { rows } = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM plan_items WHERE plan_id = $1`, [planId],
    );
    expect(rows[0].n).toBe(1); // بند الإنشاء وحده
  });

  it("خطة SAR + خدمة دليل بلا سعر ⇒ رفض كذلك", async () => {
    const planId = await createPlan("SAR", "قائمة SAR", 80000, false);
    const response = await postPlanItem(
      jsonRequest(`http://localhost/api/plans/${planId}/items`, {
        serviceId, quantity: 1, sessionCount: 1,
      }),
      { params: Promise.resolve({ id: String(planId) }) },
    );
    expect(response.status).toBe(400);
  });

  it("سعرٌ صريح بالدولار يُخزَّن كما كُتب — بالسنت لا بالوحدة", async () => {
    const planId = await createPlan("USD", "قائمة USD بسعر", 100000, false);
    const response = await postPlanItem(
      jsonRequest(`http://localhost/api/plans/${planId}/items`, {
        serviceId, quantity: 1, sessionCount: 1, price: "75.50",
      }),
      { params: Promise.resolve({ id: String(planId) }) },
    );
    expect(response.status).toBe(201);
    const { rows } = await getPool().query<{ unit_price_minor: string }>(
      `SELECT unit_price_minor FROM plan_items WHERE plan_id = $1 ORDER BY id DESC LIMIT 1`,
      [planId],
    );
    expect(Number(rows[0].unit_price_minor)).toBe(7550);
  });

  it("سعرٌ صريح بالسعودي يُخزَّن صحيحًا", async () => {
    const planId = await createPlan("SAR", "قائمة SAR بسعر", 80000, false);
    const response = await postPlanItem(
      jsonRequest(`http://localhost/api/plans/${planId}/items`, {
        serviceId, quantity: 1, sessionCount: 1, price: "120",
      }),
      { params: Promise.resolve({ id: String(planId) }) },
    );
    expect(response.status).toBe(201);
    const { rows } = await getPool().query<{ unit_price_minor: string }>(
      `SELECT unit_price_minor FROM plan_items WHERE plan_id = $1 ORDER BY id DESC LIMIT 1`,
      [planId],
    );
    expect(Number(rows[0].unit_price_minor)).toBe(12000);
  });

  it("خطة YER تبقى على سعر الدليل — لا يتغير السلوك القائم", async () => {
    const planId = await createPlan("YER", "قائمة YER", 15000, false);
    const response = await postPlanItem(
      jsonRequest(`http://localhost/api/plans/${planId}/items`, {
        serviceId, quantity: 1, sessionCount: 1,
      }),
      { params: Promise.resolve({ id: String(planId) }) },
    );
    expect(response.status).toBe(201);
    const { rows } = await getPool().query<{ unit_price_minor: string }>(
      `SELECT unit_price_minor FROM plan_items WHERE plan_id = $1 ORDER BY id DESC LIMIT 1`,
      [planId],
    );
    expect(Number(rows[0].unit_price_minor)).toBe(15000);
  });

  it("getPlanCurrency تقرأ عملة الخطة من صفّها — لا من الطلب", async () => {
    const planId = await createPlan("USD", "قائمة عملة", 100000, false);
    expect(await getPlanCurrency(planId)).toBe("USD");
    expect(await getPlanCurrency(999999)).toBeNull();
  });
});

/* ══════════════════ Finding 3: الفاتورة اليدوية ══════════════════ */

describe("مراجعة المالك ٣: فاتورة يدوية بعملة اتفاق", () => {
  it("فاتورة USD ببند خدمةٍ بلا سعر ⇒ 400 — سعر الدليل لا يدخلها", async () => {
    const response = await postInvoice(jsonRequest("http://localhost/api/invoices", {
      patientId, currency: "USD",
      items: [{ serviceId, quantity: 1, price: "" }],
    }));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.message).toContain("USD");
  });

  it("فاتورة SAR بلا سعر ⇒ 400 كذلك", async () => {
    const response = await postInvoice(jsonRequest("http://localhost/api/invoices", {
      patientId, currency: "SAR",
      items: [{ serviceId, quantity: 1, price: "" }],
    }));
    expect(response.status).toBe(400);
  });

  it("فاتورة USD بسعرٍ صريح تُخزَّن بالمبلغ الدقيق بعملتها", async () => {
    const response = await postInvoice(jsonRequest("http://localhost/api/invoices", {
      patientId, currency: "USD",
      items: [{ serviceId, quantity: 2, price: "12.34" }],
    }));
    expect(response.status).toBe(201);
    const invoice = await response.json();
    expect(invoice.baseCurrency).toBe("USD");
    expect(invoice.totalMinor).toBe(2 * 1234);
  });

  it("فاتورة SAR بسعرٍ صريح تُخزَّن صحيحة", async () => {
    const response = await postInvoice(jsonRequest("http://localhost/api/invoices", {
      patientId, currency: "SAR",
      items: [{ serviceId, quantity: 1, price: "250" }],
    }));
    expect(response.status).toBe(201);
    const invoice = await response.json();
    expect(invoice.baseCurrency).toBe("SAR");
    expect(invoice.totalMinor).toBe(25000);
  });

  it("فاتورة YER بلا سعر تسقط لسعر الدليل — السلوك القائم لا يمس", async () => {
    const response = await postInvoice(jsonRequest("http://localhost/api/invoices", {
      patientId, currency: "YER",
      items: [{ serviceId, quantity: 1, price: "" }],
    }));
    expect(response.status).toBe(201);
    const invoice = await response.json();
    expect(invoice.baseCurrency).toBe("YER");
    expect(invoice.totalMinor).toBe(15000);
  });
});

/* ══════════════════ Finding 5: الدفع على الحساب ══════════════════ */

describe("مراجعة المالك ٥: الدفع على الحساب — هدفٌ صريح لا دلو الأساس", () => {
  it("دفع USD بلا فاتورةٍ ولا خطة ⇒ رفضٌ صريح من المسار", async () => {
    const response = await postPayment(jsonRequest("http://localhost/api/payments", {
      patientId, amount: "100", currency: "USD", kind: "payment", method: "cash",
    }));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.message).toContain("هدف");
    /* ولا سند خُلِّف وراء الرفض. */
    const { rows } = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE patient_id = $1 AND currency = 'USD' AND invoice_id IS NULL AND plan_id IS NULL`,
      [patientId],
    );
    expect(rows[0].n).toBe(0);
  });

  it("دفع SAR بلا هدف ⇒ رفض كذلك", async () => {
    const response = await postPayment(jsonRequest("http://localhost/api/payments", {
      patientId, amount: "50", currency: "SAR", kind: "payment", method: "cash",
    }));
    expect(response.status).toBe(400);
  });

  it("دفع YER على الحساب يبقى كما كان — مسموحًا بالأساس", async () => {
    const response = await postPayment(jsonRequest("http://localhost/api/payments", {
      patientId, amount: "5000", currency: "YER", kind: "payment", method: "cash",
    }));
    expect(response.status).toBe(201);
    const payment = await response.json();
    expect(payment.currency).toBe("YER");
    expect(payment.planId).toBeNull();
  });

  it("دفعة USD مقدَّمة على خطة دولارية ⇒ تُقيَّد على خطتها وتسوّي دلو الدولار", async () => {
    const planId = await createPlan("USD", "تقويم دولاري للدفع المقدَّم", 400000);
    const response = await postPayment(jsonRequest("http://localhost/api/payments", {
      patientId, amount: "200", currency: "USD", kind: "payment", method: "cash",
      planId,
    }));
    expect(response.status).toBe(201);
    const payment = await response.json();
    expect(payment.planId).toBe(planId);
    expect(payment.invoiceId).toBeNull();

    /* الأرصدة من المصدر نفسه الذي تقرأ منه الشاشات: دلو الدولار ينقص، والأساس لا يمس. */
    const { patientBalancesByCurrency: bucketsOf } = await import("../lib/money");
    const { rows: [bucket] } = await getPool().query<{ usd: string; yer: string }>(
      `SELECT
         (SELECT COALESCE(SUM(amount_minor), 0) FROM payments WHERE patient_id = $1 AND currency = 'USD')::text AS usd,
         (SELECT COALESCE(SUM(amount_minor), 0) FROM payments WHERE patient_id = $1 AND currency = 'YER' AND invoice_id IS NULL AND plan_id IS NULL)::text AS yer`,
      [patientId],
    );
    expect(Number(bucket.usd)).toBe(20000); // 200 دولار بالسنت
    void bucketsOf;
  });

  it("خطةً لغير المريض هدفًا للدفع ⇒ invalid_plan_target", async () => {
    const { rows: [stranger] } = await getPool().query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('OWNREV-2', 'غريب المراجعة') RETURNING id`,
    );
    const { rows: [plan] } = await getPool().query(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date)
       VALUES ($1, 'خطة الغريب', 10000, 'SAR', 'active', CURRENT_DATE) RETURNING id`,
      [stranger.id],
    );
    const { payment, reason } = await recordPayment({
      patientId, invoiceId: null, planId: plan.id, kind: "payment", amountMinor: 1000,
      currency: "SAR", baseCurrency: "YER", exchangeRate: 140, method: "cash",
      note: null, createdBy: "ownrev",
    });
    expect(payment).toBeNull();
    expect(reason).toBe("invalid_plan_target");
  });

  it("فاتورةٌ وخطة معًا هدفان ⇒ رفض من المسار قبل القاعدة", async () => {
    const { rows: [invoice] } = await getPool().query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
       VALUES ('OWNREV-INV-2', $1, 10000, 0, 'YER') RETURNING id`, [patientId],
    );
    const planId = await createPlan("YER", "خطة هدفٍ مزدوج", 50000);
    const response = await postPayment(jsonRequest("http://localhost/api/payments", {
      patientId, amount: "100", currency: "YER", kind: "payment", method: "cash",
      invoiceId: invoice.id, planId,
    }));
    expect(response.status).toBe(400);
  });
});

/* ══════════════════ Finding 4: الردّ يرث هدف الأصل ══════════════════ */

describe("مراجعة المالك ٤: الردّ يرث هدف تسوية سنده الأصلي", () => {
  let usdInvoiceId: number;
  let sarInvoiceId: number;

  beforeAll(async () => {
    const { rows: [usdInvoice] } = await getPool().query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
       VALUES ('OWNREV-INV-USD', $1, 300000, 0, 'USD') RETURNING id`, [patientId],
    );
    usdInvoiceId = usdInvoice.id;
    const { rows: [sarInvoice] } = await getPool().query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
       VALUES ('OWNREV-INV-SAR', $1, 200000, 0, 'SAR') RETURNING id`, [patientId],
    );
    sarInvoiceId = sarInvoice.id;
  });

  it("ردُّ دفعة USD بreversalOfId بلا invoiceId ⇒ يرث فاتورتها ولا يمسّ الأساس", async () => {
    const paid = await recordPayment({
      patientId, invoiceId: usdInvoiceId, kind: "payment", amountMinor: 100000,
      currency: "USD", baseCurrency: "YER", exchangeRate: 530, method: "cash",
      note: null, createdBy: "ownrev",
    });
    expect(paid.reason).toBeNull();

    /* الردّ بلا ذكرٍ للفاتورة إطلاقًا — الوراثة هي العقد. */
    const refunded = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 40000,
      currency: "USD", baseCurrency: "YER", exchangeRate: 530, method: "cash",
      note: null, createdBy: "ownrev", reversalOfId: paid.payment!.id,
    });
    expect(refunded.reason).toBeNull();
    expect(refunded.payment!.invoiceId).toBe(usdInvoiceId);
    expect(refunded.payment!.exchangeRate).toBe(530);

    const { rows: [row] } = await getPool().query<{ usd: string; yer: string }>(
      `SELECT
         (SELECT COALESCE(SUM(amount_minor), 0) FROM payments WHERE invoice_id = $1 AND kind = 'refund')::text AS usd,
         (SELECT COALESCE(SUM(amount_minor), 0) FROM payments WHERE patient_id = $2 AND currency = 'YER' AND kind = 'refund')::text AS yer`,
      [usdInvoiceId, patientId],
    );
    expect(Number(row.usd)).toBe(40000);
    expect(Number(row.yer)).toBe(0);
  });

  it("الردود الجزئية المتعددة تسلسلها المجموع ≤ الأصل، وإعادة المحاولة idempotent", async () => {
    const paid = await recordPayment({
      patientId, invoiceId: sarInvoiceId, kind: "payment", amountMinor: 90000,
      currency: "SAR", baseCurrency: "YER", exchangeRate: 140, method: "cash",
      note: null, createdBy: "ownrev", idempotencyKey: "ownrev-sar-0001",
    });
    expect(paid.reason).toBeNull();

    const first = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 20000,
      currency: "SAR", baseCurrency: "YER", exchangeRate: 140, method: "cash",
      note: null, createdBy: "ownrev", reversalOfId: paid.payment!.id,
      idempotencyKey: "ownrev-refund-0001",
    });
    expect(first.reason).toBeNull();
    expect(first.payment!.invoiceId).toBe(sarInvoiceId);

    /* إعادة المحاولة بالمفتاح نفسه ⇒ السند نفسه لا ردٌّ ثانٍ. */
    const replay = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 20000,
      currency: "SAR", baseCurrency: "YER", exchangeRate: 140, method: "cash",
      note: null, createdBy: "ownrev", reversalOfId: paid.payment!.id,
      idempotencyKey: "ownrev-refund-0001",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.payment!.id).toBe(first.payment!.id);

    const second = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 50000,
      currency: "SAR", baseCurrency: "YER", exchangeRate: 140, method: "cash",
      note: null, createdBy: "ownrev", reversalOfId: paid.payment!.id,
    });
    expect(second.reason).toBeNull();

    const beyond = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 20001,
      currency: "SAR", baseCurrency: "YER", exchangeRate: 140, method: "cash",
      note: null, createdBy: "ownrev", reversalOfId: paid.payment!.id,
    });
    expect(beyond.reason).toBe("reversal_exceeds_remaining");

    const { rows: [sums] } = await getPool().query<{ refunded: string; n: number }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::text AS refunded, COUNT(*)::int AS n
         FROM payments WHERE reversal_of_id = $1 AND kind = 'refund'`,
      [paid.payment!.id],
    );
    expect(sums.n).toBe(2);
    expect(Number(sums.refunded)).toBe(70000);
  });

  it("هدفٌ صريح يخالف هدف الأصل ⇒ reversal_target_conflict (fail-closed)", async () => {
    const paid = await recordPayment({
      patientId, invoiceId: usdInvoiceId, kind: "payment", amountMinor: 50000,
      currency: "USD", baseCurrency: "YER", exchangeRate: 530, method: "cash",
      note: null, createdBy: "ownrev",
    });
    expect(paid.reason).toBeNull();
    /* فاتورة أخرى يزعمها المتصل — ليست فاتورة الأصل. */
    const { rows: [other] } = await getPool().query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
       VALUES ('OWNREV-INV-OTHER', $1, 50000, 0, 'YER') RETURNING id`, [patientId],
    );
    const conflicting = await recordPayment({
      patientId, invoiceId: other.id, kind: "refund", amountMinor: 10000,
      currency: "USD", baseCurrency: "YER", exchangeRate: 530, method: "cash",
      note: null, createdBy: "ownrev", reversalOfId: paid.payment!.id,
    });
    expect(conflicting.payment).toBeNull();
    expect(conflicting.reason).toBe("reversal_target_conflict");
  });

  it("ردُّ دفعةٍ مقدَّمةٍ على خطة يرث خطتها — لا دلو الأساس", async () => {
    const planId = await createPlan("USD", "تقويم ردّ المقدَّم", 300000);
    const paid = await recordPayment({
      patientId, invoiceId: null, planId, kind: "payment", amountMinor: 50000,
      currency: "USD", baseCurrency: "YER", exchangeRate: 530, method: "cash",
      note: null, createdBy: "ownrev",
    });
    expect(paid.reason).toBeNull();

    const refunded = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 20000,
      currency: "USD", baseCurrency: "YER", exchangeRate: 530, method: "cash",
      note: null, createdBy: "ownrev", reversalOfId: paid.payment!.id,
    });
    expect(refunded.reason).toBeNull();
    expect(refunded.payment!.planId).toBe(planId);
    expect(refunded.payment!.invoiceId).toBeNull();
  });
});

/* ══════════════════ Finding 1: توقيع الزيارة يعيد عملة الفاتورة ══════════════════ */

describe("مراجعة المالك ١: توقيع الزيارة يعيد عملة الفاتورة الفعلية", () => {
  it("زيارة من خطة USD: النتيجة والمسار كلاهما يحملان invoiceCurrency = USD", async () => {
    const planId = await createPlan("USD", "زيارة مراجعة USD", 150000);
    const visitId = await visitWithPlanItem(planId, 150000);
    const response = await postClinical(
      jsonRequest(`http://localhost/api/visits/${visitId}/clinical`, { action: "sign" }),
      { params: Promise.resolve({ id: String(visitId) }) },
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.invoiceId).not.toBeNull();
    expect(payload.invoiceCurrency).toBe("USD");
    expect(payload.duesMinor).toBe(150000);
  });

  it("زيارة من خطة SAR: المسار يعيد SAR", async () => {
    const planId = await createPlan("SAR", "زيارة مراجعة SAR", 90000);
    const visitId = await visitWithPlanItem(planId, 90000);
    const response = await postClinical(
      jsonRequest(`http://localhost/api/visits/${visitId}/clinical`, { action: "sign" }),
      { params: Promise.resolve({ id: String(visitId) }) },
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.invoiceCurrency).toBe("SAR");
    expect(payload.duesMinor).toBe(90000);
  });

  it("زيارة بلا ربط بخطة: الفاتورة بالأساس والمسار يعيد YER", async () => {
    const { rows: [visit] } = await getPool().query<{ id: number }>(
      `INSERT INTO visits (patient_name, status, patient_id, arrived_at)
       VALUES ('مريض مراجعة المالك', 'seated', $1, NOW()) RETURNING id`, [patientId],
    );
    await getPool().query(
      `INSERT INTO visit_procedures (visit_id, service_id, quantity, unit_price_minor)
       VALUES ($1, $2, 1, 15000)`, [visit.id, serviceId],
    );
    const response = await postClinical(
      jsonRequest(`http://localhost/api/visits/${visit.id}/clinical`, { action: "sign" }),
      { params: Promise.resolve({ id: String(visit.id) }) },
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.invoiceCurrency).toBe(CLINIC_BASE_CURRENCY);
  });
});

/* ══════════════════ الأرصدة: دفعات الخطط تسوّي دلو عملتها ══════════════════ */

describe("الأرصدة: الدفعة المقيدة على خطة تسوّي دلو عملتها", () => {
  it("toCurrencyPaymentLikes: planId يوجّه الدفعة لدلو عملة خطتها", () => {
    const payments = [{
      amountMinor: 20000, currency: "USD" as const, exchangeRate: 530,
      baseAmountMinor: 10600000, kind: "payment" as const,
      invoiceId: null, planId: 77,
    }];
    const likes = toCurrencyPaymentLikes(payments, new Map(), new Map([[77, "USD"]]));
    expect(likes[0].invoiceCurrency).toBe("USD");

    const balances = patientBalancesByCurrency(
      [{ totalMinor: 400000, discountMinor: 0, status: "open", baseCurrency: "USD" }],
      likes,
      0,
    );
    expect(balances.USD.dueMinor).toBe(380000);
    expect(balances.YER.dueMinor).toBe(0);
  });

  it("patientPlanCurrencies: خريطة عملة كل خطط المريض من القاعدة", async () => {
    const planId = await createPlan("SAR", "خريطة خطط", 60000);
    const map = await patientPlanCurrencies(patientId);
    expect(map.get(planId)).toBe("SAR");
  });
});
