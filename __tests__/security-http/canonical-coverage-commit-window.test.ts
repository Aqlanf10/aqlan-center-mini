import { build } from "esbuild";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";
import type { CanonicalCoverageCommitSnapshot } from "../fixtures/canonical-coverage-commit-window";
let browser: Browser, script = "";
const location = "/__synthetic_canonical_coverage_commit__/";
beforeAll(async () => {
  const h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  // Observe entry synchronously before crypto/IndexedDB can yield. The wrapper
  // delegates unchanged to the real journal; it is not a storage implementation.
  const journalPath = JSON.stringify(resolve("lib/financial-command-journal.ts"));
  const result = await build({ plugins: [{ name: "observe-coverage-acknowledgment", setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/financial-command-journal$/ }, () => ({ path: "journal-observer", namespace: "synthetic-coverage" }));
    builder.onLoad({ filter: /.*/, namespace: "synthetic-coverage" }, () => ({ loader: "js", resolveDir: process.cwd(), contents:
      `export * from ${journalPath}; import { acknowledgeFinancialCommand as actual } from ${journalPath}; export function acknowledgeFinancialCommand(...args) { window.dispatchEvent(new Event("synthetic-coverage-acknowledgment")); return actual(...args); }` }));
  } }], absWorkingDir: process.cwd(), entryPoints: ["__tests__/fixtures/canonical-coverage-commit-window.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json", metafile: true, define: { "process.env.NODE_ENV": JSON.stringify("development") } });
  const inputs = Object.keys(result.metafile!.inputs);
  for (const path of ["components/OrthoFollowupCoveragePanel.tsx", "components/SessionProvider.tsx", "lib/financial-command-journal.ts"]) expect(inputs).toContain(path);
  expect(inputs.some(p => p.endsWith("node_modules/react-dom/client.js"))).toBe(true);
  expect(inputs.some(p => /(?:^|\/)lib\/db(?:\.|\/)|node_modules\/(?:next|pg|@electric-sql)\//.test(p))).toBe(false);
  script = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240000);
afterAll(async () => { await browser?.close(); });
async function fixture(run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ serviceWorkers: "block" }); const external: string[] = [], errors: string[] = [];
  try {
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== baseUrl || request.method() !== "GET") { external.push(request.method() + " " + url.pathname); return route.abort(); }
      if (url.pathname === location) return route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'none'; style-src 'unsafe-inline'" }, body: `<html><body><div id="root"></div><script src="${location}fixture.js"></script></body></html>` });
      if (url.pathname === location + "fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
      if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
      external.push(request.method() + " " + url.pathname); return route.abort();
    });
    const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
    await page.goto(baseUrl + location); await run(page);
    expect(external).toEqual([]); expect(errors).toEqual([]);
  } finally { await context.close(); }
}
async function fill(page: Page) {
  await page.getByRole("button", { name: /نطاق المتابعات الروتينية ضمن الاتفاق/ }).click();
  await page.getByLabel("مصدر تغطية المتابعات", { exact: true }).selectOption("806:805");
  await page.getByLabel("قرار نطاق المتابعات", { exact: true }).selectOption("included");
  await page.getByLabel("سبب اعتماد نطاق المتابعات", { exact: true }).fill("SYN explicit coverage agreement");
  await page.getByRole("checkbox").check();
}
it.each(["owner", "unmount", "permission"] as const)("real React/IndexedDB: %s commit preserves the old pending receipt before passive effects", async kind => {
  await fixture(async page => {
    await fill(page); await page.getByRole("button", { name: "اعتماد نطاق المتابعات القادمة", exact: true }).click();
    const snapshot = (): Promise<CanonicalCoverageCommitSnapshot> => page.evaluate(() => window.__canonicalCoverageCommit.snapshot());
    await expect.poll(async () => (await snapshot()).jsonCalls).toBe(1);
    const before = (await snapshot()).journal; expect(before.command).not.toBeNull();
    await page.evaluate(kind => window.__canonicalCoverageCommit.retire(kind), kind);
    await expect.poll(async () => (await snapshot()).early).not.toBeNull();
    await expect.poll(async () => (await snapshot()).passiveEpoch).toBe(1);
    const result = await snapshot();
    expect(result.early!.passiveEpoch).toBe(0); expect(result.early!.saved).toBe(0); expect(result.early!.acknowledgments).toBe(0);
    expect(result.events.indexOf("commit:1")).toBeLessThan(result.events.indexOf("microtasks:1"));
    expect(result.journal).toEqual(before); expect(result.posts).toBe(1); expect(result.saved).toBe(0); expect(result.acknowledgments).toBe(0); expect(result.unexpected).toEqual([]);
  });
});
it("real React: last-field decision survives polling remount without restoring confirmation or sending", async () => {
  await fixture(async page => {
    await fill(page); await page.getByLabel("قرار نطاق المتابعات", { exact: true }).selectOption("excluded");
    await page.evaluate(() => window.__canonicalCoverageCommit.retire("refresh"));
    await expect.poll(() => page.getByRole("button", { name: /نطاق المتابعات الروتينية ضمن الاتفاق/ }).textContent()).toContain("+");
    await page.getByRole("button", { name: /نطاق المتابعات الروتينية ضمن الاتفاق/ }).click();
    await expect.poll(() => page.getByLabel("قرار نطاق المتابعات", { exact: true }).inputValue()).toBe("excluded");
    expect(await page.getByLabel("سبب اعتماد نطاق المتابعات", { exact: true }).inputValue()).toBe("SYN explicit coverage agreement");
    expect(await page.getByRole("checkbox").isChecked()).toBe(false);
    const result = await page.evaluate(() => window.__canonicalCoverageCommit.snapshot());
    expect(result.posts).toBe(0); expect(result.journal.command).toBeNull(); expect(result.unexpected).toEqual([]);
  });
});
