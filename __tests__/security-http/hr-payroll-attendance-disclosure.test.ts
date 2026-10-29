import { afterAll, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type BrowserServer } from "playwright";
let server: BrowserServer | undefined;
afterAll(async () => { await server?.kill(); });

it("discloses that attendance and leave do not automatically adjust payroll, without writes", async () => {
  const built = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {HrPayrollPanel} from './components/hr/PayrollPanel';createRoot(document.getElementById('root')).render(React.createElement(HrPayrollPanel));`, resolveDir: process.cwd(), loader: "jsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
  // Own a dedicated process so teardown does not depend on Chromium's
  // graceful-close handshake (which can stall on Windows headless shell).
  server = await chromium.launchServer({ host: "127.0.0.1" });
  const browser = await chromium.connect(server.wsEndpoint());
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const unexpected: string[] = [];
  const run = { id: 1, periodId: 1, currency: "YER", status: "draft", items: [], totalBaseSalaryMinor: 10000, totalAllowancesMinor: 0, totalCommissionsMinor: 0, totalPaidMinor: 0, totalDeductionsMinor: 0, totalNetDueMinor: 10000 };
  try {
    await context.route("**/*", route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== "http://127.0.0.1:47901" || request.method() !== "GET") { unexpected.push(request.url()); return route.abort(); }
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      const body = url.pathname === "/api/hr/payroll/periods" ? [{ id: 1, periodKey: "2026-10", name: "Synthetic month", status: "draft" }]
        : url.pathname === "/api/hr/payroll/runs" ? url.searchParams.has("id") ? run : [run] : null;
      if (!body) { unexpected.push(url.pathname); return route.abort(); }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("http://127.0.0.1:47901");
    await page.addScriptTag({ content: built.outputFiles[0].text });
    await page.getByText("الصافي المستحق", { exact: true }).waitFor({ timeout: 5000 }).catch(async error => { throw new Error(`${error.message}; ${errors.join("; ")}; ${await page.locator("body").innerText()}`); });
    expect(await page.getByText("الخصميات والغياب", { exact: true }).count()).toBe(0);
    expect(await page.getByText("الخصميات المسجلة", { exact: true }).count()).toBe(1);
    expect(await page.getByText(/الحضور والإجازات لا تعدّل مبلغ المسير تلقائيًا/).count()).toBe(1);
    expect(unexpected).toEqual([]);
  } finally {
    const process = server.process();
    const disconnected = browser.isConnected()
      ? new Promise<void>(resolve => browser.once("disconnected", () => resolve())) : Promise.resolve();
    await server.kill();
    await disconnected;
    server = undefined;
    expect(process.exitCode !== null || process.signalCode !== null).toBe(true);
    expect(browser.isConnected()).toBe(false);
  }
});
