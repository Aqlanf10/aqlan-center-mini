import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Route } from "playwright";
import { POSTABLE_ACCOUNTS, LEDGER_CURRENCIES, type JournalEntry } from "../../lib/accounting";
import { accountingPeriod, accountLedger } from "../../lib/accounting-reports";
import { baseUrl, harness } from "./_server";

// Built accounting UI and real test authentication. Journal responses below
// are synthetic intercepted fixtures; no financial documents are read/written.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

const entries: JournalEntry[] = [
  { date: "2026-09-30", source: "manual", reference: "OPEN", description: "Synthetic opening", lines: [
    { accountCode: "1101", currency: "YER", amountMinor: 10_000, side: "debit" },
    { accountCode: "3101", currency: "YER", amountMinor: 10_000, side: "credit" },
    { accountCode: "1102", currency: "SAR", amountMinor: 50_000, side: "debit" },
    { accountCode: "3101", currency: "SAR", amountMinor: 50_000, side: "credit" },
  ] },
  { date: "2026-10-01", source: "expense", reference: "SPEND", description: "Synthetic October expense", lines: [
    { accountCode: "5502", currency: "YER", amountMinor: 2_000, side: "debit" },
    { accountCode: "1101", currency: "YER", amountMinor: 2_000, side: "credit" },
  ] },
];
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
function payload(route: Route) {
  const params = new URL(route.request().url()).searchParams;
  const a = params.get("from")!;
  const b = params.get("to")!;
  const [from, to] = a <= b ? [a, b] : [b, a];
  const report = accountingPeriod(entries, from, to);
  const account = params.get("account");
  const currency = params.get("currency") === "SAR" ? "SAR" : "YER";
  if (account) return { from, to, account, currency, ...accountLedger(report, account, currency), baseCurrency: "YER" };
  return { from, to, balances: report.balances, cumulativeBalances: report.cumulativeBalances,
    accountSummaries: report.accountSummaries, statements: report.statements, entryCount: report.entryCount,
    accounts: POSTABLE_ACCOUNTS, currencies: LEDGER_CURRENCIES, baseCurrency: "YER" };
}

async function fixture() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.accountant.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const errors: string[] = [];
  const pending: Route[] = [];
  let hold = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/accounting?*", async (route) => {
    if (route.request().method() !== "GET") { await route.abort(); return; }
    if (hold && new URL(route.request().url()).searchParams.has("account")) pending.push(route);
    else await json(route, payload(route));
  });
  await page.goto(`${baseUrl}/finance/accounting`);
  await page.getByLabel("ميزان المراجعة", { exact: true }).waitFor();
  await page.getByLabel("من", { exact: true }).fill("2026-10-01");
  await page.getByLabel("إلى", { exact: true }).fill("2026-10-02");
  await expect.poll(async () => (await page.getByTestId("trial-YER").innerText()).includes("8,000")).toBe(true);
  return { context, page, pending, errors, setHold: (next: boolean) => { hold = next; } };
}

