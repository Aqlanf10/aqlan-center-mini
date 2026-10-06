import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { addDays } from "../../lib/schedule";
import { friendlyDateLong } from "../../lib/reminders";
import { baseUrl, harness } from "./_server";

// Real built daily-report page and isolated synthetic admin session. Every
// /api/report payload below is an intercepted fixture controlled from the test:
// no Production record, permission change or external message is involved, and
// the WhatsApp share link is only inspected, never opened.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

type Pending = {
  url: string; bodyStarted: boolean;
  viewAtRequest: { date: string | null; hasReport: boolean; hasPrintAction: boolean; hasShare: boolean };
  respond: (status: number) => void;
  body: (payload: unknown) => void;
};
type FixtureWindow = Window & { __dailyReports: Pending[] };
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function dayPayload(date: string, arrived: number, labLate: number) {
  return {
    date,
    nextDate: addDays(date, 1),
    report: {
      arrived, done: Math.max(0, arrived - 3), stillOpen: 1, noShow: 2, cancelled: 0,
      averageWaitMinutes: 12, longestWaitMinutes: 25, averageChairMinutes: 34,
      booked: arrived + 2, unresolved: 1,
    },
    tomorrow: { booked: 6, bookedMinutes: 180, capacityMinutes: 360, percent: 50 },
    // Lab figures keep their current-state semantics exactly as the route sends them.
    lab: { outstanding: 4, late: labLate, dueToday: 1, waitingFitting: 2 },
    chairs: 4,
    plannedToday: [],
  };
}

