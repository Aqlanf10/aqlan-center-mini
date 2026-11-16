import { build } from "esbuild";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";
import type { CanonicalCephCommitSnapshot } from "../fixtures/canonical-ceph-commit-window";
let browser: Browser, script = "";
const location = "/__synthetic_canonical_ceph_commit__/";
beforeAll(async () => {
  const h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  const result = await build({ absWorkingDir: process.cwd(), entryPoints: ["__tests__/fixtures/canonical-ceph-commit-window.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json", metafile: true, define: { "process.env.NODE_ENV": JSON.stringify("development") } });
  const inputs = Object.keys(result.metafile!.inputs);
  expect(inputs).toContain("components/patient/CanonicalCephCreate.tsx");
  expect(inputs.some(p => p.endsWith("node_modules/react-dom/client.js"))).toBe(true);
  expect(inputs.some(p => /(?:^|\/)lib\/db(?:\.|\/)|node_modules\/(?:next|pg|@electric-sql)\//.test(p))).toBe(false);
  script = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240000);
afterAll(async () => { await browser?.close(); });
it.each(["close", "owner", "unmount"] as const)("real React: %s commit retires POST ownership before passive effects can run", async kind => {
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
    await page.goto(baseUrl + location);
    await page.getByRole("button", { name: "فتح مسودة جديدة", exact: true }).click();
    await page.getByLabel("الصورة المسجلة", { exact: true }).selectOption("901");
    await page.getByRole("button", { name: "إنشاء المسودة غير المعتمدة", exact: true }).click();
    const snapshot = (): Promise<CanonicalCephCommitSnapshot> => page.evaluate(() => window.__canonicalCephCommit.snapshot());
    await expect.poll(async () => (await snapshot()).jsonCalls).toBe(1);
    expect((await snapshot()).marker).toBe("pending");
    await page.evaluate(kind => window.__canonicalCephCommit.retire(kind), kind);
    await expect.poll(async () => (await snapshot()).early).not.toBeNull();
    const result = await snapshot(); console.info("SYN canonical commit boundary", kind, JSON.stringify(result));
    expect(result.early!.passiveEpoch).toBe(0);
    expect(result.events.indexOf("commit:1")).toBeLessThan(result.events.indexOf("microtasks:1"));
    expect(result.early!.created).toBe(0); expect(result.early!.marker).toBe("pending");
    expect(result.created).toBe(0); expect(result.refreshes).toBe(0); expect(result.posts).toBe(1); expect(result.marker).toBe("pending");
    expect(result.unexpected).toEqual([]); expect(external).toEqual([]); expect(errors).toEqual([]);
  } finally { await context.close(); }
});
