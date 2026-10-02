import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { mkdir } from "node:fs/promises";
import { expenseCategoriesFixture as input } from "../fixtures/expense-categories";
import { projectExpenseCategories } from "../../lib/expense-catalogue-visibility";
import { baseUrl, harness } from "./_server";

// Mandatory built-page cases on the isolated security-HTTP harness. Every
// catalogue/order response is synthetic; no role grant or business write occurs.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

const full = projectExpenseCategories(input, "full")!;
const catalogue = projectExpenseCategories(input, "catalogue")!;
const reportHeading = "تقرير تدقيق بنود المصروفات التشغيلية والميزانيات التقديرية";
type Pending = { respond: (status: number) => void; body: (payload: unknown) => void };
type FixtureWindow = Window & {
  __expenseCatalogue: Pending[];
  __expenseExports: { filename: string; xml: string }[];
  __expensePrints: number;
};
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function fixture(path = "/finance/expense-categories", width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const unexpected: string[] = [];
  const errors: string[] = [];
  const downloads: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await context.route("**/*", async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== new URL(baseUrl).origin) {
      unexpected.push(`external ${url.origin}`); await route.abort(); return;
    }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    if (request.method() === "GET") {
      switch (url.pathname) {
        case "/api/booking-requests": await json(route, []); return;
        case "/api/lab": await json(route, { orders: [], labs: [], late: 0 }); return;
        case "/api/messages": await json(route, { unread: 0, urgent: 0 }); return;
        case "/api/auth/me": await json(route, { username: "secadmin", role: "admin" }); return;
        case "/api/laboratories": await json(route, { laboratories: [] }); return;
        case "/api/lab/services": await json(route, { services: [] }); return;
      }
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    await route.fulfill({ status: 501, contentType: "application/json", body: '{"message":"Unmocked fixture request blocked"}' });
  });
  await page.addInitScript(() => {
    const target = window as unknown as FixtureWindow;
    target.__expenseCatalogue = [];
    target.__expenseExports = [];
    target.__expensePrints = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((resource: RequestInfo | URL, init?: RequestInit) => {
      const raw = resource instanceof Request ? resource.url : String(resource);
      const url = new URL(raw, window.location.href);
      const method = init?.method ?? (resource instanceof Request ? resource.method : "GET");
      if (url.origin !== window.location.origin || url.pathname !== "/api/finance/expense-categories" || method !== "GET") {
        return originalFetch(resource, init);
      }
      let respond!: (response: Response) => void;
      let body!: (payload: unknown) => void;
      const response = new Promise<Response>((resolve) => { respond = resolve; });
      const payload = new Promise<unknown>((resolve) => { body = resolve; });
      target.__expenseCatalogue.push({ body, respond: (status) => respond({
        ok: status >= 200 && status < 300, status, json: () => payload,
      } as Response) });
      return response;
    }) as typeof window.fetch;

    // Exercise the actual exporter but retain its synthetic Blob in memory.
    // No file is downloaded, opened, written or transmitted; print is a spy.
    const blobs = new Map<string, Blob>();
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      if (!(blob instanceof Blob)) throw new Error("Unexpected non-Blob export");
      const key = `blob:synthetic-expense-export-${blobs.size}`;
      blobs.set(key, blob); return key;
    };
    URL.revokeObjectURL = (key: string) => { blobs.delete(key); };
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download) return originalClick.call(this);
      const blob = blobs.get(this.href);
      if (!blob) throw new Error("Unknown export Blob");
      const record = { filename: this.download, xml: "" };
      target.__expenseExports.push(record);
      void blob.text().then((xml) => { record.xml = xml; });
    };
    window.print = () => { target.__expensePrints++; };
  });
  await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
  await waitForRequest(page, 0);
  return { context, page, assertIsolated: () => {
    expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(downloads).toEqual([]);
  } };
}
async function waitForRequest(page: Page, index: number) {
  await expect.poll(() => page.evaluate((i) => Boolean((window as unknown as FixtureWindow).__expenseCatalogue[i]), index)).toBe(true);
}
async function complete(page: Page, index: number, payload: unknown, status = 200) {
  await page.evaluate(({ index, payload, status }) => {
    const pending = (window as unknown as FixtureWindow).__expenseCatalogue[index];
    pending.respond(status); pending.body(payload);
  }, { index, payload, status });
}
async function changeMonth(page: Page, force = false) {
  const field = page.locator('input[type="month"]');
  const month = await field.inputValue();
  await field.fill(month === "2026-08" ? "2026-09" : "2026-08", { force });
}
async function assertNoBudget(page: Page) {
  expect(await page.getByTestId("expense-budget-manager").count()).toBe(0);
  expect(await page.getByRole("heading", { name: reportHeading, exact: true }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "تصدير Excel", exact: true }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "حفظ التعديلات الآن", exact: true }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "إضافة بند مصروف جديد", exact: true }).count()).toBe(0);
  expect(await page.getByText("Synthetic confidential budget note", { exact: false }).count()).toBe(0);
}

