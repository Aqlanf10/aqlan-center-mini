import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";
import type {} from "../fixtures/clinical-context-owner";

/** Production hook + real React with controlled late transport. Not backend/writer proof. */
let browser: Browser, script = "";
const fixturePath = "/__test_only_clinical_context_owner__/";
beforeAll(async () => {
  const h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  const bundle = await build({ absWorkingDir: process.cwd(), entryPoints: ["__tests__/fixtures/clinical-context-owner.tsx"],
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json", metafile: true,
    define: { "process.env.NODE_ENV": JSON.stringify("development") } });
  for (const suffix of ["components/useClinicalNavigationContext.ts", "lib/patient-navigation.ts", "node_modules/react-dom/client.js"]) {
    expect(Object.keys(bundle.metafile!.inputs).some((input) => input.endsWith(suffix))).toBe(true);
  }
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240000);
afterAll(async () => { await browser?.close(); });
const count = (page: Page) => page.evaluate(() => window.__clinicalOwner.requests().length);
async function mount() {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  await page.route(`**${fixturePath}**`, (route) => route.fulfill({ status: 200, contentType: "text/html",
    body: '<!doctype html><html dir="rtl"><body><div id="root"></div><script>' + script.replace(/<\/script/gi, "<\\/script") + '</script></body></html>' }));
  await page.goto(baseUrl + fixturePath); await expect.poll(() => count(page)).toBe(1);
  return { context, page };
}
const valid = (patientId = 11, orthoCaseId = 51) => ({ ok: true, context: { patientId, orthoCaseId }, specialty: "orthodontics", sub: "ortho" });
describe("clinical context generations and strict response validation", () => {
  it("does not resurrect prior A after A → B → A, even with late ignored-abort bodies", async () => {
    const { page, context } = await mount();
    try {
      await page.evaluate((payload) => window.__clinicalOwner.respond(1, payload), valid());
      await expect.poll(() => page.locator("#clinical-owner-result").getAttribute("data-ready")).toBe("true");
      await page.evaluate(() => window.__clinicalOwner.set({ patientId: 11, authority: "B", context: { orthoCaseId: 51 } }));
      await expect.poll(() => count(page)).toBe(2);
      await page.evaluate(() => window.__clinicalOwner.set({ patientId: 11, authority: "A", context: { orthoCaseId: 51 } }));
      await expect.poll(() => count(page)).toBe(3);
      expect(await page.locator("#clinical-owner-result").textContent()).toBe("loading");
      await page.evaluate((payload) => window.__clinicalOwner.respond(2, payload), valid());
      await page.waitForTimeout(0);
      expect(await page.locator("#clinical-owner-result").textContent()).toBe("loading");
      await page.evaluate(() => window.__clinicalOwner.respond(3, {}, 403));
      await expect.poll(() => page.locator("#clinical-owner-result").textContent()).toContain("لم يتم اختيار");
      expect(await page.locator("#clinical-owner-result").getAttribute("data-ready")).toBe("false");
    } finally { await context.close(); }
  });
  it("withdraws old patient state and rejects coercible derived IDs", async () => {
    const { page, context } = await mount();
    try {
      await page.evaluate(() => window.__clinicalOwner.set({ patientId: 12, authority: "A", context: { orthoCaseId: 52 } }));
      await expect.poll(() => count(page)).toBe(2);
      await page.evaluate((payload) => window.__clinicalOwner.respond(1, payload), valid());
      await page.waitForTimeout(0); expect(await page.locator("#clinical-owner-result").textContent()).toBe("loading");
      await page.evaluate(() => window.__clinicalOwner.respond(2, { ok: true, context: { patientId: 12, orthoCaseId: 52, clinicalCaseId: "42" }, specialty: "orthodontics", sub: "ortho" }));
      await expect.poll(() => page.locator("#clinical-owner-result").textContent()).toContain("لم يتم اختيار");
    } finally { await context.close(); }
  });
  it("invalid explicit contexts never fetch or use a previous accepted result", async () => {
    const { page, context } = await mount();
    try {
      await page.evaluate((payload) => window.__clinicalOwner.respond(1, payload), valid());
      await expect.poll(() => page.locator("#clinical-owner-result").getAttribute("data-ready")).toBe("true");
      await page.evaluate(() => window.__clinicalOwner.set({ patientId: 11, authority: "A", invalid: true }));
      await expect.poll(() => page.locator("#clinical-owner-result").textContent()).toContain("غير صالح");
      expect(await count(page)).toBe(1);
    } finally { await context.close(); }
  });
});
