import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {} from "../fixtures/money-attempt-real-react";

// Real React StrictMode and production components; synthetic network only.
// Executed by the existing isolated CI browser job, never against clinic data.
let browser: Browser, script: string;
beforeAll(async () => {
  const bundle = await build({ absWorkingDir: process.cwd(), entryPoints: ["__tests__/fixtures/money-attempt-real-react.tsx"], bundle: true,
    write: false, platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": JSON.stringify("development") } });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 120_000);
afterAll(async () => { await browser?.close(); });
const snapshot = (page: Page) => page.evaluate(() => window.__moneyFixture.snapshot());
const retry = (page: Page) => page.getByRole("button", { name: "إعادة التحقق من العملية السابقة" });
async function open() {
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://money.test") throw new Error("Unexpected external request");
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>' });
    await route.abort();
  });
  const page = await context.newPage();
  await page.goto("http://money.test/");
  await page.getByRole("dialog").waitFor();
  return { page, context };
}
async function submit(page: Page) {
  const amount = page.getByLabel("المبلغ", { exact: true });
  // Switching patient or reopening reuses the component. Wait for its new
  // session initialization to clear the previous amount before entering one.
  await expect.poll(() => amount.inputValue()).toBe("");
  await expect.poll(() => amount.isEnabled()).toBe(true);
  await amount.fill("500");
  await expect.poll(() => amount.inputValue()).toBe("500");
  await page.getByRole("button", { name: "سجّل الدفعة واطبع السند" }).click();
  await expect.poll(async () => (await snapshot(page)).requests.length).toBeGreaterThan(0);
}

describe("DOT-PF-01 real forms", () => {
  it.each(["{", "{}", "null", '{"id":"701"}'])("never reports success for 2xx %s and replays exact request after close and remount", async (body) => {
    const f = await open();
    try {
      await submit(f.page);
      await f.page.evaluate((body) => window.__moneyFixture.reply(0, body), body);
      await expect.poll(() => retry(f.page).isEnabled()).toBe(true);
      expect((await snapshot(f.page)).successes).toEqual([]);
      expect(await f.page.getByLabel("المبلغ", { exact: true }).isDisabled()).toBe(true);
      await f.page.getByRole("button", { name: "إغلاق", exact: true }).click();
      await f.page.locator("#mount").click(); await f.page.locator("#mount").click(); await f.page.locator("#open").click();
      await retry(f.page).click();
      await expect.poll(async () => (await snapshot(f.page)).requests.length).toBe(2);
      const requests = (await snapshot(f.page)).requests;
      expect(requests[1]).toEqual(requests[0]);
      await f.page.evaluate(() => window.__moneyFixture.reply(1, '{"id":701}', 200));
      await expect.poll(async () => (await snapshot(f.page)).successes).toEqual([{ patientId: 101, id: 701 }]);
    } finally { await f.context.close(); }
  });

  it("keeps A's lost-response request across patient and target changes, without giving it to B", async () => {
    const f = await open();
    try {
      await submit(f.page); await f.page.evaluate(() => window.__moneyFixture.fail(0));
      await expect.poll(() => retry(f.page).isEnabled()).toBe(true);
      await f.page.locator("#patient-b").click();
      await f.page.getByRole("region", { name: "تحصيل دفعة من Synthetic 102" }).waitFor();
      await submit(f.page);
      await expect.poll(async () => (await snapshot(f.page)).requests.length).toBe(2);
      await f.page.evaluate(() => window.__moneyFixture.fail(1));
      await expect.poll(() => retry(f.page).isEnabled()).toBe(true);
      await f.page.locator("#patient-a").click(); await f.page.locator("#target").click();
      expect(await f.page.getByLabel("المبلغ", { exact: true }).isDisabled()).toBe(true);
      await retry(f.page).click();
      await expect.poll(async () => (await snapshot(f.page)).requests.length).toBe(3);
      const { requests } = await snapshot(f.page);
      expect(requests[1].key).not.toBe(requests[0].key);
      expect(requests[2]).toEqual(requests[0]);
    } finally { await f.context.close(); }
  });

  it.each(["#patient-b", "#target", "#close", "#mount", "#principal"])("does not apply a late acknowledgment after %s", async (change) => {
    const f = await open();
    try {
      await submit(f.page); await f.page.locator(change).click();
      await f.page.evaluate(() => window.__moneyFixture.reply(0, '{"id":701}'));
      // Allow the promise + React updates to drain, without elapsed-time sleeps.
      await f.page.evaluate(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
      expect((await snapshot(f.page)).successes).toEqual([]);
      expect((await snapshot(f.page)).requests).toHaveLength(1);
    } finally { await f.context.close(); }
  });

  it("double clicks produce one write and a valid acknowledgment permits a new key", async () => {
    const f = await open();
    try {
      await f.page.getByLabel("المبلغ", { exact: true }).fill("500");
      await f.page.getByRole("button", { name: "سجّل الدفعة واطبع السند" }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await expect.poll(async () => (await snapshot(f.page)).requests.length).toBe(1);
      await f.page.evaluate(() => window.__moneyFixture.reply(0, '{"id":701}'));
      await expect.poll(async () => (await snapshot(f.page)).successes.length).toBe(1);
      await f.page.getByRole("dialog").waitFor({ state: "hidden" });
      await f.page.locator("#open").click(); await submit(f.page);
      await expect.poll(async () => (await snapshot(f.page)).requests.length).toBe(2);
      const { requests } = await snapshot(f.page);
      expect(requests[1].key).not.toBe(requests[0].key);
    } finally { await f.context.close(); }
  });

  it("correction cannot become a void after an invalid reply, including cancellation/remount", async () => {
    const f = await open();
    try {
      await f.page.locator("#correction").click();
      await f.page.getByLabel("سبب تصحيح السند").fill("Synthetic correction reason");
      await f.page.getByRole("button", { name: "صحّح السند", exact: true }).click();
      await expect.poll(async () => (await snapshot(f.page)).requests.length).toBe(1);
      await f.page.evaluate(() => window.__moneyFixture.reply(0, "{}"));
      await expect.poll(() => retry(f.page).isEnabled()).toBe(true);
      expect((await snapshot(f.page)).successes).toEqual([]);
      expect(await f.page.getByRole("radio", { name: /إبطال السند/ }).isDisabled()).toBe(true);
      await f.page.getByRole("button", { name: "إلغاء", exact: true }).click(); await f.page.locator("#open").click();
      await retry(f.page).click();
      await expect.poll(async () => (await snapshot(f.page)).requests.length).toBe(2);
      const { requests } = await snapshot(f.page); expect(requests[1]).toEqual(requests[0]);
      await f.page.evaluate(() => window.__moneyFixture.reply(1, JSON.stringify({ reversal: { id: 801, receiptNumber: "SYN-R" }, replacement: { id: 802, receiptNumber: "SYN-P2" } }), 200));
      await expect.poll(async () => (await snapshot(f.page)).successes).toEqual([{ patientId: 101, id: 802 }]);
    } finally { await f.context.close(); }
  });
});
