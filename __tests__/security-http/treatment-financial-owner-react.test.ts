import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";
import type {} from "../fixtures/treatment-financial-owner";

/** Real production component/React with controllable transport, not PG/HTTP integration evidence.
 * Live money/identity reader acceptance is supplied by the separate HTTP journey suite. */
let browser: Browser;
let script = "";
const fixturePath = "/__test_only_financial_owner__/";
beforeAll(async () => {
  const h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  const bundle = await build({ absWorkingDir: process.cwd(),
    entryPoints: ["__tests__/fixtures/treatment-financial-owner.tsx"], bundle: true, write: false,
    platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json", metafile: true,
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
  });
  const inputs = Object.keys(bundle.metafile!.inputs);
  for (const path of ["components/TreatmentFinancialContext.tsx", "lib/treatment-financial-context-validation.ts", "node_modules/react-dom/client.js"]) {
    expect(inputs.some((input) => input.endsWith(path))).toBe(true);
  }
  expect(inputs.some((input) => /lib\/db\.ts|node_modules\/pg\//.test(input))).toBe(false);
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240000);
afterAll(async () => { await browser?.close(); });
const requests = (page: Page) => page.evaluate(() => window.__financialOwner.requests());
async function latest(page: Page, count: number) {
  await expect.poll(async () => (await requests(page)).length).toBe(count);
  return (await requests(page)).at(-1)!.id;
}
async function mount() {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  await page.route(`**${fixturePath}**`, (route) => route.fulfill({
    status: 200, contentType: "text/html",
    body: '<!doctype html><html dir="rtl"><body><div id="root"></div><script>' + script.replace(/<\/script/gi, "<\\/script") + "</script></body></html>",
  }));
  await page.goto(baseUrl + fixturePath);
  await latest(page, 1);
  return { context, page };
}
describe("financial component generation and permission fences", () => {
  it("withdraws accepted A for B and never revives A while the second A read is pending", async () => {
    const { context, page } = await mount();
    try {
      await page.evaluate(() => window.__financialOwner.respond(1, 11, "accepted-A"));
      await page.getByText("accepted-A", { exact: true }).waitFor();
      await page.evaluate(() => window.__financialOwner.set({ patientId: 11, canView: true, authorityKey: "B" }));
      const b = await latest(page, 2);
      expect(await page.getByText("accepted-A", { exact: true }).count()).toBe(0);
      await page.evaluate(() => window.__financialOwner.set({ patientId: 11, canView: true, authorityKey: "A" }));
      const secondA = await latest(page, 3);
      expect(await page.getByText("accepted-A", { exact: true }).count()).toBe(0);
      await page.evaluate((id) => window.__financialOwner.respond(id, 11, "late-B"), b);
      await page.waitForTimeout(0);
      expect(await page.getByText("late-B", { exact: true }).count()).toBe(0);
      expect((await requests(page)).find((request) => request.id === b)?.aborted).toBe(true);
      await page.evaluate((id) => window.__financialOwner.respond(id, 11, "denied", 403), secondA);
      await page.getByRole("alert").waitFor();
      expect(await page.locator("#financial-owner-fixture a").count()).toBe(0);
    } finally { await context.close(); }
  });
  it("capability revoke/regrant with unchanged principal requires a new read", async () => {
    const { context, page } = await mount();
    try {
      await page.evaluate(() => window.__financialOwner.respond(1, 11, "accepted-before-revoke"));
      await page.getByText("accepted-before-revoke", { exact: true }).waitFor();
      await page.evaluate(() => window.__financialOwner.set({ patientId: 11, canView: false, authorityKey: "A" }));
      await expect.poll(() => page.locator("#financial-owner-fixture").textContent()).toBe("");
      expect((await requests(page)).length).toBe(1);
      await page.evaluate(() => window.__financialOwner.set({ patientId: 11, canView: true, authorityKey: "A" }));
      const granted = await latest(page, 2);
      expect(await page.getByText("accepted-before-revoke", { exact: true }).count()).toBe(0);
      await page.evaluate((id) => window.__financialOwner.respond(id, 11, "accepted-after-regrant"), granted);
      await page.getByText("accepted-after-regrant", { exact: true }).waitFor();
    } finally { await context.close(); }
  });
  it("ignores late prior-patient bodies and refuses wrong-owner payloads", async () => {
    const { context, page } = await mount();
    try {
      await page.evaluate(() => window.__financialOwner.set({ patientId: 12, canView: true, authorityKey: "A" }));
      const next = await latest(page, 2);
      await page.evaluate(() => window.__financialOwner.respond(1, 11, "late-patient-11"));
      await page.waitForTimeout(0);
      expect(await page.getByText("late-patient-11", { exact: true }).count()).toBe(0);
      await page.evaluate((id) => window.__financialOwner.respond(id, 11, "wrong-owner"), next);
      await page.getByRole("alert").waitFor();
      expect(await page.locator("#financial-owner-fixture a").count()).toBe(0);
    } finally { await context.close(); }
  });
});
