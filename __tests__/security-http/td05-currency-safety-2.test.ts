import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import { baseUrl, harness } from "./_server";
import { observeOwnedFinancialReads } from "../helpers/owned-financial-read-witness";

/**
 * رحلات المتصفح للمراجعة الثانية للمالك TD-05 (PR #44) — الاستنتاجان ٦ و٧.
 *
 * الاستنتاج ٦ — الشبّاك يستعمل رصيد ما قبل التوقيع الحقيقي:
 *  الرصيد السابق كان يُعاد قراءته بعد توليد فاتورة اليوم فيحسبها مرتين
 *  (سابق ٥٠٠ دولار + فاتورة اليوم ١٥٠٠ = ٣٥٠٠ بدل ٢٠٠٠). هنا يُثبَت أن الشبّاك
 *  يحتفظ بالرصيد المرجعي من المحرك (باستثناء فاتورة الزيارة ودفعات يومها)،
 *  ويقرأ الدين الحالي مستقلاً دون جمعه ثانيةً مع فاتورة اليوم.
 *
 * الاستنتاج ٧ — المبالغ الأجنبية بعملة الاتفاق من الحمولة نفسها عند أول تحميل:
 *  ١٥٠٠٠٠ وحدة صغرى دولارية تُعرض «1500.00» لا «150000»، وتصمد بعد إعادة تحميل
 *  الصفحة، والمزيج (بند أجنبي مرتبط + بند أساسي حر) لا يعرض إجماليًّا رقميًّا
 *  واحدًا عبر العملات — مجاميع منفصلة وتحذير صريح.
 */

let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let browser: Browser;
let context: BrowserContext;
let page: Page;

const PATIENT_B_NAME = "مريض المراجعة الثانية الاصطناعي";
let privatePatientId = 0, privateDoctorId = 0, firstUsdInvoiceId = 0;
const fixtureVisitIds = new Set<number>();
const planVisitIds = new Map<string, number>();
let financialWitness: ReturnType<typeof observeOwnedFinancialReads> | undefined;

