import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

/** Built app, real isolated test DB and synthetic records only. Never visits WhatsApp. */
const DATE = "2098-05-10";
const ARTIFACTS = join(process.cwd(), ".settings-ui-artifacts");
const fixtures = [
  { name: "مراجع تجريبي أول", phone: "770000001", time: "10:30", label: "💬 تذكير واتساب" },
  { name: "مراجع تجريبي ثان", phone: "770000002", time: "11:00", label: "إعادة تذكير؟" },
  { name: "مراجع تجريبي ثالث", phone: "770000003", time: "11:30", label: "ذُكِّر ✓" },
] as const;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let db: Client;
const patientIds: number[] = [];
const appointmentIds: number[] = [];
const writes: string[] = [];
let interceptedDrafts = 0;

function sessionCookie(raw: string) {
  const [name, ...value] = raw.split("=");
  return { name, value: value.join("=") };
}

function row(index = 0) {
  return page.locator(`li[data-appointment="${appointmentIds[index]}"]`);
}

async function reminderStamp() {
  const { rows: [record] } = await db.query<{ stamp: string | null }>(
    "SELECT reminder_sent_at::text AS stamp FROM appointments WHERE id = $1", [appointmentIds[0]],
  );
  return record.stamp;
}

beforeAll(async () => {
  const h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const run = `${Date.now()}-${process.pid}`;
  for (const [index, fixture] of fixtures.entries()) {
    const { rows: [patient] } = await db.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name, phone) VALUES ($1, $2, $3) RETURNING id",
      [`REMINDER-COMPACT-${run}-${index}`, fixture.name, fixture.phone],
    );
    patientIds.push(patient.id);
    const { rows: [appointment] } = await db.query<{ id: number }>(
      `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, status, reminder_sent_at)
       VALUES ($1, $2::date, $3::time, 15, 'booked',
         CASE $4::int WHEN 1 THEN NOW() WHEN 2 THEN NOW() - INTERVAL '24 hours' ELSE NULL END)
       RETURNING id`,
      [patient.id, DATE, fixture.time, index],
    );
    appointmentIds.push(appointment.id);
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
  // Context routing also catches the popup's first request before network access.
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(baseUrl).origin) return route.continue();
    if (url.hostname === "wa.me") {
      interceptedDrafts += 1;
      return route.fulfill({ status: 200, contentType: "text/plain", body: "Synthetic draft intercepted. No external request or message sent." });
    }
    return route.abort("blockedbyclient");
  });
  page = await context.newPage();
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === new URL(baseUrl).origin && /^\/api\/appointments(?:\/|$)/.test(url.pathname)
      && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.method());
  });
  await page.goto(`${baseUrl}/appointments?date=${DATE}`, { waitUntil: "domcontentloaded" });
  await row().waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
}, 240_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  if (db) {
    if (appointmentIds.length) await db.query("DELETE FROM appointments WHERE id = ANY($1::int[])", [appointmentIds]);
    if (patientIds.length) await db.query("DELETE FROM patients WHERE id = ANY($1::int[])", [patientIds]);
    await db.end();
  }
});

