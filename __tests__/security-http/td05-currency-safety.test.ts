import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * رحلات أمن العملات لمراجعة المالك TD-05 (PR #44) — على HTTP حقيقي ومتصفح حقيقي.
 *
 * الغرض: إثبات أن الحماية في **الخادم** لا في الواجهة — فالمسار المباشر
 * (curl/API bypass) لا يستطيع:
 *  ١) إنشاء فاتورة SAR/USD ببندٍ بلا سعر (سعر الدليل يمنيّ لا يدخلها).
 *  ٢) إضافة بندٍ إلى خطة SAR/USD قائمة بسعر الدليل.
 *  ٣) قبض عملة أجنبية «على الحساب» بلا هدف — فتخفض الريال بصمت.
 *
 * ثم رحلة المتصفح: خطة دولارية غير موافَق عليها ⇒ حقل السعر بعملة الخطة إلزامي
 * في الشاشة نفسها، ورفض الخادم يظهر للمستخدم.
 *
 * ورحلة الشبّاك كاملة في المتصفح: زيارة من خطة دولارية ⇒ توقيع ⇒ الفاتورة
 * دولارية ⇒ الشبّاك يعرض الدولار ⇒ التحصيل يفتح على فاتورة اليوم بعملتها ⇒
 * السند يرتبط بالفاتورة نفسها.
 */

let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let browser: Browser;
let context: BrowserContext;
let page: Page;

const TEST_PATIENT_NAME = "مريض الأمن أ";

const USD_PLAN_TITLE = "تقويم دولاري — رحلة المراجعة";
const SAR_PLAN_TITLE = "اتفاق سعودي — رحلة المراجعة";