let usdServiceId = 0;
/** عنوان→معرّف الخطة التي أنشأها beforeAll — الزيارات تُبنى عند الطلب أدناه. */
const planIds = new Map<string, number>();
const USD_CHECKOUT_PLAN = "تقويم دولاري — شبّاك المراجعة الثانية";
const SAR_CHECKOUT_PLAN = "اتفاق سعودي — شبّاك المراجعة الثانية";
const YER_USD_CHECKOUT_PLAN = "تقويم دولاري — فصل العملات";
const USD_FIRSTLOAD_PLAN = "تقويم دولاري — أول تحميل";
const SAR_FIRSTLOAD_PLAN = "اتفاق سعودي — أول تحميل";
const MIXED_PREVIEW_PLAN = "تقويم دولاري — مزيج معاينة";

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(["127.0.0.1", "localhost"]).toContain(new URL(h.seeded.dbUrl).hostname);
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  // An owned patient makes NOW() the newest visit without inventing a future arrival day.
  privateDoctorId = (await db.query<{ id: number }>(
    `INSERT INTO parties (name, kind, is_active) VALUES ('طبيب المراجعة الثانية الاصطناعي', 'doctor', TRUE) RETURNING id`,
  )).rows[0].id;
  privatePatientId = (await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`OWNREV2-${Date.now()}`, PATIENT_B_NAME, privateDoctorId],
  )).rows[0].id;

  /* وردية مفتوحة وأسعار صرف — التحصيل يحتاجهما. */
  await db.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'ownrev2-http', 0, 0, 0
      WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`,
  );
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('finance.rate.USD', '530'), ('finance.rate.SAR', '140')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );

  const { rows: [service] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active)
     VALUES ('تنظيف المراجعة الثانية', 15000, TRUE) RETURNING id`,
  );
  usdServiceId = service.id;

  /* فواتير سابقة غير مسدَّدة — «الرصيد السابق» الحقيقي لما قبل التوقيع. */
  const { rows: [usdPrevious] } = await db.query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
     VALUES ('OWNREV2-PREV-USD', $1, 50000, 0, 'USD') RETURNING id`,
    [privatePatientId],
  );
  void usdPrevious;
  await db.query(
    `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
     SELECT id, 'استحقاق سابق دولاري', 1, 50000, 50000 FROM invoices WHERE id = $1`,
    [usdPrevious.id],
  );

  const { rows: [sarPrevious] } = await db.query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
     VALUES ('OWNREV2-PREV-SAR', $1, 30000, 0, 'SAR') RETURNING id`,
    [privatePatientId],
  );
  await db.query(
    `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
     SELECT id, 'استحقاق سابق سعودي', 1, 30000, 30000 FROM invoices WHERE id = $1`,
    [sarPrevious.id],
  );

  const { rows: [yerPrevious] } = await db.query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
     VALUES ('OWNREV2-PREV-YER', $1, 25000, 0, 'YER') RETURNING id`,
    [privatePatientId],
  );
  await db.query(
    `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
     SELECT id, 'استحقاق سابق يمني', 1, 25000, 25000 FROM invoices WHERE id = $1`,
    [yerPrevious.id],
  );

  /* خطط موافَق عليها — بندٌ لكل رحلة. الزيارات تُبنى عند الطلب داخل كل اختبار:
     صفحة المريض تفتح أحدث زيارةٍ مفتوحة (ORDER BY arrived_at DESC)، فلو بُنيت
     الرحلات كلها دفعةً واحدةً بتوقيتٍ واحد التقت العناوين على زيارةٍ غير
     المقصودة — زيارة كل رحلةٍ هي الأحدث لحظتها. */
  for (const [planTitle, currency] of [
    [USD_CHECKOUT_PLAN, "USD"],
    [SAR_CHECKOUT_PLAN, "SAR"],
    [YER_USD_CHECKOUT_PLAN, "USD"],
    [USD_FIRSTLOAD_PLAN, "USD"],
    [SAR_FIRSTLOAD_PLAN, "SAR"],
    [MIXED_PREVIEW_PLAN, "USD"],
  ] as [string, "USD" | "SAR"][]) {
    const { rows: [plan] } = await db.query<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date, consent_at)
       VALUES ($1, $2, 150000, $3, 'active', CURRENT_DATE, NOW()) RETURNING id`,
      [privatePatientId, planTitle, currency],
    );
    const { rows: [item] } = await db.query<{ id: number }>(
      `INSERT INTO plan_items (plan_id, service_id, service_name, category, quantity, unit_price_minor, billing_rule, session_count, status)
       VALUES ($1, $2, 'تنظيف المراجعة الثانية', 'cleaning', 1, 150000, 'on_completion', 1, 'planned') RETURNING id`,
      [plan.id, usdServiceId],
    );
    planIds.set(planTitle, item.id);
  }

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
  page = await context.newPage();
  financialWitness = observeOwnedFinancialReads(page, request => {
    const url = new URL(request.url());
    if (url.origin !== baseUrl) return null;
    if (request.method() === "GET" && url.pathname === `/api/patients/${privatePatientId}/workflow`) {
      return { kind: "workflow", patientId: privatePatientId };
    }
    const matched = /^\/api\/visits\/(\d+)\/walkout$/.exec(url.pathname);
    if (request.method() === "GET" && matched && fixtureVisitIds.has(Number(matched[1]))) {
      return { kind: "walkout", patientId: privatePatientId, visitId: Number(matched[1]) };
    }
    if (request.method() === "POST" && url.pathname === "/api/payments") {
      try {
        if (request.postDataJSON()?.patientId === privatePatientId) return { kind: "payment", patientId: privatePatientId };
      } catch { /* Non-fixture/non-JSON requests are outside this witness. */ }
    }
    return null;
  });
}, 240_000);

afterEach(({ task }) => {
  if (task.result?.state === "fail") console.info("[td05-owned-financial-read]", JSON.stringify(financialWitness?.snapshot() ?? []));
});