describe("compact appointment reminders on the built Arabic page", () => {
  it("captures original compact controls plus staff confirmation, without overflow", async () => {
    await expect.poll(() => row().locator('[data-action="confirm-manual-reminder"]').isEnabled()).toBe(true);
    // The screenshots must contain exactly these three synthetic cards, no other records.
    expect(await page.locator("li[data-appointment]").evaluateAll(nodes => nodes.map(node => Number(node.getAttribute("data-appointment"))))).toEqual(appointmentIds);
    const list = row().locator("..");
    await mkdir(ARTIFACTS, { recursive: true });
    for (const width of [1280, 390, 320] as const) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      await list.evaluate(node => node.scrollIntoView({ block: "center" }));
      // Keep the synthetic image even when a subsequent geometry assertion fails.
      await list.screenshot({ path: join(ARTIFACTS, `appointment-reminder-compact-${width}.png`), animations: "disabled" });
      expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      for (const [index, fixture] of fixtures.entries()) {
        const card = row(index);
        const reminder = card.locator("[data-manual-reminder]");
        const draft = reminder.locator("a");
        const staff = reminder.locator("button");
        expect(await draft.innerText()).toBe(fixture.label);
        expect(await staff.innerText()).toBe("تأكيد الموظف");
        expect(await reminder.locator("a, button").count()).toBe(2);
        expect(await draft.getAttribute("aria-label")).toContain("فتح مسودة واتساب");
        const describedBy = await draft.getAttribute("aria-describedby");
        expect(await page.locator(`[id="${describedBy}"]`).count()).toBe(1);
        const help = await page.locator(`[id="${describedBy}"]`).evaluate(node => {
          const box = node.getBoundingClientRect();
          return { width: box.width, height: box.height, position: getComputedStyle(node).position };
        });
        expect(help).toEqual({ width: 1, height: 1, position: "absolute" });
        const controls = await card.locator('a[target="_blank"], button').allTextContents();
        expect(controls.map(text => text.trim())).toEqual([
          fixture.label, "تأكيد الموظف", "📲 تأكيد", "🪑 وصل للعيادة", "نقل الموعد", "لم يحضر", "إلغاء", "🗑 حذف",
        ]);
        const geometry = await card.evaluate(node => {
          const card = node.getBoundingClientRect();
          const controls = [...node.querySelectorAll<HTMLElement>('a[target="_blank"], button')].map(control => {
            const box = control.getBoundingClientRect();
            return { left: box.left, right: box.right, center: box.top + box.height / 2 };
          });
          return { left: card.left, right: card.right, height: card.height,
            noOverflow: node.scrollWidth <= node.clientWidth + 1, controls };
        });
        expect(geometry.noOverflow).toBe(true);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(width + 1);
        for (const control of geometry.controls) {
          expect(control.left).toBeGreaterThanOrEqual(geometry.left);
          expect(control.right).toBeLessThanOrEqual(geometry.right);
        }
        if (width === 1280) {
          expect(geometry.height).toBeLessThanOrEqual(90);
          const centers = geometry.controls.map(control => control.center);
          expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(2);
        }
      }
      expect(await row().locator("[data-manual-reminder] a").evaluate(node => getComputedStyle(node).backgroundColor)).toBe("rgb(37, 211, 102)");
    }
    expect(writes).toEqual([]);
    expect(await reminderStamp()).toBeNull();
  });

  it("opening the intercepted draft and cancelling staff confirmation never records contact", async () => {
    const reminder = row().locator("[data-manual-reminder]");
    const popupPromise = page.waitForEvent("popup");
    await reminder.locator("a").click();
    const popup = await popupPromise;
    await expect.poll(() => interceptedDrafts).toBe(1);
    await popup.waitForLoadState("domcontentloaded");
    await popup.close();
    expect(writes).toEqual([]);
    expect(await reminderStamp()).toBeNull();

    const staff = reminder.locator("button");
    await staff.focus();
    const dialogPromise = page.waitForEvent("dialog");
    const activation = staff.press("Enter");
    const dialog = await dialogPromise;
    expect(dialog.message()).toContain(fixtures[0].name);
    expect(dialog.message()).toContain("ليس إثبات تسليم آلي");
    await dialog.dismiss();
    await activation;
    // Settle the event turn, then verify both transport and real stored state.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(writes).toEqual([]);
    expect(await reminderStamp()).toBeNull();
  });

  it("only explicit staff acceptance records the unchanged appointment snapshot", async () => {
    const staff = row().locator('[data-action="confirm-manual-reminder"]');
    const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/appointments/${appointmentIds[0]}`
      && result.request().method() === "PATCH");
    page.once("dialog", dialog => { void dialog.accept(); });
    await staff.click();
    const recorded = await response;
    expect(recorded.status()).toBe(200);
    expect(recorded.request().postDataJSON()).toEqual({
      action: "reminded", snapshot: {
        patientId: patientIds[0], patientName: fixtures[0].name, patientPhone: fixtures[0].phone,
        scheduledDate: DATE, scheduledTime: fixtures[0].time, status: "booked",
      },
    });
    await expect.poll(reminderStamp).not.toBeNull();
    expect(writes).toEqual(["PATCH"]);
    await expect.poll(() => row().locator("[data-manual-reminder] a").innerText()).toBe("إعادة تذكير؟");
    expect(interceptedDrafts).toBe(1);
  });
});
