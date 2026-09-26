import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  const h = await harness();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.accountant.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  page = await context.newPage();
}, 180_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

describe("accountant finance UI", () => {
  it("keeps reading and navigation while hiding cash, shift and lab mutations", async () => {
    await page.goto(`${baseUrl}/finance`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => page.getByRole("note").filter({ hasText: "وضع الاطلاع" }).count()).toBe(1);
    await expect.poll(() => page.getByRole("button", { name: /الذمم والتحصيل والمعامل/ }).count()).toBe(1);
    for (const name of [/سند قبض سريع/, /سند صرف نثري/, /فتح وردية جديدة/, /افتح وردية الصندوق/, /إغلاق الوردية/, /إغلاق وجرد الوردية/, /تسوية معمل أسنان/]) {
      expect(await page.getByRole("button", { name }).count(), String(name)).toBe(0);
    }
    await page.getByRole("button", { name: /الذمم والتحصيل والمعامل/ }).click();
    expect(await page.getByRole("button", { name: "تحصيل", exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: /تسوية كشف المعمل/ }).count()).toBe(0);
    await page.goto(`${baseUrl}/finance/reconciliation`, { waitUntil: "domcontentloaded" });
    expect(await page.getByRole("button", { name: /فتح وردية جديدة|جرد وإقفال الوردية/ }).count()).toBe(0);
    expect(await page.getByText("الوردية الحالية").count()).toBeGreaterThan(0);
  });
});