afterAll(async () => {
  financialWitness?.stop();
  await browser?.close();
  if (db) {
    await db.query(`DELETE FROM payments WHERE patient_id = $1`, [privatePatientId]).catch(() => {});
    await db.query(`DELETE FROM invoices WHERE patient_id = $1`, [privatePatientId]).catch(() => {});
    await db.query(
      `DELETE FROM visit_procedures WHERE visit_id = ANY (SELECT id FROM visits WHERE patient_id = $1)`,
      [privatePatientId],
    ).catch(() => {});
    await db.query(`DELETE FROM visits WHERE patient_id = $1`, [privatePatientId]).catch(() => {});
    await db.query(
      `DELETE FROM plan_items WHERE plan_id = ANY (SELECT id FROM treatment_plans WHERE patient_id = $1)`,
      [privatePatientId],
    ).catch(() => {});
    await db.query(`DELETE FROM treatment_plans WHERE patient_id = $1`, [privatePatientId]).catch(() => {});
    await db.query(`DELETE FROM services WHERE id = $1`, [usdServiceId]).catch(() => {});
    await db.end();
  }
});

// Positive readiness evidence: absence of an error banner is not verified money.
async function verifiedCheckout(checkout: Locator): Promise<void> {
  await checkout.waitFor({ timeout: 60_000 });
  await expect.poll(() => checkout.getAttribute("data-financial-state"), { timeout: 30_000 }).toBe("verified");
}
function moneyRow(checkout: Locator, kind: "previous-balance" | "current-balance" | "visit-invoice", currency: "YER" | "SAR" | "USD") {
  return checkout.locator(`[data-testid="checkout-${kind}"][data-currency="${currency}"]`);
}
async function exactMoney(checkout: Locator, kind: "previous-balance" | "current-balance" | "visit-invoice", currency: "YER" | "SAR" | "USD", displayed: string) {
  const row = moneyRow(checkout, kind, currency);
  await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await row.textContent())?.match(/-?\d[\d,]*(?:\.\d+)?/g), { timeout: 30_000 }).toEqual([displayed]);
  const symbol = currency === "USD" ? "$" : currency === "SAR" ? "ر.س" : "ر.ي";
  expect(await row.textContent()).toContain(symbol);
}

/* Same canonical prior/current basis as immediate sign, reopen and print. */

