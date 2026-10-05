import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import type { TodayFixtureSnapshot } from "../fixtures/today-readiness-real-react";

let browser: Browser, script = "";
const path = "/__test_only_today_readiness__/", scriptPath = path + "fixture.js";
beforeAll(async () => {
  const h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  const bundle = await build({ absWorkingDir: process.cwd(), entryPoints: ["__tests__/fixtures/today-readiness-real-react.tsx"],
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json",
    metafile: true, define: { "process.env.NODE_ENV": JSON.stringify("development") } });
  expect(bundle.outputFiles).toHaveLength(1);
  const inputs = Object.keys(bundle.metafile!.inputs);
  for (const real of ["components/today/useChairReadiness.ts", "components/today/ReadinessChip.tsx",
    "components/SessionProvider.tsx", "node_modules/react-dom/client.js"]) {
    expect(inputs.some(input => input.endsWith(real))).toBe(true);
  }
  expect(inputs.some(input => /(?:^|\/)lib\/db(?:\.|\/)|node_modules\/(?:pg|@electric-sql|next)\//.test(input))).toBe(false);
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });
const snapshot = (page: Page): Promise<TodayFixtureSnapshot> => page.evaluate(() => window.__todayReadinessFixture.snapshot());
const panel = (page: Page) => page.locator("#today-fixture");
const state = (page: Page) => panel(page).getAttribute("data-state");
const settle = (page: Page) => page.evaluate(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
async function latest(page: Page) {
  await expect.poll(async () => (await snapshot(page)).reads.length).toBeGreaterThan(0);
  return (await snapshot(page)).reads.at(-1)!.id;
}
async function reload(page: Page) {
  const count = (await snapshot(page)).reads.length;
  await page.evaluate(() => window.__todayReadinessFixture.reload());
  await expect.poll(async () => (await snapshot(page)).reads.length).toBe(count + 1);
  const id = await latest(page);
  // Request creation is synchronous; React's loading commit is not. Observe
  // both before delivering a body so a preceding ready view cannot satisfy
  // the completion check for this request.
  await expect.poll(() => state(page)).toBe("loading");
  expect((await snapshot(page)).reads.find(read => read.id === id)).toMatchObject({ id, aborted: false, jsonCalls: 0 });
  return id;
}
async function respond(page: Page, id: number, patient = 91) {
  await page.evaluate(({ id, patient }) => window.__todayReadinessFixture.respond(id, patient), { id, patient });
  await expect.poll(() => state(page)).toBe("ready");
  await revealChecklist(page);
}
async function revealChecklist(page: Page) {
  const details = panel(page).locator("details");
  if (await details.count() && await details.getAttribute("open") === null) await details.locator("summary").click();
}
async function fixture(body: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const external: string[] = [], errors: string[] = [];
  const guard = await guardBrowserRoutes(context, baseUrl, external, async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== baseUrl || request.method() !== "GET") {
      external.push(request.method() + " " + url.origin + url.pathname); await route.abort(); return;
    }
    if (url.pathname === path) await route.fulfill({ contentType: "text/html", headers: {
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
    }, body: '<!doctype html><html lang="ar" dir="rtl"><body><div id="root"></div><script src="' + scriptPath + '"></script></body></html>' });
    else if (url.pathname === scriptPath) await route.fulfill({ contentType: "text/javascript", body: script });
    else if (url.pathname === "/favicon.ico") await route.fulfill({ status: 204, body: "" });
    else { external.push(request.method() + " " + url.pathname); await route.abort(); }
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await guard.run(async () => {
    await page.clock.install();
    await page.goto(baseUrl + path, { waitUntil: "domcontentloaded" });
    await panel(page).waitFor();
    await expect.poll(async () => (await snapshot(page)).setups).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => (await snapshot(page)).cleanups).toBeGreaterThanOrEqual(1);
    await body(page);
    const final = await snapshot(page); expect(final.unexpected).toEqual([]); expect(final.clears).toEqual([]);
  }, () => { expect(external).toEqual([]); expect(errors).toEqual([]); });
}
async function capture(page: Page, kind: string) {
  if (kind === "reload") await page.evaluate(() => window.__todayReadinessFixture.captureReload("old"));
  else await panel(page).getByRole("button", { name: "أعد التحقق", exact: true })
    .evaluate(element => window.__todayReadinessFixture.captureRetry("old", element as HTMLElement));
}
async function unavailable(page: Page) {
  await page.evaluate(id => window.__todayReadinessFixture.headers(id, 503), await latest(page));
  await expect.poll(() => state(page)).toBe("unavailable");
}

describe("Today read lifetimes in real React development StrictMode", () => {
  for (const callback of ["reload", "retry"]) {
    it.each(["principal-aba", "patient-aba", "permission-aba"])("keeps retained " + callback + " inert after committed %s", async control => {
      await fixture(async page => {
        await unavailable(page); await capture(page, callback);
        const before = (await snapshot(page)).reads.length;
        await page.locator("#" + control).click();
        await expect.poll(async () => (await snapshot(page)).reads.length).toBeGreaterThan(before);
        const current = await latest(page), count = (await snapshot(page)).reads.length;
        await page.evaluate(() => window.__todayReadinessFixture.replay("old")); await settle(page);
        const after = await snapshot(page);
        expect(after.reads).toHaveLength(count); expect(after.reads.find(read => read.id === current)?.aborted).toBe(false);
        await respond(page, current);
      });
    });
    it("keeps retained " + callback + " inert across hidden/foreground renewal", async () => {
      await fixture(async page => {
        await unavailable(page); await capture(page, callback);
        await page.evaluate(() => window.__todayReadinessFixture.visibility("hidden"));
        const count = (await snapshot(page)).reads.length;
        await page.evaluate(() => { window.__todayReadinessFixture.replay("old"); window.__todayReadinessFixture.visibility("visible");
          window.__todayReadinessFixture.replay("old"); });
        await expect.poll(async () => (await snapshot(page)).reads.length).toBe(count + 1);
        const current = await latest(page);
        await page.evaluate(() => window.__todayReadinessFixture.replay("old")); await settle(page);
        expect((await snapshot(page)).reads).toHaveLength(count + 1);
        expect((await snapshot(page)).reads.at(-1)?.aborted).toBe(false);
        await respond(page, current);
      });
    });
  }
  it.each([401, 403, 404])("revokes previous confidential rows at %i headers without parsing a stuck body", async status => {
    await fixture(async page => {
      await respond(page, await latest(page)); expect(await panel(page).innerText()).toContain("عليه");
      const id = await reload(page);
      await page.evaluate(({ id, status }) => window.__todayReadinessFixture.headers(id, status), { id, status });
      await expect.poll(() => state(page)).toBe("unavailable");
      expect((await snapshot(page)).reads.find(read => read.id === id)?.jsonCalls).toBe(0);
      expect(await panel(page).innerText()).not.toContain("تحذير المريض"); expect(await panel(page).innerText()).not.toContain("عليه");
      await page.evaluate(id => window.__todayReadinessFixture.body(id), id); await settle(page);
      expect(await state(page)).toBe("unavailable");
    });
  });
  it.each(["headers", "body"])("ignores an older %s success after a new warning is current", async boundary => {
    await fixture(async page => {
      const old = await latest(page);
      if (boundary === "body") {
        await page.evaluate(id => window.__todayReadinessFixture.headers(id), old);
        await expect.poll(async () => (await snapshot(page)).reads[old].jsonCalls).toBe(1);
      }
      const current = await reload(page);
      await page.evaluate(id => window.__todayReadinessFixture.respond(id, 91, { warning: "تحذير أحدث" }), current);
      await expect.poll(() => state(page)).toBe("ready");
      await revealChecklist(page);
      await page.evaluate(id => window.__todayReadinessFixture.respond(id), old); await settle(page);
      expect(await panel(page).innerText()).toContain("تحذير أحدث");
      expect(await panel(page).innerText()).not.toContain("تحذير المريض الأول");
    });
  });
  it.each(["headers", "body"])("bounds stalled %s, labels cached warning and recovers on keyboard retry", async boundary => {
    await fixture(async page => {
      await page.evaluate(id => window.__todayReadinessFixture.respond(id, 91, { cleared: true }), await latest(page));
      await expect.poll(() => state(page)).toBe("ready");
      const stalled = await reload(page);
      if (boundary === "body") await page.evaluate(id => window.__todayReadinessFixture.headers(id), stalled);
      expect(await panel(page).innerText()).toContain("آخر تنبيه محفوظ");
      expect(await panel(page).innerText()).not.toContain("جاهز ✓"); expect(await panel(page).innerText()).not.toContain("عليه");
      await page.clock.fastForward(15_001); await expect.poll(() => state(page)).toBe("unavailable");
      expect((await snapshot(page)).reads[stalled].aborted).toBe(true);
      const count = (await snapshot(page)).reads.length;
      await panel(page).getByRole("button", { name: "أعد التحقق", exact: true }).focus(); await page.keyboard.press("Enter");
      await expect.poll(async () => (await snapshot(page)).reads.length).toBe(count + 1);
      await respond(page, await latest(page));
      await page.evaluate(id => window.__todayReadinessFixture.respond(id, 91, { warning: "متأخر" }), stalled); await settle(page);
      expect(await panel(page).innerText()).not.toContain("متأخر");
    });
  });
  it("relinks the current row without ever displaying the previous patient's cached body", async () => {
    await fixture(async page => {
      await respond(page, await latest(page)); const old = await reload(page);
      await page.evaluate(id => window.__todayReadinessFixture.headers(id), old);
      const count = (await snapshot(page)).reads.length;
      await page.locator("#patient-b").click();
      expect(await panel(page).innerText()).not.toContain("تحذير المريض الأول");
      await expect.poll(async () => (await snapshot(page)).reads.length).toBeGreaterThan(count);
      const current = await latest(page); await respond(page, current, 92);
      await page.evaluate(id => window.__todayReadinessFixture.body(id, 91), old); await settle(page);
      expect(await panel(page).innerText()).toContain("تحذير المريض الثاني");
      expect(await panel(page).innerText()).not.toContain("تحذير المريض الأول");
    });
  });
  it("accepts redacted current data, rejects malformed replacement and does not restore cached money", async () => {
    await fixture(async page => {
      await respond(page, await latest(page));
      const redacted = await reload(page);
      await page.evaluate(id => window.__todayReadinessFixture.respond(id, 91, { redacted: true }), redacted);
      await expect.poll(() => state(page)).toBe("ready");
      // This text exists only in the committed redacted view. Waiting on ready
      // alone previously observed the old ready view before its replacement.
      await expect.poll(() => panel(page).innerText()).toBe("لم تُقَرّ الجاهزية");
      expect((await snapshot(page)).reads.find(read => read.id === redacted)).toMatchObject({ id: redacted, aborted: false, jsonCalls: 1 });
      expect(await panel(page).innerText()).not.toContain("عليه"); expect(await panel(page).innerText()).not.toContain("تحذير المريض");
      const malformed = await reload(page);
      await page.evaluate(id => { window.__todayReadinessFixture.headers(id);
        window.__todayReadinessFixture.rawBody(id, { items: [{ visitId: 701, balances: {} }], requireClearance: false }); }, malformed);
      await expect.poll(() => state(page)).toBe("unavailable");
      expect(await panel(page).innerText()).not.toContain("عليه"); expect(await panel(page).innerText()).not.toContain("تحذير المريض");
    });
  });
  it.each(["headers", "body"])("retires retained retry and delayed %s across unmount/remount", async boundary => {
    await fixture(async page => {
      await unavailable(page); await capture(page, "retry"); const old = await reload(page);
      if (boundary === "body") await page.evaluate(id => window.__todayReadinessFixture.headers(id), old);
      await page.locator("#toggle").click(); expect(await panel(page).count()).toBe(0);
      await page.locator("#toggle").click();
      await expect.poll(async () => (await snapshot(page)).reads.length).toBeGreaterThan(old + 1);
      const current = await latest(page), count = (await snapshot(page)).reads.length;
      await page.evaluate(({ old }) => { window.__todayReadinessFixture.replay("old"); window.__todayReadinessFixture.respond(old); }, { old });
      await settle(page);
      expect((await snapshot(page)).reads).toHaveLength(count);
      expect((await snapshot(page)).reads.find(read => read.id === current)?.aborted).toBe(false);
      await respond(page, current);
    });
  });
});
