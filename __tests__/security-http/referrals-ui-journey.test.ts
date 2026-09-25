import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * (P3-8) رحلة متصفّح: الطبيب يصدر إحالة من ملف المريض فيُفتح الخطاب في نافذته.
 *
 * مراجعة: النافذة كانت تُفتح بعد انتظار الحفظ وإعادة التحميل — Safari يحجبها فتُحفظ
 * الإحالة ولا يظهر الخطاب. الآن تُفتح مع الضغطة وتُوجَّه بعد الحفظ؛ هذه الرحلة تثبت
 * أن النافذة التي فُتحت هي التي تحمل الخطاب المحفوظ.
 */

let browser: Browser;
let context: BrowserContext;
let page: Page;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let patientId = 0;
const stamp = Date.now();

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  const { rows: [row] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`RFU-${stamp}`, `مريض رحلة الإحالة ${stamp}`, doctor.party_id],
  );
  patientId = row.id;

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.doctorA.cookie), url: baseUrl }]);
  page = await context.newPage();
}, 180_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await db?.end();
});

describe("P3-8 — إصدار الإحالة من ملف المريض", () => {
  it("الحفظ يفتح الخطاب المحفوظ في النافذة التي فُتحت مع الضغطة", async () => {
    // صفحة المريض تستطلع دوريًّا فلا تبلغ networkidle — ننتظر الزر نفسه.
    await page.goto(`${baseUrl}/patients/${patientId}?tab=referrals`, { waitUntil: "domcontentloaded" });
    const newReferral = page.getByRole("button", { name: "+ إحالة جديدة" });
    await newReferral.waitFor({ state: "visible", timeout: 30_000 });
    await newReferral.click();
    await page.getByLabel("المحال إليه (طبيب أو مركز)").fill("د. سامي — جراحة الفكين");
    await page.getByLabel("السبب والمطلوب من الزميل").fill("قلع الضواحك الأولى الأربعة قبل التقويم");
    await page.getByLabel("الأسنان بترقيم FDI (اختياري)").fill("14, 24, 34, 44");

    const popupPromise = context.waitForEvent("page");
    await page.getByRole("button", { name: "حفظ وطباعة الخطاب" }).click();
    const popup = await popupPromise;
    await popup.waitForURL(/\/print\/referral\/\d+$/, { timeout: 30_000 });
    await expect.poll(async () => popup.locator("body").textContent()).toContain("خطاب إحالة");
    expect(await popup.locator("body").textContent()).toContain("14, 24, 34, 44");

    await expect.poll(() => page.locator("li[data-referral]").count()).toBe(1);
  });
});
