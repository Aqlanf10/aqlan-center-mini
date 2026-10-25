import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { authedMutation, baseUrl, harness } from "./_server";

/**
 * The patient account's ReceiptCorrection form on one allocation of a split agreement collection, in
 * the built app with a real browser and real routes (synthetic data only, no route interception). The
 * split is created through the app's own endpoints: approval, deposit, recorded upgrade, then one tender
 * that the writer splits between the original and the agreement-delta invoice.
 *  - Moving the delta allocation onto its settled sibling invoice is refused explicitly: the form shows
 *    the guard's Arabic reason (not «أعد المحاولة») and nothing is written.
 *  - A supported partial correction of the delta allocation (original target) records exactly one
 *    reversal and one replacement on the delta invoice, moves the drawer by the difference only, and
 *    leaves the sibling receipt untouched.
 */
let browser: Browser, h: Awaited<ReturnType<typeof harness>>, client: Client, serial = 0;
const q = async <R = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await client.query(sql, values)).rows as R[];

beforeAll(async () => {
  h = await harness();
  client = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await client.connect();
  await q("INSERT INTO cashier_shifts(opened_by) SELECT 'secadmin' WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 180_000);
afterAll(async () => { await browser?.close(); await client?.end(); });

async function splitFixture() {
  const marker = `${Date.now()}-${++serial}`;
  const [{ id: patientId }] = await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic split correction patient') RETURNING id", [`SPLIT-UI-${marker}`]);
  const service = async (price: number) => (await q<{ id: number }>("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES($1,$2,TRUE,TRUE,'prostho') RETURNING id", [`Synthetic split service ${marker}-${price}`, price]))[0].id;
  const originalServiceId = await service(50_000), newServiceId = await service(80_000);
  const [{ id: planId }] = await q<{ id: number }>("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,start_date,consent_at,consent_by) VALUES($1,'Synthetic ten crowns',500000,'YER','2026-10-01',now(),'secadmin') RETURNING id", [patientId]);
  await q("INSERT INTO plan_items(plan_id,service_id,service_name,quantity,unit_price_minor,billing_rule,session_count) VALUES($1,$2,'Synthetic original service',10,50000,'once',1)", [planId, originalServiceId]);
  await q("INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES($1,1,'2026-10-01',250000),($1,2,'2099-12-01',250000)", [planId]);
  const ok = async (response: Response, status = 201) => { expect(response.status, await response.clone().text()).toBe(status); return response.json() as Promise<Record<string, unknown>>; };
  await ok(await authedMutation(`/api/plans/${planId}/financial-approval`, h.sessions.admin, "POST",
    JSON.stringify({ expectedTotalMinor: 500000, currency: "YER", source: { kind: "new" }, reason: "Synthetic full original approval" }), { "Idempotency-Key": `split-ui-approve-${marker}` }));
  await ok(await authedMutation(`/api/plans/${planId}`, h.sessions.admin, "POST", JSON.stringify({ amount: "180000", currency: "YER" }), { "Idempotency-Key": `split-ui-deposit-${marker}` }));
  const preview = await fetch(`${baseUrl}/api/plans/${planId}/agreement-amendment`, { headers: { Cookie: h.sessions.admin.cookie } });
  const { sourceHash } = await preview.json() as { sourceHash: string };
  const upgrade = await ok(await authedMutation(`/api/plans/${planId}/agreement-amendment`, h.sessions.admin, "POST",
    JSON.stringify({ idempotencyKey: `split-ui-upgrade-${marker}`, expectedSourceHash: sourceHash, newServiceId, newUnitMinor: 80000, reason: "Synthetic signed upgrade" })));
  const split = await ok(await authedMutation(`/api/plans/${planId}`, h.sessions.admin, "POST", JSON.stringify({ amount: "400000", currency: "YER" }), { "Idempotency-Key": `split-ui-collect-${marker}` }));
  const receipts = await q<{ id: number; receipt_number: string; invoice_id: number; amount: number }>(
    "SELECT id, receipt_number, invoice_id, amount_minor::int AS amount FROM payments WHERE id = ANY($1::int[]) ORDER BY id", [split.paymentIds]);
  expect(receipts.map((row) => row.amount)).toEqual([320_000, 80_000]);
  const [original, delta] = receipts;
  expect(delta.invoice_id).toBe(upgrade.deltaInvoiceId);
  return { patientId, original, delta };
}

const financialState = async (patientId: number) => JSON.stringify(await q(`SELECT
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM payments p WHERE p.patient_id=$1) AS payments,
  (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM invoices i WHERE i.patient_id=$1) AS invoices,
  (SELECT count(*) FROM audit_log a WHERE a.entity='payment' AND a.entity_id IN (SELECT id::text FROM payments WHERE patient_id=$1)) AS audits`, [patientId]));
/** This patient's net YER cash in the open drawer: receipts less refunds (the drawer's payment component). */
const patientDrawerYer = async (patientId: number) => Number((await q<{ n: string }>(`SELECT coalesce(sum(CASE WHEN kind='payment' THEN amount_minor ELSE -amount_minor END),0)::text AS n
  FROM payments WHERE patient_id=$1 AND currency='YER' AND method='cash' AND shift_id=(SELECT id FROM cashier_shifts WHERE status='open' ORDER BY id LIMIT 1)`, [patientId]))[0].n);

async function openCorrection(patientId: number, receiptNumber: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
  const row = page.locator("section[aria-label='الدفعات'] li").filter({ hasText: receiptNumber });
  await row.getByRole("button", { name: "تصحيح السند" }).click({ timeout: 30_000 });
  await page.getByRole("group", { name: `تصحيح ${receiptNumber}` }).waitFor({ timeout: 20_000 });
  return page;
}

describe("ReceiptCorrection on a split-collection allocation (built app, real browser)", () => {
  it("moving the delta allocation onto its settled sibling invoice shows the explicit refusal and writes nothing", async () => {
    const f = await splitFixture();
    const before = await financialState(f.patientId);
    const page = await openCorrection(f.patientId, f.delta.receipt_number);
    try {
      const form = page.getByRole("group", { name: `تصحيح ${f.delta.receipt_number}` });
      await form.getByLabel("المبلغ الصحيح").fill("80000");
      await form.getByLabel("على ماذا يُسجَّل السند الصحيح").selectOption(`inv:${f.original.invoice_id}`);
      await form.getByLabel("سبب تصحيح السند").fill("Synthetic move to the settled sibling invoice");
      const answered = page.waitForResponse((response) => response.url().endsWith(`/api/payments/${f.delta.id}/correct`) && response.request().method() === "POST");
      await form.getByRole("button", { name: "صحّح السند" }).click();
      const response = await answered;
      expect(response.status()).toBe(400);
      expect(await response.json()).toEqual({ message: "المبلغ يتجاوز متبقي المصدر أو الحساب.", code: "invalid" });
      const alert = form.getByRole("alert");
      await expect.poll(() => alert.innerText(), { timeout: 20_000 }).toContain("المبلغ يتجاوز متبقي المصدر أو الحساب.");
      expect(await alert.innerText()).not.toContain("أعد المحاولة");
      expect(await financialState(f.patientId)).toBe(before);
    } finally { await page.context().close(); }
  }, 180_000);

  it("a supported partial correction of the delta allocation records one reversal and one replacement on the delta invoice only", async () => {
    const f = await splitFixture();
    const drawerBefore = await patientDrawerYer(f.patientId);
    const page = await openCorrection(f.patientId, f.delta.receipt_number);
    try {
      const form = page.getByRole("group", { name: `تصحيح ${f.delta.receipt_number}` });
      await form.getByLabel("المبلغ الصحيح").fill("48000");
      await form.getByLabel("سبب تصحيح السند").fill("Synthetic partial correction of the delta allocation");
      const answered = page.waitForResponse((response) => response.url().endsWith(`/api/payments/${f.delta.id}/correct`) && response.request().method() === "POST");
      await form.getByRole("button", { name: "صحّح السند" }).click();
      expect((await answered).status()).toBe(201);
      await form.waitFor({ state: "detached", timeout: 20_000 });
    } finally { await page.context().close(); }
    const rows = await q<{ kind: string; amount: number; invoice_id: number; reversal_of_id: number | null }>(
      "SELECT kind, amount_minor::int AS amount, invoice_id, reversal_of_id FROM payments WHERE patient_id=$1 AND id > $2 ORDER BY id", [f.patientId, f.delta.id]);
    expect(rows).toEqual([
      { kind: "refund", amount: 80_000, invoice_id: f.delta.invoice_id, reversal_of_id: f.delta.id },
      { kind: "payment", amount: 48_000, invoice_id: f.delta.invoice_id, reversal_of_id: null },
    ]);
    expect(await q("SELECT id FROM payments WHERE reversal_of_id=$1", [f.original.id])).toEqual([]);
    expect(drawerBefore - await patientDrawerYer(f.patientId)).toBe(32_000);
  }, 180_000);
});