let usdPlanId = 0;
let sarPlanId = 0;
let serviceId = 0;
let signVisitId = 0;
let signInvoiceId = 0;
let browserVisitId = 0;

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();

  /* وردية مفتوحة + أسعار صرف — القبض يحتاجهما. */
  await db.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'ownrev-http', 0, 0, 0
      WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`,
  );
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('finance.rate.USD', '530'), ('finance.rate.SAR', '140')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );

  const { rows: [service] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active)
     VALUES ('تنظيف رحلة المراجعة', 15000, TRUE) RETURNING id`,
  );
  serviceId = service.id;

  const { rows: [usdPlan] } = await db.query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date, consent_at)
     VALUES ($1, $2, 150000, 'USD', 'active', CURRENT_DATE, NULL) RETURNING id`,
    [h.seeded.patientAId, USD_PLAN_TITLE],
  );
  usdPlanId = usdPlan.id;

  const { rows: [sarPlan] } = await db.query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date, consent_at)
     VALUES ($1, $2, 80000, 'SAR', 'active', CURRENT_DATE, NULL) RETURNING id`,
    [h.seeded.patientAId, SAR_PLAN_TITLE],
  );
  sarPlanId = sarPlan.id;

  /* رحلة التوقيع: خطة دولارية موافَق عليها وبنده مربوط بزيارةٍ قائمة. */
  const { rows: [consentedPlan] } = await db.query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date, consent_at)
     VALUES ($1, 'تقويم دولاري للتوقيع', 200000, 'USD', 'active', CURRENT_DATE, NOW()) RETURNING id`,
    [h.seeded.patientAId],
  );
  async function linkedUsdVisit(unitPriceMinor: number): Promise<number> {
    const { rows: [item] } = await db.query<{ id: number }>(
      `INSERT INTO plan_items (plan_id, service_id, service_name, category, quantity, unit_price_minor, billing_rule, session_count, status)
       VALUES ($1, $2, 'تنظيف رحلة المراجعة', 'cleaning', 1, $3, 'on_completion', 1, 'planned') RETURNING id`,
      [consentedPlan.id, serviceId, unitPriceMinor],
    );
    const { rows: [visit] } = await db.query<{ id: number }>(
      `INSERT INTO visits (patient_name, patient_id, status, arrived_at)
       VALUES ($1, $2, 'seated', NOW()) RETURNING id`,
      [TEST_PATIENT_NAME, h.seeded.patientAId],
    );
    await db.query(
      `INSERT INTO visit_procedures (visit_id, service_id, plan_item_id, quantity, unit_price_minor)
       VALUES ($1, $2, $3, 1, $4)`,
      [visit.id, serviceId, item.id, unitPriceMinor],
    );
    return visit.id;
  }
  signVisitId = await linkedUsdVisit(200000);   // رحلة HTTP
  browserVisitId = await linkedUsdVisit(150000); // رحلة المتصفح

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
  page = await context.newPage();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  if (db) {
    await db.query(`DELETE FROM payments WHERE patient_id = $1`, [h.seeded.patientAId]).catch(() => {});
    await db.query(`DELETE FROM invoices WHERE patient_id = $1`, [h.seeded.patientAId]).catch(() => {});
    await db.query(
      `DELETE FROM visit_procedures WHERE visit_id = ANY (SELECT id FROM visits WHERE patient_id = $1)`,
      [h.seeded.patientAId],
    ).catch(() => {});
    await db.query(`DELETE FROM visits WHERE patient_id = $1`, [h.seeded.patientAId]).catch(() => {});
    await db.query(`DELETE FROM treatment_plans WHERE patient_id = $1`, [h.seeded.patientAId]).catch(() => {});
    await db.query(`DELETE FROM plan_items WHERE service_id = $1`, [serviceId]).catch(() => {});
    await db.query(`DELETE FROM services WHERE id = $1`, [serviceId]).catch(() => {});
    await db.end();
  }
});

/* ══════════════ الفاتورة اليدوية: المسار المباشر لا يجتاز ══════════════ */

describe("مسار HTTP المباشر: فاتورة أجنبية بلا سعر صريح", () => {
  it("فاتورة USD ببند خدمةٍ بلا سعر ⇒ 400 — لا استيراد لسعر الدليل اليمني", async () => {
    const response = await authedJson("/api/invoices", {
      patientId: h.seeded.patientAId, currency: "USD",
      items: [{ serviceId, quantity: 1, price: "" }],
    });
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.message).toContain("USD");
  });

  it("فاتورة SAR بلا سعر ⇒ 400، وبسعرٍ صريح تُخزَّن بعملتها", async () => {
    const rejected = await authedJson("/api/invoices", {
      patientId: h.seeded.patientAId, currency: "SAR",
      items: [{ serviceId, quantity: 1, price: "" }],
    });
    expect(rejected.status).toBe(400);

    const accepted = await authedJson("/api/invoices", {
      patientId: h.seeded.patientAId, currency: "SAR",
      items: [{ serviceId, quantity: 1, price: "80" }],
    });
    expect(accepted.status).toBe(201);
    const invoice = await accepted.json();
    expect(invoice.baseCurrency).toBe("SAR");
    expect(invoice.totalMinor).toBe(8000);
  });

  it("فاتورة YER بلا سعر تسقط لسعر الدليل — السلوك القائم لا يمس", async () => {
    const response = await authedJson("/api/invoices", {
      patientId: h.seeded.patientAId, currency: "YER",
      items: [{ serviceId, quantity: 1, price: "" }],
    });
    expect(response.status).toBe(201);
    const invoice = await response.json();
    expect(invoice.baseCurrency).toBe("YER");
    expect(invoice.totalMinor).toBe(15000);
  });
});

/* ══════════════ بند على خطة قائمة: المسار المباشر ══════════════ */

describe("مسار HTTP المباشر: بند على خطة قائمة بعملة اتفاق", () => {
  it("خطة USD + بلا سعر ⇒ 400 ولا بند خلف الرفض", async () => {
    const before = await planItemCount(usdPlanId);
    const response = await authedJson(`/api/plans/${usdPlanId}/items`, {
      serviceId, quantity: 1, sessionCount: 1,
    });
    expect(response.status).toBe(400);
    expect(await planItemCount(usdPlanId)).toBe(before);
  });

  it("خطة SAR + بلا سعر ⇒ 400، وبسعرٍ صريح يُخزَّن بعملتها", async () => {
    const rejected = await authedJson(`/api/plans/${sarPlanId}/items`, {
      serviceId, quantity: 1, sessionCount: 1,
    });
    expect(rejected.status).toBe(400);

    const accepted = await authedJson(`/api/plans/${sarPlanId}/items`, {
      serviceId, quantity: 1, sessionCount: 1, price: "95.25",
    });
    expect(accepted.status).toBe(201);
    const { rows: [row] } = await db.query<{ unit_price_minor: string }>(
      `SELECT unit_price_minor FROM plan_items WHERE plan_id = $1 ORDER BY id DESC LIMIT 1`,
      [sarPlanId],
    );
    expect(Number(row.unit_price_minor)).toBe(9525);
  });
});

/* ══════════════ الدفع على الحساب: هدفٌ صريح ══════════════ */

describe("مسار HTTP المباشر: الدفع الأجنبي بلا هدف مرفوض", () => {
  it("USD بلا فاتورةٍ ولا خطة ⇒ 400 ولا سند خلفه", async () => {
    const before = await paymentCount();
    const response = await authedJson("/api/payments", {
      patientId: h.seeded.patientAId, amount: "100", currency: "USD",
      kind: "payment", method: "cash",
    });
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.message).toContain("هدف");
    expect(await paymentCount()).toBe(before);
  });

  it("دفعة USD مقدَّمة على الخطة الدولارية ⇒ 201 تُقيَّد بخطتها", async () => {
    const response = await authedJson("/api/payments", {
      patientId: h.seeded.patientAId, amount: "100", currency: "USD",
      kind: "payment", method: "cash", planId: usdPlanId,
    });
    expect(response.status).toBe(201);
    const payment = await response.json();
    expect(payment.planId).toBe(usdPlanId);
    expect(payment.invoiceId).toBeNull();
  });

  it("YER على الحساب كما كانت دائمًا ⇒ 201", async () => {
    const response = await authedJson("/api/payments", {
      patientId: h.seeded.patientAId, amount: "1000", currency: "YER",
      kind: "payment", method: "cash",
    });
    expect(response.status).toBe(201);
  });
});

/* ══════════════ الشبّاك على HTTP: التوقيع يعيد العملة والتحصيل يرتبط ══════════════ */

describe("رحلة الشبّاك على HTTP: توقيع دولاري → تحصيل على فاتورتها", () => {
  it("توقيع الزيارة ⇒ invoiceCurrency=USD في الاستجابة والفاتورة دولارية", async () => {
    const response = await authedJson(`/api/visits/${signVisitId}/clinical`, { action: "sign" });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.invoiceId).not.toBeNull();
    expect(payload.invoiceCurrency).toBe("USD");
    expect(payload.duesMinor).toBe(200000);
    signInvoiceId = payload.invoiceId;

    const { rows: [invoice] } = await db.query<{ base_currency: string }>(
      `SELECT base_currency FROM invoices WHERE id = $1`, [signInvoiceId],
    );
    expect(invoice.base_currency).toBe("USD");
  });

  it("التحصيل على فاتورة اليوم بعملتها ⇒ السند يرتبط بها ودلو الأساس لا يمس", async () => {
    const before = await ledgerBuckets();
    const response = await authedJson("/api/payments", {
      patientId: h.seeded.patientAId, amount: "100", currency: "USD",
      kind: "payment", method: "cash", invoiceId: signInvoiceId,
    });
    expect(response.status).toBe(201);
    const payment = await response.json();
    expect(payment.invoiceId).toBe(signInvoiceId);

    const after = await ledgerBuckets();
    expect(after.usdCollected).toBe(before.usdCollected + 10000);
    expect(after.yerCollected).toBe(before.yerCollected);
  });

  it("ردُّ الدفعة بreversalOfId وحده يرث فاتورتها — لا دلو الأساس", async () => {
    const { rows: [paid] } = await db.query<{ id: number }>(
      `SELECT id FROM payments WHERE invoice_id = $1 AND kind = 'payment' ORDER BY id DESC LIMIT 1`,
      [signInvoiceId],
    );
    const before = await ledgerBuckets();
    const response = await authedJson("/api/payments", {
      patientId: h.seeded.patientAId, amount: "40", currency: "USD",
      kind: "refund", method: "cash", reversalOfId: paid.id,
    });
    expect(response.status).toBe(201);
    const refund = await response.json();
    expect(refund.invoiceId).toBe(signInvoiceId);

    const after = await ledgerBuckets();
    expect(after.usdCollected).toBe(before.usdCollected - 4000);
    expect(after.yerCollected).toBe(before.yerCollected);
  });
});

/* ══════════════ رحلة المتصفح: سعر البند بعملة الخطة في الشاشة ══════════════ */

describe("رحلة المتصفح: إضافة بندٍ لخطة دولارية", () => {
  it("حقل السعر بعملة الخطة ظاهر، والرفض بلا سعرٍ يصل المستخدم، والسعر الصريح يُخزَّن", async () => {
    await page.goto(`${baseUrl}/patients/${h.seeded.patientAId}?tab=plans`);
    /* بطاقة الخطة الدولارية وحدها — فقد تُعرض خطط أجنبية أخرى إلى جوارها. */
    const usdPlanCard = page.locator("li").filter({ hasText: USD_PLAN_TITLE }).first();
    await usdPlanCard.waitFor({ timeout: 60_000 });
    const priceField = usdPlanCard.locator('[data-field="plan-item-price"]');
    await priceField.waitFor({ timeout: 30_000 });
    await expect.poll(async () => priceField.getAttribute("aria-label"), { timeout: 10_000 })
      .toContain("دولار");

    /* رفض الخادم يظهر في الشاشة — الحماية خادمية والرسالة تصل. */
    await usdPlanCard.locator('[data-action="plan-add-item"]').click();
    /* p[role=alert] تحديدًا — فعّال next-route-announcer يحمل الدور نفسه. */
    const alert = page.locator('p[role="alert"]');
    await alert.waitFor({ timeout: 30_000 });
    expect(await alert.textContent()).toContain("USD");

    /* السعر الصريح بالدولار: البند يُخزَّن به بعملة الخطة. الانتظار على أثر
       القاعدة لا على اختفاء التنبيه — فالتنبيه يُمسح عند بدء الإضافة لا عند
       اكتمالها (سباقٌ ظهر في CI لا محليًّا). */
    await priceField.fill("75.50");
    await usdPlanCard.locator('[data-action="plan-add-item"]').click();
    await expect.poll(async () => {
      const { rows: [row] } = await db.query<{ unit_price_minor: string }>(
        `SELECT unit_price_minor FROM plan_items WHERE plan_id = $1 ORDER BY id DESC LIMIT 1`,
        [usdPlanId],
      );
      return row ? Number(row.unit_price_minor) : 0;
    }, { timeout: 30_000 }).toBe(7550);
  }, 180_000);
});

/* ══════════════ رحلة المتصفح: الشبّاك بعملة الفاتورة ══════════════ */

describe("رحلة المتصفح: شبّاك ما بعد الزيارة بالدولار", () => {
  it("التوقيع في الشاشة ⇒ الشبّاك بالدولار ⇒ التحصيل يفتح على فاتورة اليوم بعملتها", async () => {
    await page.goto(`${baseUrl}/patients/${h.seeded.patientAId}?tab=today&visit=${browserVisitId}`);

    /* الزيارة القائمة (المزروعة أعلاه) تُعرض — ومنها إلى المراجعة والتوقيع. */
    await page.getByRole("button", { name: /مراجعة وإنهاء الزيارة/ }).waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: /مراجعة وإنهاء الزيارة/ }).click();
    const confirm = page.getByRole("button", { name: /تأكيد إنهاء الزيارة/ });
    await confirm.waitFor({ timeout: 30_000 });
    await confirm.click();

    /* فاتورة هذه الزيارة تحديدًا — لرحلة المتصفح فاتورتها لا فاتورة رحلة HTTP. */
    let browserInvoiceId = 0;
    for (let attempt = 0; attempt < 60 && browserInvoiceId === 0; attempt += 1) {
      const { rows: [visitRow] } = await db.query<{ invoice_id: number | null }>(
        `SELECT invoice_id FROM visits WHERE id = $1`, [browserVisitId],
      );
      browserInvoiceId = visitRow?.invoice_id ?? 0;
      if (browserInvoiceId === 0) await page.waitForTimeout(500);
    }
    expect(browserInvoiceId).toBeGreaterThan(0);

    /* الشبّاك يظهر: استحقاق اليوم بالدولار لا باليمني. */
    const checkout = page.locator('[aria-label="شبّاك ما بعد الزيارة"]');
    await checkout.waitFor({ timeout: 60_000 });

    /* استحقاق اليوم بعملة الفاتورة — الدولار — لا باليمني. */
    const todayDueRow = checkout.locator("div", { hasText: "استحقاق اليوم" }).last();
    await expect.poll(async () => todayDueRow.textContent(), { timeout: 10_000 }).toContain("1,500");
    expect(await todayDueRow.textContent()).toContain("$");

    /* الإجمالي المستحق مجموعٌ داخل عملة الفاتورة وحدها — موسومٌ بها، ولا
       يجمع يمنيًّا مع الدولار أبدًا. */
    const totalRow = checkout.getByText("الإجمالي المستحق (دولار)");
    await totalRow.waitFor({ timeout: 10_000 });
    const dl = checkout.locator("dl");
    const totalsText = await dl.textContent();
    expect(totalsText).toContain("الإجمالي المستحق (دولار)");

    /* والرصيد السابق سطرٌ لكل عملة — والعملات الأخرى تُعرض منفصلة موسومة،
       لا تدخل أي مجموع. */
    const otherCurrencies = checkout.getByText(/أرصدة بعملات أخرى/);
    await otherCurrencies.waitFor({ timeout: 10_000 });

    /* التحصيل يفتح مستهدفًا فاتورة اليوم نفسها وبعملتها. */
    await checkout.getByRole("button", { name: /تحصيل وطباعة السند/ }).click();
    const currencySelect = page.locator('select[aria-label="العملة"]');
    await currencySelect.waitFor({ timeout: 30_000 });
    await expect.poll(async () => currencySelect.inputValue(), { timeout: 10_000 }).toBe("USD");

    /* فاتورة اليوم هي المختارة سلفًا — لا «على الحساب». */
    const invoiceSelect = page.locator('select[aria-label="فاتورة الهدف"]');
    await invoiceSelect.waitFor({ timeout: 30_000 });
    await expect.poll(async () => invoiceSelect.inputValue(), { timeout: 10_000 }).toBe(String(browserInvoiceId));

    /* المبلغ مقترح باستحقاق اليوم بالدولار. */
    const amountInput = page.locator('input[aria-label="المبلغ"]');
    await expect.poll(async () => (await amountInput.inputValue()).replace(/,/g, ""), { timeout: 10_000 }).toBe("1500.00");

    /* التسجيل: السند يرتبط بفاتورة اليوم نفسها وبالدولار. */
    const before = await paymentCountOn(browserInvoiceId);
    await page.getByRole("button", { name: /سجّل الدفعة واطبع السند/ }).click();
    await page.locator('[aria-label="شبّاك ما بعد الزيارة"]').waitFor({ state: "detached", timeout: 60_000 })
      .catch(() => {});
    await expect.poll(async () => paymentCountOn(browserInvoiceId), { timeout: 30_000 }).toBe(before + 1);

    const { rows: [last] } = await db.query<{ currency: string; invoice_id: number | null }>(
      `SELECT currency, invoice_id FROM payments WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`,
      [browserInvoiceId],
    );
    expect(last.currency).toBe("USD");
    expect(last.invoice_id).toBe(browserInvoiceId);
  }, 300_000);
});

/* ══════════════ مساعدات ══════════════ */

async function authedJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Cookie: h.sessions.admin.cookie,
      Origin: baseUrl,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

async function planItemCount(planId: number): Promise<number> {
  const { rows: [row] } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM plan_items WHERE plan_id = $1`, [planId],
  );
  return row.n;
}

async function paymentCount(): Promise<number> {
  const { rows: [row] } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM payments WHERE patient_id = $1`, [h.seeded.patientAId],
  );
  return row.n;
}

async function paymentCountOn(invoiceId: number): Promise<number> {
  const { rows: [row] } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM payments WHERE invoice_id = $1`, [invoiceId],
  );
  return row.n;
}

async function ledgerBuckets(): Promise<{ usdCollected: number; yerCollected: number }> {
  const response = await fetch(`${baseUrl}/api/patients/${h.seeded.patientAId}/ledger`, {
    headers: { Cookie: h.sessions.admin.cookie },
    redirect: "manual",
  });
  expect(response.status).toBe(200);
  const ledger = await response.json();
  return {
    usdCollected: ledger.balances.USD.collectedMinor,
    yerCollected: ledger.balances.YER.collectedMinor,
  };
}
