import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { mkdir } from "node:fs/promises";
import { formatMoney, toInputAmount, type Currency } from "../../lib/money";
import { authedGet, authedMutation, baseUrl, harness, type Session } from "./_server";

let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser, doctorId: number, serviceId: number, serial = 0;
const evidence = process.env.INVOICE_CONSUMER_OUTPUT ?? ".settings-ui-artifacts/invoice-consumer";
beforeAll(async () => {
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  doctorId = (await db.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic consumer HTTP doctor') RETURNING id")).rows[0].id;
  serviceId = (await db.query("INSERT INTO services(name,category,price_minor,price_sar_minor,price_usd_minor,price_configured,is_active) VALUES('Synthetic consumer historical group','ortho',1500,1500,1500,TRUE,TRUE) RETURNING id")).rows[0].id;
  await db.query("INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd) SELECT 'synthetic-consumer-http',0,0,0 WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')");
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240000);
afterAll(async () => { await browser?.close(); await db?.end(); });
const post = (path: string, body: unknown, actor = h.sessions.admin, key?: string) => authedMutation(path, actor, "POST", JSON.stringify(body), key ? { "Idempotency-Key": key } : undefined);
async function owner() {
  const patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'اختبار ربط فاتورة ومغادرة اصطناعي') RETURNING id", [`INV-CONSUMER-${Date.now()}-${++serial}`])).rows[0].id as number;
  const visitId = (await db.query("INSERT INTO visits(patient_id,patient_name,doctor_id,diagnosis,treatment_done) VALUES($1,'اختبار ربط فاتورة ومغادرة اصطناعي',$2,'تشخيص اصطناعي','توثيق دون رسوم إضافية') RETURNING id", [patientId, doctorId])).rows[0].id as number;
  return { patientId, visitId };
}
async function invoice(currency: Currency, paid: number) {
  const f = await owner();
  const created = await post("/api/invoices", { patientId: f.patientId, visitId: f.visitId, currency,
    items: [{ description: "فاتورة اختبار أصلية", quantity: 1, price: toInputAmount(1000, currency) }], discount: "0", idempotencyKey: `consumer-create-${f.patientId}` });
  const original = await created.json(); expect(created.status, JSON.stringify(original)).toBe(201); expect(original.visitId).toBe(f.visitId);
  let receiptId = 0;
  if (paid) {
    const response = await post("/api/payments", { patientId: f.patientId, invoiceId: original.id, amount: toInputAmount(paid, currency), currency, kind: "payment", method: "cash" }, h.sessions.admin, `consumer-receipt-${f.patientId}`);
    const receipt = await response.json(); expect(response.status, JSON.stringify(receipt)).toBe(201); receiptId = receipt.id;
  }
  const signed = await post(`/api/visits/${f.visitId}/clinical`, { action: "sign" }); const signature = await signed.json();
  expect(signed.status, JSON.stringify(signature)).toBe(200); expect(signature).toMatchObject({ invoiceId: original.id, createdInvoiceId: null, invoiceCurrency: currency, duesMinor: 0 });
  expect((await db.query("SELECT invoice_id FROM visits WHERE id=$1", [f.visitId])).rows).toEqual([{ invoice_id: original.id }]);
  return { ...f, original, receiptId };
}
async function correct(invoiceId: number, currency: Currency, paid: number, amount: number) {
  const path = `/api/invoices/${invoiceId}/correct`, read = await authedGet(path, h.sessions.admin);
  expect(read.status).toBe(200); const view = await read.json();
  const response = await post(path, { idempotencyKey: `consumer-correct-${++serial}`, expectedSourceHash: view.sourceHash, reason: "تصحيح اصطناعي للتحقق من ربط التسوية",
    lines: view.invoice.items.map((item: { id: number }) => ({ itemId: item.id, quantity: 1, unitPrice: toInputAmount(amount, currency) })), discount: "0", discountReason: null,
    repaymentTerms: { mode: "full", installments: [] }, expectedRemainingMinor: Math.max(0, amount - paid) });
  const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(201); return body.corrected;
}
async function read(visitId: number, actor = h.sessions.reception) {
  const response = await authedGet(`/api/visits/${visitId}/walkout`, actor); const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store"); return body;
}
async function open(patientId: number, visitId: number, width: number, actor: Session) {
  const context = await browser.newContext({ viewport: { width, height: 1040 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = actor.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  await page.goto(`${baseUrl}/patients/${patientId}?tab=today&checkoutVisit=${visitId}`, { waitUntil: "networkidle" });
  return { context, page };
}
async function checked(page: Page, currency: Currency, amount: number) {
  const region = page.getByRole("region", { name: "شبّاك ما بعد الزيارة", exact: true });
  await expect.poll(() => region.getAttribute("data-financial-state")).toBe("verified");
  await expect.poll(() => region.locator(`[data-testid="checkout-current-balance"][data-currency="${currency}"]`).innerText()).toContain(formatMoney(amount, currency));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); return region;
}
describe("real invoice signing, correction lineage and browser checkout", () => {
  it.each((["YER", "SAR", "USD"] as const).flatMap(currency => [400, 1000].map(paid => ({ currency, paid, width: paid === 400 ? 390 : 1280 }))))("$currency paid$paid stays accurate through signature, two corrections and original receipt reversal at$width", async ({ currency, paid, width }) => {
    const f = await invoice(currency, paid), first = await correct(f.original.id, currency, paid, 950), current = await correct(first.id, currency, paid, 900);
    let result = await read(f.visitId);
    expect(result).toMatchObject({ invoice: { id: current.id, netMinor: 900, currency }, checkout: { invoicePaidMinor: paid, current: { [currency]: 900 - paid } }, receptionHandoff: { status: paid === 1000 ? "collected" : "pending" } });
    expect(result.summary.find((row: { currency: string }) => row.currency === currency)).toMatchObject({ todayRemainingMinor: Math.max(0, 900 - paid), dueNowMinor: Math.max(0, 900 - paid) });
    const { context, page } = await open(f.patientId, f.visitId, width, h.sessions.reception);
    try {
      let region = await checked(page, currency, 900 - paid);
      if (paid === 1000) expect(await region.getByRole("button", { name: "تحصيل وطباعة السند", exact: true }).count()).toBe(0);
      else {
        await region.getByRole("button", { name: "تحصيل وطباعة السند", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "تحصيل دفعة", exact: true });
        await expect.poll(async () => ({ target: await dialog.getByLabel("فاتورة الهدف", { exact: true }).inputValue(), amount: await dialog.getByLabel("المبلغ", { exact: true }).inputValue(), currency: await dialog.getByLabel("العملة", { exact: true }).inputValue() }))
          .toEqual({ target: String(current.id), amount: currency === "YER" ? "500" : "5.00", currency });
        await page.screenshot({ path: `${evidence}/remaining-preset-${currency}-${width}.png`, fullPage: true });
        // Collect exactly the lineage remainder on the replacement. The original
        // receipt stays on its ancestor; neither receipt may be counted twice.
        const response = page.waitForResponse(response => response.url().endsWith("/api/payments") && response.request().method() === "POST");
        await dialog.getByRole("button", { name: "سجّل الدفعة واطبع السند", exact: true }).click();
        expect((await response).status()).toBe(201); await dialog.waitFor({ state: "detached" });
        region = await checked(page, currency, 0);
        expect((await db.query("SELECT invoice_id,amount_minor::text FROM payments WHERE patient_id=$1 ORDER BY id", [f.patientId])).rows)
          .toEqual([{ invoice_id: f.original.id, amount_minor: "400" }, { invoice_id: current.id, amount_minor: "500" }]);
      }
      await page.screenshot({ path: `${evidence}/corrected-${currency}-${paid}-${width}.png`, fullPage: true });
      const reversal = await post(`/api/payments/${f.receiptId}/correct`, { mode: "void", reason: "إبطال اصطناعي لإعادة التحقق من تسوية الأصل" }, h.sessions.admin, `consumer-void-${f.receiptId}`);
      expect(reversal.status, await reversal.text()).toBe(201);
      const replacementPaid = paid === 400 ? 500 : 0, remaining = 900 - replacementPaid;
      result = await read(f.visitId); expect(result.checkout.invoicePaidMinor).toBe(replacementPaid); expect(result.checkout.current[currency]).toBe(remaining); expect(result.receptionHandoff.status).toBe("pending");
      await page.reload({ waitUntil: "networkidle" }); await checked(page, currency, remaining);
      await page.screenshot({ path: `${evidence}/reversed-${currency}-${paid}-${width}.png`, fullPage: true });
      expect((await db.query("SELECT invoice_id,kind FROM payments WHERE patient_id=$1 ORDER BY id", [f.patientId])).rows).toEqual([
        { invoice_id: f.original.id, kind: "payment" }, ...(paid === 400 ? [{ invoice_id: current.id, kind: "payment" }] : []), { invoice_id: f.original.id, kind: "refund" }]);
      expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1", [f.patientId])).rows).toHaveLength(3);
    } finally { await context.close(); }
  }, 90000);
  it.each(["YER", "SAR", "USD"] as const)("historical %s corrections/reversals preserve opening-only money through signing and browser reads", async currency => {
    const f = await owner();
    const source = { patientId: f.patientId, currency, items: [{ serviceId, quantity: 1, price: toInputAmount(1500, currency), catalogPriceMinor: 1500, scope: "both" }], discount: "0", discountReason: null,
      previouslyPaidAmount: toInputAmount(500, currency), historicalAsOf: "2026-10-01", note: null, idempotencyKey: `consumer-historical-${f.patientId}`,
      repaymentTerms: { mode: "full", installments: [] }, repaymentRemainingMinor: 1000, repaymentVersion: 0, repaymentSourceHash: null };
    const path = `/api/patients/${f.patientId}/historical-documents`, created = await post(path, source), body = await created.json(); expect(created.status, JSON.stringify(body)).toBe(201);
    const paid = await post("/api/payments", { patientId: f.patientId, openingCurrency: currency, amount: toInputAmount(1000, currency), currency, kind: "payment", method: "cash" }, h.sessions.admin, `consumer-history-paid-${f.patientId}`);
    const receipt = await paid.json(); expect(paid.status, JSON.stringify(receipt)).toBe(201);
    const list = await (await authedGet(path, h.sessions.admin)).json(), view = list.documents[0];
    const correction = await post(`${path}/${body.document.id}/correct`, { idempotencyKey: `consumer-history-correction-${f.patientId}`, expectedVersion: view.version, expectedSourceHash: view.sourceHash,
      prices: [toInputAmount(1400, currency)], discount: "0", discountReason: null, previouslyPaidAmount: toInputAmount(500, currency), historicalAsOf: "2026-10-01", note: null,
      reason: "تصحيح تاريخي اصطناعي دون اختلاق نقد", repaymentTerms: { mode: "full", installments: [] }, repaymentRemainingMinor: 0, repaymentVersion: view.scheduleVersion });
    expect(correction.status, await correction.text()).toBe(200);
    const sign = await post(`/api/visits/${f.visitId}/clinical`, { action: "sign" }); expect(sign.status).toBe(200); expect(await sign.json()).toMatchObject({ invoiceId: null, createdInvoiceId: null, duesMinor: 0 });
    let result = await read(f.visitId); expect(result.invoice).toBeNull(); expect(result.checkout.current[currency]).toBe(-100);
    const { context, page } = await open(f.patientId, f.visitId, 390, h.sessions.admin);
    try {
      await checked(page, currency, -100); await page.screenshot({ path: `${evidence}/historical-credit-${currency}-390.png`, fullPage: true });
      const reversed = await post(`/api/payments/${receipt.id}/correct`, { mode: "void", reason: "إبطال سند افتتاحي اصطناعي" }, h.sessions.admin, `consumer-history-void-${receipt.id}`); expect(reversed.status).toBe(201);
      result = await read(f.visitId); expect(result.checkout.current[currency]).toBe(900);
      await page.reload({ waitUntil: "networkidle" }); await checked(page, currency, 900);
      await page.screenshot({ path: `${evidence}/historical-reversed-${currency}-390.png`, fullPage: true });
      expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1", [f.patientId])).rows).toHaveLength(0);
      expect((await db.query("SELECT invoice_id,opening_currency,kind FROM payments WHERE patient_id=$1 ORDER BY id", [f.patientId])).rows).toEqual([{ invoice_id: null, opening_currency: currency, kind: "payment" }, { invoice_id: null, opening_currency: currency, kind: "refund" }]);
    } finally { await context.close(); }
  }, 90000);
  it("keeps existing role/privacy and foreign target boundaries without financial writes", async () => {
    const f = await invoice("SAR", 400), other = await owner();
    // Real concurrent HTTP readers must also fit the default application pool.
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => read(f.visitId)));
    for (const result of concurrent) expect(result).toMatchObject({ invoice: { id: f.original.id, currency: "SAR" }, checkout: { invoicePaidMinor: 400, current: { SAR: 600 } } });
    const before = (await db.query("SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1 ORDER BY id", [f.patientId])).rows;
    for (const actor of [h.sessions.reception, h.sessions.accountant, h.sessions.cashier]) expect((await post(`/api/visits/${other.visitId}/clinical`, { action: "sign" }, actor)).status).toBe(403);
    expect((await authedGet(`/api/visits/${f.visitId}/walkout`, h.sessions.portalA)).status).toBe(401);
    // The current operational owner boundary deliberately hides a foreign visit.
    expect((await authedGet(`/api/visits/${f.visitId}/walkout`, h.sessions.doctorB)).status).toBe(404);
    expect((await post(`/api/payments/${f.receiptId}/correct`, { mode: "void", reason: "Unauthorized synthetic reversal" }, h.sessions.reception)).status).toBe(403);
    expect((await post(`/api/invoices/${f.original.id}/correct`, {}, h.sessions.reception)).status).toBe(403);
    const foreignCurrency = await post("/api/payments", { patientId: f.patientId, invoiceId: f.original.id, amount: "1", currency: "USD", kind: "payment", method: "cash" }, h.sessions.admin, `consumer-foreign-${f.patientId}`); expect(foreignCurrency.status).toBe(409);
    const originalLink = (await db.query("SELECT invoice_id FROM visits WHERE id=$1", [other.visitId])).rows[0].invoice_id;
    try {
      await db.query("UPDATE visits SET invoice_id=$2 WHERE id=$1", [other.visitId, f.original.id]);
      const invalid = await post(`/api/visits/${other.visitId}/clinical`, { action: "sign" }); expect(invalid.status).toBe(409);
      const missing = await authedGet(`/api/visits/${other.visitId}/walkout`, h.sessions.admin); expect(missing.status).toBe(409); expect(await missing.json()).toMatchObject({ message: expect.stringMatching(/مراجعة مالية/) });
      expect((await db.query("SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1 ORDER BY id", [f.patientId])).rows).toEqual(before);
    } finally {
      // The invalid ownership edge is deliberate only inside this security probe.
      // Do not contaminate later real daily-report readers on the shared fixture.
      await db.query("UPDATE visits SET invoice_id=$2 WHERE id=$1", [other.visitId, originalLink]);
    }
    const date = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Aden"}).format(new Date());
    const report = await authedGet(`/api/reports/daily-clinic?date=${date}`, h.sessions.admin);
    expect(report.status, await report.text()).toBe(200);
  });
});
