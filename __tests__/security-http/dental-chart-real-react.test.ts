import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toothName } from "../../lib/dental";
import type { DentalChartFixtureSnapshot } from "../fixtures/dental-chart-real-react";

// Real React development StrictMode acceptance, isolated entirely by interception.
// No route, server, clinic, database, external network, or real mutation is used.
let browser: Browser, script: string;
const origin = "http://dental-chart.test", fixturePath = "/dental-chart-fixture", scriptPath = "/dental-chart-fixture.js";
const SAVE = "تثبيت الحالة على المخطط السني";
beforeAll(async () => {
  const bundle = await build({ absWorkingDir: process.cwd(), entryPoints: ["__tests__/fixtures/dental-chart-real-react.tsx"],
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json", metafile: true,
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
  });
  expect(bundle.outputFiles).toHaveLength(1);
  const inputs = Object.keys(bundle.metafile!.inputs);
  for (const real of ["components/DentalChart.tsx", "components/SessionProvider.tsx", "node_modules/react-dom/client.js"])
    expect(inputs.some((path) => path.endsWith(real))).toBe(true);
  expect(inputs.some((path) => /(?:^|\/)lib\/db(?:\.|\/)|node_modules\/(?:next|pg|@electric-sql)\//.test(path))).toBe(false);
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 120_000);
afterAll(async () => { await browser?.close(); });
const snapshot = (page: Page): Promise<DentalChartFixtureSnapshot> => page.evaluate(() => window.__dentalChartFixture.snapshot());
const panel = (page: Page) => page.locator("#fixture-chart");
const reads = async (page: Page) => (await snapshot(page)).requests.filter((row) => row.method === "GET");
const writes = async (page: Page) => (await snapshot(page)).requests.filter((row) => row.method === "POST");
const payload = (marker: string) => ({ records: [{ id: 401, toothCode: 11, condition: "filling", stage: "existing", surfaces: "MO",
  note: marker, recordedBy: "synthetic-clinician", recordedAt: "2026-10-05T12:00:00Z", visitId: null }] });
async function settle(page: Page) { await page.evaluate(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); }
async function grant(page: Page, marker = "accepted-chart-a") {
  const id = (await reads(page)).at(-1)!.id;
  await page.evaluate(({ id, value }) => window.__dentalChartFixture.respond(id, value), { id, value: payload(marker) });
  await expect.poll(() => panel(page).locator('[data-testid="dental-chart-workspace"]').getAttribute("data-read-state")).toBe("ready");
}
async function pick(page: Page, tooth = 11) { await panel(page).getByRole("button", { name: toothName(tooth), exact: true }).click(); }
async function hidden(page: Page) {
  expect(await panel(page).getByLabel("ملاحظة", { exact: true }).count()).toBe(0);
  expect(await panel(page).textContent()).not.toMatch(/accepted-chart|private-draft|synthetic-clinician/);
}
async function open() {
  const context = await browser.newContext({ locale: "ar-YE", serviceWorkers: "block" });
  const external: string[] = [], errors: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") { external.push(request.method() + " " + url.href); await route.abort(); return; }
    if (url.pathname === fixturePath) await route.fulfill({ status: 200, contentType: "text/html", headers: {
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
    }, body: '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head><body><div id="root"></div><script src="' + scriptPath + '"></script></body></html>' });
    else if (url.pathname === scriptPath) await route.fulfill({ status: 200, contentType: "text/javascript", body: script });
    else if (url.pathname === "/favicon.ico") await route.fulfill({ status: 204, body: "" });
    else { external.push(request.method() + " " + url.href); await route.abort(); }
  });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(origin + fixturePath, { waitUntil: "domcontentloaded" });
    await expect.poll(async () => (await snapshot(page)).setups).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => (await snapshot(page)).cleanups).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await reads(page)).length).toBeGreaterThanOrEqual(2);
    expect((await reads(page))[0].aborted).toBe(true);
    return { page, context, isolated: async () => { expect((await snapshot(page)).unexpected).toEqual([]); expect(external).toEqual([]); expect(errors).toEqual([]); } };
  } catch (error) { await context.close(); throw error; }
}
async function submit(page: Page, key = "old-save") {
  await page.evaluate(() => window.__dentalChartFixture.allow());
  const control = panel(page).getByRole("button", { name: SAVE, exact: true });
  await control.evaluate((element, key) => window.__dentalChartFixture.capture(key, element as HTMLElement), key);
  await control.click();
  await expect.poll(async () => (await writes(page)).length).toBeGreaterThan(0);
  return (await writes(page)).at(-1)!.id;
}