describe("المراجعة الثانية ٦: شبّاك الدولار — سابق ٥٠٠ + اليوم ١٥٠٠ = ٢٠٠٠ لا ٣٥٠٠", () => {
  it("التوقيع ⇒ السابق ٥٠٠ واليوم ١٥٠٠ والإجمالي ٢٠٠٠ — والرقم ٣٥٠٠ لا وجود له", async () => {
    const usdCheckoutVisitId = await linkedVisit(USD_CHECKOUT_PLAN);
    await signVisit(usdCheckoutVisitId);

    const checkout = page.locator('[aria-label="شبّاك ما بعد الزيارة"]');
    await verifiedCheckout(checkout);

    /* المرجع باستثناء فاتورة هذه الزيارة ودفعات يومها: ٥٠٠ دولار. */
    const previousRow = moneyRow(checkout, "previous-balance", "USD");
    await expect.poll(async () => previousRow.textContent(), { timeout: 20_000 }).toContain("500.00");
    expect(await previousRow.textContent()).toContain("$");
    expect(await previousRow.textContent()).not.toContain("2,000");
    expect(await previousRow.textContent()).not.toContain("1,500");

    /* استحقاق اليوم بعملة فاتورتها: ١٥٠٠ دولار. */
    const todayRow = moneyRow(checkout, "visit-invoice", "USD");
    await expect.poll(async () => todayRow.textContent(), { timeout: 20_000 }).toContain("1,500.00");

    /* الإجمالي مجموعٌ داخل الدولار وحده: ٢٠٠٠ لا ٣٥٠٠ أبدًا. */
    const totalRow = moneyRow(checkout, "current-balance", "USD");
    await totalRow.waitFor({ timeout: 20_000 });
    const totalText = await totalRow.textContent();
    expect(totalText).toContain("2,000.00");
    expect(totalText).not.toContain("3,500");

    /* وباب الشبّاك كله لا يحوي الرقم المزدوج. */
    const allText = await checkout.locator("dl").textContent();
    expect(allText).not.toContain("3,500");
  }, 300_000);

  it("بعد التحصيل: السابق المرجعي ٥٠٠ والحالي صفر دولار والرقم ٣٥٠٠ مستحيل", async () => {
    /* تُستأنف الرحلة من زيارة الاختبار السابق — فاتورتها سُجلت وفحصت هناك. */
    const { rows: [todayInvoice] } = await db.query<{ invoice_id: number }>(
      `SELECT invoice_id FROM visits WHERE patient_id = $1 AND invoice_id IS NOT NULL
        ORDER BY id DESC LIMIT 1`, [privatePatientId],
    );
    expect(todayInvoice?.invoice_id).toBeTruthy();
    firstUsdInvoiceId = todayInvoice.invoice_id;

    const checkout = page.locator('[aria-label="شبّاك ما بعد الزيارة"]');
    await checkout.getByRole("button", { name: /تحصيل وطباعة السند/ }).click();

    const amountInput = page.locator('input[aria-label="المبلغ"]');
    await amountInput.waitFor({ timeout: 30_000 });
    /* ننتظر قيمة الاقتراح أولًا (١٥٠٠) حتى لا تسبق تعبئتُنا أثر التهيئة
       فتُمسح — ثم نكتب السداد الكامل ٢٠٠٠. */
    await expect.poll(async () => amountInput.inputValue(), { timeout: 30_000 }).toBe("1,500.00");
    await amountInput.fill("2000");
    await expect.poll(async () => amountInput.inputValue(), { timeout: 10_000 }).toBe("2000");

    /* TD-REG-025: نعطي أي إعادة-render متأخرة فرصةً للوقوع؛ المبلغ اليدوي يجب
       أن يبقى 2000 ولا يعود إلى اقتراح 1500 مهما تحدّث الأب أثناء فتح النافذة. */
    await page.waitForTimeout(750);
    expect(await amountInput.inputValue()).toBe("2000");

    const before = await paymentCountOn(todayInvoice.invoice_id);
    await page.getByRole("button", { name: /سجّل الدفعة واطبع السند/ }).click();

    /* السند يُسجَّل على فاتورة اليوم بالدولار. */
    await expect.poll(async () => paymentCountOn(todayInvoice.invoice_id), { timeout: 60_000 }).toBe(before + 1);

    /* TD-REG-025 — الحسم من السجل نفسه: 2000.00 USD = 200000 وحدة صغرى.
       لا يكفي أن يبدو الرصيد صحيحًا في الواجهة؛ نثبت أن ما حُفظ هو ما كتبه
       المحصّل، وليس suggestedMinor=1500.00 الذي كان يظهر في الفشل المتقطع. */
    await expect.poll(async () => {
      const payment = await latestPaymentOn(todayInvoice.invoice_id);
      return payment ? `${payment.amountMinor}:${payment.currency}` : null;
    }, { timeout: 60_000 }).toBe("200000:USD");

    await assertReceiptArrivalDay(planVisitIds.get(USD_CHECKOUT_PLAN)!, todayInvoice.invoice_id);

    /* Previous reference remains 500; canonical current USD debt is now zero, not frozen 2000. */
    await verifiedCheckout(checkout);
    const previousRow = moneyRow(checkout, "previous-balance", "USD");
    await expect.poll(async () => previousRow.textContent(), { timeout: 30_000 }).toContain("500.00");
    await exactMoney(checkout, "current-balance", "USD", "0.00");
    expect(await moneyRow(checkout, "current-balance", "USD").textContent()).not.toContain("2,000.00");

    // The USD payment cannot settle the independent YER/SAR fixture debts.
    await exactMoney(checkout, "current-balance", "YER", "25,000");
    await exactMoney(checkout, "current-balance", "SAR", "300.00");

    /* ولا يزال ٣٥٠٠ مستحيلًا في الشبّاك كله. */
    const allText = await checkout.locator("dl").textContent();
    expect(allText).not.toContain("3,500");
  }, 300_000);
});

