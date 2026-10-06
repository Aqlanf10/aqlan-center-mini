import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

/**
 * (INV-LINK D) رحلة الفاتورة العلاجية في المتصفح على التطبيق المبني وقاعدة معزولة:
 * الاستقبال يصدر فاتورة تقويم ← المعاينة تقول ما سيحدث ← الحفظ مرةً واحدة رغم النقر المزدوج ← الطبيب يرى
 * «بدء التقييم السريري — تقويم» ← تبويب التقويم يعرض الحالة التي تحتاج تقييمًا.
 */

let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let serviceId = 0;
const stamp = Date.now();

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض فاتورة التقويم', $2) RETURNING id`,
    [`IFJ-${stamp}`, doctor.party_id]));
  ({ rows: [{ id: serviceId }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 30000000, TRUE, TRUE, 'ortho') RETURNING id`,
    [`تقويم ثابت رحلة ${stamp}`]));
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function open(who: "reception" | "doctorA", path: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions[who].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
  return { context, page };
}

describe("INV-LINK D — invoice-first journey", () => {
  it("reception: preview says a new intake case will be created; a double click saves one invoice", async () => {
    const { context, page } = await open("reception", `/patients/${patientId}?tab=account`);
    await page.getByRole("button", { name: "فاتورة يدوية" }).click();
    await page.getByLabel("الخدمة", { exact: true }).selectOption(String(serviceId));
    const preview = page.getByTestId("invoice-clinical-preview-0");
    await preview.filter({ hasText: "سيتم إنشاء حالة أولية تحتاج تقييم الطبيب" }).waitFor();
    expect(await preview.innerText()).toContain("بند خطة جديد");
    const save = page.getByRole("button", { name: "احفظ الفاتورة" });
    await save.dblclick();
    await page.getByTestId("invoice-clinical-notice").waitFor();
    expect(await page.getByTestId("invoice-clinical-notice").innerText()).toContain("حالة أولية تحتاج تقييم الطبيب");
    const { rows } = await db.query(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patientId]);
    expect(rows).toHaveLength(1);
    const { rows: cases } = await db.query<{ specialty: string; origin: string }>(`SELECT specialty, origin FROM clinical_cases WHERE patient_id = $1`, [patientId]);
    expect(cases).toEqual([{ specialty: "orthodontics", origin: "invoice" }]);
    await context.close();
  });

  it("doctor: the next action is the clinical assessment and the ortho tab shows the pending case", async () => {
    const { context, page } = await open("doctorA", `/patients/${patientId}`);
    const action = page.getByRole("button", { name: /بدء التقييم السريري — تقويم/ });
    await action.waitFor();
    await action.click();
    const banner = page.getByTestId("assessment-banner-orthodontics");
    await banner.waitFor();
    expect(await banner.innerText()).toContain("تحتاج تقييمًا سريريًّا");
    expect(await banner.innerText()).toContain("مقبول ماليًّا");
    // nothing clinical was invented: no ortho_cases row exists yet
    expect((await db.query(`SELECT 1 FROM ortho_cases WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
    await context.close();
  });
});
