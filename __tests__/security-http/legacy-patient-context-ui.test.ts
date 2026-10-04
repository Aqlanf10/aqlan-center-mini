import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";

// Remote CI built-app browser gate only. Synthetic database fixtures are seeded
// before browsing; every browser mutation/external request is blocked. No
// historical correction or financial submit is performed by these tests.
let browser: Browser;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let patientId = 0;
let caseId = 0;
const stamp = Date.now();

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number }>(
    `SELECT party_id FROM users WHERE username = 'secdoctora'`);
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id)
     VALUES ($1, 'مريض تقويم سابق تجريبي', $2) RETURNING id`, [`LEGACY-UI-${stamp}`, doctor.party_id]));
  await db.query(
    `INSERT INTO patient_opening_balances (patient_id, currency, amount_minor, as_of_date, note, created_by)
     VALUES ($1, 'SAR', 35000, CURRENT_DATE, 'متبقٍ فقط من علاج سابق تجريبي', 'secadmin')`, [patientId]);
  ({ rows: [{ id: caseId }] } = await db.query<{ id: number }>(
    `INSERT INTO ortho_cases (patient_id, created_by, baseline_kind, baseline_recorded_at,
       legacy_financial_mode, start_date, phase, responsible_doctor_id)
     VALUES ($1, 'secadmin', 'legacy', NOW(), 'opening_balance', CURRENT_DATE - 365, 'working', $2) RETURNING id`,
    [patientId, doctor.party_id]));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function financialState() {
  return (await db.query(
    `SELECT (SELECT COUNT(*)::int FROM treatment_plans WHERE patient_id = $1) AS plans,
            (SELECT COUNT(*)::int FROM payments WHERE patient_id = $1) AS payments,
            (SELECT COUNT(*)::int FROM invoices WHERE patient_id = $1) AS invoices,
            (SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id = $1 AND currency = 'SAR') AS opening`,
    [patientId])).rows;
}
async function open(width: number, tab: "plans" | "account", who: "admin" | "doctorA" = "admin") {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions[who].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const writes: string[] = [];
  const external: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== baseUrl) { external.push(url.origin); await route.abort(); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "Synthetic UI writes blocked" }) });
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=${tab}`, { waitUntil: "domcontentloaded" });
    return { page, context, writes, external, errors };
  } catch (error) { await context.close(); throw error; }
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
}

// Full-page captures must start at the document origin: otherwise sticky
// patient controls can be painted over content at the previous scroll offset.
async function screenshotFromTop(page: Page, path: string) {
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
  await page.waitForFunction(() => window.scrollY === 0 && window.scrollX === 0);
  await page.screenshot({ path, fullPage: true });
}

// Exercise real scrolling without hiding fixed controls. Every rendered text
// line must fit in the viewport, and its edges/centre must hit the guidance,
// not a sticky cockpit or another overlay. Scroll each complete note as a unit.
async function assertTextReadable(locator: Locator) {
  await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await expect.poll(() => locator.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const rects: DOMRect[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0));
    }
    return rects.length > 0 && rects.every((rect) => {
      if (rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) return false;
      const xs = [rect.left + 1, rect.left + rect.width / 2, rect.right - 1];
      const ys = [rect.top + 1, rect.top + rect.height / 2, rect.bottom - 1];
      return xs.every((x) => ys.every((y) => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && element.contains(hit);
      }));
    });
  })).toBe(true);
}