describe("المراجعة الثانية ٦: شبّاك السعودي — سابق ٣٠٠ + اليوم ١٥٠٠ = ١٨٠٠", () => {
  it("التوقيع ⇒ السابق ٣٠٠ بالسعودي والإجمالي ١٨٠٠ ر.س", async () => {
    const sarCheckoutVisitId = await linkedVisit(SAR_CHECKOUT_PLAN);
    await signVisit(sarCheckoutVisitId);

    const checkout = page.locator('[aria-label="شبّاك ما بعد الزيارة"]');
    await verifiedCheckout(checkout);

    const previousRow = moneyRow(checkout, "previous-balance", "SAR");
    await expect.poll(async () => previousRow.textContent(), { timeout: 20_000 }).toContain("300.00");
    expect(await previousRow.textContent()).toContain("ر.س");

    const totalRow = moneyRow(checkout, "current-balance", "SAR");
    await totalRow.waitFor({ timeout: 20_000 });
    const totalText = await totalRow.textContent();
    expect(totalText).toContain("1,800.00");
    expect(totalText).not.toContain("3,300");
  }, 300_000);
});

describe("المراجعة الثانية ٦: سابق يمني + اليوم دولاري — عملتان منفصلتان لا مجموع واحد", () => {
  it("التوقيع ⇒ السابق باليمني سطره، واليوم بالدولار سطره، ولا إجمالي عبر العملتين", async () => {
    const yerUsdCheckoutVisitId = await linkedVisit(YER_USD_CHECKOUT_PLAN);
    await assertReceiptArrivalDay(yerUsdCheckoutVisitId, firstUsdInvoiceId);
    await signVisit(yerUsdCheckoutVisitId);

    const checkout = page.locator('[aria-label="شبّاك ما بعد الزيارة"]');
    await verifiedCheckout(checkout);

    /* الرصيد السابق باليمني وحده — لا يُحوَّل ولا يُجمع مع الدولار. */
    const previousRow = moneyRow(checkout, "previous-balance", "YER");
    await expect.poll(async () => previousRow.textContent(), { timeout: 20_000 }).toContain("25,000");
    expect(await previousRow.textContent()).toContain("ر.ي");

    /* استحقاق اليوم بالدولار. */
    const todayRow = moneyRow(checkout, "visit-invoice", "USD");
    await expect.poll(async () => todayRow.textContent(), { timeout: 20_000 }).toContain("1,500.00");
    expect(await todayRow.textContent()).toContain("$");

    // Earlier USD 500 + its 1500 invoice remain in the prior reference because
    // the canonical reader excludes all payments on this arrival day.
    // Current debt includes the actual 2000 USD receipt: only this new 1500 remains.
    await exactMoney(checkout, "previous-balance", "USD", "2,000.00");
    await exactMoney(checkout, "current-balance", "USD", "1,500.00");
    await exactMoney(checkout, "current-balance", "YER", "25,000");
    await exactMoney(checkout, "current-balance", "SAR", "1,800.00");

    /* واليمني يظهر في العملات الأخرى المنفصلة لا في أي مجموع. */
    const otherCurrencies = checkout.getByText(/أرصدة بعملات أخرى/);
    await otherCurrencies.waitFor({ timeout: 20_000 });

    /* ولا رقمٌ يجمع الدولار باليمني في الشبّاك كله. */
    const allText = await checkout.locator("dl").textContent();
    expect(allText).not.toContain("3,000");
  }, 300_000);
});

/* ══════════════ الاستنتاج ٧: أول تحميل بعملة الاتفاق ══════════════ */

