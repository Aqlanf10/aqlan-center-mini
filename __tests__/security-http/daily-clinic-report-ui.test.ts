import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dailyClinicReportFixture } from "../fixtures/daily-clinic-report";
import { baseUrl, harness, authedGet } from "./_server";
import { emitDailyClinicEvidence, emitDailyClinicFailureEvidence, type DailyClinicEvidenceFile } from "./_daily-clinic-evidence";

// Built page + isolated test database for authentication only. Every report
// payload is synthetic and intercepted; no live clinic record enters artifacts.
const evidence: DailyClinicEvidenceFile[] = [];
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => {
  await browser?.close();
  // Each buffer is retained only after that synthetic scenario's complete
  // layout, PDF and isolation assertions. An incomplete set cannot be emitted.
  emitDailyClinicEvidence(evidence);
});

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
async function noResult(page: Page) {
  await expect.poll(() => page.getByTestId("daily-clinic-result").count()).toBe(0);
  expect(await page.getByTestId("daily-clinic-print").count()).toBe(0);
}

describe("admin-only daily clinic close authorization over HTTP", () => {
  it("passes through the real proxy and loader for an admin on an empty historical day", async () => {
    const response = await authedGet("/api/reports/daily-clinic?date=1900-01-01", h.sessions.admin);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const report = await response.json();
    expect(report.date).toBe("1900-01-01");
    expect(report.attendees).toEqual([]);
    expect(report.work).toEqual([]);
    expect(report.receipts).toEqual([]);
    expect(report.expenses.movements).toEqual([]);
  });
  it("denies anonymous requests and does not serialize clinical or financial data", async () => {
    const response = await fetch(`${baseUrl}/api/reports/daily-clinic?date=2026-09-30`, { redirect: "manual" });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toMatch(/attendees|agreements|receipts|currentAccounts/);
  });
  it.each(["doctorA", "reception", "accountant", "cashier"] as const)("denies the report API to authenticated %s", async (role) => {
    const response = await authedGet("/api/reports/daily-clinic?date=2026-09-30", h.sessions[role]);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toMatch(/attendees|agreements|receipts|currentAccounts/);
  });
  it.each(["doctorA", "reception", "accountant", "cashier"] as const)("never server-renders report data or controls for %s", async (role) => {
    const response = await fetch(`${baseUrl}/reports/daily-clinic?date=2026-09-30`, { headers: { Cookie: h.sessions[role].cookie }, redirect: "manual" });
    expect([403, 404, 307, 308]).toContain(response.status);
    const html = await response.text();
    expect(html).not.toContain('data-testid="daily-clinic-report"');
    expect(html).not.toContain('data-testid="daily-clinic-result"');
  });
});

