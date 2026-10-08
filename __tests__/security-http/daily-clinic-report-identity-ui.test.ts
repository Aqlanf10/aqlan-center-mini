import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "esbuild";
import { resolve } from "node:path";
import { dailyClinicReportFixture } from "../fixtures/daily-clinic-report";

/** Actual report component + React DOM. Only external providers/styles are
 * synthetic, so authorization lifetime is exercised without a production test hook. */
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const result = await build({ write: false, bundle: true, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import { createRoot } from 'react-dom/client';
      import { OwnerFixture } from '@/components/SessionProvider';
      import { DailyClinicReportView } from './app/reports/daily-clinic/DailyClinicReportView';
      createRoot(document.getElementById('root')!).render(<OwnerFixture><DailyClinicReportView initialDate="2026-09-30" clinicTimeZone="Asia/Aden" /></OwnerFixture>);
    ` }, plugins: [{ name: "synthetic-provider-boundaries", setup(plugin) {
      plugin.onResolve({ filter: /^@\/components\/(SessionProvider|SettingsProvider|PageHeader)$/ }, (args) => ({ path: args.path, namespace: "provider-fixture" }));
      plugin.onLoad({ filter: /.*/, namespace: "provider-fixture" }, (args) => {
        if (args.path.endsWith("SessionProvider")) return { loader: "js", contents: `
          import React, { createContext, useContext, useState } from 'react';
          import { flushSync } from 'react-dom';
          const Owner = createContext(null);
          export const useSession = () => useContext(Owner);
          export function OwnerFixture({children}) {
            const [owner, setOwner] = useState({username:'owner-a',role:'admin'});
            window.__setTestOwner = (next) => flushSync(() => setOwner(next));
            return React.createElement(Owner.Provider, {value:owner}, children);
          }`, resolveDir: process.cwd() };
        if (args.path.endsWith("SettingsProvider")) return { loader: "js", contents: "export const useClinicName = () => 'Synthetic identity clinic';" };
        return { loader: "js", contents: "import React from 'react'; export function PageHeader({children,title}) { return React.createElement('header',null,React.createElement('h1',null,title),children); }", resolveDir: process.cwd() };
      });
      plugin.onResolve({ filter: /\.module\.css$/ }, () => ({ path: "synthetic-styles", namespace: "style-fixture" }));
      plugin.onLoad({ filter: /.*/, namespace: "style-fixture" }, () => ({ loader: "js", contents: "export default new Proxy({}, {get:(_, key)=>String(key)});" }));
      plugin.onResolve({ filter: /^@\/lib\// }, (args) => ({ path: resolve(process.cwd(), `${args.path.slice(2)}.ts`) }));
    } }] });
  bundle = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 120_000);
afterAll(async () => { await browser?.close(); });

type Owner = { username: string; role: string } | null;
type IdentityWindow = Window & {
  __setTestOwner: (owner: Owner) => void;
  __identityRequests: { headers: (status: number) => void; body: (value: unknown) => void }[];
};
async function nextRequest(page: Page, index: number) {
  await expect.poll(() => page.evaluate((i) => !!(window as unknown as IdentityWindow).__identityRequests[i], index)).toBe(true);
}
async function headers(page: Page, index: number, status = 200) {
  await page.evaluate(({ i, status }) => (window as unknown as IdentityWindow).__identityRequests[i].headers(status), { i: index, status });
}
async function body(page: Page, index: number) {
  await page.evaluate(({ i, report }) => (window as unknown as IdentityWindow).__identityRequests[i].body(report), { i: index, report: dailyClinicReportFixture() });
}
async function owner(page: Page, next: Owner) {
  const observed = await page.evaluate((next) => {
    (window as unknown as IdentityWindow).__setTestOwner(next);
    return { result: !!document.querySelector('[data-testid="daily-clinic-result"]'), print: !!document.querySelector('[data-testid="daily-clinic-print"]') };
  }, next);
  expect(observed).toEqual({ result: false, print: false });
}

describe("report authorization generation in the actual React component", () => {
  it("retires cached results across owner/role/null round trips and rejects late bodies and denial", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.setContent('<main id="root"></main>');
      await page.evaluate(() => {
        const requests: IdentityWindow["__identityRequests"] = [];
        (window as unknown as IdentityWindow).__identityRequests = requests;
        window.fetch = (() => {
          let deliverHeaders!: (response: Response) => void, deliverBody!: (body: unknown) => void;
          const response = new Promise<Response>((resolve) => { deliverHeaders = resolve; });
          const data = new Promise<unknown>((resolve) => { deliverBody = resolve; });
          requests.push({ headers: (status) => deliverHeaders({ status, ok: status >= 200 && status < 300, json: () => data } as Response), body: deliverBody });
          return response; // Deliberately ignore abort to expose stale completion bugs.
        }) as typeof window.fetch;
      });
      await page.addScriptTag({ content: bundle });
      await nextRequest(page, 0); await headers(page, 0); await body(page, 0);
      await expect.poll(() => page.getByTestId("daily-clinic-result").count()).toBe(1);
      await owner(page, null);
      await owner(page, { username: "owner-a", role: "admin" });
      await nextRequest(page, 1); await headers(page, 1); // Its JSON remains pending.
      await owner(page, { username: "owner-a", role: "reception" });
      await owner(page, { username: "owner-a", role: "admin" });
      await nextRequest(page, 2);
      await body(page, 1);
      expect(await page.getByTestId("daily-clinic-result").count()).toBe(0);
      expect(await page.getByTestId("daily-clinic-print").count()).toBe(0);
      await headers(page, 2, 403);
      await expect.poll(() => page.getByRole("alert").count()).toBe(1);
      expect(await page.getByTestId("daily-clinic-result").count()).toBe(0);
      await owner(page, { username: "owner-b", role: "admin" });
      await nextRequest(page, 3); await headers(page, 3);
      await owner(page, { username: "owner-a", role: "admin" });
      await nextRequest(page, 4); await body(page, 3);
      expect(await page.getByTestId("daily-clinic-result").count()).toBe(0);
      await headers(page, 4); await body(page, 4);
      await expect.poll(() => page.getByTestId("daily-clinic-result").count()).toBe(1);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });
});
