import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { Client } from "pg";
import { baseUrl, harness, TEST_USERS } from "./_server";

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

  // Review #483 6883224187 and 0133: the first send leaves the page and its connection drops; the server has
  // not seen it yet. A retry is refused for the drawer and the server retires that exact request (committed
  // after the refusal's rollback), so the page may treat the refusal as final. The first request then
  // arrives late and writes nothing: no voucher, no drawer movement, no audit.
  it("a first send still on its way: the retry's refusal retires the request, and the late first request writes nothing", async () => {
    const note = `SYN-REC-INFLIGHT-${++serial}-${Date.now()}`;
    const { context, page } = await open("admin");
    try {
      // More than the open drawer holds now. Files share this database and other files take cash into the
      // same shift, so size it from the drawer's expected cash, not from its opening (hosted run 43659458968).
      const shifts = await (await page.request.get(`${baseUrl}/api/shifts`)).json();
      const amount = String(Number(shifts.drawer.expected.YER) + 1_000_000);
      await startExpense(page, note, amount);
      let firstHeaders: Record<string, string> | null = null, firstBody: string | null = null;
      let held = false;
      await page.route("**/api/expenses", async (route: Route) => {
        if (held || route.request().method() !== "POST") return route.continue();
        held = true;
        firstHeaders = await route.request().allHeaders();
        firstBody = route.request().postData();
        await route.abort("connectionreset"); // the page sees a dropped connection; the server sees nothing yet
      });
      await save(page);
      await uncertain(page);
      await count(pending(page), 1);
      const key = firstHeaders!["idempotency-key"];
      expect(key).toBeTruthy();
      expect(await evidence(note)).toEqual({ vouchers: 0, audits: 0, drawerOut: 0 });
      // The retry of the same key reaches the server: refused for the drawer and retired.
      const refused = page.waitForResponse((r) => r.url().endsWith("/api/expenses") && r.request().method() === "POST");
      await pending(page).getByRole("button", { name: "تحقّق" }).click();
      const answer = await refused;
      expect(answer.status()).toBe(409);
      expect(answer.request().headers()["idempotency-key"]).toBe(key);
      expect(await answer.json()).toMatchObject({ code: "exceeds_drawer_cash", requestKeyState: "retired" });
      expect((await db.query("SELECT count(*)::int AS n FROM expense_request_retirements WHERE idempotency_key = $1", [key])).rows)
        .toEqual([{ n: 1 }]);
      await count(pending(page), 0); // final: the server proved no send of this request can write any more
      // Cash arrives, then the first request finally reaches the server: it writes nothing.
      const { rows: [{ id: patientId }] } = await db.query<{ id: number }>(
        "INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض اصطناعي للتعافي') RETURNING id", [`SYN-REC-P-${serial}`]);
      await db.query(`INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor, currency, base_amount_minor, method, created_by)
        SELECT $1, $2, id, 'payment', $3, 'YER', $3, 'cash', 'syn-expense-recovery' FROM cashier_shifts WHERE status = 'open'`,
        [`SYN-REC-TOPUP-${serial}`, patientId, Number(amount) * 2]);
      const headers = Object.fromEntries(Object.entries(firstHeaders!).filter(([name]) => !/^(host|content-length|connection)$/i.test(name)));
      const late = await fetch(`${baseUrl}/api/expenses`, { method: "POST", headers, body: firstBody! });
      expect(late.status).toBe(409);
      expect(await late.json()).toMatchObject({ code: "expense_request_retired", requestKeyState: "retired" });
      expect(await evidence(note)).toEqual({ vouchers: 0, audits: 0, drawerOut: 0 });
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
  // 0133 on the second screen: the bill payment's only send never got an answer. The user ends it for good;
  // the request the server has not seen yet then arrives and writes nothing; the bill is not settled.
  it("an unanswered bill payment ended for good: the late request writes nothing and the bill stays open", async () => {
    const description = `SYN-REC-BILL-RETIRE-${++serial}-${Date.now()}`;
    const { rows: [{ id: payableId }] } = await db.query<{ id: number }>(`INSERT INTO payables (party_id, category, description, amount_minor, currency, base_currency, exchange_rate, base_amount_minor, created_by)
      VALUES ($1, 'supplier', $2, 50, 'YER', 'YER', 1, 50, 'syn-expense-recovery') RETURNING id`, [supplierId, description]);
    const { context, page } = await open("admin");
    try {
      await page.goto(`${baseUrl}/finance/parties/${supplierId}`, { waitUntil: "networkidle" });
      const row = page.locator("li", { hasText: description });
      await row.getByRole("button", { name: "سداد" }).click();
      await page.getByLabel("المبلغ المدفوع").fill("20");
      await page.getByRole("button", { name: /معاينة/ }).click();
      let firstHeaders: Record<string, string> | null = null, firstBody: string | null = null, held = false;
      await page.route("**/api/expenses", async (route: Route) => {
        if (held || route.request().method() !== "POST") return route.continue();
        held = true; firstHeaders = await route.request().allHeaders(); firstBody = route.request().postData();
        await route.abort("connectionreset");
      });
      await page.getByRole("button", { name: /تأكيد/ }).click();
      await uncertain(page);
      await count(pending(page), 1);
      // No second voucher can come from a new key while the attempt is unknown: the same entry reuses it.
      const retire = page.waitForResponse((r) => r.url().endsWith("/api/expenses/attempts/retire"));
      await pending(page).getByRole("button", { name: "أنهِ هذا الطلب نهائيًا" }).click();
      const ended = await retire;
      expect(ended.status()).toBe(200);
      expect(await ended.json()).toEqual({ requestKeyState: "retired" });
      expect(JSON.parse(ended.request().postData()!)).toMatchObject({ key: firstHeaders!["idempotency-key"], body: firstBody });
      await count(pending(page), 0);
      const headers = Object.fromEntries(Object.entries(firstHeaders!).filter(([name]) => !/^(host|content-length|connection)$/i.test(name)));
      const late = await fetch(`${baseUrl}/api/expenses`, { method: "POST", headers, body: firstBody! });
      expect(late.status).toBe(409);
      expect((await late.json()).code).toBe("expense_request_retired");
      const paid = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM expenses WHERE payable_id = $1", [payableId]);
      expect(paid.rows[0]).toEqual({ n: 0 });
      expect((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'expense.create' AND details::text LIKE $1", [`%${description}%`])).rows[0].n).toBe(0);
      // The user's explicit «أنهِ» is audited once, under the request key; the late request adds nothing.
      expect((await db.query("SELECT actor FROM audit_log WHERE action = 'expense.request_retire' AND entity_id = $1", [firstHeaders!["idempotency-key"]])).rows)
        .toEqual([{ actor: TEST_USERS.admin.username }]);
    } finally { await context.close(); }
  });

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
