import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dailyClinicReportFixture } from "../fixtures/daily-clinic-report";
import { baseUrl, harness } from "./_server";

// (INV-LINK REPORT) Built page + isolated test database for authentication only. Every report
// payload is the synthetic fixture; no live clinic record enters artifacts.
const ARTIFACTS = ".settings-ui-artifacts";
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

type Pending = {
  url: string;
  bodyStarted: boolean;
  atRequest: { date: string | null; result: boolean; print: boolean };
  respond: (status: number) => void;
  body: (value: unknown) => void;
  reject: () => void;
};
type TestWindow = Window & { __dailyClinic: Pending[] };
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });

async function fixture(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Pacific/Honolulu", serviceWorkers: "block" });
  const [name, ...parts] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: parts.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const errors: string[] = [], unexpected: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseUrl).origin) { unexpected.push(url.origin); await route.abort(); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    if (route.request().method() === "GET") {
      if (url.pathname === "/api/booking-requests") { await json(route, []); return; }
      if (url.pathname === "/api/lab") { await json(route, { late: 0 }); return; }
      if (url.pathname === "/api/messages") { await json(route, { unread: 0, urgent: 0 }); return; }
      if (url.pathname === "/api/auth/me") { await json(route, { username: "secadmin", role: "admin" }); return; }
    }
    unexpected.push(`${route.request().method()} ${url.pathname}`);
    await json(route, { message: "Synthetic daily clinic test blocked an unmocked request" }, 501);
  });
  await page.addInitScript(() => {
    const pending: Pending[] = [];
    (window as unknown as TestWindow).__dailyClinic = pending;
    const original = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname !== "/api/reports/daily-clinic" || url.origin !== location.origin) return original(input, init);
      let respond!: (response: Response) => void, body!: (value: unknown) => void, reject!: (error: Error) => void;
      const response = new Promise<Response>((resolve) => { respond = resolve; });
      const data = new Promise<unknown>((resolve, fail) => { body = resolve; reject = fail; });
      const root = document.querySelector('[data-testid="daily-clinic-report"]');
      const item: Pending = {
        url: url.toString(), bodyStarted: false,
        atRequest: { date: root?.querySelector<HTMLInputElement>('input[type="date"]')?.value ?? null, result: !!root?.querySelector('[data-testid="daily-clinic-result"]'), print: !!root?.querySelector('[data-testid="daily-clinic-print"]') },
        respond: (status) => respond({ status, ok: status >= 200 && status < 300, json: () => { item.bodyStarted = true; return data; } } as Response),
        body, reject: () => reject(new Error("Obsolete synthetic JSON failure")),
      };
      pending.push(item);
      // Ignore abort so stale headers AND stale body completions are exercised.
      return response;
    }) as typeof window.fetch;
  });
  await page.goto(`${baseUrl}/reports/daily-clinic?date=2026-09-30`, { waitUntil: "networkidle" });
  await waitForRequest(page, 0);
  return { page, context, assertIsolated: () => { expect(errors).toEqual([]); expect(unexpected).toEqual([]); } };
}
async function waitForRequest(page: Page, i: number) {
  await expect.poll(() => page.evaluate((index) => !!(window as unknown as TestWindow).__dailyClinic[index], i)).toBe(true);
}
async function respond(page: Page, i: number, status = 200) {
  await page.evaluate(({ i, status }) => (window as unknown as TestWindow).__dailyClinic[i].respond(status), { i, status });
}
async function body(page: Page, i: number, value: unknown) {
  await page.evaluate(async ({ i, value }) => {
    (window as unknown as TestWindow).__dailyClinic[i].body(value);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, { i, value });
}
async function complete(page: Page, i: number, value: unknown, status = 200) { await respond(page, i, status); await body(page, i, value); }

describe("(INV-LINK REPORT) invoices and pre-system treatment in the daily clinic close", () => {
  it.each([390, 1280])("shows each invoice once with its line links, explicit receipts and stored correction at %s", async (width) => {
    const f = await fixture(width);
    try {
      await complete(f.page, 0, dailyClinicReportFixture());
      await expect.poll(() => f.page.getByTestId("daily-clinic-result").count()).toBe(1);
      const invoices = f.page.getByTestId("daily-clinic-invoices");
      expect(await invoices.locator("tbody tr[data-invoice-id]").count()).toBe(3);
      expect(await invoices.locator('tbody tr[data-invoice-id="900"]').count()).toBe(1);
      const single = invoices.locator('tr[data-invoice-id="900"]');
      expect(await single.innerText()).toContain("بند #3001");
      expect(await single.innerText()).toContain("حالة #4001");
      expect(await single.innerText()).toContain("سن 36");
      expect(await single.innerText()).toContain("تصحيح للفاتورة");
      expect(await single.innerText()).toContain("السندات: 502");
      const mixed = invoices.locator('tr[data-invoice-id="901"]');
      expect(await mixed.getAttribute("data-invoice-linkage")).toBe("mixed");
      expect(await mixed.innerText()).toContain("لا توزيع للدفعات على الحالات");
      expect(await mixed.innerText()).toContain("مالي فقط");
      const cancelled = invoices.locator('tr[data-invoice-id="899"]');
      expect(await cancelled.getAttribute("data-invoice-status")).toBe("cancelled");
      expect(await cancelled.innerText()).toContain("صُححت بالفاتورة");
      expect(await cancelled.innerText()).toContain("تصحيح سعر اصطناعي");
      const legacy = f.page.getByTestId("daily-clinic-legacy");
      expect(await legacy.locator("tbody tr[data-legacy-id]").count()).toBe(2);
      expect(await legacy.innerText()).toContain("حالة بدأت قبل النظام");
      expect(await legacy.innerText()).toContain("التغطية غير مثبتة — تحتاج مراجعة");
      const row = legacy.locator('tr[data-legacy-id="950"] [data-minor]');
      expect(await row.evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-minor")))).toEqual(["300000", "120000", "180000"]);
      expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(await f.page.evaluate(() => document.documentElement.dir)).toBe("rtl");
      await mkdir(ARTIFACTS, { recursive: true });
      await f.page.getByTestId("daily-clinic-invoices").scrollIntoViewIfNeeded();
      await writeFile(`${ARTIFACTS}/daily-clinic-invoices-${width}.png`, await f.page.screenshot({ fullPage: true }));
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("prints the invoice and legacy sections on A4 in RTL", async () => {
    const f = await fixture(1280);
    try {
      await complete(f.page, 0, dailyClinicReportFixture());
      await expect.poll(() => f.page.getByTestId("daily-clinic-result").count()).toBe(1);
      await f.page.emulateMedia({ media: "print" });
      const pdf = await f.page.pdf({ preferCSSPageSize: true, printBackground: true });
      await mkdir(ARTIFACTS, { recursive: true });
      const path = `${ARTIFACTS}/daily-clinic-invoices-a4.pdf`;
      await writeFile(path, pdf);
      const info = execFileSync("pdfinfo", [path], { encoding: "utf8" });
      expect(info).toMatch(/Page size:\s+(84\d\.\d+ x 59\d\.\d+|59\d\.\d+ x 84\d\.\d+)/);
      const text = execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" });
      for (const needle of ["SYNTHETIC-INV-900", "SYNTHETIC-INV-901", "SYNTHETIC-INV-899", "قبل النظام"]) expect(text).toContain(needle);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });
});
