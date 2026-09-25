import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * رحلة متصفّح: فلترا العمل في شاشة المواعيد — «لم يُذكَّر» و«تنتظر التركيبة».
 *
 * جولة المساء على قائمة الغد: ضغطةٌ واحدة تُبقي من لم يُذكَّر فقط، وأخرى تُبقي من
 * ينتظر عمل مختبر لم يصل. بدلها كان الاستقبال يقرأ القائمة كلها بعينه.
 */

let browser: Browser;
let context: BrowserContext;
let page: Page;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
const stamp = Date.now();
const names = {
  due: `ينتظر تذكيره ${stamp}`,
  reminded: `ذُكِّر سابقًا ${stamp}`,
  noPhone: `بلا هاتف ${stamp}`,
};

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

async function patient(name: string, phone: string | null): Promise<number> {
  const { rows: [row] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, phone) VALUES ($1, $2, $3) RETURNING id`,
    [`AF-${stamp}-${name.length}-${phone ?? "x"}`, name, phone],
  );
  return row.id;
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [days] } = await db.query<{ today: string; later: string }>(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Aden')::date)::text AS today,
            ((NOW() AT TIME ZONE 'Asia/Aden')::date + 9)::text AS later`,
  );
  const due = await patient(names.due, "777100200");
  const reminded = await patient(names.reminded, "777100201");
  const noPhone = await patient(names.noPhone, null);
  await db.query(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, status, reminder_sent_at)
     VALUES ($1, $4::date, '16:05', 15, 'booked', NULL),
            ($2, $4::date, '16:25', 15, 'booked', NOW()),
            ($3, $4::date, '16:45', 15, 'booked', NULL)`,
    [due, reminded, noPhone, days.today],
  );
  await db.query(
    `INSERT INTO lab_orders (patient_id, lab_name, work_type, due_date, status)
     VALUES ($1, 'مختبر الفلتر', 'تاج فلتر', $2::date, 'sent')`, [reminded, days.later],
  );

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.reception.cookie), url: baseUrl }]);
  page = await context.newPage();
}, 180_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await db?.end();
});

function visible(name: string) {
  return page.locator("li[data-appointment]", { hasText: name }).count();
}

describe("فلترا العمل في شاشة المواعيد", () => {
  it("«لم يُذكَّر» يُبقي المحجوز الذي له رقمٌ ولم يُذكَّر فقط", async () => {
    await page.goto(`${baseUrl}/appointments`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => visible(names.due), { timeout: 30_000 }).toBe(1);
    await page.locator('button[data-filter="unreminded"]').click();
    await expect.poll(() => visible(names.due)).toBe(1);
    expect(await visible(names.reminded)).toBe(0);
    expect(await visible(names.noPhone)).toBe(0);
  });

  it("«تنتظر التركيبة» يُبقي من عمل مختبره لم يصل", async () => {
    await page.locator('button[data-filter="lab"]').click();
    await expect.poll(() => visible(names.reminded)).toBe(1);
    expect(await visible(names.due)).toBe(0);
    expect(await visible(names.noPhone)).toBe(0);
  });
});