const screens = [
  { path: "/finance/expense-categories", width: 1280 },
  { path: "/finance/expense-categories", width: 390 },
  { path: "/settings/finance-expenses", width: 1280 },
  { path: "/settings/finance-expenses", width: 390 },
];
describe("built expense catalogue visibility and daily workflow compatibility", () => {
  it.each(screens)("shows catalogue-only metadata on $path at $width px without budget/export output", async ({ path, width }) => {
    const f = await fixture(path, width);
    try {
      await complete(f.page, 0, catalogue);
      await expect.poll(() => f.page.getByTestId("expense-catalogue-only").count()).toBe(1);
      await assertNoBudget(f.page);
      const panel = f.page.getByTestId("expense-catalogue-only");
      expect(await panel.textContent()).toContain("Synthetic lab category");
      expect(await panel.textContent()).toContain("Synthetic account");
      expect(await panel.textContent()).toContain("5101");
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (path === "/finance/expense-categories") {
        await mkdir(".settings-ui-artifacts", { recursive: true });
        await panel.screenshot({ path: `.settings-ui-artifacts/expense-catalogue-restricted-${width}.png` });
      }
      await f.page.emulateMedia({ media: "print" });
      await assertNoBudget(f.page);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("keeps the admin full report, synthetic Excel serialization and print control working", async () => {
    const f = await fixture();
    try {
      await complete(f.page, 0, full);
      await expect.poll(() => f.page.getByTestId("expense-budget-manager").count()).toBe(1);
      await f.page.getByRole("button", { name: "تصدير Excel", exact: true }).click();
      await expect.poll(() => f.page.evaluate(() => (window as unknown as FixtureWindow).__expenseExports[0]?.xml.includes("Synthetic lab category"))).toBe(true);
      const exported = await f.page.evaluate(() => (window as unknown as FixtureWindow).__expenseExports[0]);
      expect(exported.filename).toMatch(/\.xls$/);
      expect(exported.xml).toContain("123400.00"); expect(exported.xml).toContain("45678.00");
      await f.page.getByRole("button", { name: "تقرير وتدقيق الميزانية (PDF)", exact: true }).click();
      await expect.poll(() => f.page.getByRole("heading", { name: reportHeading, exact: true }).count()).toBe(1);
      await f.page.getByTitle("تنزيل كملف Excel معتمد", { exact: true }).click();
      await expect.poll(() => f.page.evaluate(() => (window as unknown as FixtureWindow).__expenseExports[1]?.xml.includes("Synthetic lab category"))).toBe(true);
      await f.page.getByRole("button", { name: "طباعة / PDF", exact: true }).click();
      expect(await f.page.evaluate(() => (window as unknown as FixtureWindow).__expensePrints)).toBe(1);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("removes an open full report and discards unsaved budget drafts on a restricted reload", async () => {
    const f = await fixture();
    try {
      await complete(f.page, 0, full);
      const manager = f.page.getByTestId("expense-budget-manager");
      await expect.poll(() => manager.count()).toBe(1);
      const row = manager.locator("tbody tr").filter({ hasText: "Synthetic lab category" });
      await row.locator('input[type="number"]').fill("321000");
      await expect.poll(() => f.page.getByRole("button", { name: "حفظ التعديلات الآن", exact: true }).count()).toBe(1);
      await f.page.getByRole("button", { name: "تقرير وتدقيق الميزانية (PDF)", exact: true }).click();
      await expect.poll(() => f.page.getByRole("heading", { name: reportHeading, exact: true }).count()).toBe(1);
      // A synthetic native form event triggers the real reload handler while the
      // modal is open. No session/grant or server state is changed.
      await changeMonth(f.page, true);
      await waitForRequest(f.page, 1);
      await assertNoBudget(f.page);
      await complete(f.page, 1, catalogue);
      await expect.poll(() => f.page.getByTestId("expense-catalogue-only").count()).toBe(1);
      await assertNoBudget(f.page);
      await mkdir(".settings-ui-artifacts", { recursive: true });
      await f.page.getByTestId("expense-catalogue-only").screenshot({ path: ".settings-ui-artifacts/expense-catalogue-revoked-open-report.png" });
      await f.page.emulateMedia({ media: "print" }); await assertNoBudget(f.page);
      await f.page.emulateMedia({ media: "screen" });
      await f.page.getByRole("button", { name: "إعادة التحميل", exact: true }).click();
      await waitForRequest(f.page, 2); await complete(f.page, 2, full);
      await expect.poll(() => manager.count()).toBe(1);
      expect(await row.locator('input[type="number"]').inputValue()).toBe("123400");
      expect(await f.page.getByRole("button", { name: "حفظ التعديلات الآن", exact: true }).count()).toBe(0);
      expect(await f.page.getByRole("heading", { name: reportHeading, exact: true }).count()).toBe(0);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it.each([401, 403])("clears the loaded manager on HTTP %s and permits a later safe retry", async (status) => {
    const f = await fixture();
    try {
      await complete(f.page, 0, full);
      await expect.poll(() => f.page.getByTestId("expense-budget-manager").count()).toBe(1);
      await changeMonth(f.page);
      await waitForRequest(f.page, 1);
      await complete(f.page, 1, { message: `Synthetic denied ${status}` }, status);
      await expect.poll(() => f.page.getByRole("alert").filter({ hasText: new RegExp(`^Synthetic denied ${status}$`) }).count()).toBe(1);
      await assertNoBudget(f.page);
      await f.page.getByRole("button", { name: "إعادة التحميل", exact: true }).click();
      await waitForRequest(f.page, 2); await complete(f.page, 2, catalogue);
      await expect.poll(() => f.page.getByTestId("expense-catalogue-only").count()).toBe(1);
      await assertNoBudget(f.page); f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("keeps the lab's ordinary category and account-mapping picker usable without budgets", async () => {
    const f = await fixture("/lab");
    try {
      await complete(f.page, 0, catalogue);
      await f.page.getByRole("button", { name: "+ إرسال عمل جديد للمختبر", exact: true }).click();
      const picker = f.page.locator('select:has(option[value="901"])');
      await expect.poll(() => picker.count()).toBe(1);
      expect(await picker.locator('option[value="901"]').textContent()).toContain("Synthetic lab category (Synthetic group)");
      expect(await picker.locator('option[value="901"]').textContent()).toContain("5101");
      await picker.selectOption("901"); expect(await picker.inputValue()).toBe("901");
      expect(await f.page.getByText("Synthetic confidential budget note", { exact: false }).count()).toBe(0);
      // No patient selection, lab submission, category write or file export.
      f.assertIsolated();
    } finally { await f.context.close(); }
  });
});
