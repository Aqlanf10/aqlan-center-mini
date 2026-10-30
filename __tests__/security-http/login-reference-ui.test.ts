import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness, TEST_USERS } from "./_server";

// Hosted acceptance of the built app against the existing isolated CI database.
// Only two pristine, unauthenticated screenshots are written. Never capture after
// entering credentials, export storage/cookies, or enable traces/video.
const ARTIFACTS = join(process.cwd(), ".settings-ui-artifacts", "login-reference");
const USERNAME_KEY = "aqlan_center_saved_username";
let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  await harness();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
}, 240_000);

beforeEach(async () => {
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 }, locale: "ar-YE", serviceWorkers: "block",
  });
  await context.route("**/*", route => {
    return new URL(route.request().url()).origin === new URL(baseUrl).origin
      ? route.continue()
      : route.abort("blockedbyclient");
  });
  page = await context.newPage();
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#login-submit-btn").waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
});

afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); });

describe("login reference with official clinic identity on the built app", () => {
  for (const width of [1280, 390]) {
    it(`captures only the pristine ${width}px login and verifies official colors/reflow`, async () => {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      expect(await page.locator("#username").inputValue()).toBe("");
      expect(await page.locator("#password").inputValue()).toBe("");
      expect(await page.getByRole("checkbox").isChecked()).toBe(false);
      expect(await page.locator("#login-form").count()).toBe(1);
      expect(await page.locator("main").getAttribute("dir")).toBe("rtl");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(await page.locator("main").evaluate(n => getComputedStyle(n).backgroundColor)).toBe("rgb(242, 246, 251)");
      expect(await page.locator("#login-submit-btn").evaluate(n => getComputedStyle(n).backgroundColor)).toBe("rgb(13, 33, 55)");
      const logos = page.locator('img[alt="شعار المركز"]');
      expect(await logos.count()).toBeGreaterThan(0);
      await expect.poll(() => logos.evaluateAll(nodes => nodes.every(n =>
        (n as HTMLImageElement).complete && (n as HTMLImageElement).naturalWidth > 0
          && new URL((n as HTMLImageElement).src).origin === location.origin,
      ))).toBe(true);
      for (const id of ["username", "password", "login-submit-btn"]) {
        const box = await page.locator(`#${id}`).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      }
      // Screenshot is the full real document at this viewport, not a resized image.
      // No user was signed in and neither input has ever been filled in this context.
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({ path: join(ARTIFACTS, `login-${width}.png`), fullPage: true, animations: "disabled" });
    });
  }

  it("supports keyboard reveal and disclosure focus restoration without losing typed values", async () => {
    const password = page.locator("#password");
    await password.fill("Synthetic-visibility-only");
    await password.press("Tab");
    const reveal = page.getByRole("button", { name: "إظهار كلمة المرور", exact: true });
    expect(await reveal.evaluate(n => document.activeElement === n)).toBe(true);
    await page.keyboard.press("Enter");
    expect(await password.getAttribute("type")).toBe("text");
    await page.getByRole("button", { name: "إخفاء كلمة المرور", exact: true }).press("Enter");
    expect(await password.getAttribute("type")).toBe("password");
    const help = page.getByRole("button", { name: "نسيت كلمة المرور؟", exact: true });
    await help.press("Enter");
    expect(await page.locator("#login-help").isVisible()).toBe(true);
    await page.getByRole("button", { name: "إغلاق الإرشاد", exact: true }).press("Enter");
    expect(await help.evaluate(n => document.activeElement === n)).toBe(true);
    expect(await help.getAttribute("aria-expanded")).toBe("false");
    expect(await password.inputValue()).toBe("Synthetic-visibility-only");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#login-submit-btn").waitFor();
    expect(await page.locator("#password").inputValue()).toBe("");
    expect(await page.locator("#login-help").count()).toBe(0);
  });

  it("renders query errors and clears them on browser Back without persisting credentials", async () => {
    await page.goto(`${baseUrl}/login?error=invalid_credentials`, { waitUntil: "domcontentloaded" });
    await page.locator("#login-error-alert").waitFor();
    expect(await page.locator("#login-error-alert").innerText()).toContain("غير صحيحة");
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.locator("#login-submit-btn").waitFor();
    expect(await page.locator("#login-error-alert").count()).toBe(0);
    expect(await page.locator("#username").inputValue()).toBe("");
    expect(await page.getByRole("checkbox").isChecked()).toBe(false);
  });

  it("shows an honest offline hint, attempts the request, and recovers the button on network failure", async () => {
    await context.setOffline(true);
    await expect.poll(() => page.getByText("يبدو أن الجهاز غير متصل بالإنترنت حالياً.", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText("متصل بالخادم السحابي الآمن", { exact: true }).count()).toBe(0);
    let requests = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/auth/login") requests++; });
    await page.locator("#username").fill("synthetic-offline");
    await page.locator("#password").fill("Synthetic-offline-only");
    await page.locator("#login-submit-btn").click();
    await page.locator("#login-error-alert").waitFor();
    expect(requests).toBe(1);
    expect(await page.locator("#login-error-alert").innerText()).toContain("تعذّر الاتصال بالخادم");
    expect(await page.locator("#login-submit-btn").isEnabled()).toBe(true);
    await context.setOffline(false);
    await expect.poll(() => page.getByText("يبدو أن الجهاز غير متصل بالإنترنت حالياً.", { exact: true }).count()).toBe(0);
  });

  it("rejects malformed HTTP200 before username persistence or navigation, and permits retry", async () => {
    let requests = 0;
    await page.route("**/api/auth/login", async route => {
      requests++;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.locator("#username").fill("synthetic-malformed");
    await page.locator("#password").fill("Synthetic-malformed-only");
    await page.getByRole("checkbox").check();
    await page.locator("#login-submit-btn").click();
    await page.locator("#login-error-alert").waitFor();
    expect(await page.locator("#login-error-alert").innerText()).toContain("تعذّر تأكيد");
    expect(new URL(page.url()).pathname).toBe("/login");
    expect(await page.evaluate(key => localStorage.getItem(key), USERNAME_KEY)).toBeNull();
    expect(await page.locator("#login-submit-btn").isEnabled()).toBe(true);
    await page.locator("#login-submit-btn").click();
    await expect.poll(() => requests).toBe(2);
  });

  it("signs in the existing synthetic reception fixture using the real API and HttpOnly session", async () => {
    await page.locator("#username").fill(TEST_USERS.reception.username);
    await page.locator("#password").fill(TEST_USERS.reception.password);
    const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/login" && r.request().method() === "POST");
    await page.locator("#login-submit-btn").click();
    expect((await response).status()).toBe(200);
    await page.waitForURL(url => url.pathname === "/", { timeout: 30_000 });
    // Assert flags only. Never print, snapshot, store, or upload cookie values.
    const session = (await context.cookies()).find(cookie => cookie.name === "aqlan_flow_session");
    expect(Boolean(session)).toBe(true);
    expect(session?.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie.includes("aqlan_flow_session="))).toBe(false);
    expect(await page.evaluate(key => localStorage.getItem(key), USERNAME_KEY)).toBeNull();
    // No screenshot or trace is taken in this authenticated context.
  });
});
