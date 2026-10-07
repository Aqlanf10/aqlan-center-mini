import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

/**
 * (INV-LEGACY) رحلة «علاج بدأ قبل النظام» في المتصفح على التطبيق المبني وقاعدة معزولة:
 * الاستقبال يفتح حساب المريض ← «علاج بدأ قبل النظام» ← تقويم 300,000 / 120,000 / تاريخ ← المعاينة تقول 180,000 وأن لا إيصال
 * ← الحفظ مرةً واحدة رغم النقر المزدوج ← الحساب يعرض الرصيد السابق 180,000 ولوحة الاتفاق التاريخي ← تبويب التقويم يعرض
 * الحالة موسومة «حالة بدأت قبل النظام» (لا «تحتاج تقييمًا»). وعلى عرض الهاتف (390px) لا تمرير أفقي للصفحة.
 */

let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let serviceId = 0;
let rctId = 0;
const stamp = Date.now();

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض تقويم قديم', $2) RETURNING id`,
    [`LTJ-${stamp}`, doctor.party_id]));
  ({ rows: [{ id: serviceId }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 300000, TRUE, TRUE, 'ortho') RETURNING id`,
    [`تقويم ثابت قديم ${stamp}`]));
  ({ rows: [{ id: rctId }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 80000, TRUE, TRUE, 'rct') RETURNING id`,
    [`علاج عصب قديم ${stamp}`]));
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function open(who: "reception" | "doctorA", path: string, width = 1280): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions[who].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
  return { context, page };
}

describe("INV-LEGACY — pre-system treatment journey", () => {
  it("reception: form + live preview (180,000, no receipt) → save once → opening 180,000 and the historical panel", async () => {
    const { context, page } = await open("reception", `/patients/${patientId}?tab=account`);
    await page.getByRole("button", { name: "علاج بدأ قبل النظام" }).click();
    const form = page.getByTestId("legacy-treatment-form");
    await form.waitFor();
    await page.getByLabel("الخدمة العلاجية", { exact: true }).selectOption(String(serviceId));
    await page.getByLabel("المبلغ المتفق عليه أصلًا").fill("300000");
    await page.getByLabel("المدفوع قبل النظام").fill("120000");
    await page.getByLabel("تاريخ المعلومات التاريخية").fill("2026-09-30");
    const preview = page.getByTestId("legacy-treatment-preview");
    await page.getByTestId("legacy-remaining").filter({ hasText: "180,000" }).waitFor();
    const text = await preview.innerText();
    expect(text).toContain("300,000");
    expect(text).toContain("120,000");
    expect(text).toContain("لن يُنشأ إيصال للمبلغ المدفوع سابقًا");
    expect(text).toContain("الرصيد الافتتاحي = المتبقي فقط");
    await page.getByTestId("legacy-case-preview").filter({ hasText: "حالة بدأت قبل النظام" }).waitFor();

    await page.getByRole("button", { name: "احفظ العلاج السابق" }).dblclick();
    const panel = page.getByTestId("legacy-agreements");
    await panel.filter({ hasText: "180,000" }).waitFor();
    const panelText = await panel.innerText();
    expect(panelText).toContain("المتفق عليه أصلًا");
    expect(panelText).toContain("300,000");
    expect(panelText).toContain("120,000");
    expect(panelText).toContain("حالة بدأت قبل النظام");
    await page.getByText(/رصيد افتتاحي 180,000/).first().waitFor();

    const { rows: money } = await db.query<{ agreements: number; payments: number; invoices: number; opening: string }>(
      `SELECT (SELECT COUNT(*)::int FROM legacy_treatment_agreements WHERE patient_id = $1) AS agreements,
              (SELECT COUNT(*)::int FROM payments WHERE patient_id = $1) AS payments,
              (SELECT COUNT(*)::int FROM invoices WHERE patient_id = $1) AS invoices,
              (SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id = $1 AND currency = 'YER') AS opening`,
      [patientId]);
    expect(money[0]).toEqual({ agreements: 1, payments: 0, invoices: 0, opening: "180000" });
    await context.close();
  });

  it("the ortho tab shows the case labelled «حالة بدأت قبل النظام», not as needing an initial assessment", async () => {
    const { context, page } = await open("reception", `/patients/${patientId}?tab=treatment&sub=ortho`);
    const banner = page.getByTestId("legacy-case-banner-orthodontics");
    await banner.waitFor();
    expect(await banner.innerText()).toContain("حالة بدأت قبل النظام");
    expect(await page.getByTestId("assessment-banner-orthodontics").count()).toBe(0);
    await context.close();
  });

  it("mobile 390px: the account page with the open form has no horizontal page overflow", async () => {
    const { context, page } = await open("reception", `/patients/${patientId}?tab=account`, 390);
    await page.getByRole("button", { name: "علاج بدأ قبل النظام" }).click();
    await page.getByTestId("legacy-treatment-form").waitFor();
    await page.getByTestId("legacy-agreements").waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });

  it("(INV-LINK TOOTH) a legacy endodontic treatment takes its tooth from the shared Dental Chart; no tooth ⇒ cannot save", async () => {
    // a patient without an opening yet: adding to an existing opening is an admin edit (covered elsewhere)
    const { rows: [{ id: endoPatient }] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض عصب قديم') RETURNING id`, [`LTE-${stamp}`]);
    const { context, page } = await open("reception", `/patients/${endoPatient}?tab=account`);
    await page.getByRole("button", { name: "علاج بدأ قبل النظام" }).click();
    await page.getByLabel("الخدمة العلاجية", { exact: true }).selectOption(String(rctId));
    await page.getByLabel("المبلغ المتفق عليه أصلًا").fill("80000");
    await page.getByLabel("المدفوع قبل النظام").fill("30000");
    await page.getByLabel("تاريخ المعلومات التاريخية").fill("2026-09-30");
    await page.getByTestId("legacy-tooth-problem").waitFor();
    expect(await page.getByRole("button", { name: "احفظ العلاج السابق" }).isDisabled()).toBe(true);
    expect(await page.getByLabel("سن العلاج السابق").count()).toBe(0); // no free-text tooth field
    await page.getByTestId("legacy-tooth-button").click();
    await page.getByTestId("tooth-dialog").waitFor();
    await page.getByTestId("odontogram-tooth-36").click();
    await page.getByTestId("tooth-dialog-confirm").click();
    await page.getByTestId("legacy-tooth-chip").filter({ hasText: "36" }).waitFor();
    await page.getByTestId("legacy-case-preview").filter({ hasText: "حالة بدأت قبل النظام" }).waitFor();
    await page.getByRole("button", { name: "احفظ العلاج السابق" }).click();
    await page.getByTestId("legacy-agreements").filter({ hasText: "50,000" }).waitFor();
    const { rows } = await db.query<{ tooth_code: number; site: string }>(
      `SELECT a.tooth_code, c.site FROM legacy_treatment_agreements a JOIN clinical_cases c ON c.id = a.case_id
        WHERE a.patient_id = $1 AND a.service_id = $2`, [endoPatient, rctId]);
    expect(rows).toEqual([{ tooth_code: 36, site: "36" }]);
    await context.close();
  });
});
