import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * رحلات المتصفح للتصحيحات النهائية للمالك TD-05 (PR #44) — الحافتان الأخيرتان.
 *
 *  **الاستنتاج أ (النهائي) — تصفير حالة الزيارة عند زيارةٍ جديدة:**
 *  مكوّن تبويب «زيارة اليوم» يبقى محمّلًا والمريض نفسه يبدأ زيارةً ثانية بعد أن
 *  وقّعت الأولى وحُصّلت. بلا تصفيرٍ مرتبط بمعرّف الزيارة الجديدة ترث الزيارة
 *  الثانية شبّاك الأولى: لقطة رصيدها المجمّدة، وstate التحصيل، وفاتورتها.
 *  هنا تُثبَت الرحلة الكاملة: زيارة أ ← توقيع ← تحصيل جزئي ← زيارة ب بلا مغادرة
 *  الشاشة ← لقطة ما قبل توقيعٍ جديدة لب، وشبّاكها لها وحدها، وزرّ التحصيل عائد.
 *  والتصفير لا يقع لمجرّد أن الزيارة الأولى صارت null بعد توقيعها — شبّاكها
 *  يبقى مرئيًا حتى نهاية المسار الطبيعي.
 *
 *  **الاستنتاج ب (النهائي) — العملة ملك البند لا الزيارة:**
 *  زيارةٌ فارغة لا تعرف عملة بند الخطة الدولاري/السعودي الذي يُضاف من «مخطَّط
 *  لليوم»: كان السعر المقترح يُنسَّق بالأساس «150,000» بدل «1,500.00». الآن
 *  كل بندٍ يُنسَّق بعملة خطته لحظة الإضافة، ويصمد بعد الحفظ وإعادة التحميل،
 *  والمزيج (دولاري + سعودي) مجموعان منفصلان وتحذير صريح — لا أساس أبدًا ولا
 *  إجمالي رقمي واحد — ورفض الخادم (mixed_plan_currencies) يبقى حارسًا ذا
 *  fail-closed بلا فاتورة ولا أثر مالي جزئي.
 */

let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let browser: Browser;
let context: BrowserContext;
let page: Page;

let serviceId = 0;
/** عنوان الخطة → معرّف بندها. الزيارات تُبنى عند الطلب أدناه. */
const planItemIds = new Map<string, number>();
const USD_EMPTY_PLAN = "اتفاق دولاري — إضافة على زيارة فارغة";
const SAR_EMPTY_PLAN = "اتفاق سعودي — إضافة على زيارة فارغة";
const USD_MIX_PLAN = "اتفاق دولاري — مزيج نهائي";
const SAR_MIX_PLAN = "اتفاق سعودي — مزيج نهائي";
const USD_SEQ_A_PLAN = "اتفاق دولاري — الزيارة المتتالية أ";
const USD_SEQ_B_PLAN = "اتفاق دولاري — الزيارة المتتالية ب";

/** زيارة مزيج العملات — تُنشأ في الاختبار د ويُفحص توقيعها المرفوض بعده. */
let mixedVisitId = 0;

/** عدّادٌ تنازلي للطوابع — كل زيارةٍ تُبنى بترقيمٍ أحدث، والزيارة التي يبدؤها
    المستخدم من الشاشة (بلا إزاحة) تصبح الأحدث جميعًا. */
let visitClock = 0;

/* مريضنا الخاص لرحلات هذا الملف وحده: قاعدة الجولة واحدة مشتركة بين ملفات
   الاختبار كلها، وسجل الدفعات append-only بمفتاح قاعدة البيانات (لا حذف
   عاديًا إطلاقًا) — فأي مريض مشترك يرث أرصدة الملفات الأدنى ترتيبًا ولا
   يُضمن. مريضُنا يُبنى هنا نظيفًا أينما وقعنا في ترتيب التشغيل. */
const PRIVATE_PATIENT_NAME = "مريض التصحيحات النهائية";
let privatePatientId = 0;

/**
 * تنظيف طبقة الزيارات من ملف مريضنا الخاص — بترتيبٍ يحترم مفاتيح القاعدة
 * (sessions/documents/ortho/diagnoses/tooth → procedures → visits؛ والخطط
 * وبنودها في التفكيك النهائي). الفواتير تبقى: سجل الدفعات append-only
 * بمفتاح القاعدة، وفاتورة الزيارة الموقَّعة مرتبطة بسندها — وكلاهما على
 * مريضنا الخاص فلا يقرأهما أحد بعدنا أبدًا.
 */
async function cleanPrivatePatient(withPlans = false): Promise<void> {
  const patientId = privatePatientId;
  await db.query(
    `DELETE FROM treatment_sessions WHERE visit_id = ANY (SELECT id FROM visits WHERE patient_id = $1)`,
    [patientId],
  );
  await db.query(
    `DELETE FROM patient_documents WHERE visit_id = ANY (SELECT id FROM visits WHERE patient_id = $1)`,
    [patientId],
  );
  await db.query(
    `DELETE FROM ortho_adjustments WHERE visit_id = ANY (SELECT id FROM visits WHERE patient_id = $1)`,
    [patientId],
  );
  await db.query(
    `DELETE FROM patient_diagnoses WHERE visit_id = ANY (SELECT id FROM visits WHERE patient_id = $1)`,
    [patientId],
  );
  await db.query(
    `DELETE FROM tooth_conditions WHERE visit_id = ANY (SELECT id FROM visits WHERE patient_id = $1)`,
    [patientId],
  );
  await db.query(
    `DELETE FROM visit_procedures WHERE visit_id = ANY (SELECT id FROM visits WHERE patient_id = $1)`,
    [patientId],
  );
  /* إنجاز البند يوصم زيارته (وكذلك مسار حذف الزيارة في التطبيق نفسه) — فيُأبطل قبل حذف الزيارات. */
  await db.query(
    `UPDATE plan_items SET visit_id = NULL WHERE visit_id = ANY (SELECT id FROM visits WHERE patient_id = $1)`,
    [patientId],
  );
  await db.query(`DELETE FROM visits WHERE patient_id = $1`, [patientId]);
  if (!withPlans) return;
  await db.query(
    `DELETE FROM plan_items WHERE plan_id = ANY (SELECT id FROM treatment_plans WHERE patient_id = $1)`,
    [patientId],
  );
  await db.query(`DELETE FROM treatment_plans WHERE patient_id = $1`, [patientId]);
}

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();

  /* مريضنا الخاص: يُبنى هنا ولا يمسه غيرنا — فلا يحتاج تنطيفًا أصلًا. */
  const { rows: [privatePatient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, phone)
     VALUES ('FINALRV-P3', $1, '777199003') RETURNING id`,
    [PRIVATE_PATIENT_NAME],
  );
  privatePatientId = privatePatient.id;

  /* وردية مفتوحة وأسعار صرف — التحصيل يحتاجهما. */
  await db.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'finalrv-http', 0, 0, 0
      WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`,
  );
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('finance.rate.USD', '530'), ('finance.rate.SAR', '140')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );

  const { rows: [service] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active)
     VALUES ('تنظيف التصحيحات النهائية', 15000, TRUE) RETURNING id`,
  );
  serviceId = service.id;

  /* رصيد سابق دولاري ٥٠٠$ — يميّز لقطة ما قبل توقيع الزيارة ب عن لقطة أ. */
  const { rows: [usdPrevious] } = await db.query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
     VALUES ('FINALRV-PREV-USD', $1, 50000, 0, 'USD') RETURNING id`,
    [privatePatientId],
  );
  await db.query(
    `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
     SELECT id, 'استحقاق سابق دولاري نهائي', 1, 50000, 50000 FROM invoices WHERE id = $1`,
    [usdPrevious.id],
  );

  /* خطط موافَق عليها بعملاتها — لكل رحلةٍ خطتها فلا تتقاطع البنود. */
  for (const [planTitle, currency, unitMinor] of [
    [USD_EMPTY_PLAN, "USD", 150000],
    [SAR_EMPTY_PLAN, "SAR", 150000],
    [USD_MIX_PLAN, "USD", 150000],
    [SAR_MIX_PLAN, "SAR", 90000],
    [USD_SEQ_A_PLAN, "USD", 150000],
    [USD_SEQ_B_PLAN, "USD", 150000],
  ] as [string, "USD" | "SAR", number][]) {
    const { rows: [plan] } = await db.query<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date, consent_at)
       VALUES ($1, $2, $3, $4, 'active', CURRENT_DATE, NOW()) RETURNING id`,
      [privatePatientId, planTitle, unitMinor, currency],
    );
    const { rows: [item] } = await db.query<{ id: number }>(
      `INSERT INTO plan_items (plan_id, service_id, service_name, category, quantity, unit_price_minor, billing_rule, session_count, status)
       VALUES ($1, $2, 'تنظيف التصحيحات النهائية', 'cleaning', 1, $3, 'on_completion', 1, 'planned') RETURNING id`,
      [plan.id, serviceId, unitMinor],
    );
    planItemIds.set(planTitle, item.id);
  }

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
    /* تفكيك كامل بترتيبٍ يحترم المفاتيح — بلا حذف مدفوعات (append-only بحكم
       القاعدة) ولا فواتير مربوطة بسند: كلاهما على مريضنا الخاص فلا يقرأهما
       أحد بعدنا. */
    await cleanPrivatePatient(true);
    await db.query(`DELETE FROM services WHERE id = $1`, [serviceId]).catch(() => {});
    await db.end();
  }
});

/* ══════════════ الاختبار أ: زيارة فارغة + بند دولاري ══════════════ */

describe("النهائية أ: زيارة فارغة + بند خطة دولاري — 150000 وحدة صغرى = «1,500.00» دولارًا", () => {
  it("«+ نفّذ اليوم» يضيف السطر بعملة بنده فورًا — لا تنسيقًا بالأساس", async () => {
    const visitId = await emptyVisit();
    await page.goto(`${baseUrl}/patients/${privatePatientId}?tab=today&visit=${visitId}`);

    /* قسم «مخطَّط لهذا المريض» يعرض بند الخطة الدولارية — بند خطته هو. */
    const planned = page.locator('section[aria-label="مخطَّط لليوم"]');
    await planned.waitFor({ timeout: 60_000 });
    await planned.locator("li", { hasText: USD_EMPTY_PLAN }).getByRole("button", { name: /نفّذ اليوم/ }).click();

    /* حقل السعر لحظة الإضافة: ١٥٠٠ دولارًا بعملة الاتفاق — لا «150,000» بالأساس. */
    const priceInput = page.locator('input[aria-label="السعر"]').first();
    await priceInput.waitFor({ timeout: 30_000 });
    await expect.poll(async () => priceInput.inputValue(), { timeout: 20_000 }).toBe("1,500.00");

    /* والإجمالي بعملة البند نفسها — لا سطر يمني ولا رقمٍ خام. */
    const procedures = page.locator('section[aria-label="الإجراءات المنفَّذة"]');
    const headerTotal = procedures.locator("h3").locator("..").locator("span").filter({ hasText: /\d/ }).first();
    await expect.poll(async () => headerTotal.textContent(), { timeout: 20_000 }).toContain("1,500.00");
    expect(await headerTotal.textContent()).toContain("$");
    /* لا تفسيرًا بالأساس أبدًا: الرقم الخام «150,000» مستحيل في قائمة
       السطور — أسعار الدليل تُعرض بالأساس دائمًا فلا تُفحص على القسم كله. */
    expect(await procedures.locator("ul").textContent()).not.toContain("150,000");
  }, 240_000);

  it("الحفظ ثم إعادة التحميل — القيمة والعملة كما هما تمامًا", async () => {
    /* السطر المضاف أعلاه ما زال مسوّدةً غير محفوظة — احفظه ثم أعد تحميل الصفحة. */
    await page.getByRole("button", { name: /احفظ بلا توقيع/ }).click();

    /* الحفظ يمر بالخادم: يملك سعر السطر المرتبط من الخطة — انتظر إعادة القراءة. */
    const procedures = page.locator('section[aria-label="الإجراءات المنفَّذة"]');
    await expect
      .poll(async () => procedures.locator('input[aria-label="السعر"]').count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(async () => procedures.locator('input[aria-label="السعر"]').first().inputValue(), { timeout: 30_000 })
      .toBe("1,500.00");

    /* إعادة التحميل الكاملة: العملة تُقرأ من بند السطر نفسه بعد الولادة من جديد. */
    await page.reload();
    const priceInput = page.locator('input[aria-label="السعر"]').first();
    await priceInput.waitFor({ timeout: 60_000 });
    await expect.poll(async () => priceInput.inputValue(), { timeout: 20_000 }).toBe("1,500.00");
    const headerTotal = procedures.locator("h3").locator("..").locator("span").filter({ hasText: /\d/ }).first();
    await expect.poll(async () => headerTotal.textContent(), { timeout: 20_000 }).toContain("1,500.00");
    expect(await procedures.locator("ul").textContent()).not.toContain("150,000");

    /* وفي القاعدة: السطر مخزَّن ببنده ووحداته الصغرى كما للخطة — لا تضخّم. */
    const { rows: [row] } = await db.query<{ unit_price_minor: string; plan_item_id: number }>(
      `SELECT unit_price_minor, plan_item_id FROM visit_procedures
        WHERE plan_item_id = $1 ORDER BY id DESC LIMIT 1`,
      [planItemIds.get(USD_EMPTY_PLAN)],
    );
    expect(Number(row.unit_price_minor)).toBe(150000);
    expect(row.plan_item_id).toBe(planItemIds.get(USD_EMPTY_PLAN));
  }, 240_000);
});

/* ══════════════ الاختبار ب: زيارة فارغة + بند سعودي ══════════════ */

describe("النهائية ب: زيارة فارغة + بند خطة سعودي — «1,500.00» ر.س لا «150,000»", () => {
  it("«+ نفّذ اليوم» بعملة الاتفاق السعودي فورًا، وتصمد بعد إعادة التحميل", async () => {
    const visitId = await emptyVisit();
    await page.goto(`${baseUrl}/patients/${privatePatientId}?tab=today&visit=${visitId}`);

    const planned = page.locator('section[aria-label="مخطَّط لليوم"]');
    await planned.waitFor({ timeout: 60_000 });
    await planned.locator("li", { hasText: SAR_EMPTY_PLAN }).getByRole("button", { name: /نفّذ اليوم/ }).click();

    const priceInput = page.locator('input[aria-label="السعر"]').first();
    await priceInput.waitFor({ timeout: 30_000 });
    await expect.poll(async () => priceInput.inputValue(), { timeout: 20_000 }).toBe("1,500.00");

    const procedures = page.locator('section[aria-label="الإجراءات المنفَّذة"]');
    const headerTotal = procedures.locator("h3").locator("..").locator("span").filter({ hasText: /\d/ }).first();
    await expect.poll(async () => headerTotal.textContent(), { timeout: 20_000 }).toContain("1,500.00");
    expect(await headerTotal.textContent()).toContain("ر.س");
    expect(await procedures.locator("ul").textContent()).not.toContain("150,000");

    /* وإعادة التحميل لا تفسّر السطر السعودي بالأساس — يُحفَظ أولًا (المسوّدة
       كائنٌ في الشاشة وحدها) ثم يُعاد تحميلها من القاعدة بعملة بندها. */
    await page.getByRole("button", { name: /احفظ بلا توقيع/ }).click();
    await expect
      .poll(async () => procedures.locator('input[aria-label="السعر"]').first().inputValue(), { timeout: 30_000 })
      .toBe("1,500.00");
    await page.reload();
    await priceInput.waitFor({ timeout: 60_000 });
    await expect.poll(async () => priceInput.inputValue(), { timeout: 20_000 }).toBe("1,500.00");
    expect(await procedures.locator("ul").textContent()).not.toContain("150,000");
  }, 240_000);
});

/* ══════════════ الاختبار د: مزيج عملات خطتين ══════════════ */

describe("النهائية د: بند دولاري + بند سعودي — مجموعان بعملتيهما وتحذير، والتوقيع يُرفض ذا fail-closed", () => {
  it("المعاينة: مجموع دولارٍ ومجموع سعودي وتحذير صريح — لا يمني ولا إجماليًا واحدًا", async () => {
    mixedVisitId = await mixedLinkedVisit();
    await page.goto(`${baseUrl}/patients/${privatePatientId}?tab=today&visit=${mixedVisitId}`);

    const procedures = page.locator('section[aria-label="الإجراءات المنفَّذة"]');
    await procedures.waitFor({ timeout: 60_000 });

    /* المجموعان المنفصلان: ١٥٠٠ دولارًا و٩٠٠ سعوديًا — كلٌّ بعملته. */
    const subtotals = procedures.locator('[data-testid="currency-subtotals"]');
    await subtotals.waitFor({ timeout: 30_000 });
    const subtotalsText = await subtotals.textContent();
    expect(subtotalsText).toContain("1,500.00");
    expect(subtotalsText).toContain("$");
    expect(subtotalsText).toContain("900.00");
    expect(subtotalsText).toContain("ر.س");
    /* لا تفسيرًا بالأساس في المجاميع نفسها أبدًا. */
    expect(subtotalsText).not.toContain("ر.ي");
    expect(subtotalsText).not.toContain("150,000");
    expect(subtotalsText).not.toContain("90,000");

    /* تحذير المزيج صريح في الشاشة. */
    const warning = procedures.locator('[data-testid="mixed-currency-warning"]');
    await warning.waitFor({ timeout: 30_000 });

    /* لا تفسيرًا بالأساس في قائمة السطور: الرقمان الخامان مستحيلان —
       وسطر الدليل الحر وحده يذكر الأساس (أسعار الدليل أساسية دائمًا). */
    const draftsText = await procedures.locator("ul").textContent();
    expect(draftsText).not.toContain("150,000");
    expect(draftsText).not.toContain("90,000");
    /* ولا إجماليًّا رقميًّا واحدًا عبر العملتين في القسم كله. */
    const sectionText = await procedures.textContent();
    expect(sectionText).not.toContain("2,400");
    expect(sectionText).not.toContain("1,590");
  }, 240_000);

  it("التوقيع: الرفض atomic بلا فاتورة ولا أثر مالي جزئي", async () => {
    const { rows: [before] } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM invoices WHERE patient_id = $1`, [privatePatientId],
    );

    await page.getByRole("button", { name: /مراجعة وإنهاء الزيارة/ }).click();
    const confirm = page.getByRole("button", { name: /تأكيد إنهاء الزيارة/ });
    await confirm.waitFor({ timeout: 30_000 });
    await confirm.click();

    /* رسالة الرفض ظاهرة — العملات المختلطة لا تُفوتر فاتورةً واحدة. */
    const alert = page.locator('p[role="alert"]');
    await expect.poll(async () => alert.textContent(), { timeout: 60_000 }).toContain("عملات اتفاقٍ مختلفة");

    /* والزيارة بقيت مفتوحة بلا فاتورة — لا أثر مالي جزئي. */
    const { rows: [visitRow] } = await db.query<{ signed_at: Date | null; invoice_id: number | null }>(
      `SELECT signed_at, invoice_id FROM visits WHERE id = $1`,
      [mixedVisitId],
    );
    expect(visitRow.signed_at).toBeNull();
    expect(visitRow.invoice_id).toBeNull();
    const { rows: [after] } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM invoices WHERE patient_id = $1`, [privatePatientId],
    );
    expect(after.n).toBe(before.n);
  }, 240_000);
});

/* ══════════════ الاختبار هـ: زيارتان متتاليتان بلا مغادرة الشاشة ══════════════ */

describe("النهائية أ-هـ: زيارة أ ← توقيع ← تحصيل ← زيارة ب على الشاشة نفسها", () => {
  it("الرحلة الكاملة: شبّاك ب جديدة تمامًا — لقطة وباتون وزرّ تحصيل لها وحدها", async () => {
    /* ملفُ المريض يبدأ الرحلة من رياضيّة مالية وزيارةً نظيفة: زيارات الرحلات
       السابقة في هذا الملف يُزال كلها — لا تفتح صفحةُ المريض إلا الأحدث،
       وزيارة ب التي ستُبدأ من الشاشة تكون الأحدث جميعًا ورصيدها يُقاس من
       خلالها وحدها. خططُ الرحلة تبقى — تحتاجها الرحلة نفسها. */
    await cleanPrivatePatient(false);

    /* ── ١) زيارة أ مربوطة ببندها الدولاري (١٥٠٠$) — أحدث زيارةٍ مفتوحة. */
    const visitA = await linkedVisit(USD_SEQ_A_PLAN);

    /* ── ٢) توقيع أ من الشاشة — فتح الصفحة أولًا: أحدث زيارةٍ مفتوحة. */
    await page.goto(`${baseUrl}/patients/${privatePatientId}?tab=today`);
    await signViaUi();
    const checkout = page.locator('[aria-label="شبّاك ما بعد الزيارة"]');
    await checkout.waitFor({ timeout: 60_000 });

    /* شبّاك أ: سابق ٥٠٠ + اليوم ١٥٠٠ = ٢٠٠٠ — المبلغ الصحيح لزيارة أ. */
    const previousA = checkout.locator("div", { hasText: "الرصيد السابق" }).last();
    await expect.poll(async () => previousA.textContent(), { timeout: 30_000 }).toContain("500.00");
    const totalA = checkout.locator("div", { hasText: "الإجمالي المستحق (دولار)" }).last();
    await totalA.waitFor({ timeout: 30_000 });
    expect(await totalA.textContent()).toContain("2,000.00");

    /* ── ٣) تحصيل جزئي: ١٠٠٠$ من ٢٠٠٠$ — يبقى على المريض ١٠٠٠$ لبداية ب. */
    const { rows: [invoiceA] } = await db.query<{ invoice_id: number }>(
      `SELECT invoice_id FROM visits WHERE id = $1`, [visitA],
    );
    expect(invoiceA.invoice_id).toBeTruthy();
    await checkout.getByRole("button", { name: /تحصيل وطباعة السند/ }).click();
    const amountInput = page.locator('input[aria-label="المبلغ"]');
    await amountInput.waitFor({ timeout: 30_000 });
    await expect.poll(async () => amountInput.inputValue(), { timeout: 30_000 }).toBe("1,500.00");
    await amountInput.fill("1000");
    const beforePay = await paymentCount();
    await page.getByRole("button", { name: /سجّل الدفعة واطبع السند/ }).click();
    await expect.poll(async () => paymentCount(), { timeout: 60_000 }).toBe(beforePay + 1);

    /* الرصيد الحالي بعد التحصيل: ١٠٠٠$ متبقّية. */
    const currentRow = checkout.locator("div", { hasText: "الرصيد الحالي" }).last();
    await expect.poll(async () => currentRow.textContent(), { timeout: 30_000 }).toContain("1,000");

    /* ── ٤) بدء زيارة ب من الشاشة نفسها — بلا أي مغادرة. */
    await page.getByRole("button", { name: /بدء زيارة اليوم/ }).click();
    const openBanner = page.locator('section[aria-label="زيارة اليوم"]');
    await expect
      .poll(async () => openBanner.getByText("زيارة قائمة").count(), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(1);

    /* ── ٥-٧) شبّاك أ اختفى كلّه: لا فاتورة أ، ولا «تم التحصيل»، ولا إجماليها. */
    await expect
      .poll(async () => page.locator('[aria-label="شبّاك ما بعد الزيارة"]').count(), { timeout: 30_000 })
      .toBe(0);

    /* ── ٨) تنفيذ بند ب وإضافة سطره — من «مخطَّط لليوم» بعملة بنده. */
    const planned = page.locator('section[aria-label="مخطَّط لليوم"]');
    await planned.waitFor({ timeout: 60_000 });
    await planned.locator("li", { hasText: USD_SEQ_B_PLAN }).getByRole("button", { name: /نفّذ اليوم/ }).click();
    const priceInput = page.locator('input[aria-label="السعر"]').first();
    await priceInput.waitFor({ timeout: 30_000 });
    await expect.poll(async () => priceInput.inputValue(), { timeout: 20_000 }).toBe("1,500.00");

    /* ── ٩) توقيع ب: شبّاكها لها وحدها. */
    await signViaUi();
    await checkout.waitFor({ timeout: 60_000 });

    /* الرصيد السابق لب = لقطة ما قبل توقيع ب الجديدة: ١٠٠٠$ المتبقّية بعد
       تحصيل أ — لا لقطة أ المجمّدة (٥٠٠$) ولا فاتورة ب محسوبة مرتين. */
    const previousB = checkout.locator("div", { hasText: "الرصيد السابق" }).last();
    await expect.poll(async () => previousB.textContent(), { timeout: 30_000 }).toContain("1,000.00");
    expect(await previousB.textContent()).not.toContain("500.00");

    /* اليوم = استحقاق ب وحده: ١٥٠٠$. */
    const todayB = checkout.locator("div", { hasText: "استحقاق اليوم" }).last();
    await expect.poll(async () => todayB.textContent(), { timeout: 30_000 }).toContain("1,500.00");

    /* الإجمالي = ١٠٠٠ + ١٥٠٠ = ٢٥٠٠$ — لا ٢٠٠٠ (لقطة أ) ولا ٣٥٠٠/٤٠٠٠ (مزدوج). */
    const totalB = checkout.locator("div", { hasText: "الإجمالي المستحق (دولار)" }).last();
    await totalB.waitFor({ timeout: 30_000 });
    expect(await totalB.textContent()).toContain("2,500.00");
    const checkoutText = await checkout.locator("dl").textContent();
    expect(checkoutText).not.toContain("3,500");
    expect(checkoutText).not.toContain("4,000");
    expect(checkoutText).not.toContain("2,000.00");

    /* ── ١٠) زرّ التحصيل متاح لب — «تم التحصيل» لا يُورَّث أبدًا. */
    expect(await checkout.getByRole("button", { name: /تحصيل وطباعة السند/ }).count()).toBe(1);
    expect(await checkout.getByText(/تم التحصيل — سند الاستحقاق سُجّل/).count()).toBe(0);

    /* ── ١١) فاتورة الشبّاك فاتورة ب وحدها — الرابط والقاعدة على زيارة ب. */
    const { rows: [visitBRow] } = await db.query<{ id: number; invoice_id: number }>(
      `SELECT id, invoice_id FROM visits WHERE patient_id = $1 AND signed_at IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
      [privatePatientId],
    );
    expect(visitBRow.invoice_id).toBeTruthy();
    expect(visitBRow.id).not.toBe(visitA);
    const { rows: [invoiceBRow] } = await db.query<{ note: string }>(
      `SELECT note FROM invoices WHERE id = $1`, [visitBRow.invoice_id],
    );
    expect(invoiceBRow.note).toContain(`من الزيارة رقم ${visitBRow.id}`);
    const todayLink = checkout.getByRole("link", { name: /فاتورة اليوم/ });
    expect(await todayLink.getAttribute("href")).toBe(`/print/invoice/${visitBRow.invoice_id}`);
  }, 420_000);
});

