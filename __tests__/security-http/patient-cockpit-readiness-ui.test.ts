import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { mkdir } from "node:fs/promises";
import { baseUrl, harness } from "./_server";

// Built application and its original isolated security harness only. Patient and
// shell reads use the real synthetic fixture. Cockpit transports are intercepted
// explicitly to reproduce loading/denial/recovery; this is browser UI evidence,
// not evidence of backend chair arbitration. Mutations never reach the database.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let patientId: number;
let visitId: number;
const stamp = Date.now();
const patientName = "مريض اختبار جاهزية الكرسي — بيانات اصطناعية";
const alert = "تنبيه طبي اصطناعي للتحقق البصري";
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctor = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username = 'secdoctora'")).rows[0].party_id;
  patientId = (await db.query<{ id: number }>("INSERT INTO patients (patient_number, full_name, primary_doctor_id, medical_alert) VALUES ($1, $2, $3, $4) RETURNING id", [`COCKPIT-${stamp}`, patientName, doctor, alert])).rows[0].id;
  visitId = (await db.query<{ id: number }>("INSERT INTO visits (patient_id, patient_name, doctor_id, status) VALUES ($1, $2, $3, 'waiting') RETURNING id", [patientId, patientName, doctor])).rows[0].id;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function open(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  return { context, page: await context.newPage() };
}
const cockpit = (page: Page) => page.locator('[aria-label="قمرة المريض"]');
const entry = (page: Page) => cockpit(page).getByRole("button", { name: /^إدخال إلى الكرسي/ });
const retry = (page: Page) => cockpit(page).getByRole("button", { name: "إعادة التحقق", exact: true });
function readiness(status = "waiting") {
  return { visit: { visitId, patientId, status, chair: status === "in_chair" ? 1 : null,
    arrivedAt: new Date().toISOString(), seatedAt: status === "in_chair" ? new Date().toISOString() : null,
    signedAt: null, cleared: null, checklist: [{ key: "alerts", state: "attention", label: alert }], attention: 1,
    alerts: [alert], balances: [{ currency: "SAR", dueMinor: 500, warn: true }] } };
}
async function noHorizontalOverflow(page: Page) {
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
}

describe("patient cockpit readiness on the built RTL patient file", () => {
  it.each([1280, 390])("at %ipx distinguishes pending/failed reads and keyboard retry before ordinary seating", async (width) => {
    const { context, page } = await open(width);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let mode: "pending" | "failed" | "ready" | "seated" = "pending";
    const mutations: Array<{ url: string; body: unknown }> = [];
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.route(`**/api/visits/readiness?patientId=${patientId}`, async (route) => {
        if (mode === "pending") await paused;
        await route.fulfill({ status: mode === "failed" ? 503 : 200, contentType: "application/json",
          body: JSON.stringify(mode === "failed" ? { message: "قراءة اصطناعية غير متاحة" } : readiness(mode === "seated" ? "in_chair" : "waiting")) });
      });
      await page.route(/\/api\/visits(?:\/\d+)?$/, async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: visitId, patientId, status: mode === "seated" ? "in_chair" : "waiting", chair: mode === "seated" ? 1 : null }]) });
          return;
        }
        mutations.push({ url: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
        mode = "seated";
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: visitId, patientId, status: "in_chair", chair: 1 }) });
      });
      await page.goto(`${baseUrl}/patients/${patientId}?tab=summary`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("patient-cockpit-read-state").waitFor();
      expect(await cockpit(page).innerText()).toContain("قيد التحقق");
      expect(await entry(page).count()).toBe(0); expect(mutations).toHaveLength(0);
      mode = "failed"; release();
      await expect.poll(() => cockpit(page).innerText()).toContain("غير متاحة");
      expect(await entry(page).count()).toBe(0); expect(mutations).toHaveLength(0);
      expect(await cockpit(page).innerText()).not.toContain("لا زيارة اليوم");
      expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
      await noHorizontalOverflow(page);
      await mkdir(".settings-ui-artifacts", { recursive: true });
      await page.screenshot({ path: `.settings-ui-artifacts/patient-cockpit-readiness-unavailable-${width}.png`, fullPage: true });
      mode = "ready";
      await retry(page).focus(); await page.keyboard.press("Enter");
      await expect.poll(() => entry(page).isEnabled()).toBe(true);
      // Debt and absent clearance do not create new client-side policy holds.
      expect(await cockpit(page).innerText()).toContain("عليه");
      expect(await cockpit(page).innerText()).not.toContain("جاهز ✓");
      await noHorizontalOverflow(page);
      await page.screenshot({ path: `.settings-ui-artifacts/patient-cockpit-readiness-${width}.png`, fullPage: true });
      await entry(page).click();
      await expect.poll(() => mutations.length).toBe(1);
      expect(mutations[0]).toEqual({ url: `/api/visits/${visitId}`, body: { action: "seat", chair: 1 } });
      await expect.poll(() => cockpit(page).innerText()).toContain("على الكرسي 1");
      expect(await entry(page).count()).toBe(0);
      expect(mutations).toHaveLength(1); expect(errors).toEqual([]);
      expect((await db.query("SELECT status FROM visits WHERE id=$1", [visitId])).rows[0].status).toBe("waiting");
    } finally { release(); await context.close(); }
  });

  it("a real browser never re-enables entry from a denied read or a stalled retry", async () => {
    const { context, page } = await open(390);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let mode: "ready" | "denied" | "pending" = "ready";
    const mutations: string[] = [];
    try {
      await page.route(`**/api/visits/readiness?patientId=${patientId}`, async (route) => {
        if (mode === "pending") await paused;
        await route.fulfill({ status: mode === "denied" ? 403 : 200, contentType: "application/json", body: JSON.stringify(mode === "denied" ? { message: "رفض اصطناعي" } : readiness()) });
      });
      await page.route(/\/api\/visits(?:\/\d+)?$/, async (route) => {
        if (route.request().method() !== "GET") mutations.push(route.request().method());
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: visitId, patientId, status: "waiting", chair: null }]) });
      });
      await page.goto(`${baseUrl}/patients/${patientId}?tab=summary`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => entry(page).isEnabled()).toBe(true);
      mode = "denied";
      // An actual focus refresh invokes the component's installed event listener.
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect.poll(() => cockpit(page).innerText()).toContain("غير متاحة");
      expect(await cockpit(page).innerText()).not.toContain(alert); expect(await entry(page).count()).toBe(0);
      mode = "pending"; await retry(page).click();
      await expect.poll(() => cockpit(page).innerText()).toContain("قيد التحقق");
      expect(await cockpit(page).innerText()).not.toContain(alert); expect(await entry(page).count()).toBe(0);
      expect(mutations).toEqual([]);
      release(); await expect.poll(() => entry(page).isEnabled()).toBe(true);
    } finally { release(); await context.close(); }
  });
});