describe("accounting carry-forward in the built read-only browser", () => {
  it("shows opening/activity/closing, cumulative sheet, period income and opening-only empty periods", async () => {
    const f = await fixture();
    try {
      expect(await f.page.getByTestId("trial-YER").innerText()).toContain("رصيد أول المدة");
      expect(await f.page.getByTestId("trial-SAR").innerText()).toContain("500");
      await f.page.getByRole("button", { name: "الميزانية", exact: true }).click();
      const sheet = f.page.getByLabel("الميزانية", { exact: true });
      expect(await sheet.innerText()).toContain("أرصدة تراكمية حتى 2026-10-02");
      expect(await sheet.innerText()).toContain("8,000");
      expect(await sheet.innerText()).toContain("الأرباح المتراكمة حتى تاريخ الميزانية");
      await f.page.getByRole("button", { name: "قائمة الدخل", exact: true }).click();
      expect(await f.page.getByLabel("قائمة الدخل", { exact: true }).innerText()).toContain("2,000");
      await f.page.getByRole("button", { name: "دفتر الأستاذ", exact: true }).click();
      await f.page.getByTestId("ledger-period-summary").waitFor();
      expect(await f.page.getByTestId("ledger-period-summary").innerText()).toMatch(/رصيد أول المدة[\s\S]*10,000[\s\S]*رصيد آخر المدة[\s\S]*8,000/);
      expect(await f.page.getByRole("row").last().innerText()).toContain("8,000");
      const artifacts = join(process.cwd(), ".settings-ui-artifacts");
      await mkdir(artifacts, { recursive: true });
      await f.page.screenshot({ path: join(artifacts, "accounting-carry-forward.png"), fullPage: true });
      await f.page.setViewportSize({ width: 390, height: 844 });
      expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await f.page.screenshot({ path: join(artifacts, "accounting-carry-forward-mobile.png"), fullPage: true });
      await f.page.setViewportSize({ width: 1280, height: 1000 });
      await f.page.getByLabel("من", { exact: true }).fill("2026-10-02");
      await expect.poll(async () => (await f.page.getByLabel("دفتر الأستاذ", { exact: true }).innerText()).includes("لا حركة على هذا الحساب")).toBe(true);
      expect(await f.page.getByTestId("ledger-period-summary").innerText()).toMatch(/رصيد أول المدة[\s\S]*8,000[\s\S]*رصيد آخر المدة[\s\S]*8,000/);
      await f.page.getByLabel("الحساب", { exact: true }).selectOption("1102");
      await f.page.getByLabel("العملة", { exact: true }).selectOption("SAR");
      await expect.poll(async () => (await f.page.getByTestId("ledger-period-summary").innerText()).includes("500")).toBe(true);
      await f.page.getByRole("button", { name: "ميزان المراجعة", exact: true }).click();
      await f.page.getByLabel("من", { exact: true }).fill("");
      await f.page.getByLabel("إلى", { exact: true }).fill("");
      await f.page.getByLabel("ميزان المراجعة", { exact: true }).waitFor();
      expect(await f.page.getByText("جارٍ التحميل…", { exact: true }).count()).toBe(0);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it("hides old account balances during loading/failure and ignores an older late currency response", async () => {
    const f = await fixture();
    try {
      await f.page.getByRole("button", { name: "دفتر الأستاذ", exact: true }).click();
      await f.page.getByTestId("ledger-period-summary").waitFor();
      f.setHold(true);
      await f.page.getByLabel("العملة", { exact: true }).selectOption("SAR");
      await expect.poll(() => f.pending.length).toBe(1);
      expect(await f.page.getByTestId("ledger-period-summary").count()).toBe(0);
      await f.page.getByLabel("العملة", { exact: true }).selectOption("YER");
      await expect.poll(() => f.pending.length).toBe(2);
      await json(f.pending[1], payload(f.pending[1]));
      await f.page.getByTestId("ledger-period-summary").waitFor();
      await json(f.pending[0], payload(f.pending[0]));
      await expect.poll(async () => (await f.page.getByTestId("ledger-period-summary").innerText()).includes("8,000")).toBe(true);
      await f.page.getByLabel("العملة", { exact: true }).selectOption("SAR");
      await expect.poll(() => f.pending.length).toBe(3);
      await json(f.pending[2], { message: "تعذّر تحميل الدفتر التجريبي" }, 500);
      await f.page.getByRole("alert").filter({ hasText: "تعذّر تحميل الدفتر التجريبي" }).waitFor();
      expect(await f.page.getByTestId("ledger-period-summary").count()).toBe(0);
      f.setHold(false);
      await f.page.getByLabel("العملة", { exact: true }).selectOption("YER");
      await f.page.getByTestId("ledger-period-summary").waitFor();
      expect(await f.page.getByTestId("ledger-period-summary").innerText()).toContain("8,000");
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });
});
