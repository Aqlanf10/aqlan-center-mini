import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * رحلة متصفّح: بطاقة «غدًا» على الشاشة الرئيسية تفتح قائمة الغد بفلترها جاهزًا.
 *
 * جولة المساء بضغطة: البطاقة تعدّ من لم يُذكَّر ومن ينتظر تركيبته، ورابطها يفتح
 * `/appointments?date=<الغد>&filter=unreminded` فلا يبقى في القائمة إلا من بقي.
 */

let browser: Browser;
let context: BrowserContext;
let page: Page;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
const stamp = Date.now();
const due = `تذكير الغد ${stamp}`;
const waiting = `تركيبة الغد ${stamp}`;
let tomorrow = "";

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [days] } = await db.query<{ tomorrow: string; later: string }>(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Aden')::date + 1)::text AS tomorrow,
            ((NOW() AT TIME ZONE 'Asia/Aden')::date + 9)::text AS later`,
  );
  tomorrow = days.tomorrow;
  const ids: number[] = [];
  for (const [name, phone] of [[due, "777300400"], [waiting, "777300401"]] as const) {
    const { rows: [row] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name, phone) VALUES ($1, $2, $3) RETURNING id`,
      [`TC-${stamp}-${phone}`, name, phone],
    );
    ids.push(row.id);
  }
  await db.query(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, status, reminder_sent_at)
     VALUES ($1, $3::date, '16:05', 15, 'booked', NULL), ($2, $3::date, '16:25', 15, 'booked', NOW())`,
    [ids[0], ids[1], tomorrow],
  );
  await db.query(
    `INSERT INTO lab_orders (patient_id, lab_name, work_type, due_date, status)
     VALUES ($1, 'مختبر الغد', 'تاج الغد', $2::date, 'sent')`, [ids[1], days.later],
  );

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.reception.cookie), url: baseUrl }]);
  page = await context.newPage();
}, 180_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await db?.end();
});

describe("بطاقة الغد", () => {
  it("تظهر بعدد من لم يُذكَّر ومن ينتظر تركيبته، ورابطها يفتح قائمة الغد مفلترة", async () => {
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    const card = page.locator("[data-tomorrow-card]");
    await card.waitFor({ state: "visible", timeout: 30_000 });
    const text = await card.textContent();
    expect(text).toMatch(/💬 \d+ لم يُذكَّروا/);
    expect(text).toMatch(/🧪 \d+ تنتظر تركيبةً لم تصل/);

    await card.getByRole("link", { name: /لم يُذكَّروا/ }).click();
    await page.waitForURL(new RegExp(`/appointments\\?date=${tomorrow}&filter=unreminded`));
    await expect.poll(() => page.locator("li[data-appointment]", { hasText: due }).count(), { timeout: 30_000 }).toBe(1);
    expect(await page.locator("li[data-appointment]", { hasText: waiting }).count()).toBe(0);
  });
});