describe("legacy patient entry and plan context in the real RTL UI", () => {
  it.each([1280, 390])("shows existing old ortho without a financial plan or write at %ipx", async (width) => {
    const before = await financialState();
    const f = await open(width, "plans");
    try {
      const panel = f.page.getByRole("region", { name: "التقويم السابق ضمن خطة المريض" });
      await panel.getByText(`حالة #${caseId}`, { exact: false }).waitFor();
      expect(await panel.innerText()).toContain("المرحلة العاملة");
      expect(await panel.innerText()).not.toMatch(/350\.00|35,000|المدفوع|المتبقي.*350/);
      const link = panel.getByRole("link", { name: "متابعة الحالة من ملف التقويم" });
      expect(await link.getAttribute("href")).toBe(`/patients/${patientId}?tab=ortho`);
      await f.page.getByText("لا توجد خطط علاج جديدة مسجّلة هنا", { exact: false }).waitFor();
      await fits(f.page);
      await screenshotFromTop(f.page, `.settings-ui-artifacts/legacy-patient-plan-${width}.png`);
      await link.click();
      await f.page.getByText("بدأ قبل النظام", { exact: true }).waitFor();
      await f.page.goBack();
      await f.page.getByRole("region", { name: "التقويم السابق ضمن خطة المريض" }).getByText(`حالة #${caseId}`, { exact: false }).waitFor();
      expect(f.writes).toEqual([]); expect(f.external).toEqual([]); expect(f.errors).toEqual([]);
      expect(await financialState()).toEqual(before);
    } finally { await f.context.close(); }
  });

  it.each([1280, 390])("explains remaining-only opening and current cash, with reachable cancel at %ipx", async (width) => {
    const before = await financialState();
    const f = await open(width, "account");
    try {
      await f.page.getByRole("button", { name: "تعديل الرصيد السابق", exact: true }).click();
      const opening = f.page.getByRole("region", { name: "رصيد افتتاحي", exact: true });
      await opening.getByText("الرصيد السابق المتبقي", { exact: true }).waitFor();
      expect(await opening.innerText()).toContain("قيمة العلاج 600، المدفوع سابقًا 250، الرصيد السابق الذي تُدخله 350");
      expect(await opening.innerText()).toContain("لا تطرحها مرة أخرى");
      expect(await opening.getByLabel("المبلغ", { exact: true }).inputValue()).toBe("350.00");
      await fits(f.page);
      const guidance = opening.getByRole("note").filter({ hasText: "أدخل المتبقي المستحق قبل بدء البرنامج" });
      const correction = opening.getByRole("note").filter({ hasText: "عند التصحيح، راجع مبلغ البداية فقط." });
      expect(await guidance.count()).toBe(1); expect(await correction.count()).toBe(1);
      await assertTextReadable(guidance);
      await assertTextReadable(correction);
      await screenshotFromTop(f.page, `.settings-ui-artifacts/legacy-opening-guidance-${width}.png`);
      await f.page.getByRole("button", { name: "قبض دفعة", exact: true }).click();
      const dialog = f.page.getByRole("dialog", { name: "تحصيل دفعة", exact: true });
      await dialog.getByText("سجّل هنا مبلغًا استلمته الآن فقط", { exact: false }).waitFor();
      expect(await dialog.innerText()).toContain("تحصيل الوردية الحالية");
      expect(await dialog.innerText()).toContain("المبالغ المدفوعة قبل بدء البرنامج بيانات تاريخية");
      const submit = dialog.getByRole("button", { name: "سجّل الدفعة واطبع السند", exact: true });
      await submit.scrollIntoViewIfNeeded();
      const box = await submit.boundingBox();
      expect(box).not.toBeNull(); expect(box!.y + box!.height).toBeLessThanOrEqual(width === 390 ? 844 : 1000);
      await fits(f.page);
      await f.page.screenshot({ path: `.settings-ui-artifacts/legacy-current-collection-${width}.png` });
      await dialog.getByRole("button", { name: "إغلاق", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(f.writes).toEqual([]); expect(f.external).toEqual([]); expect(f.errors).toEqual([]);
      expect(await financialState()).toEqual(before);
    } finally { await f.context.close(); }
  });

  it("shows the same clinical-only reference to the owning doctor", async () => {
    const f = await open(390, "plans", "doctorA");
    try {
      const panel = f.page.getByRole("region", { name: "التقويم السابق ضمن خطة المريض" });
      await panel.getByText(`حالة #${caseId}`, { exact: false }).waitFor();
      expect(await panel.locator("input, form, button").count()).toBe(0);
      expect(await panel.innerText()).not.toMatch(/350\.00|35,000|المدفوع|السعودي|SAR/);
      expect(f.writes).toEqual([]); expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it("explains the remaining-only field during new-patient registration without saving", async () => {
    const f = await open(390, "account");
    try {
      await f.page.goto(`${baseUrl}/patients`, { waitUntil: "domcontentloaded" });
      await f.page.getByRole("button", { name: "+ مريض جديد", exact: true }).click();
      await f.page.getByRole("checkbox", { name: "مريض سابق: لديه مبلغ متبقٍ قبل بدء البرنامج", exact: true }).check();
      await f.page.getByLabel("مبلغ الرصيد السابق", { exact: true }).fill("350");
      await f.page.getByLabel("عملة الرصيد السابق", { exact: true }).selectOption("SAR");
      await f.page.getByText("قيمة العلاج 600، المدفوع سابقًا 250، الرصيد السابق الذي تُدخله 350", { exact: false }).waitFor();
      expect(f.writes).toEqual([]); expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });
});
