import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { mkdir } from "node:fs/promises";
import { formatMoney } from "../../lib/money";
import { authedMutation, baseUrl, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser, serial = 0;
const evidence = process.env.INVOICE_LIVE_OUTPUT ?? ".settings-ui-artifacts/invoice-live-refresh";
beforeAll(async () => {
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  await db.query(`INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd)
    SELECT 'synthetic-live-refresh',0,0,0 WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')`);
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
});
afterAll(async () => { await browser?.close(); await db?.end(); });
async function post(path: string, body: unknown, key?: string) {
  return authedMutation(path, h.sessions.admin, "POST", JSON.stringify(body), key ? { "Idempotency-Key": key } : undefined);
}
async function seed(paid = 0) {
  const stamp = `${Date.now()}-${++serial}`;
  const patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'اختبار تحديث مالي اصطناعي') RETURNING id", [`LIVE-${stamp}`])).rows[0].id as number;
  const response = await post("/api/invoices", { patientId, currency: "YER", items: [{ description: "قيمة مالية مستقلة للاختبار", quantity: 1, price: "1000" }] });
  expect(response.status).toBe(201); const invoice = await response.json();
  let receiptId = 0;
  if (paid) {
    const payment = await post("/api/payments", { patientId, invoiceId: invoice.id, amount: String(paid), currency: "YER", kind: "payment", method: "cash" }, `live-receipt-${stamp}`);
    expect(payment.status).toBe(201); receiptId = (await payment.json()).id;
  }
  return { patientId, invoice, receiptId };
}
async function open(patientId: number, width = 390, tab = "account") {
  const context = await browser.newContext({ viewport: { width, height: 1040 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on("dialog", dialog => void dialog.accept());
  await page.goto(`${baseUrl}/patients/${patientId}?tab=${tab}`, { waitUntil: "networkidle" });
  return { context, page };
}
async function account(page: Page, amount: number) {
  const formatted = formatMoney(amount, "YER");
  await expect.poll(async () => ({
    ledger: await page.getByTestId("account-canonical-balance").locator("p").first().allTextContents(),
    header: (await page.getByTestId("patient-account-header").allTextContents()).some(text => text.includes(formatted)),
  }), { timeout: 5000 }).toEqual({ ledger: [`على المريض ${formatted}`], header: true }).catch(async error => {
    await page.screenshot({ path: `${evidence}/failed-expected-${amount}-${++serial}.png`, fullPage: true });
    throw error;
  });
}
async function collect(page: Page, invoiceId: number, amount: string) {
  await page.getByRole("button", { name: "قبض دفعة", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "تحصيل دفعة", exact: true });
  await expect.poll(() => modal.getByLabel("المبلغ", { exact: true }).isEnabled()).toBe(true);
  await modal.getByLabel("فاتورة الهدف", { exact: true }).selectOption(String(invoiceId));
  await modal.getByLabel("المبلغ", { exact: true }).fill(amount);
  await modal.getByRole("button", { name: "سجّل الدفعة واطبع السند", exact: true }).click();
}
async function voidReceipt(page: Page, receiptId: number) {
  const print = page.getByRole("link", { name: "السند", exact: true }).and(page.locator(`a[href="/print/receipt/${receiptId}"]`));
  await page.getByRole("region", { name: "الدفعات", exact: true }).locator("li").filter({ has: print }).getByRole("button", { name: "تصحيح السند", exact: true }).click();
  const editor = page.getByRole("group", { name: /^تصحيح / });
  await editor.getByRole("radio", { name: "إبطال السند (الدفعة لم تقع)", exact: true }).click();
  await editor.getByLabel("سبب تصحيح السند").fill("إبطال اصطناعي لاختبار تحديث الحساب");
  await editor.getByRole("button", { name: "أبطل السند", exact: true }).click();
}
async function opening(page: Page, existing: boolean) {
  await page.getByTestId("account-secondary-actions").locator("summary").click();
  await page.getByRole("button", { name: existing ? "تعديل الرصيد السابق" : "رصيد سابق (قبل النظام)", exact: true }).click();
  return page.getByRole("heading", { name: "الرصيد السابق المتبقي", exact: true }).locator("..");
}

describe("authoritative live financial refresh through the invoice owner callback", () => {
  it.each([390, 1280, 1448])("refreshes canonical ledger and patient header after collection and correction without reload at %ipx", async width => {
    const { patientId, invoice } = await seed(); const { context, page } = await open(patientId, width);
    try {
      await account(page, 1000);
      await collect(page, invoice.id, "400");
      await account(page, 600);
      await page.getByRole("button", { name: "تصحيح الفاتورة", exact: true }).click();
      const form = page.getByTestId("invoice-correction-editor");
      await form.getByLabel("سعر التصحيح 1", { exact: true }).fill("900");
      await form.getByLabel("سبب التصحيح", { exact: true }).fill("تعديل السعر في اختبار التحديث الحي");
      await page.screenshot({ path: `${evidence}/correction-${width}-form.png`, fullPage: true });
      await form.getByRole("button", { name: "تأكيد تصحيح الفاتورة", exact: true }).click();
      await account(page, 500);
      const receiptId = (await db.query("SELECT id FROM payments WHERE patient_id=$1", [patientId])).rows[0].id as number;
      await voidReceipt(page, receiptId);
      await account(page, 900);
      expect((await db.query("SELECT invoice_id,kind FROM payments WHERE patient_id=$1 ORDER BY id", [patientId])).rows)
        .toEqual([{ invoice_id: invoice.id, kind: "payment" }, { invoice_id: invoice.id, kind: "refund" }]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${evidence}/collection-correction-reversal-${width}.png`, fullPage: true });
    } finally { await context.close(); }
  });

  it("refreshes receipt reversal independently of an invoice correction", async () => {
    const { patientId, receiptId } = await seed(400); const { context, page } = await open(patientId);
    try { await account(page, 600); await voidReceipt(page, receiptId); await account(page, 1000); }
    finally { await context.close(); }
  });

  it("refreshes opening additions, edits and deletion without inventing receipts", async () => {
    const { patientId } = await seed(); const { context, page } = await open(patientId);
    try {
      await account(page, 1000);
      let form = await opening(page, false);
      await form.getByLabel("المبلغ", { exact: true }).fill("250");
      await form.getByRole("button", { name: "احفظ الرصيد الافتتاحي", exact: true }).click();
      await account(page, 1250);
      form = await opening(page, true);
      await form.getByLabel("المبلغ", { exact: true }).fill("100");
      await form.getByLabel("سبب التعديل").fill("تعديل رصيد اصطناعي");
      await form.getByRole("button", { name: "احفظ الرصيد الافتتاحي", exact: true }).click();
      await account(page, 1100);
      form = await opening(page, true);
      await form.getByLabel("سبب التعديل").fill("حذف رصيد اصطناعي");
      await form.getByRole("button", { name: "احذفه", exact: true }).click();
      await account(page, 1000);
      expect((await db.query("SELECT id FROM payments WHERE patient_id=$1", [patientId])).rows).toHaveLength(0);
    } finally { await context.close(); }
  });

  it("retires stale parent balances when the post-acknowledgement workflow read fails, then recovers by GET", async () => {
    const { patientId, invoice } = await seed(); const { context, page } = await open(patientId);
    try {
      await account(page, 1000);
      const path = `**/api/patients/${patientId}/workflow`;
      await page.route(path, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic workflow read failure" }) }));
      await collect(page, invoice.id, "400");
      await expect.poll(() => page.getByTestId("account-canonical-balance").locator("p").first().allTextContents()).toEqual([`على المريض ${formatMoney(600, "YER")}`]);
      expect(await page.getByTestId("patient-account-header").count()).toBe(0);
      await expect.poll(() => page.getByTestId("patient-workflow-read-state").innerText()).toContain("تعذّر التحقق");
      await page.screenshot({ path: `${evidence}/failed-parent-read-390.png`, fullPage: true });
      await page.unroute(path);
      await page.getByRole("button", { name: "إعادة التحقق من الملخص", exact: true }).click();
      await account(page, 600);
      expect((await db.query("SELECT id FROM payments WHERE patient_id=$1", [patientId])).rows).toHaveLength(1);
    } finally { await context.close(); }
  });

  it("invalidates an accepted opening change before a pending ledger GET can finish, and keeps failed parent evidence unavailable", async () => {
    const { patientId } = await seed(); const { context, page } = await open(patientId);
    let releaseLedger!: () => void, releaseWorkflow!: () => void;
    const ledgerReleased = new Promise<void>(resolve => { releaseLedger = resolve; });
    const workflowReleased = new Promise<void>(resolve => { releaseWorkflow = resolve; });
    let ledgerHeld = false, workflowHeld = false;
    const ledgerPath = `**/api/patients/${patientId}/ledger`, workflowPath = `**/api/patients/${patientId}/workflow`;
    try {
      await account(page, 1000);
      await page.route(ledgerPath, async route => {
        ledgerHeld = true; await ledgerReleased; await route.continue().catch(() => {});
      });
      await page.route(workflowPath, async route => {
        workflowHeld = true; await workflowReleased;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic unavailable parent read" }) }).catch(() => {});
      });
      const form = await opening(page, false);
      await form.getByLabel("المبلغ", { exact: true }).fill("250");
      const committed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/opening-balances" && response.request().method() === "POST");
      await form.getByRole("button", { name: "احفظ الرصيد الافتتاحي", exact: true }).click();
      expect((await committed).status()).toBe(201);
      await expect.poll(() => ({ ledgerHeld, workflowHeld })).toEqual({ ledgerHeld: true, workflowHeld: true });
      expect(await page.getByTestId("patient-account-header").count()).toBe(0);
      expect(await page.getByTestId("account-canonical-balance").count()).toBe(0);
      expect(await page.getByTestId("account-balance-unavailable").isVisible()).toBe(true);
      releaseWorkflow();
      await expect.poll(() => page.getByTestId("patient-workflow-read-state").innerText()).toContain("تعذّر التحقق");
      expect(await page.getByTestId("patient-account-header").count()).toBe(0);
      releaseLedger();
      await expect.poll(() => page.getByTestId("account-canonical-balance").locator("p").first().allTextContents()).toEqual([`على المريض ${formatMoney(1250, "YER")}`]);
      expect(await page.getByTestId("patient-account-header").count()).toBe(0);
      await page.screenshot({ path: `${evidence}/opening-pending-ledger-failed-parent-390.png`, fullPage: true });
      await page.unroute(ledgerPath); await page.unroute(workflowPath);
      await page.getByRole("button", { name: "إعادة التحقق من الملخص", exact: true }).click();
      await account(page, 1250);
      expect((await db.query("SELECT id FROM payments WHERE patient_id=$1", [patientId])).rows).toHaveLength(0);
    } finally { releaseLedger(); releaseWorkflow(); await context.close(); }
  });

  it.each(["account", "summary", "header"] as const)("recovers the exact lost %s collection through Account and refreshes current parent facts", async entry => {
    const { patientId, invoice } = await seed(); const { context, page } = await open(patientId, 390, entry === "summary" ? "summary" : "account");
    const requests: { key: string; body: string | null }[] = [];
    try {
      await page.route("**/api/payments", async route => {
        if (route.request().method() !== "POST") return route.continue();
        requests.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
        const response = await route.fetch(); expect(response.ok()).toBe(true);
        if (requests.length === 1) return route.abort("failed");
        await route.fulfill({ response });
      });
      if (entry === "account") await page.getByRole("button", { name: "قبض دفعة", exact: true }).click();
      else if (entry === "summary") await page.getByRole("region", { name: "الحساب", exact: true }).getByRole("button", { name: "تحصيل دفعة", exact: true }).click();
      else await page.getByRole("button", { name: "تحصيل دفعة", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "تحصيل دفعة", exact: true });
      await expect.poll(() => modal.getByLabel("المبلغ", { exact: true }).isEnabled()).toBe(true);
      await modal.getByLabel("المبلغ", { exact: true }).fill("400");
      // Summary/header commands remain explicit on-account YER commands; Account
      // selects the original invoice. Recovery must retain that exact distinction.
      if (entry === "account") await modal.getByLabel("فاتورة الهدف", { exact: true }).selectOption(String(invoice.id));
      await modal.getByRole("button", { name: "سجّل الدفعة واطبع السند", exact: true }).click();
      await modal.getByRole("button", { name: "إعادة التحقق من العملية السابقة", exact: true }).waitFor();
      await modal.getByRole("button", { name: "إغلاق", exact: true }).click();
      await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "networkidle" });
      await account(page, 600);
      // A genuine independent admin update occurs while the saved browser intent
      // awaits acknowledgement. No fabricated response or optimistic arithmetic.
      const changed = await post("/api/opening-balances", {
        patientId, currency: "YER", amount: "100", asOfDate: "2026-10-01", note: "تعديل مستقل أثناء انتظار الإقرار",
      });
      expect(changed.status, await changed.clone().text()).toBe(201);
      await page.getByTestId("money-command-recovery").getByRole("button", { name: "إعادة التحقق من العملية السابقة", exact: true }).click();
      await account(page, 700);
      expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
      expect((await db.query("SELECT id FROM payments WHERE patient_id=$1", [patientId])).rows).toHaveLength(1);
      await page.screenshot({ path: `${evidence}/recovered-${entry}-390.png`, fullPage: true });
    } finally { await context.close(); }
  });
});
