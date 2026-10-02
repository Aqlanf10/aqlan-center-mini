import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { mkdir } from "node:fs/promises";
import { baseUrl, harness } from "./_server";

// Mandatory CI built-app cases. The isolated HTTP harness supplies only a
// synthetic session. All browser API reads are synthetic, every write and
// external request is blocked, and no financial submit control is clicked.
// Refresh/retry are the real GET-only UI controls, not React internals.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

const zero = () => ({ YER: 0, SAR: 0, USD: 0 });
const expectedCash = { YER: 72_500, SAR: 1_234, USD: -125 };
function shift(id = 98301) {
  return {
    id, openedBy: "Synthetic cashier", openedAt: "2030-01-01T09:00:00.000Z",
    opening: { YER: 50_000, SAR: 1_000, USD: 200 }, closedBy: null,
    closedAt: null, counted: null, note: null, status: "open",
  };
}
function feed(open = true, id = 98301) {
  return {
    clinicTimeZone: "Asia/Aden", open: open ? shift(id) : null,
    totals: { byCurrency: zero(), baseTotalMinor: open ? 90_000 : 0, paymentCount: open ? 2 : 0 },
    expenseTotals: { byCategory: {}, byCurrency: zero(), baseTotalMinor: open ? 500 : 0, count: open ? 1 : 0 },
    payments: [], expenses: [], recent: [], drawer: open ? { expected: expectedCash } : null,
  };
}
function reconciliation(open = true, id = 98301) {
  return {
    openShift: open ? { shift: shift(id), paymentsCount: 2, expensesCount: 1,
      income: zero(), refunds: zero(), expenses: zero(), expected: expectedCash } : null,
    shifts: [], baseCurrency: "YER",
  };
}
const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status, contentType: "application/json", body: JSON.stringify(body),
});
type Mode = "finance" | "reconciliation";
async function fixture(mode: Mode = "finance", role: "admin" | "accountant" = "admin") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions[role].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const pending: Route[] = [];
  const writes: string[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const target = mode === "finance" ? "/api/shifts" : "/api/finance/reconciliation";
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (url.origin !== baseUrl) {
      unexpected.push(`${method} ${url.origin}${path}`);
      await route.abort();
    } else if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      writes.push(`${method} ${path}`);
      await json(route, { message: "Write blocked by synthetic shift fixture" }, 409);
    } else if (path === target) pending.push(route);
    else if (path === "/api/parties" || path === "/api/booking-requests") await json(route, []);
    else if (path === "/api/finance/debts") await json(route, { rows: [] });
    else if (path === "/api/plans") await json(route, { plans: [] });
    else if (path === "/api/finance/lab-reconciliation") await json(route, { labs: [], risks: [], totalRisksCount: 0 });
    else if (path === "/api/finance/commissions") await json(route, { rows: [], totals: {} });
    else if (path === "/api/accounting") await json(route, { balances: [], cumulativeBalances: [], to: "2030-01-01", entryCount: 0 });
    else if (path === "/api/lab") await json(route, { late: 0 });
    else if (path === "/api/messages") await json(route, { unread: 0, urgent: 0 });
    else if (path === "/api/auth/me") await json(route, { username: role === "admin" ? "secadmin" : "secaccountant", role });
    else if (path.startsWith("/api/") || path.startsWith("/print/")) {
      unexpected.push(`${method} ${path}`);
      await json(route, { message: "Read blocked by synthetic shift fixture" }, 404);
    } else await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}${mode === "finance" ? "/finance" : "/finance/reconciliation"}`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => pending.length).toBe(1);
    return {
      page, context, pending, writes, unexpected, errors,
      respond: async (open = true, id = 98301) => {
        const route = pending.shift();
        if (!route) throw new Error("No shift read is pending");
        await json(route, mode === "finance" ? feed(open, id) : reconciliation(open, id));
      },
      fail: async (network = false) => {
        const route = pending.shift();
        if (!route) throw new Error("No shift read is pending");
        if (network) await route.abort("failed");
        else await json(route, { message: "Synthetic shift read unavailable" }, 503);
      },
      assertIsolated: () => {
        expect(writes).toEqual([]);
        expect(unexpected).toEqual([]);
        expect(errors).toEqual([]);
      },
    };
  } catch (error) { await context.close(); throw error; }
}
async function expectUnknown(page: Page) {
  const main = page.locator("main").last();
  expect(await main.getByText("لا توجد وردية مفتوحة", { exact: false }).count()).toBe(0);
  expect(await main.getByText("الصندوق مغلق", { exact: false }).count()).toBe(0);
  expect(await main.getByRole("button", { name: /فتح وردية جديدة|جرد وإقفال الوردية|إغلاق وجرد الوردية/ }).count()).toBe(0);
}

for (const mode of ["finance", "reconciliation"] as const) {
  describe(`built ${mode} shift read state`, () => {
    it.each([false, true])("keeps unknown through initial failure then recovers from the visible retry, network=%s", async (network) => {
      const f = await fixture(mode);
      try {
        await expectUnknown(f.page);
        expect(await f.page.getByRole("button", { name: "تحديث بيانات الصندوق", exact: true }).isDisabled()).toBe(true);
        await f.fail(network);
        await f.page.getByRole("button", { name: "إعادة المحاولة", exact: true }).waitFor();
        await expectUnknown(f.page);
        await f.page.getByRole("button", { name: "إعادة المحاولة", exact: true }).click();
        await expect.poll(() => f.pending.length).toBe(1);
        await expectUnknown(f.page);
        await f.respond(false);
        await expect.poll(() => f.page.getByText("لا توجد وردية مفتوحة", { exact: false }).count()).toBeGreaterThan(0);
        f.assertIsolated();
      } finally { await f.context.close(); }
    });

    it("preserves accountant read-only controls after a confirmed open read", async () => {
      const f = await fixture(mode, "accountant");
      try {
        await f.respond();
        await expect.poll(() => f.page.getByRole("button", { name: "تحديث بيانات الصندوق", exact: true }).isEnabled()).toBe(true);
        expect(await f.page.getByRole("button", { name: /سند قبض سريع|سند صرف نثري|فتح وردية جديدة|جرد وإقفال الوردية|إغلاق وجرد الوردية/ }).count()).toBe(0);
        f.assertIsolated();
      } finally { await f.context.close(); }
    });
  });
}

describe("built cash form draft identity across real GET refreshes", () => {
  it("keeps opening balances mounted, hidden and unfocusable until the same confirmed-closed snapshot recovers", async () => {
    const f = await fixture();
    try {
      await f.respond(false);
      const opening = f.page.locator('section[aria-label="فتح الوردية"]');
      await opening.waitFor();
      const amounts = opening.locator("input");
      await amounts.nth(0).fill("12345");
      await amounts.nth(1).fill("12.34");
      await f.page.getByRole("button", { name: "تحديث بيانات الصندوق", exact: true }).click();
      await expect.poll(() => f.pending.length).toBe(1);
      expect(await amounts.nth(0).count()).toBe(1);
      expect(await amounts.nth(0).isVisible()).toBe(false);
      expect(await amounts.nth(0).evaluate((input) => {
        input.focus();
        return Boolean(input.closest("[hidden][inert]")) && document.activeElement !== input;
      })).toBe(true);
      await f.fail();
      await f.page.getByRole("button", { name: "إعادة المحاولة", exact: true }).waitFor();
      expect(await amounts.nth(0).isVisible()).toBe(false);
      await f.page.getByRole("button", { name: "إعادة المحاولة", exact: true }).click();
      await expect.poll(() => f.pending.length).toBe(1);
      await f.respond(false);
      await expect.poll(() => amounts.nth(0).isVisible()).toBe(true);
      expect(await amounts.nth(0).inputValue()).toBe("12345");
      expect(await amounts.nth(1).inputValue()).toBe("12.34");
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("preserves same-shift expense/count drafts and resets them only when a different shift is confirmed", async () => {
    const f = await fixture();
    try {
      await f.respond();
      await f.page.getByRole("button", { name: /سند صرف نثري$/ }).click();
      const payee = f.page.getByPlaceholder("اسم المستفيد المباشر", { exact: true });
      const amount = f.page.getByPlaceholder("المبلغ", { exact: true });
      await payee.fill("Synthetic draft payee");
      await amount.fill("12345");
      // These controls only reveal/edit a draft. Never click a submit action.
      await f.page.getByRole("button", { name: /إغلاق وجرد الوردية$/ }).click();
      const counted = f.page.locator('input[aria-label^="المعدود "]').first();
      await counted.fill("98765");
      await f.page.getByRole("button", { name: "تحديث بيانات الصندوق", exact: true }).click();
      await expect.poll(() => f.pending.length).toBe(1);
      expect(await payee.count()).toBe(1);
      expect(await payee.isVisible()).toBe(false);
      expect(await counted.isVisible()).toBe(false);
      expect(await payee.evaluate((input) => {
        input.focus();
        return Boolean(input.closest("[hidden][inert]")) && document.activeElement !== input;
      })).toBe(true);
      await f.page.keyboard.press("Tab");
      expect(await f.page.evaluate(() => document.activeElement?.closest("[hidden][inert]") === null)).toBe(true);
      await f.fail();
      await f.page.getByRole("button", { name: "إعادة المحاولة", exact: true }).waitFor();
      await mkdir(".settings-ui-artifacts", { recursive: true });
      await f.page.screenshot({ path: ".settings-ui-artifacts/finance-shift-unavailable.png", fullPage: true });
      await f.page.getByRole("button", { name: "إعادة المحاولة", exact: true }).click();
      await expect.poll(() => f.pending.length).toBe(1);
      await f.respond();
      await expect.poll(() => payee.isVisible()).toBe(true);
      expect(await payee.inputValue()).toBe("Synthetic draft payee");
      expect(await amount.inputValue()).toBe("12345");
      expect(await counted.inputValue()).toBe("98765");
      await f.page.screenshot({ path: ".settings-ui-artifacts/finance-shift-draft-restored.png", fullPage: true });
      await f.page.getByRole("button", { name: "تحديث بيانات الصندوق", exact: true }).click();
      await expect.poll(() => f.pending.length).toBe(1);
      await f.respond(true, 98302);
      await expect.poll(() => f.page.getByRole("button", { name: "تحديث بيانات الصندوق", exact: true }).isEnabled()).toBe(true);
      expect(await payee.count()).toBe(0);
      expect(await counted.count()).toBe(0);
      await f.page.getByRole("button", { name: /سند صرف نثري$/ }).click();
      expect(await payee.inputValue()).toBe("");
      expect(await amount.inputValue()).toBe("");
      await f.page.getByRole("button", { name: /إغلاق وجرد الوردية$/ }).click();
      expect(await counted.inputValue()).toBe("");
      f.assertIsolated();
    } finally { await f.context.close(); }
  });
});