describe("Dental chart real React identity boundaries", () => {
  it.each(["patient-b", "patient-aba", "principal-b", "principal-aba", "permission-b"])("clears clinical data and tooth draft on %s", async (change) => {
    const f = await open();
    try {
      await grant(f.page); await pick(f.page); await panel(f.page).getByLabel("ملاحظة", { exact: true }).fill("private-draft old");
      await panel(f.page).getByRole("button", { name: SAVE, exact: true }).evaluate((element) => window.__dentalChartFixture.capture("retired", element as HTMLElement));
      await f.page.locator("#" + change).click(); await hidden(f.page);
      await f.page.evaluate(() => window.__dentalChartFixture.replay("retired")); await settle(f.page);
      expect(await writes(f.page)).toHaveLength(0); await grant(f.page, "accepted-chart-new"); await pick(f.page);
      expect(await panel(f.page).getByLabel("ملاحظة", { exact: true }).inputValue()).toBe(""); await f.isolated();
    } finally { await f.context.close(); }
  });

  it.each(["headers", "body"] as const)("ignores late patient read at %s boundary", async (boundary) => {
    const f = await open();
    try {
      const old = (await reads(f.page)).at(-1)!;
      if (boundary === "body") { await f.page.evaluate((id) => window.__dentalChartFixture.headers(id), old.id);
        await expect.poll(async () => (await reads(f.page)).find((row) => row.id === old.id)?.jsonCalls).toBe(1); }
      await f.page.locator("#patient-b").click(); await grant(f.page, "accepted-chart-b"); await pick(f.page);
      expect((await reads(f.page)).find((row) => row.id === old.id)?.aborted).toBe(true);
      await f.page.evaluate(({ id, value }) => window.__dentalChartFixture.respond(id, value), { id: old.id, value: payload("accepted-chart-old") });
      await settle(f.page); expect(await panel(f.page).textContent()).toContain("accepted-chart-b");
      expect(await panel(f.page).textContent()).not.toContain("accepted-chart-old");
      if (boundary === "headers") expect((await reads(f.page)).find((row) => row.id === old.id)?.jsonCalls).toBe(0);
      await f.isolated();
    } finally { await f.context.close(); }
  });

  for (const boundary of ["headers", "body"] as const) {
    it.each(["patient-b", "patient-aba", "principal-b", "principal-aba", "permission-b", "toggle-chart"])(
      "retires save completion after %s at " + boundary, async (change) => {
        const f = await open();
        try {
          await grant(f.page); await pick(f.page); await panel(f.page).getByLabel("ملاحظة", { exact: true }).fill("private-draft old");
          const old = await submit(f.page);
          if (boundary === "body") { await f.page.evaluate((id) => window.__dentalChartFixture.headers(id, 201), old);
            await expect.poll(async () => (await writes(f.page)).find((row) => row.id === old)?.jsonCalls).toBe(1); }
          await f.page.locator("#" + change).click();
          if (change === "toggle-chart") await f.page.locator("#toggle-chart").click();
          await grant(f.page, "accepted-chart-new"); await pick(f.page); await panel(f.page).getByLabel("ملاحظة", { exact: true }).fill("private-draft new");
          const count = (await reads(f.page)).length;
          await f.page.evaluate((id) => window.__dentalChartFixture.respond(id, { id: 402 }, 201), old);
          await f.page.evaluate(() => window.__dentalChartFixture.replay("old-save")); await settle(f.page);
          expect(await reads(f.page)).toHaveLength(count); expect(await writes(f.page)).toHaveLength(1);
          expect(await panel(f.page).getByLabel("ملاحظة", { exact: true }).inputValue()).toBe("private-draft new");
          if (boundary === "headers") expect((await writes(f.page)).find((row) => row.id === old)?.jsonCalls).toBe(0);
          await f.isolated();
        } finally { await f.context.close(); }
      });
  }

  it("resets a tooth-specific draft and rejects its retired callback after A B A", async () => {
    const f = await open();
    try {
      await grant(f.page); await pick(f.page); await panel(f.page).getByLabel("ملاحظة", { exact: true }).fill("private-draft tooth11");
      await panel(f.page).getByRole("button", { name: SAVE, exact: true }).evaluate((element) => window.__dentalChartFixture.capture("tooth11", element as HTMLElement));
      await pick(f.page, 12); expect(await panel(f.page).getByLabel("ملاحظة", { exact: true }).inputValue()).toBe("");
      await pick(f.page, 11); await f.page.evaluate(() => window.__dentalChartFixture.replay("tooth11")); await settle(f.page);
      expect(await writes(f.page)).toHaveLength(0); await f.isolated();
    } finally { await f.context.close(); }
  });

  it("retains rejected draft and admits one repeated-click write before a successful current refresh", async () => {
    const f = await open();
    try {
      await grant(f.page); await pick(f.page); await panel(f.page).getByLabel("ملاحظة", { exact: true }).fill("private-draft retry");
      const old = await submit(f.page);
      await f.page.evaluate(() => window.__dentalChartFixture.replay("old-save")); await settle(f.page);
      expect(await writes(f.page)).toHaveLength(1);
      await f.page.evaluate((id) => window.__dentalChartFixture.respond(id, { message: "Synthetic rejected" }, 409), old);
      await expect.poll(() => panel(f.page).getByRole("button", { name: SAVE, exact: true }).isDisabled()).toBe(false);
      expect(await panel(f.page).getByLabel("ملاحظة", { exact: true }).inputValue()).toBe("private-draft retry");
      const next = await submit(f.page, "retry"); expect((await writes(f.page)).at(-1)?.submitted).toMatchObject({ toothCode: 11, note: "private-draft retry" });
      const readCount = (await reads(f.page)).length;
      await f.page.evaluate((id) => window.__dentalChartFixture.respond(id, { id: 402 }, 201), next);
      await expect.poll(async () => (await reads(f.page)).length).toBe(readCount + 1);
      await grant(f.page, "accepted-chart-saved"); expect(await panel(f.page).textContent()).toContain("accepted-chart-saved");
      await f.isolated();
    } finally { await f.context.close(); }
  });
  it.each(["network", "server", "unauthenticated", "forbidden"] as const)("requires a fresh chart read after %s save failure", async (failure) => {
    const f = await open();
    try {
      await grant(f.page); await pick(f.page); await panel(f.page).getByLabel("ملاحظة", { exact: true }).fill("private-draft uncertain");
      const old = await submit(f.page);
      if (failure === "network") await f.page.evaluate((id) => window.__dentalChartFixture.fail(id), old);
      else await f.page.evaluate(({ id, status }) => window.__dentalChartFixture.respond(id, { message: "Synthetic failure" }, status),
        { id: old, status: failure === "server" ? 500 : failure === "forbidden" ? 403 : 401 });
      await expect.poll(() => panel(f.page).locator('[data-testid="dental-chart-workspace"]').getAttribute("data-read-state")).toBe("error");
      await hidden(f.page); const count = (await reads(f.page)).length;
      await f.page.evaluate(() => window.__dentalChartFixture.replay("old-save")); await settle(f.page);
      expect(await writes(f.page)).toHaveLength(1); expect(await reads(f.page)).toHaveLength(count);
      await panel(f.page).getByRole("button", { name: "إعادة تحميل مخطط الأسنان", exact: true }).click(); await grant(f.page, "accepted-chart-reconciled");
      await pick(f.page); await f.page.evaluate(() => window.__dentalChartFixture.replay("old-save")); await settle(f.page);
      expect(await writes(f.page)).toHaveLength(1); await f.isolated();
    } finally { await f.context.close(); }
  });

});
