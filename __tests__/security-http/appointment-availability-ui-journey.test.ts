import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

let browser: Browser;
let context: BrowserContext;
let page: Page;
let db: Client;
let date = "";
let doctorId = 0;

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

beforeAll(async () => {
  const h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number; date: string }>(
    `SELECT party_id, ((NOW() AT TIME ZONE 'Asia/Aden')::date + 46)::text AS date
       FROM users WHERE username = 'secdoctora'`);
  doctorId = doctor.party_id;
  date = doctor.date;
  const { rows: [otherDoctor] } = await db.query<{ party_id: number }>(
    `SELECT party_id FROM users WHERE username = 'secdoctorb'`);
  await db.query(
    `INSERT INTO appointments (patient_id, doctor_id, scheduled_date, scheduled_time, duration_minutes, status)
     VALUES ($1, $2, $3::date, '09:00', 30, 'booked')`,
    [h.seeded.patientAId, doctorId, date],
  );
  await db.query(
    `INSERT INTO provider_blocks (provider_id, starts_at, ends_at, reason, created_by)
     VALUES ($1, ($2::date + time '10:00') AT TIME ZONE 'Asia/Aden',
             ($2::date + time '10:30') AT TIME ZONE 'Asia/Aden', 'غياب', 'admin')`,
    [doctorId, date],
  );
  await db.query(
    `INSERT INTO appointments (patient_id, doctor_id, scheduled_date, scheduled_time, duration_minutes, status, chair_no)
     VALUES ($1, $2, $3::date, '11:00', 30, 'booked', 1)`,
    [h.seeded.patientBId, otherDoctor.party_id, date],
  );
  browser = await chromium.launch({
    headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.reception.cookie), url: baseUrl }]);
  page = await context.newPage();
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

describe("appointment booking screen shows doctor availability", () => {
  it("disables booked and blocked times and selects an available time", async () => {
    await page.goto(`${baseUrl}/appointments`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /حجز موعد جديد/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[type="date"]').fill(date);
    await expect.poll(() => dialog.locator('select[id$="-doctor"] option').count()).toBeGreaterThan(1);
    await dialog.locator('select[id$="-doctor"]').selectOption(String(doctorId));
    await expect.poll(() => dialog.getByRole("button", { name: "09:00 — محجوز" }).count(), { timeout: 30_000 }).toBe(1);
    expect(await dialog.getByRole("button", { name: "09:00 — محجوز" }).isDisabled()).toBe(true);
    expect(await dialog.getByRole("button", { name: "10:00 — الطبيب غير متاح" }).isDisabled()).toBe(true);
    const free = dialog.getByRole("button", { name: "09:30 — متاح" });
    expect(await free.isEnabled()).toBe(true);
    await free.click();
    expect(await dialog.locator('input[type="time"]').inputValue()).toBe("09:30");
    expect(await dialog.getByRole("button", { name: "11:00 — متاح" }).isEnabled()).toBe(true);
    await dialog.locator('select[id$="-chair"]').selectOption("1");
    await expect.poll(() => dialog.getByRole("button", { name: "11:00 — غير متاح" }).count()).toBe(1);
    expect(await dialog.getByRole("button", { name: "11:00 — غير متاح" }).isDisabled()).toBe(true);
  });
});