async function fixture(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
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
    await json(route, { message: "Unmocked request blocked by daily report fixture" }, 501);
  });
  await page.addInitScript(() => {
    const requests: Pending[] = [];
    (window as unknown as FixtureWindow).__dailyReports = requests;
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw, window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== "/api/report") return originalFetch(input, init);
      let respond!: (response: Response) => void;
      let body!: (payload: unknown) => void;
      const response = new Promise<Response>((resolve) => { respond = resolve; });
      const payload = new Promise<unknown>((resolve) => { body = resolve; });
      // The date selection has committed by the time its passive effect fetches.
      // Capture synchronously: guards that clear old state inside that effect
      // have not committed yet, so polling the DOM afterward would miss the gap.
      const report = document.querySelector('[data-testid="daily-report"]');
      const dateInput = report?.querySelector<HTMLInputElement>('input[type="date"]');
      const record: Pending = {
        url: url.toString(), bodyStarted: false, body,
        viewAtRequest: {
          date: dateInput?.value ?? null,
          hasReport: Boolean(report?.querySelector('[aria-label="الحضور"]')),
          hasPrintAction: Boolean(report?.querySelector(".print-actions")),
          hasShare: Boolean(report?.querySelector('a[href*="wa.me"]')),
        },
        respond: (status) => respond({ ok: status >= 200 && status < 300, status,
          json: () => { record.bodyStarted = true; return payload; },
        } as Response),
      };
      requests.push(record);
      // Ignore AbortSignal to verify the completion guard, including late JSON.
      return response;
    }) as typeof window.fetch;
  });
  await page.goto(`${baseUrl}/report`, { waitUntil: "networkidle" });
  await waitForRequest(page, 0);
  const assertIsolated = () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); };
  return { page, context, assertIsolated };
}
async function waitForRequest(page: Page, index: number) {
  await expect.poll(() => page.evaluate((i) => Boolean((window as unknown as FixtureWindow).__dailyReports[i]), index)).toBe(true);
}
async function respond(page: Page, index: number, status = 200) {
  await page.evaluate(({ i, status }) => (window as unknown as FixtureWindow).__dailyReports[i].respond(status), { i: index, status });
}
async function body(page: Page, index: number, payload: unknown) {
  await page.evaluate(async ({ i, payload }) => {
    (window as unknown as FixtureWindow).__dailyReports[i].body(payload);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, { i: index, payload });
}
async function complete(page: Page, index: number, payload: unknown, status = 200) {
  await respond(page, index, status);
  await body(page, index, payload);
}
async function requestDate(page: Page, index: number) {
  return page.evaluate((i) => new URL((window as unknown as FixtureWindow).__dailyReports[i].url).searchParams.get("date")!, index);
}
/** No report values, print action or share link may exist in the rendered page. */
async function noReport(page: Page) {
  await expect.poll(() => page.locator('[aria-label="الحضور"]').count()).toBe(0);
  await expect.poll(() => page.locator(".print-actions").count()).toBe(0);
  await expect.poll(() => page.locator('a[href*="wa.me"]').count()).toBe(0);
}
async function shareParams(page: Page) {
  const href = await page.locator('a[href*="wa.me"]').getAttribute("href");
  return decodeURIComponent(new URL(href!, baseUrl).searchParams.get("text")!);
}

describe("built daily report page date identity and stale-response containment", () => {
  it.each([1280, 390])("renders only the requested day with print and share at width %s, including print media", async (width) => {
    const f = await fixture(width);
    try {
      const today = await requestDate(f.page, 0);
      await complete(f.page, 0, dayPayload(today, 17, 3));
      await expect.poll(() => f.page.getByText(`تقرير يوم: ${friendlyDateLong(today)}`, { exact: false }).count()).toBe(1);
      expect(await f.page.getByTestId("daily-report").getByRole("button", { name: "اطبع", exact: true }).count()).toBe(1);
      const shared = await shareParams(f.page);
      expect(shared).toContain(`تقرير ${friendlyDateLong(today)}`);
      expect(shared).toContain("الحضور: 17");
      expect(shared).toContain("تراكيب متأخرة: 3");
      expect(await f.page.getByText("تراكيب متأخرة بالمختبر: 3", { exact: false }).count()).toBe(1);
      const screenshot = process.env.REPORT_PAGE_UI_SCREENSHOT ?? ".settings-ui-artifacts/daily-report-selected-day.png";
      await mkdir(dirname(screenshot), { recursive: true });
      await f.page.getByTestId("daily-report").screenshot({ path: screenshot.replace(/\.png$/, `-${width}.png`) });

      // Browser print keeps the center identity and the report's own date, and
      // hides the interactive date picker and share action.
      await f.page.emulateMedia({ media: "print" });
      expect(await f.page.locator("main > div.print\\:block").isVisible()).toBe(true);
      expect(await f.page.getByText(`تقرير يوم: ${friendlyDateLong(today)}`, { exact: false }).isVisible()).toBe(true);
      expect(await f.page.locator('a[href*="wa.me"]').isHidden()).toBe(true);
      expect(await f.page.getByTestId("daily-report").locator(".print-actions").isHidden()).toBe(true);
      if (width === 1280) {
        await f.page.getByTestId("daily-report").screenshot({ path: screenshot.replace(/\.png$/, "-print-1280.png") });
      }
      await f.page.emulateMedia({ media: "screen" });
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it.each([1280, 390])("withholds the old report, print and share in the date-selection commit before effect clearing at width %s", async (width) => {
    const f = await fixture(width);
    try {
      const today = await requestDate(f.page, 0);
      await complete(f.page, 0, dayPayload(today, 17, 3));
      await expect.poll(() => f.page.locator('[aria-label="الحضور"]').count()).toBe(1);

      const a = addDays(today, -1);
      await f.page.getByTestId("daily-report").locator('input[type="date"]').fill(a);
      await waitForRequest(f.page, 1);
      // Snapshot from fetch entry: the new date is committed while the report,
      // print action and share link produced for the old date are already gone.
      expect(await f.page.evaluate((i) => (window as unknown as FixtureWindow).__dailyReports[i].viewAtRequest, 1)).toEqual({
        date: a, hasReport: false, hasPrintAction: false, hasShare: false,
      });
      expect(await requestDate(f.page, 1)).toBe(a);
      // Browser print during the pending window carries no old report either.
      await f.page.emulateMedia({ media: "print" });
      await noReport(f.page);
      expect(await f.page.getByText(`تقرير يوم: ${friendlyDateLong(today)}`, { exact: false }).count()).toBe(0);
      await f.page.emulateMedia({ media: "screen" });

      await complete(f.page, 1, dayPayload(a, 42, 5));
      await expect.poll(() => f.page.getByText(`تقرير يوم: ${friendlyDateLong(a)}`, { exact: false }).count()).toBe(1);
      expect(await shareParams(f.page)).toContain(`تقرير ${friendlyDateLong(a)}`);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("ignores stale completions, rejects a wrong-date response, and recovers through retry", async () => {
    const f = await fixture();
    try {
      const today = await requestDate(f.page, 0);
      const a = addDays(today, -1), b = addDays(today, -3);
      await complete(f.page, 0, dayPayload(today, 17, 3));
      await expect.poll(() => f.page.locator('[aria-label="الحضور"]').count()).toBe(1);

      // A→B: A's request stays unresolved while B is selected and completes.
      const dateInput = f.page.getByTestId("daily-report").locator('input[type="date"]');
      await dateInput.fill(a);
      await waitForRequest(f.page, 1);
      await dateInput.fill(b);
      await waitForRequest(f.page, 2);
      // Stale A succeeds while B is still in flight: the loading notice stays
      // truthful and nothing of A reaches the page.
      await complete(f.page, 1, dayPayload(a, 42, 5));
      await expect.poll(() => f.page.getByText("جارٍ إعداد التقرير اليومي", { exact: false }).count()).toBe(1);
      await noReport(f.page);
      await complete(f.page, 2, dayPayload(b, 42, 5));
      await expect.poll(() => f.page.getByText(`تقرير يوم: ${friendlyDateLong(b)}`, { exact: false }).count()).toBe(1);

      // B→A with a payload whose own date is not the requested one: a clear
      // error, never a silent day swap.
      await dateInput.fill(a);
      await waitForRequest(f.page, 3);
      await complete(f.page, 3, dayPayload(b, 99, 9));
      await expect.poll(() => f.page.getByRole("alert").filter({ hasText: "بتاريخٍ غير التاريخ المطلوب" }).count()).toBe(1);
      await noReport(f.page);

      // The retry button sends a clean request for the selected date and renders it.
      await f.page.getByRole("button", { name: "أعد المحاولة", exact: true }).click();
      await waitForRequest(f.page, 4);
      expect(await requestDate(f.page, 4)).toBe(a);
      await complete(f.page, 4, dayPayload(a, 23, 1));
      await expect.poll(() => f.page.getByText(`تقرير يوم: ${friendlyDateLong(a)}`, { exact: false }).count()).toBe(1);
      expect(await shareParams(f.page)).toContain(`تقرير ${friendlyDateLong(a)}`);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("keeps a failed new day empty of the previous report on screen and in print, then recovers", async () => {
    const f = await fixture();
    try {
      const today = await requestDate(f.page, 0);
      const a = addDays(today, -1);
      await complete(f.page, 0, dayPayload(today, 17, 3));
      await expect.poll(() => f.page.locator(".print-actions").count()).toBe(1);

      await f.page.getByTestId("daily-report").locator('input[type="date"]').fill(a);
      await waitForRequest(f.page, 1);
      await complete(f.page, 1, { message: "Synthetic report failure" }, 500);
      await expect.poll(() => f.page.getByRole("alert").filter({ hasText: "Synthetic report failure" }).count()).toBe(1);
      await noReport(f.page);
      expect(await f.page.getByText(`تقرير يوم: ${friendlyDateLong(today)}`, { exact: false }).count()).toBe(0);

      // Browser print: center identity survives, the old report does not.
      await f.page.emulateMedia({ media: "print" });
      await noReport(f.page);
      expect(await f.page.getByText(`تقرير يوم: ${friendlyDateLong(today)}`, { exact: false }).count()).toBe(0);
      expect(await f.page.locator("main > div.print\\:block").isVisible()).toBe(true);
      await f.page.emulateMedia({ media: "screen" });

      // «اليوم» restores the current day with a clean request.
      await f.page.getByRole("button", { name: /^اليوم \(/ }).click();
      await waitForRequest(f.page, 2);
      expect(await requestDate(f.page, 2)).toBe(today);
      await complete(f.page, 2, dayPayload(today, 17, 3));
      await expect.poll(() => f.page.locator(".print-actions").count()).toBe(1);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("sends no request for a cleared date and shows a truthful notice until a real date returns", async () => {
    const f = await fixture();
    try {
      const today = await requestDate(f.page, 0);
      await complete(f.page, 0, dayPayload(today, 17, 3));
      await expect.poll(() => f.page.locator(".print-actions").count()).toBe(1);

      await f.page.getByTestId("daily-report").locator('input[type="date"]').fill("");
      await expect.poll(() => f.page.getByText("التاريخ المختار غير صالح", { exact: false }).count()).toBe(1);
      // Passive effects have flushed by the double animation frame: no
      // ambiguous /api/report request ever left the page for the empty value.
      await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await f.page.evaluate(() => (window as unknown as FixtureWindow).__dailyReports.length)).toBe(1);
      await noReport(f.page);
      expect(await f.page.getByRole("button", { name: "‹ اليوم السابق", exact: true }).isDisabled()).toBe(true);
      expect(await f.page.getByRole("button", { name: "اليوم التالي ›", exact: true }).isDisabled()).toBe(true);

      await f.page.getByRole("button", { name: /^اليوم \(/ }).click();
      await waitForRequest(f.page, 1);
      expect(await requestDate(f.page, 1)).toBe(today);
      await complete(f.page, 1, dayPayload(today, 17, 3));
      await expect.poll(() => f.page.locator(".print-actions").count()).toBe(1);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });
});