describe("المراجعة الثانية ٧: أول تحميل — ١٥٠٠٠٠ وحدة صغرى دولارية = «1500.00»", () => {
  it("حقل سعر البند المرتبط يعرض 1500.00 من الحمولة الأولى — لا 150000", async () => {
    const usdFirstLoadVisitId = await linkedVisit(USD_FIRSTLOAD_PLAN);
    await page.goto(`${baseUrl}/patients/${privatePatientId}?tab=today&visit=${usdFirstLoadVisitId}`);
    const priceInput = page.locator('input[aria-label="السعر"]').first();
    await priceInput.waitFor({ timeout: 60_000 });
    await expect.poll(async () => priceInput.inputValue(), { timeout: 20_000 }).toBe("1,500.00");
  }, 180_000);

  it("إعادة تحميل الصفحة ⇒ الرقم نفسه 1500.00 يصمد — لا تفسير بالأساس بعد التحديث", async () => {
    await page.reload();
    const priceInput = page.locator('input[aria-label="السعر"]').first();
    await priceInput.waitFor({ timeout: 60_000 });
    await expect.poll(async () => priceInput.inputValue(), { timeout: 20_000 }).toBe("1,500.00");
  }, 180_000);
});

describe("المراجعة الثانية ٧: أول تحميل بالسعودي — ١٥٠٠٠٠ وحدة صغرى = «1500.00» ر.س", () => {
  it("حقل السعر يعرض 1500.00 بعملة الاتفاق السعودي من الحمولة الأولى", async () => {
    const sarFirstLoadVisitId = await linkedVisit(SAR_FIRSTLOAD_PLAN);
    await page.goto(`${baseUrl}/patients/${privatePatientId}?tab=today&visit=${sarFirstLoadVisitId}`);
    const priceInput = page.locator('input[aria-label="السعر"]').first();
    await priceInput.waitFor({ timeout: 60_000 });
    await expect.poll(async () => priceInput.inputValue(), { timeout: 20_000 }).toBe("1,500.00");
  }, 180_000);
});

describe("المراجعة الثانية ٧: مزيج بندٍ أجنبي مرتبط + بندٍ أساسي حر — لا إجمالي رقمي واحد", () => {
  it("رأس الإجراءات يعرض مجموعين منفصلين وتحذير عملتين — لا 1,650.00 مجمَّعة", async () => {
    const mixedPreviewVisitId = await linkedVisit(MIXED_PREVIEW_PLAN, true);
    await page.goto(`${baseUrl}/patients/${privatePatientId}?tab=today&visit=${mixedPreviewVisitId}`);

    const procedures = page.locator('section#visit-procedures[aria-label="قائمة عمل الزيارة"]');
    await procedures.waitFor({ timeout: 60_000 });

    /* المجموعان المنفصلان: ١٥٠٠ دولار و١٥٠٠٠ يمني — كلٌّ بعملته. */
    const subtotals = procedures.locator('[data-testid="currency-subtotals"]');
    await subtotals.waitFor({ timeout: 30_000 });
    const subtotalsText = await subtotals.textContent();
    expect(subtotalsText).toContain("1,500.00");
    expect(subtotalsText).toContain("$");
    expect(subtotalsText).toContain("15,000");
    expect(subtotalsText).toContain("ر.ي");

    /* تحذير المزيج صريح في الشاشة — رفض الخادم وحده لا يكفي. */
    const warning = procedures.locator('[data-testid="mixed-currency-warning"]');
    await warning.waitFor({ timeout: 30_000 });

    /* ولا إجماليًّا رقميًّا واحدًا عبر العملتين في الرأس: ١٦٥٠٠٠ لا وجود له. */
    const headerText = await procedures.textContent();
    expect(headerText).not.toContain("1,650");
  }, 180_000);
});

/* ══════════════ مساعدات ══════════════ */

/** زيارةٌ مربوطة ببند خطة — تُبنى لحظة الحاجة فتكون أحدث زيارةٍ مفتوحة
    للمريض (الصفحة تفتح الأحدث)، وبإجراءٍ حرٍّ بالأساس إن طُلب للمزيج. */
