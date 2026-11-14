import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

/**
 * Owner's review #483 6882465665 on 0128: an expense whose outcome is unknown is never lost and never
 * re-sent under a new key, from the real screens of the built app. Each case breaks the transport the way a
 * clinic network does (lost response, unreadable success, blocked storage, expired session, another user)
 * and then counts the real vouchers, drawer movements and audit rows in PostgreSQL. Synthetic data only.
 */
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let serial = 0;
let supplierId = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  // 0128: vouchers need drawer cash. Reuse an open shift (other suites share it) or open a funded one.
  await db.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
    SELECT 'syn-expense-recovery', 100000, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
  ({ rows: [{ id: supplierId }] } = await db.query<{ id: number }>(
    "INSERT INTO parties (name, kind) VALUES ('مورد اصطناعي للتعافي', 'supplier') RETURNING id"));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

type Role = "admin" | "reception";
async function open(role: Role, options: { brokenStorage?: boolean } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  await signIn(context, role);
  if (options.brokenStorage) {
    await context.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
    });
  }
  const page = await context.newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  return { context, page };
}
async function signIn(context: BrowserContext, role: Role) {
  await context.clearCookies();
  const [name, ...value] = h.sessions[role].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
}
/** The next matching POST reaches the server for real; its answer is then broken on the way back. */
async function breakNextAnswer(page: Page, path: string, mode: "lost" | "unreadable") {
  let done = false;
  await page.route(`**${path}`, async (route: Route) => {
    if (done || route.request().method() !== "POST") return route.continue();
    done = true;
    await route.fetch();
    if (mode === "lost") await route.abort("connectionreset");
    else await route.fulfill({ status: 201, contentType: "application/json", body: "{\"id\":" });
  });
}
async function startExpense(page: Page, note: string, amount = "3") {
  await page.goto(`${baseUrl}/finance`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /\+ سند صرف/ }).first().click();
  await page.locator('select:has(option[value="other"])').first().selectOption("other");
  await page.getByPlaceholder("اسم المستفيد المباشر").fill("مستفيد اصطناعي");
  await page.getByPlaceholder("المبلغ").first().fill(amount);
  await page.getByPlaceholder("البيان ومبرر الصرف بالتفصيل").fill(note);
}
const save = (page: Page) => page.getByRole("button", { name: /سجّل الصرف واطبع السند/ }).click();
async function evidence(note: string) {
  const vouchers = (await db.query<{ id: number; amount_minor: string; drawer_amount_minor: string }>(
    "SELECT id, amount_minor, drawer_amount_minor FROM expenses WHERE note = $1 AND reversal_of_id IS NULL", [note])).rows;
  const audits = vouchers.length ? Number((await db.query("SELECT count(*) FROM audit_log WHERE action = 'expense.create' AND entity_id = ANY($1::text[])",
    [vouchers.map((v) => String(v.id))])).rows[0].count) : 0;
  return { vouchers: vouchers.length, audits, drawerOut: vouchers.reduce((sum, v) => sum + Number(v.drawer_amount_minor), 0) };
}
const uncertain = (page: Page) => page.getByRole("alert").filter({ hasText: "قد يكون سُجّل" }).first().waitFor({ timeout: 15_000 });
const pending = (page: Page) => page.getByTestId("pending-expense-attempt");
const count = (locator: ReturnType<Page["locator"]>, n: number) => expect.poll(() => locator.count(), { timeout: 15_000 }).toBe(n);

