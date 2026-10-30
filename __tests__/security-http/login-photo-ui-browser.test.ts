import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

// Real built-app acceptance on the disposable harness only. The only screenshots
// are fresh unauthenticated login pages with empty inputs and a synthetic image.
// Never screenshot settings, persist cookies/storage, or enable traces/video.
const KEYS = ["clinic.login_photo_asset", "clinic.login_photo_visible"];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const ARTIFACTS = join(process.cwd(), ".settings-ui-artifacts", "login-reference");
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

async function isolatedContext(width: number): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar-YE", serviceWorkers: "block" });
  await context.route("**/*", route => new URL(route.request().url()).origin === new URL(baseUrl).origin
    ? route.continue() : route.abort("blockedbyclient"));
  return context;
}
async function freshLogin(page: Page) {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#login-submit-btn").waitFor();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.locator("#username").inputValue()).toBe("");
  expect(await page.locator("#password").inputValue()).toBe("");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

describe("owner uploads and controls the login photo through Settings", () => {
  it("keeps uploads private, publishes explicitly and hides without deleting at desktop and mobile widths", async () => {
    const url = new URL(h.seeded.dbUrl);
    expect(["postgres:", "postgresql:"]).toContain(url.protocol);
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname);
    expect(url.pathname).toBe("/aqlan_sec_http");
    const db = new Client({ host: url.hostname === "[::1]" ? "::1" : url.hostname,
      port: Number(url.port || "5432"), database: "aqlan_sec_http", ssl: false,
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) });
    await db.connect();
    const { rows: saved } = await db.query("SELECT key,value,updated_at FROM settings WHERE key=ANY($1::text[])", [KEYS]);
    try {
      for (const width of [1280, 390]) {
        const adminContext = await isolatedContext(width);
        const visitorContext = await isolatedContext(width);
        try {
          const pair = h.sessions.admin.cookie.split(";")[0];
          const separator = pair.indexOf("=");
          await adminContext.addCookies([{ name: pair.slice(0, separator), value: pair.slice(separator + 1), url: baseUrl }]);
          const settings = await adminContext.newPage();
          const visitor = await visitorContext.newPage();
          await settings.goto(`${baseUrl}/settings`, { waitUntil: "domcontentloaded" });
          await settings.locator("#settings-search").fill("صورة شاشة الدخول");
          const card = settings.getByRole("article", { name: "صورة شاشة الدخول", exact: true });
          await card.waitFor();
          await card.getByLabel("اختيار صورة أو تغييرها").setInputFiles({ name: "synthetic-login.png", mimeType: "image/png", buffer: PNG });
          const upload = settings.waitForResponse(r => new URL(r.url()).pathname === "/api/settings/login-photo" && r.request().method() === "POST");
          await card.getByRole("button", { name: "حفظ الصورة مخفية", exact: true }).press("Enter");
          expect((await upload).status()).toBe(200);
          await card.getByText("الحالة: محفوظة ومخفية", { exact: true }).waitFor();
          await expect.poll(() => card.getByRole("img", { name: "معاينة صورة شاشة الدخول" }).evaluate(n =>
            (n as HTMLImageElement).complete && (n as HTMLImageElement).naturalWidth > 0)).toBe(true);
          expect((await fetch(`${baseUrl}/api/branding/login-photo`)).status).toBe(404);
          await freshLogin(visitor);
          expect(await visitor.getByRole("img", { name: "صورة شاشة الدخول", exact: true }).count()).toBe(0);
          const show = card.getByRole("button", { name: "إظهار الصورة للزوار", exact: true });
          await show.focus();
          expect(await show.evaluate(n => document.activeElement === n)).toBe(true);
          const shown = settings.waitForResponse(r => new URL(r.url()).pathname === "/api/settings/login-photo" && r.request().method() === "PATCH");
          await show.press("Enter");
          expect((await shown).status()).toBe(200);
          await card.getByText("الحالة: ظاهرة للزوار", { exact: true }).waitFor();
          const publicImage = await fetch(`${baseUrl}/api/branding/login-photo`);
          expect(publicImage.status).toBe(200);
          expect(publicImage.headers.get("cache-control")).toContain("no-store");
          expect(Buffer.from(await publicImage.arrayBuffer()).equals(PNG)).toBe(true);
          await freshLogin(visitor);
          const photo = visitor.getByRole("img", { name: "صورة شاشة الدخول", exact: true });
          await photo.waitFor();
          await expect.poll(() => photo.evaluate(n => (n as HTMLImageElement).complete
            && (n as HTMLImageElement).naturalWidth > 0)).toBe(true);
          const box = await photo.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
          await mkdir(ARTIFACTS, { recursive: true });
          await visitor.screenshot({ path: join(ARTIFACTS, `login-photo-${width}.png`), fullPage: true, animations: "disabled" });
          expect(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
          const hide = card.getByRole("button", { name: "إخفاء الصورة", exact: true });
          const hidden = settings.waitForResponse(r => new URL(r.url()).pathname === "/api/settings/login-photo" && r.request().method() === "PATCH");
          await hide.press("Enter");
          expect((await hidden).status()).toBe(200);
          await card.getByText("الحالة: محفوظة ومخفية", { exact: true }).waitFor();
          expect(await card.getByRole("img", { name: "معاينة صورة شاشة الدخول" }).count()).toBe(1);
          expect((await fetch(`${baseUrl}/api/branding/login-photo`)).status).toBe(404);
          await freshLogin(visitor);
          expect(await visitor.getByRole("img", { name: "صورة شاشة الدخول", exact: true }).count()).toBe(0);
          const logos = visitor.locator('img[alt="شعار المركز"]');
          expect(await logos.count()).toBeGreaterThan(0);
          await expect.poll(() => logos.evaluateAll(nodes => nodes.every(n =>
            (n as HTMLImageElement).complete && (n as HTMLImageElement).naturalWidth > 0))).toBe(true);
        } finally {
          await adminContext.close();
          await visitorContext.close();
        }
      }
    } finally {
      // Restore only the fixture keys. Audit rows remain immutable; uploaded
      // synthetic bytes are owned and removed by the global harness lifecycle.
      try {
        await db.query("DELETE FROM settings WHERE key=ANY($1::text[])", [KEYS]);
        for (const row of saved) await db.query("INSERT INTO settings(key,value,updated_at) VALUES($1,$2,$3)", [row.key, row.value, row.updated_at]);
      } finally { await db.end(); }
    }
  }, 180_000);
});
