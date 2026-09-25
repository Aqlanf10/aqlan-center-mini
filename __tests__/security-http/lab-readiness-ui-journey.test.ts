import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * رحلة متصفّح: جاهزية التركيبة تظهر بجانب الموعد في **العرضين** — القائمة والكراسي.
 *
 * مراجعة: الشريط أعلى اليوم كان يعدّ الموعد المنتظر تركيبته، وعرض الكراسي لا يقول
 * أيّ مريضٍ هو — فيُضطر الاستقبال إلى تبديل العرض ليعرف بمن يتصل.
 */

let browser: Browser;
let context: BrowserContext;
let page: Page;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
const stamp = Date.now();
const patientName = `مريض تركيبة ${stamp}`;

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [days] } = await db.query<{ today: string; due: string }>(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Aden')::date)::text AS today,
            ((NOW() AT TIME ZONE 'Asia/Aden')::date + 5)::text AS due`,
  );
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`LRU-${stamp}`, patientName],
  );
  await db.query(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, status)
     VALUES ($1, $2::date, '10:15', 30, 'booked')`, [patient.id, days.today],
  );
  await db.query(
    `INSERT INTO lab_orders (patient_id, lab_name, work_type, due_date, status)
     VALUES ($1, 'مختبر الرحلة', 'تاج رحلة', $2::date, 'sent')`, [patient.id, days.due],
  );

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
  page = await context.newPage();
}, 180_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await db?.end();
});

describe("جاهزية التركيبة في شاشة المواعيد", () => {
  it("القائمة: الشارة والسبب بجانب الموعد، والشريط يعدّه", async () => {
    await page.goto(`${baseUrl}/appointments`, { waitUntil: "networkidle" });
    const row = page.locator("li[data-appointment]", { hasText: patientName });
    await expect.poll(() => row.locator('[data-lab-readiness="pending"]').count()).toBe(1);
    expect(await row.textContent()).toContain("تاج رحلة: وصولها المتوقَّع");
    expect(await page.locator("[data-lab-readiness-summary]").count()).toBe(1);
  });

  it("مراجعة: عرض الكراسي يُظهر الشارة والسبب على بطاقة المريض نفسها", async () => {
    await page.getByRole("button", { name: /كراسي/ }).click();
    const card = page.locator("div.rounded-xl", { hasText: patientName }).last();
    await expect.poll(() => card.locator('[data-lab-readiness="pending"]').count()).toBe(1);
    expect(await card.textContent()).toContain("تاج رحلة");
  });
});