describe("petty expense on the cash screen", () => {
  it("a lost response, then the same click again: one voucher, one drawer movement, one audit", async () => {
    const note = `SYN-REC-LOST-${++serial}-${Date.now()}`;
    const { context, page } = await open("admin");
    try {
      await startExpense(page, note);
      await breakNextAnswer(page, "/api/expenses", "lost");
      await save(page);
      await uncertain(page);
      expect(await evidence(note)).toEqual({ vouchers: 1, audits: 1, drawerOut: 3 });
      await count(pending(page), 1);
      await save(page);
      await count(page.getByRole("alert").filter({ hasText: "قد يكون سُجّل" }), 0);
      expect(await evidence(note)).toEqual({ vouchers: 1, audits: 1, drawerOut: 3 });
      await count(pending(page), 0);
    } finally { await context.close(); }
  });

  it("an unreadable success, then the same click again: one voucher", async () => {
    const note = `SYN-REC-UNREAD-AGAIN-${++serial}-${Date.now()}`;
    const { context, page } = await open("admin");
    try {
      await startExpense(page, note);
      await breakNextAnswer(page, "/api/expenses", "unreadable");
      await save(page);
      await uncertain(page);
      await save(page);
      await expect.poll(async () => (await evidence(note)).vouchers, { timeout: 15_000 }).toBeGreaterThan(0);
      await page.waitForTimeout(1_000);
      expect(await evidence(note)).toEqual({ vouchers: 1, audits: 1, drawerOut: 3 });
    } finally { await context.close(); }
  });

  it("an unreadable success, then a reload: the pending request is verified, never re-entered", async () => {
    const note = `SYN-REC-UNREAD-${++serial}-${Date.now()}`;
    const { context, page } = await open("admin");
    try {
      await startExpense(page, note);
      await breakNextAnswer(page, "/api/expenses", "unreadable");
      await save(page);
      await uncertain(page);
      await page.reload({ waitUntil: "load" }); await page.getByRole("button", { name: /\+ سند صرف/ }).first().waitFor();
      await count(pending(page), 1);
      expect(await pending(page).innerText()).toContain("مستفيد اصطناعي");
      await pending(page).getByRole("button", { name: "تحقّق" }).click();
      await count(page.getByTestId("pending-expense-attempts"), 0);
      expect(await evidence(note)).toEqual({ vouchers: 1, audits: 1, drawerOut: 3 });
    } finally { await context.close(); }
  });

  it("blocked browser storage still keeps the key for the retry in the page", async () => {
    const note = `SYN-REC-NOSTORE-${++serial}-${Date.now()}`;
    const { context, page } = await open("admin", { brokenStorage: true });
    try {
      await startExpense(page, note);
      await breakNextAnswer(page, "/api/expenses", "lost");
      await save(page);
      await uncertain(page);
      const warning = await page.getByRole("alert").first().innerText();
      await save(page);
      await expect.poll(async () => (await evidence(note)).vouchers, { timeout: 15_000 }).toBeGreaterThan(0);
      await page.waitForTimeout(1_000);
      expect(await evidence(note)).toEqual({ vouchers: 1, audits: 1, drawerOut: 3 });
      expect(warning).toContain("تخزين المتصفح غير متاح");
    } finally { await context.close(); }
  });

  it("an expired session keeps the unknown request; after signing in again it replays, never doubles", async () => {
    const note = `SYN-REC-EXPIRED-${++serial}-${Date.now()}`;
    const { context, page } = await open("admin");
    try {
      await startExpense(page, note);
      await breakNextAnswer(page, "/api/expenses", "lost");
      await save(page);
      await uncertain(page);
      await context.clearCookies();
      await save(page);
      await uncertain(page);
      expect(await evidence(note)).toEqual({ vouchers: 1, audits: 1, drawerOut: 3 });
      await signIn(context, "admin");
      await page.reload({ waitUntil: "load" }); await page.getByRole("button", { name: /\+ سند صرف/ }).first().waitFor();
      await count(pending(page), 1);
      await pending(page).getByRole("button", { name: "تحقّق" }).click();
      await count(page.getByTestId("pending-expense-attempts"), 0);
      expect(await evidence(note)).toEqual({ vouchers: 1, audits: 1, drawerOut: 3 });
    } finally { await context.close(); }
  });

  it("another user in the same tab never sees or resends it; the sender still can", async () => {
    const note = `SYN-REC-USER-${++serial}-${Date.now()}`;
    const { context, page } = await open("admin");
    try {
      await startExpense(page, note);
      await breakNextAnswer(page, "/api/expenses", "lost");
      await save(page);
      await uncertain(page);
      await signIn(context, "reception");
      await page.reload({ waitUntil: "load" }); await page.getByRole("button", { name: /\+ سند صرف/ }).first().waitFor();
      await page.getByRole("button", { name: /\+ سند صرف/ }).first().waitFor();
      await count(pending(page), 0);
      await signIn(context, "admin");
      await page.reload({ waitUntil: "load" }); await page.getByRole("button", { name: /\+ سند صرف/ }).first().waitFor();
      await count(pending(page), 1);
      await pending(page).getByRole("button", { name: "تحقّق" }).click();
      await count(page.getByTestId("pending-expense-attempts"), 0);
      expect(await evidence(note)).toEqual({ vouchers: 1, audits: 1, drawerOut: 3 });
    } finally { await context.close(); }
  });

  it("a double click records one voucher", async () => {
    const note = `SYN-REC-DOUBLE-${++serial}-${Date.now()}`;
    const { context, page } = await open("admin");
    try {
      await startExpense(page, note);
      await page.getByRole("button", { name: /سجّل الصرف واطبع السند/ }).dblclick();
      await expect.poll(async () => (await evidence(note)).vouchers, { timeout: 15_000 }).toBe(1);
      await page.waitForTimeout(500);
      expect(await evidence(note)).toEqual({ vouchers: 1, audits: 1, drawerOut: 3 });
    } finally { await context.close(); }
  });
});

describe("bill payment on the supplier page", () => {
  it("a lost confirmation, then confirming again: the bill is settled once", async () => {
    const description = `SYN-REC-BILL-${++serial}-${Date.now()}`;
    const { rows: [{ id: payableId }] } = await db.query<{ id: number }>(`INSERT INTO payables (party_id, category, description, amount_minor, currency, base_currency, exchange_rate, base_amount_minor, created_by)
      VALUES ($1, 'supplier', $2, 50, 'YER', 'YER', 1, 50, 'syn-expense-recovery') RETURNING id`, [supplierId, description]);
    const { context, page } = await open("admin");
    try {
      await page.goto(`${baseUrl}/finance/parties/${supplierId}`, { waitUntil: "networkidle" });
      const row = page.locator("li", { hasText: description });
      await row.getByRole("button", { name: "سداد" }).click();
      await page.getByLabel("المبلغ المدفوع").fill("20");
      await page.getByRole("button", { name: /معاينة/ }).click();
      await breakNextAnswer(page, "/api/expenses", "lost");
      await page.getByRole("button", { name: /تأكيد/ }).click();
      await uncertain(page);
      await page.getByRole("button", { name: /تأكيد/ }).click();
      await count(page.getByLabel("سداد الفاتورة"), 0);
      const paid = await db.query<{ n: number; settled: string }>(`SELECT count(*)::int AS n, COALESCE(sum(payable_settled_minor), 0)::text AS settled
        FROM expenses WHERE payable_id = $1 AND reversal_of_id IS NULL`, [payableId]);
      expect(paid.rows[0]).toEqual({ n: 1, settled: "20" });
    } finally { await context.close(); }
  });
});
