import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * (RC-2) المالك: «غلطنا بسندات ونشتي نعدّلها — عملنا للمريض مبلغ زيادة».
 * في متصفحٍ حقيقي: المدير يصحّح سند القبض من حساب المريض ومن قائمة سندات الصندوق — المبلغ
 * الصحيح بدل الخطأ، بسببٍ مكتوب — ويرى النتيجة. والاستقبال لا يرى الزر.
 */

let browser: Browser;
let db: Client;
let patientId = 0;
let invoiceId = 0;
let shiftId = 0;
let h: Awaited<ReturnType<typeof harness>>;

/* أرقام سندات الاختبار بلا أرقام عربية/لاتينية: مزامنة عدّاد السندات عند الإقلاع تقرأ أرقام
   المستندات القائمة — ورقمٌ فيه طابعٌ زمني يقفز بالعدّاد إلى ما لا يتسع له الترقيم. */
function stamp(): string {
  return Date.now().toString().replace(/\d/g, (digit) => "ABCDEFGHIJ"[Number(digit)]);
}

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

async function receipt(amountMinor: number, receiptNumber: string): Promise<number> {
  const { rows: [row] } = await db.query<{ id: number }>(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate,
                           base_amount_minor, base_currency, method, created_by)
     VALUES ($1, $2, $3, $4, 'payment', $5, 'YER', 1, $5, 'YER', 'cash', 'reception') RETURNING id`,
    [receiptNumber, patientId, invoiceId, shiftId, amountMinor]);
  return row.id;
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض سند زائد') RETURNING id`, [`RC2U-${Date.now()}`]));
  ({ rows: [{ id: invoiceId }] } = await db.query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
     VALUES ($1, $2, 100000, 0, 'YER', 'reception') RETURNING id`, [`RC2U-INV-${Date.now()}`, patientId]));
  await db.query(
    `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
     VALUES ($1, 'تقويم — دفعة', 1, 100000, 100000)`, [invoiceId]);
  await db.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'rc2-ui', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
  ({ rows: [{ id: shiftId }] } = await db.query<{ id: number }>(
    `SELECT id FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1`));
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await db?.end();
});

async function page(cookie: string, path: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(cookie), url: baseUrl }]);
  const tab = await context.newPage();
  await tab.goto(`${baseUrl}${path}`);
  return { context, tab };
}

async function openAccount(cookie: string) {
  const opened = await page(cookie, `/patients/${patientId}?tab=account`);
  await opened.tab.getByRole("button", { name: /الحساب/ }).first().click();
  await opened.tab.getByRole("region", { name: "الدفعات" }).waitFor();
  return opened;
}

describe("تصحيح سند قبضٍ بمبلغٍ خطأ", () => {
  it("from the patient account: 50,000 entered, 5,000 received — the admin corrects it with a reason", async () => {
    const wrongId = await receipt(50_000, `RCU-R-A-${stamp()}`);
    const { context, tab } = await openAccount(h.sessions.admin.cookie);
    try {
      const payments = tab.getByRole("region", { name: "الدفعات" });
      await payments.getByRole("button", { name: "تصحيح السند" }).first().click();
      const editor = tab.getByRole("group", { name: /^تصحيح / });
      await editor.getByLabel("المبلغ الصحيح").fill("5000");
      await editor.getByLabel("سبب تصحيح السند").fill("كُتب ٥٠ ألفًا والمقبوض ٥ آلاف");
      await editor.getByRole("button", { name: "صحّح السند" }).click();
      await tab.getByRole("status").getByText(/وصدر بدله/).waitFor();

      const { rows } = await db.query<{ kind: string; amount_minor: string }>(
        `SELECT kind, amount_minor::text FROM payments WHERE id = $1 OR reversal_of_id = $1 OR note = (SELECT 'بدل السند ' || receipt_number FROM payments WHERE id = $1) ORDER BY id`,
        [wrongId]);
      expect(rows).toEqual([
        { kind: "payment", amount_minor: "50000" },
        { kind: "refund", amount_minor: "50000" },
        { kind: "payment", amount_minor: "5000" },
      ]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("from the cash desk: the admin voids a receipt for money that never came in", async () => {
    const receiptNumber = `RCU-R-B-${stamp()}`;
    const wrongId = await receipt(7_000, receiptNumber);
    const { context, tab } = await page(h.sessions.admin.cookie, "/finance");
    try {
      const row = tab.locator("div.rounded-2xl", { hasText: `سند #${receiptNumber}` }).last();
      await row.getByRole("button", { name: "تصحيح السند" }).click();
      const editor = tab.getByRole("group", { name: /^تصحيح / });
      await editor.getByRole("radio", { name: /إبطال السند/ }).click();
      await editor.getByLabel("سبب تصحيح السند").fill("لم يُقبض شيء");
      await editor.getByRole("button", { name: "أبطل السند" }).click();
      await tab.getByText(/أُبطل .* بسند الردّ/).first().waitFor();

      const { rows } = await db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM payments WHERE reversal_of_id = $1 AND amount_minor = 7000`, [wrongId]);
      expect(rows[0].n).toBe(1);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("reception sees no correction button", async () => {
    await receipt(1_000, `RCU-R-C-${stamp()}`);
    const { context, tab } = await openAccount(h.sessions.reception.cookie);
    try {
      expect(await tab.getByRole("region", { name: "الدفعات" }).getByRole("button", { name: "تصحيح السند" }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 120_000);
});