/* ══════════════ مساعدات ══════════════ */

/** زيارة فارغة — لا إجراءات فيها: أقصى حالات «العملة المجهولة». */
async function emptyVisit(): Promise<number> {
  return createVisit([]);
}

/** زيارة بسطرين مرتبطين من خطتي عملتين مختلفتين — مزيج لا يُفوتر فاتورةً واحدة. */
async function mixedLinkedVisit(): Promise<number> {
  return createVisit([
    { planItem: planItemIds.get(USD_MIX_PLAN) as number, unitMinor: 150000 },
    { planItem: planItemIds.get(SAR_MIX_PLAN) as number, unitMinor: 90000 },
  ]);
}

/** زيارة مربوطة ببند خطة دولاري واحد. */
async function linkedVisit(planTitle: string): Promise<number> {
  return createVisit([{ planItem: planItemIds.get(planTitle) as number, unitMinor: 150000 }]);
}

async function createVisit(
  procedures: { planItem: number; unitMinor: number }[],
): Promise<number> {
  /* إزاحةٌ إلى الماضي تتناقص كل إنشاء — فكل زيارةٍ أحدث من سابقتها، وزيارةُ
     الشاشة اللاحقة (بلا إزاحة) هي الأحدث جميعًا: الصفحة تفتحها. */
  const { rows: [visit] } = await db.query<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, status, arrived_at)
     VALUES ($1, $2, 'seated', NOW() - ($3 || ' seconds')::interval) RETURNING id`,
    [PRIVATE_PATIENT_NAME, privatePatientId, String(300 - ++visitClock)],
  );
  for (const line of procedures) {
    await db.query(
      `INSERT INTO visit_procedures (visit_id, service_id, plan_item_id, quantity, unit_price_minor)
       VALUES ($1, $2, $3, 1, $4)`,
      [visit.id, serviceId, line.planItem, line.unitMinor],
    );
  }
  return visit.id;
}

/** التوقيع من الواجهة — على الزيارة المفتوحة الأحدث المعروضة في الصفحة.
    (لا يتنقّل: نداءُه لزيارة ب يكون والصفحة مفتوَة عليها أصلًا — فحصُ التصفير
    يستهدف مكوّنًا ظلّ محمّلًا، لا صفحةً حُمّلت من جديد.) */
async function signViaUi(): Promise<void> {
  const reviewButton = page.getByRole("button", { name: /مراجعة وإنهاء الزيارة/ });
  await reviewButton.waitFor({ timeout: 60_000 });
  await reviewButton.click();
  const confirm = page.getByRole("button", { name: /تأكيد إنهاء الزيارة/ });
  await confirm.waitFor({ timeout: 30_000 });
  await confirm.click();
  const checkout = page.locator('[aria-label="شبّاك ما بعد الزيارة"]');
  try {
    await checkout.waitFor({ timeout: 30_000 });
  } catch {
    const alert = await page.locator("p[role=\"alert\"]").allTextContents().catch(() => ["<no alert>"]);
    const { rows } = await db.query(
      `SELECT id, status, signed_at, invoice_id FROM visits WHERE patient_id = $1 ORDER BY id DESC LIMIT 3`,
      [privatePatientId],
    );
    throw new Error(`sign failed: ${JSON.stringify(rows)} alerts=${JSON.stringify(alert)}`);
  }
}

async function paymentCount(): Promise<number> {
  const { rows: [row] } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM payments WHERE patient_id = $1`, [privatePatientId],
  );
  return row.n;
}