describe("daily clinic close state, complete output and screen layout", () => {
  it.each([320, 390, 1280])("keeps all currency groups readable at %s and distinguishes each financial basis", async (width) => {
    const f = await fixture(width);
    try {
      const report = dailyClinicReportFixture();
      await complete(f.page, 0, report);
      await expect.poll(() => f.page.getByTestId("daily-clinic-result").count()).toBe(1);
      expect(await f.page.getByTestId("daily-clinic-attendees").locator('tbody tr[data-patient-key]').count()).toBe(2);
      expect(await f.page.getByTestId("daily-clinic-attendees").locator("thead tr:last-child th bdi").allTextContents()).toEqual(["YER", "SAR", "USD", "YER", "SAR", "USD", "YER", "SAR", "USD"]);
      const currencyHeaders = await f.page.getByTestId("daily-clinic-attendees").locator("thead tr:last-child th").allTextContents();
      expect(currencyHeaders[0]).toContain("يمني"); expect(currencyHeaders[1]).toContain("سعودي"); expect(currencyHeaders[2]).toContain("دولار");
      expect(await f.page.getByTestId("daily-clinic-close-summary").locator("tbody tr").count()).toBe(7);
      expect(await f.page.getByTestId("daily-clinic-reconciliation").locator("tbody tr").count()).toBe(7);
      expect(await f.page.getByTestId("daily-clinic-attendee-totals").locator("[data-minor]").evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute("data-minor"))))).toEqual([1975308642, 46913578, 69135780, 246912, 913578, 1135780, 1975061730, 46000000, 68000000]);
      expect(await f.page.getByTestId("daily-clinic-basis").innerText()).toContain("حالتها الحالية عند إعداد الكشف");
      expect(await f.page.getByTestId("daily-clinic-work").innerText()).toContain("غير معلوم");
      expect(await f.page.getByTestId("daily-clinic-other-receipts").innerText()).toContain("SYNTHETIC-NONATTENDEE-501");
      expect(await f.page.getByTestId("daily-clinic-attendees").innerText()).not.toContain("شخص اصطناعي لم يحضر");
      expect(await f.page.getByTestId("daily-clinic-expenses").innerText()).not.toContain("SYNTHETIC-CREATOR-NOT-RECIPIENT");
      const root = f.page.getByTestId("daily-clinic-report");
      const bounds = await root.evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }));
      expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width + 1); expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
      // Large tables scroll in their labeled regions, never by clipping amounts.
      const clipped = await root.locator("td, th, bdi").evaluateAll((nodes) => nodes.filter((node) => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1).map((node) => node.textContent));
      expect(clipped).toEqual([]);
      await mkdir(".settings-ui-artifacts", { recursive: true });
      const bytes = await f.page.screenshot({ path: `.settings-ui-artifacts/daily-clinic-${width}.png`, fullPage: false });
      f.assertIsolated();
      if (width === 390 || width === 1280) evidence.push({ filename: `daily-clinic-${width}.png`, mime: "image/png", bytes });
    } finally { await f.context.close(); }
  });

  it("hides stale results before fetch on date changes, return-to-date and same-date refresh", async () => {
    const f = await fixture();
    try {
      await complete(f.page, 0, dailyClinicReportFixture());
      const field = f.page.getByLabel("يوم الحضور", { exact: true });
      await field.fill("2026-09-29"); await waitForRequest(f.page, 1); await noResult(f.page);
      await field.fill("2026-09-30"); await waitForRequest(f.page, 2); await noResult(f.page);
      for (const index of [1, 2]) expect(await f.page.evaluate((i) => (window as unknown as TestWindow).__dailyClinic[i].atRequest, index)).toEqual({ date: index === 1 ? "2026-09-29" : "2026-09-30", result: false, print: false });
      await complete(f.page, 1, dailyClinicReportFixture("2026-09-29")); await noResult(f.page);
      await complete(f.page, 2, dailyClinicReportFixture());
      await expect.poll(() => f.page.getByTestId("daily-clinic-result").count()).toBe(1);
      await f.page.getByRole("button", { name: "تحديث الكشف", exact: true }).click(); await waitForRequest(f.page, 3);
      expect(await f.page.evaluate(() => (window as unknown as TestWindow).__dailyClinic[3].atRequest)).toEqual({ date: "2026-09-30", result: false, print: false });
      await f.page.emulateMedia({ media: "print" }); await noResult(f.page);
      await f.page.emulateMedia({ media: "screen" });
      await complete(f.page, 3, dailyClinicReportFixture()); f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it.each(["body", "reject"] as const)("ignores obsolete JSON %s after a newer successful date", async (outcome) => {
    const f = await fixture();
    try {
      await respond(f.page, 0);
      await expect.poll(() => f.page.evaluate(() => (window as unknown as TestWindow).__dailyClinic[0].bodyStarted)).toBe(true);
      await f.page.getByLabel("يوم الحضور", { exact: true }).fill("2026-09-29"); await waitForRequest(f.page, 1);
      await complete(f.page, 1, dailyClinicReportFixture("2026-09-29"));
      if (outcome === "body") await body(f.page, 0, dailyClinicReportFixture());
      else await f.page.evaluate(() => (window as unknown as TestWindow).__dailyClinic[0].reject());
      await expect.poll(() => f.page.getByTestId("daily-clinic-result-date").innerText()).toBe("2026-09-29");
      expect(await f.page.getByTestId("daily-clinic-report").getByRole("alert").count()).toBe(0); f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("rejects wrong date/timezone and errors, clears invalid date without fetching, then recovers", async () => {
    const f = await fixture();
    try {
      await f.page.evaluate(() => {
        const alert = document.createElement("div");
        alert.role = "alert"; alert.dataset.testid = "synthetic-shell-alert";
        alert.textContent = "SYNTHETIC OUTER SHELL NOTICE";
        document.body.append(alert);
      });
      expect(await f.page.getByTestId("synthetic-shell-alert").count()).toBe(1);
      expect(await f.page.getByTestId("daily-clinic-report").getByRole("alert").count()).toBe(0);
      await complete(f.page, 0, dailyClinicReportFixture("2026-09-29"));
      await expect.poll(() => f.page.getByTestId("daily-clinic-report").getByRole("alert").count()).toBe(1); await noResult(f.page);
      await f.page.getByRole("button", { name: "أعد المحاولة", exact: true }).click(); await waitForRequest(f.page, 1);
      await complete(f.page, 1, { ...dailyClinicReportFixture(), clinicTimeZone: "UTC" }); await noResult(f.page);
      await f.page.getByRole("button", { name: "أعد المحاولة", exact: true }).click(); await waitForRequest(f.page, 2);
      await complete(f.page, 2, { message: "SYNTHETIC PRIVATE DIAGNOSTIC" }, 500);
      await expect.poll(() => f.page.getByTestId("daily-clinic-report").getByRole("alert").count()).toBe(1); await noResult(f.page);
      expect(await f.page.locator("body").innerText()).not.toContain("PRIVATE DIAGNOSTIC");
      await f.page.getByLabel("يوم الحضور", { exact: true }).fill("");
      await expect.poll(() => f.page.getByTestId("daily-clinic-report").getByRole("alert").innerText()).toContain("اختر تاريخًا صحيحًا");
      expect(await f.page.evaluate(() => (window as unknown as TestWindow).__dailyClinic.length)).toBe(3);
      await f.page.emulateMedia({ media: "print" }); await noResult(f.page);
      await f.page.emulateMedia({ media: "screen" });
      const beforeAden = await f.page.evaluate(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
      await f.page.getByRole("button", { name: "اليوم بتوقيت العيادة", exact: true }).click(); await waitForRequest(f.page, 3);
      const requested = await f.page.evaluate(() => new URL((window as unknown as TestWindow).__dailyClinic[3].url).searchParams.get("date")!);
      // The browser deliberately runs in Honolulu; the clinic remains Aden.
      const aden = await f.page.evaluate(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
      expect([beforeAden, aden]).toContain(requested); // independently brackets clinic midnight
      await complete(f.page, 3, dailyClinicReportFixture(requested));
      await expect.poll(() => f.page.getByTestId("daily-clinic-result-date").innerText()).toBe(requested); f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("shows an empty attendance day without omitting clinicwide recorded movements", async () => {
    const f = await fixture();
    try {
      await complete(f.page, 0, dailyClinicReportFixture("2026-09-30", 0));
      await expect.poll(() => f.page.getByTestId("daily-clinic-result").count()).toBe(1);
      expect(await f.page.getByTestId("daily-clinic-attendees").locator("[data-patient-key]").count()).toBe(0);
      expect(await f.page.getByTestId("daily-clinic-other-receipts").locator("[data-receipt-id]").count()).toBe(2);
      expect(await f.page.getByTestId("daily-clinic-expenses").locator("[data-expense-id]").count()).toBe(2);
      expect(await f.page.getByTestId("daily-clinic-print").count()).toBe(1); f.assertIsolated();
    } finally { await f.context.close(); }
  });
});

const plain = (text: string) => text.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");

describe("daily clinic full-result A4 print proof", () => {
  it("prints every attendee across pages, repeating currency headers without clipping or footer repetition", async () => {
    const f = await fixture();
    try {
      const count = 56;
      await complete(f.page, 0, dailyClinicReportFixture("2026-09-30", count));
      await expect.poll(() => f.page.getByTestId("daily-clinic-attendees").locator("[data-patient-key]").count()).toBe(count);
      await f.page.emulateMedia({ media: "print" });
      await f.page.evaluate(() => document.fonts.ready);
      expect(await f.page.getByTestId("daily-clinic-print").isHidden()).toBe(true);
      expect(await f.page.getByLabel("يوم الحضور", { exact: true }).isHidden()).toBe(true);
      expect(await f.page.getByTestId("daily-clinic-attendees").locator("thead").evaluate((node) => getComputedStyle(node).display)).toBe("table-header-group");
      expect(await f.page.getByTestId("daily-clinic-attendees").locator("tfoot").evaluate((node) => getComputedStyle(node).display)).toBe("table-row-group");
      const splitRules = await f.page.getByTestId("daily-clinic-attendees").locator("tbody tr").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).breakInside));
      expect(splitRules.every((rule) => rule === "avoid")).toBe(true);
      const path = ".settings-ui-artifacts/daily-clinic-full-a4.pdf";
      await mkdir(".settings-ui-artifacts", { recursive: true });
      const bytes = await f.page.pdf({ path, preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
      try {
        const reference = f.page.getByTestId("daily-clinic-other-receipts").locator('tbody th[scope="row"] > bdi');
        expect(await reference.innerText()).toBe("SYNTHETIC-NONATTENDEE-501");
        expect(await reference.getAttribute("dir")).toBe("ltr");
        expect(await reference.evaluate((node) => {
          const range = document.createRange(); range.selectNodeContents(node);
          return range.getClientRects().length;
        })).toBe(1);
        expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
        const xml = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
        const pages = await f.page.evaluate((xml) => {
          const document = new DOMParser().parseFromString(xml, "application/xml");
          if (document.querySelector("parsererror")) throw new Error("Invalid PDF XML");
          return Array.from(document.getElementsByTagName("page")).map((page) => ({
            width: Number(page.getAttribute("width")), height: Number(page.getAttribute("height")),
            words: Array.from(page.getElementsByTagName("word")).map((word) => ({ text: word.textContent ?? "", xMin: Number(word.getAttribute("xMin")), xMax: Number(word.getAttribute("xMax")), yMin: Number(word.getAttribute("yMin")), yMax: Number(word.getAttribute("yMax")) })),
          }));
        }, xml);
        expect(pages.length).toBeGreaterThan(2);
        for (const page of pages) {
          expect(Math.abs(page.width - 841.89)).toBeLessThan(1.5);
          expect(Math.abs(page.height - 595.28)).toBeLessThan(1.5);
          for (const word of page.words) {
            expect(word.xMin).toBeGreaterThanOrEqual(26); expect(word.xMax).toBeLessThanOrEqual(page.width - 26);
            expect(word.yMin).toBeGreaterThanOrEqual(26); expect(word.yMax).toBeLessThanOrEqual(page.height - 26);
          }
        }
        const allWords = pages.flatMap((page) => page.words.map((word) => plain(word.text)));
        for (let i = 1; i <= count; i++) expect(allWords.filter((word) => word === `SYNTHETIC-${String(i).padStart(4, "0")}`)).toHaveLength(1);
        const attendeePages = pages.filter((page) => page.words.some((word) => /^SYNTHETIC-\d{4}$/.test(plain(word.text))));
        expect(attendeePages.length).toBeGreaterThan(1);
        for (const page of attendeePages) for (const currency of ["YER", "SAR", "USD"]) expect(page.words.filter((word) => plain(word.text) === currency).length).toBeGreaterThanOrEqual(3);
        // All nine values of the first patient's financial row belong to the
        // same paper page as that patient's marker, including its long summary.
        const first = attendeePages.find((page) => page.words.some((word) => plain(word.text) === "SYNTHETIC-0001"))!;
        const firstText = first.words.map((word) => plain(word.text)).join(" ");
        for (const amount of ["987,654,321", "234,567.89", "345,678.90", "123,456", "4,567.89", "5,678.90", "987,530,865", "230,000.00", "340,000.00"]) expect(firstText).toContain(amount);
        // Footer figures must also remain whole words, not merely reconstruct
        // correctly after removing line breaks from a damaged paper layout.
        expect(allWords).toContain("55,308,641,976");
        const compact = allWords.join("");
        expect(compact).toContain("SYNTHETIC-NONATTENDEE-501");
        expect(compact).toContain("SYNTHETIC-EXPENSE-700");
        expect(allWords).not.toContain("SYNTHETIC-CREATOR-NOT-RECIPIENT");
        expect(await f.page.getByTestId("daily-clinic-end").isVisible()).toBe(true);
        // Exact unique amounts in the main footer stay present once in that DOM
        // footer. The separate closing summary is intentionally a labeled repeat.
        expect(await f.page.getByTestId("daily-clinic-attendee-totals").count()).toBe(1);
        await writeFile(".settings-ui-artifacts/daily-clinic-print-proof.json", JSON.stringify({ synthetic: true, attendeeCount: count, pageCount: pages.length, attendeePageCount: attendeePages.length, dimensions: pages.map(({ width, height }) => ({ width, height })), complete: true }, null, 2));
        f.assertIsolated();
        evidence.push({ filename: "daily-clinic-full-a4.pdf", mime: "application/pdf", bytes });
      } catch (error) {
        // This is explicitly failed diagnostic output, not successful evidence.
        // The fixture must still prove all report input was synthetic/isolated.
        f.assertIsolated();
        emitDailyClinicFailureEvidence(bytes);
        throw error;
      }
    } finally { await f.context.close(); }
  });

  it("prints extreme exact amounts in readable currency panels without clipping", async () => {
    const f = await fixture();
    try {
      const report = dailyClinicReportFixture("2026-09-30", 1);
      const maximum = Number.MAX_SAFE_INTEGER;
      report.attendees[0].agreement.YER = maximum;
      report.attendees[0].agreementRemaining.YER = maximum - report.attendees[0].explicitlySettled.YER;
      report.totals.agreement.YER = maximum;
      report.totals.agreementRemaining.YER = report.attendees[0].agreementRemaining.YER;
      report.agreements[0].principalMinor = maximum;
      report.agreements[0].remainingMinor = report.attendees[0].agreementRemaining.YER;
      await complete(f.page, 0, report);
      await expect.poll(() => f.page.getByTestId("daily-clinic-result").count()).toBe(1);
      expect(await f.page.getByTestId("daily-clinic-currency-panels").isHidden()).toBe(true);
      await f.page.emulateMedia({ media: "print" });
      await f.page.evaluate(() => document.fonts.ready);
      expect(await f.page.getByTestId("daily-clinic-attendees").isHidden()).toBe(true);
      expect(await f.page.getByTestId("daily-clinic-recipients").isHidden()).toBe(true);
      const panels = f.page.getByTestId("daily-clinic-currency-panels");
      expect(await panels.isVisible()).toBe(true);
      expect(await panels.locator("table").count()).toBe(3);
      expect(await f.page.getByTestId("daily-clinic-recipient-currency-panels").locator("table").count()).toBe(3);
      const amounts = await panels.locator("[data-minor]").evaluateAll((nodes) => nodes.map((node) => {
        const style = getComputedStyle(node), box = node.getBoundingClientRect(), cell = node.closest("td")!.getBoundingClientRect();
        return { text: node.textContent, font: parseFloat(style.fontSize), whiteSpace: style.whiteSpace, fits: box.left >= cell.left && box.right <= cell.right };
      }));
      expect(amounts.some((amount) => amount.text === "9,007,199,254,740,991")).toBe(true);
      for (const amount of amounts) { expect(amount.font).toBeGreaterThanOrEqual(11.3); expect(amount.whiteSpace).toBe("nowrap"); expect(amount.fits).toBe(true); }
      const path = ".settings-ui-artifacts/daily-clinic-extreme-a4.pdf";
      await mkdir(".settings-ui-artifacts", { recursive: true });
      const bytes = await f.page.pdf({ path, preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
      const xml = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      const pages = await f.page.evaluate((xml) => {
        const doc = new DOMParser().parseFromString(xml, "application/xml");
        if (doc.querySelector("parsererror")) throw new Error("Invalid PDF XML");
        return Array.from(doc.getElementsByTagName("page")).map((page) => ({
          width: Number(page.getAttribute("width")), height: Number(page.getAttribute("height")),
          words: Array.from(page.getElementsByTagName("word")).map((word) => ({ text: word.textContent ?? "", xMin: Number(word.getAttribute("xMin")), xMax: Number(word.getAttribute("xMax")), yMin: Number(word.getAttribute("yMin")), yMax: Number(word.getAttribute("yMax")) })),
        }));
      }, xml);
      expect(pages.length).toBeGreaterThan(0);
      for (const page of pages) {
        expect(Math.abs(page.width - 841.89)).toBeLessThan(1.5); expect(Math.abs(page.height - 595.28)).toBeLessThan(1.5);
        for (const word of page.words) {
          expect(word.xMin).toBeGreaterThanOrEqual(26); expect(word.xMax).toBeLessThanOrEqual(page.width - 26);
          expect(word.yMin).toBeGreaterThanOrEqual(26); expect(word.yMax).toBeLessThanOrEqual(page.height - 26);
        }
      }
      const words = pages.flatMap((page) => page.words.map((word) => plain(word.text)));
      expect(words).toContain("9,007,199,254,740,991");
      expect(words).toContain("9,007,199,254,617,535");
      // One patient row per explicit currency panel, no printed grouped copy.
      expect(words.filter((word) => word === "SYNTHETIC-0001")).toHaveLength(3);
      expect(await f.page.getByTestId("daily-clinic-end").isVisible()).toBe(true);
      f.assertIsolated();
      evidence.push({ filename: "daily-clinic-extreme-a4.pdf", mime: "application/pdf", bytes });
    } finally { await f.context.close(); }
  });
});
