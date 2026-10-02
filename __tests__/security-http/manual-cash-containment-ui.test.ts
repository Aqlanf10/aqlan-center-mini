import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { POSTABLE_ACCOUNTS, LEDGER_CURRENCIES } from "../../lib/accounting";
import { MANUAL_CASH_ENTRY_GUIDANCE, ManualCashEntryConflictError } from "../../lib/manual-cash-entry";
import { baseUrl, harness } from "./_server";

// Real built page/authentication; intercepted synthetic GET/POST responses.
// No manual journal or other financial document is written by these UI tests.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

describe("manual cash conflict preserves the reviewable draft", () => {
  for (const code of ["manual_cash_requires_linked_movement", "manual_cash_shift_busy"] as const) {
    it(`${code}: explains restriction, keeps every input, and does not retry automatically`, async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE" });
      try {
        const [name, ...value] = h.sessions.admin.cookie.split("=");
        await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
        const page = await context.newPage();
        const submitted: unknown[] = [];
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/api/accounting?*", async (route) => {
          const params = new URL(route.request().url()).searchParams;
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
            from: params.get("from"), to: params.get("to"), baseCurrency: "YER",
            accounts: POSTABLE_ACCOUNTS, currencies: LEDGER_CURRENCIES, balances: [], cumulativeBalances: [],
            accountSummaries: [], statements: [], entryCount: 0,
          }) });
        });
        const conflict = new ManualCashEntryConflictError(code);
        await page.route("**/api/accounting", async (route) => {
          if (route.request().method() !== "POST") { await route.abort(); return; }
          submitted.push(route.request().postDataJSON());
          await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code, message: conflict.message }) });
        });
        await page.goto(`${baseUrl}/finance/accounting`);
        await page.getByRole("button", { name: "قيد يدوي", exact: true }).click();
        await page.getByText(MANUAL_CASH_ENTRY_GUIDANCE, { exact: true }).waitFor({ state: "visible" });
        expect(await page.getByText(MANUAL_CASH_ENTRY_GUIDANCE, { exact: true }).isVisible()).toBe(true);
        await page.getByLabel("تاريخ القيد", { exact: true }).fill("2026-09-30");
        await page.getByLabel("بيان القيد", { exact: true }).fill("Synthetic preserved cash draft");
        await page.getByLabel("الحساب", { exact: true }).nth(0).selectOption("1102");
        await page.getByLabel("الحساب", { exact: true }).nth(1).selectOption("3101");
        await page.getByLabel("العملة", { exact: true }).nth(0).selectOption("SAR");
        await page.getByLabel("العملة", { exact: true }).nth(1).selectOption("SAR");
        await page.getByLabel("الجهة", { exact: true }).nth(0).selectOption("credit");
        await page.getByLabel("الجهة", { exact: true }).nth(1).selectOption("debit");
        await page.getByLabel("المبلغ", { exact: true }).nth(0).fill("100.25");
        await page.getByLabel("المبلغ", { exact: true }).nth(1).fill("100.25");
        await page.getByRole("button", { name: "احفظ القيد", exact: true }).click();
        const conflictAlert = page.getByRole("alert").and(page.getByText(conflict.message, { exact: true }));
        await expect.poll(async () => conflictAlert.innerText()).toBe(conflict.message);
        expect(await page.getByLabel("تاريخ القيد", { exact: true }).inputValue()).toBe("2026-09-30");
        expect(await page.getByLabel("بيان القيد", { exact: true }).inputValue()).toBe("Synthetic preserved cash draft");
        expect(await page.getByLabel("الحساب", { exact: true }).nth(0).inputValue()).toBe("1102");
        expect(await page.getByLabel("الحساب", { exact: true }).nth(1).inputValue()).toBe("3101");
        expect(await page.getByLabel("العملة", { exact: true }).nth(0).inputValue()).toBe("SAR");
        expect(await page.getByLabel("العملة", { exact: true }).nth(1).inputValue()).toBe("SAR");
        expect(await page.getByLabel("الجهة", { exact: true }).nth(0).inputValue()).toBe("credit");
        expect(await page.getByLabel("الجهة", { exact: true }).nth(1).inputValue()).toBe("debit");
        expect(await page.getByLabel("المبلغ", { exact: true }).nth(0).inputValue()).toBe("100.25");
        expect(await page.getByLabel("المبلغ", { exact: true }).nth(1).inputValue()).toBe("100.25");
        expect(await page.getByRole("button", { name: "احفظ القيد", exact: true }).isEnabled()).toBe(true);
        await page.waitForTimeout(250);
        expect(submitted).toEqual([{
          date: "2026-09-30", description: "Synthetic preserved cash draft",
          lines: [
            { accountCode: "1102", currency: "SAR", amount: "100.25", side: "credit" },
            { accountCode: "3101", currency: "SAR", amount: "100.25", side: "debit" },
          ],
        }]);
        expect(errors).toEqual([]);
        const artifacts = join(process.cwd(), ".settings-ui-artifacts");
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: join(artifacts, `${code}.png`), fullPage: true });
      } finally { await context.close(); }
    });
  }
});
