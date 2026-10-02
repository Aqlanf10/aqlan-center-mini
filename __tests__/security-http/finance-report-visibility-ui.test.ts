import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { financeSummaryFixture as full } from "../fixtures/finance-summary";
import { baseUrl, harness } from "./_server";

// Real built page and isolated synthetic admin session; report payloads are
// controlled fixtures, never Production records or live permission changes.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

type Pending = {
  url: string; bodyStarted: boolean;
  respond: (status: number) => void;
  body: (payload: unknown) => void;
};
type FixtureWindow = Window & { __financeReports: Pending[] };
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const revenueOnly = {
  from: full.from, to: full.to, income: full.income, refunds: full.refunds,
  invoicedByCurrency: full.invoicedByCurrency, invoiceCount: full.invoiceCount,
  patientCount: full.patientCount, topServices: full.topServices,
};

async function fixture(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(baseUrl).origin) {
      unexpected.push(`external ${url.origin}`); await route.abort(); return;
    }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    if (request.method() === "GET") {
      switch (url.pathname) {
        case "/api/booking-requests": await json(route, []); return;
        case "/api/lab": await json(route, { late: 0 }); return;
        case "/api/messages": await json(route, { unread: 0, urgent: 0 }); return;
        case "/api/auth/me": await json(route, { username: "secadmin", role: "admin" }); return;
      }
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    await json(route, { message: "Unmocked request blocked by finance report fixture" }, 501);
  });
  await page.addInitScript(() => {
    const requests: Pending[] = [];
    (window as unknown as FixtureWindow).__financeReports = requests;
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw, window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== "/api/finance/report") return originalFetch(input, init);
      let respond!: (response: Response) => void;
      let body!: (payload: unknown) => void;
      const response = new Promise<Response>((resolve) => { respond = resolve; });
      const payload = new Promise<unknown>((resolve) => { body = resolve; });
      const record: Pending = {
        url: url.toString(), bodyStarted: false, body,
        respond: (status) => respond({ ok: status >= 200 && status < 300, status,
          json: () => { record.bodyStarted = true; return payload; },
        } as Response),
      };
      requests.push(record);
      // Ignore AbortSignal to verify the completion guard, including late JSON.
      return response;
    }) as typeof window.fetch;
  });
  await page.goto(`${baseUrl}/finance/reports`, { waitUntil: "networkidle" });
  await waitForRequest(page, 0);
  const assertIsolated = () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); };
  return { page, context, assertIsolated };
}
async function waitForRequest(page: Page, index: number) {
  await expect.poll(() => page.evaluate((i) => Boolean((window as unknown as FixtureWindow).__financeReports[i]), index)).toBe(true);
}
async function respond(page: Page, index: number, status = 200) {
  await page.evaluate(({ i, status }) => (window as unknown as FixtureWindow).__financeReports[i].respond(status), { i: index, status });
}
async function body(page: Page, index: number, payload: unknown) {
  await page.evaluate(async ({ i, payload }) => {
    (window as unknown as FixtureWindow).__financeReports[i].body(payload);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, { i: index, payload });
}
async function complete(page: Page, index: number, payload: unknown, status = 200) {
  await respond(page, index, status);
  await body(page, index, payload);
}
async function assertNoRestricted(page: Page) {
  // The fetch fixture records a request before React necessarily commits the
  // queued state clear. Observe the DOM commit, not just fetch invocation. The
  // pending-response tests keep the newer response unresolved until this passes.
  await expect.poll(() => page.getByTestId("finance-net").count()).toBe(0);
  await expect.poll(() => page.getByTestId("finance-expenses").count()).toBe(0);
  await expect.poll(() => page.getByTestId("opening-settlements").count()).toBe(0);
  await expect.poll(() => page.getByText("صُرف", { exact: true }).count()).toBe(0);
}


describe("built financial summary visibility and stale-response containment", () => {
  it.each([1280, 390])("renders revenue-only without restricted sections or false zeros at width %s, including print", async (width) => {
    const f = await fixture(width);
    try {
      await complete(f.page, 0, revenueOnly);
      await expect.poll(() => f.page.getByText("خدمة تجريبية", { exact: false }).count()).toBe(1);
      await assertNoRestricted(f.page);
      expect(await f.page.getByText("لا مصروفات في هذه المدة.", { exact: true }).count()).toBe(0);
      const screenshot = process.env.FINANCE_REPORT_UI_SCREENSHOT ?? ".settings-ui-artifacts/finance-report-revenue-only.png";
      await mkdir(dirname(screenshot), { recursive: true });
      await f.page.getByTestId("finance-report").screenshot({ path: screenshot.replace(/\.png$/, `-${width}.png`) });
      await f.page.emulateMedia({ media: "print" });
      await assertNoRestricted(f.page);
      expect(await f.page.getByText("خدمة تجريبية", { exact: false }).isVisible()).toBe(true);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("renders authorized expenses/opening settlements independently and preserves permitted zero net", async () => {
    const f = await fixture();
    try {
      await complete(f.page, 0, { ...revenueOnly, expenses: full.expenses, openingSettlements: full.openingSettlements });
      await expect.poll(() => f.page.getByTestId("finance-expenses").count()).toBe(1);
      expect(await f.page.getByTestId("opening-settlements").count()).toBe(1);
      expect(await f.page.getByTestId("finance-net").count()).toBe(0);
      await f.page.getByRole("button", { name: "أمس", exact: true }).click();
      await waitForRequest(f.page, 1);
      await assertNoRestricted(f.page);
      await complete(f.page, 1, { ...full, netMinor: 0 });
      await expect.poll(() => f.page.getByTestId("finance-net").count()).toBe(1);
      expect(await f.page.getByTestId("finance-expenses").count()).toBe(1);
      expect(await f.page.getByTestId("opening-settlements").count()).toBe(1);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it.each([401, 403])("removes a loaded report and blocks both stale fetch/body completions after HTTP %s", async (status) => {
    const f = await fixture();
    try {
      await complete(f.page, 0, full);
      await expect.poll(() => f.page.getByTestId("finance-net").count()).toBe(1);
      await f.page.getByRole("button", { name: "أمس", exact: true }).click();
      await waitForRequest(f.page, 1);
      await assertNoRestricted(f.page);
      // The first stale response is already waiting for its body.
      await respond(f.page, 1);
      await expect.poll(() => f.page.evaluate(() => (window as unknown as FixtureWindow).__financeReports[1].bodyStarted)).toBe(true);
      await f.page.getByRole("button", { name: "آخر ٧ أيام", exact: true }).click();
      await waitForRequest(f.page, 2);
      // The second stale response has not delivered even its headers.
      await f.page.getByRole("button", { name: "اليوم", exact: true }).click();
      await waitForRequest(f.page, 3);
      await complete(f.page, 3, { message: `Synthetic denied ${status}` }, status);
      await expect.poll(() => f.page.getByRole("alert").filter({ hasText: `Synthetic denied ${status}` }).count()).toBe(1);
      await body(f.page, 1, full);
      await complete(f.page, 2, full);
      await assertNoRestricted(f.page);
      expect(await f.page.getByText("خدمة تجريبية", { exact: false }).count()).toBe(0);
      await f.page.emulateMedia({ media: "print" });
      await assertNoRestricted(f.page);
      // A later genuinely authorized reduced response can still recover.
      await f.page.emulateMedia({ media: "screen" });
      await f.page.getByRole("button", { name: "أمس", exact: true }).click();
      await waitForRequest(f.page, 4);
      await complete(f.page, 4, revenueOnly);
      await expect.poll(() => f.page.getByText("خدمة تجريبية", { exact: false }).count()).toBe(1);
      await assertNoRestricted(f.page);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("ignores older full-access data after a newer revenue-only success", async () => {
    const f = await fixture();
    try {
      await respond(f.page, 0);
      await expect.poll(() => f.page.evaluate(() => (window as unknown as FixtureWindow).__financeReports[0].bodyStarted)).toBe(true);
      await f.page.getByRole("button", { name: "أمس", exact: true }).click();
      await waitForRequest(f.page, 1);
      await complete(f.page, 1, revenueOnly);
      await body(f.page, 0, full);
      await assertNoRestricted(f.page);
      expect(await f.page.getByText("خدمة تجريبية", { exact: false }).count()).toBe(1);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });
});