async function linkedVisit(planTitle: string, extraUnlinked = false): Promise<number> {
  const itemId = planIds.get(planTitle);
  if (!itemId) throw new Error(`خطة «${planTitle}» غير مهيأة`);
  const { rows: [visit] } = await db.query<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, status, arrived_at, doctor_id)
     VALUES ($1, $2, 'waiting', NOW(), $3) RETURNING id`,
    [PATIENT_B_NAME, privatePatientId, privateDoctorId],
  );
  await db.query(
    `INSERT INTO visit_procedures (visit_id, service_id, plan_item_id, quantity, unit_price_minor)
     VALUES ($1, $2, $3, 1, 150000)`,
    [visit.id, usdServiceId, itemId],
  );
  if (extraUnlinked) {
    await db.query(
      `INSERT INTO visit_procedures (visit_id, service_id, plan_item_id, quantity, unit_price_minor)
       VALUES ($1, $2, NULL, 1, 15000)`,
      [visit.id, usdServiceId],
    );
  }
  fixtureVisitIds.add(visit.id);
  planVisitIds.set(planTitle, visit.id);
  return visit.id;
}

async function signVisit(visitId: number): Promise<void> {
  await page.goto(`${baseUrl}/patients/${privatePatientId}?tab=today&visit=${visitId}`);
  await page.getByRole("button", { name: /مراجعة وإنهاء الزيارة/ }).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: /مراجعة وإنهاء الزيارة/ }).click();
  const confirm = page.getByRole("button", { name: /تأكيد إنهاء الزيارة|وقّع الزيارة/ });
  await confirm.waitFor({ timeout: 30_000 });
  await confirm.click();
  const checkout = page.locator('[aria-label="شبّاك ما بعد الزيارة"]');
  try {
    await checkout.waitFor({ timeout: 25_000 });
    await expect.poll(() => checkout.getAttribute("data-visit-id")).toBe(String(visitId));
  } catch {
    const alert = await page.locator('p[role="alert"]').allTextContents().catch(() => ["<no alert>"]);
    const { rows } = await db.query(`SELECT id, status, signed_at, invoice_id FROM visits WHERE id = $1`, [visitId]);
    const { rows: procs } = await db.query(
      `SELECT vp.id, vp.plan_item_id, vp.unit_price_minor, t.base_currency, t.id AS plan_id
         FROM visit_procedures vp
         LEFT JOIN plan_items i ON i.id = vp.plan_item_id
         LEFT JOIN treatment_plans t ON t.id = i.plan_id
        WHERE vp.visit_id = $1`, [visitId]);
    console.log("SIGN DEBUG visit:", JSON.stringify(rows), "alerts:", JSON.stringify(alert), "procs:", JSON.stringify(procs));
    throw new Error(`sign failed: ${JSON.stringify(rows)} alerts=${JSON.stringify(alert)}`);
  }
}

async function paymentCountOn(invoiceId: number): Promise<number> {
  const { rows: [row] } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM payments WHERE invoice_id = $1`, [invoiceId],
  );
  return row.n;
}

async function latestPaymentOn(invoiceId: number): Promise<{ amountMinor: number; currency: string } | null> {
  const { rows: [row] } = await db.query<{ amount_minor: string; currency: string }>(
    `SELECT amount_minor::text, currency
       FROM payments
      WHERE invoice_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [invoiceId],
  );
  return row
    ? { amountMinor: Number(row.amount_minor), currency: row.currency }
    : null;
}


/** The expected prior excludes arrival-day receipts. Detect a natural midnight crossing
 * explicitly; never rewrite a posted receipt date or pretend a different day is the same.
 */
async function assertReceiptArrivalDay(visitId: number, invoiceId: number): Promise<void> {
  const { rows: [day] } = await db.query<{ arrival_day: string; receipt_day: string }>(
    `SELECT (v.arrived_at AT TIME ZONE $4)::date::text AS arrival_day,
            (p.created_at AT TIME ZONE $4)::date::text AS receipt_day
       FROM visits v JOIN payments p ON p.patient_id = v.patient_id
      WHERE v.id = $1 AND v.patient_id = $2 AND p.invoice_id = $3
      ORDER BY p.id DESC LIMIT 1`,
    [visitId, privatePatientId, invoiceId, process.env.CLINIC_TIME_ZONE || "Asia/Aden"],
  );
  expect(day, "owned receipt and visit must exist").toBeDefined();
  expect(day.receipt_day, "same-clinic-day fixture premise; midnight is not an accounting failure").toBe(day.arrival_day);
}
