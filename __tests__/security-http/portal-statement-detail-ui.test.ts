import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { baseUrl, harness } from "./_server";
import { formatMoney, type Currency } from "../../lib/money";

/**
 * Patient portal statement journey on the built app (synthetic data only). The "حسابي" tab
 * renders, for each current invoice, the printed treatment lines (description, quantity, unit
 * price, line total) and its discount/net in the invoice's own currency; and, for the active
 * agreement, its total / paid / remaining beside, never added to, the current due. The page
 * is compared with the API feed read in the same browser session.
 */

let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let browser: Browser;
const SAR_INVOICE = "PORTAL-DETAIL-UI-SAR", YER_INVOICE = "PORTAL-DETAIL-UI-YER";
const AGREEMENT = "اتفاق تقويم تجريبي للبوابة";
const created: { invoices: number[]; plan: number; receipt: number } = { invoices: [], plan: 0, receipt: 0 };

type Line = { description: string; quantity: number; unitPriceMinor: number; totalMinor: number };
type Feed = {
  invoices: { invoiceNumber: string; baseCurrency: Currency; discountMinor: number; netMinor: number; items: Line[] }[];
  agreements: { title: string; currency: Currency; totalMinor: number; paidMinor: number; remainingMinor: number }[];
  balances: Record<Currency, { dueMinor: number }>;
};

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const patientId = h.seeded.patientAId;
  await db.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
    SELECT 'portal-detail-ui', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
  const [{ id: shiftId }] = (await db.query<{ id: number }>(`SELECT id FROM cashier_shifts WHERE status = 'open' ORDER BY id LIMIT 1`)).rows;
  const invoice = async (number: string, currency: Currency, discountMinor: number, lines: [string, number, number][]) => {
    const total = lines.reduce((sum, [, quantity, unit]) => sum + quantity * unit, 0);
    const [{ id }] = (await db.query<{ id: number }>(`INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
      VALUES ($1, $2, $3, $4, $5) RETURNING id`, [number, patientId, total, discountMinor, currency])).rows;
    for (const [description, quantity, unit] of lines) await db.query(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
      VALUES ($1, $2, $3, $4, $5)`, [id, description, quantity, unit, quantity * unit]);
    created.invoices.push(id);
  };
  await invoice(SAR_INVOICE, "SAR", 2_000, [["تاج زركونيا تجريبي #14", 1, 15_000], ["تاج مؤقت تجريبي", 2, 2_500]]);
  await invoice(YER_INVOICE, "YER", 0, [["تنظيف جير تجريبي", 1, 900_000]]);
  [{ id: created.plan }] = (await db.query<{ id: number }>(`INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date, consent_at)
    VALUES ($1, $2, 300000, 'SAR', 'active', CURRENT_DATE, NOW()) RETURNING id`, [patientId, AGREEMENT])).rows;
  [{ id: created.receipt }] = (await db.query<{ id: number }>(`INSERT INTO payments (receipt_number, patient_id, invoice_id, plan_id, shift_id, kind,
      amount_minor, currency, exchange_rate, base_amount_minor, base_currency, method, created_by)
    VALUES ('PORTAL-DETAIL-UI-R1', $1, NULL, $2, $3, 'payment', 120000, 'SAR', 140, 16800000, 'YER', 'cash', 'portal-detail-ui') RETURNING id`,
    [patientId, created.plan, shiftId])).rows;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  if (db) {
    await db.query(`DELETE FROM payments WHERE id = $1`, [created.receipt]).catch(() => {});
    await db.query(`DELETE FROM treatment_plans WHERE id = $1`, [created.plan]).catch(() => {});
    await db.query(`DELETE FROM invoice_items WHERE invoice_id = ANY($1)`, [created.invoices]).catch(() => {});
    await db.query(`DELETE FROM invoices WHERE id = ANY($1)`, [created.invoices]).catch(() => {});
    await db.end();
  }
});

async function openStatement(width: number): Promise<{ page: Page; feed: Feed }> {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.portalA.cookie), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/portal`);
  await page.getByRole("button", { name: "حسابي" }).click();
  await page.getByRole("heading", { name: "الفواتير" }).waitFor({ timeout: 30_000 });
  const feed = await page.evaluate(async () => (await fetch("/api/portal/statement", { cache: "no-store" })).json()) as Feed;
  return { page, feed };
}

describe.each([390, 1280])("portal statement tab at %ipx", (width) => {
  it("renders each invoice's printed lines, discount and net in the invoice's own currency", async () => {
    const { page, feed } = await openStatement(width);
    for (const number of [SAR_INVOICE, YER_INVOICE]) {
      const invoice = feed.invoices.find(row => row.invoiceNumber === number)!;
      expect(invoice).toBeTruthy();
      const table = page.getByRole("table", { name: `بنود الفاتورة ${number}` });
      await table.waitFor({ timeout: 20_000 });
      const rows = table.locator("tbody tr");
      await expect.poll(() => rows.count(), { timeout: 20_000 }).toBe(invoice.items.length);
      for (const [index, line] of invoice.items.entries()) {
        const cells = (await rows.nth(index).locator("td").allInnerTexts()).map(text => text.trim());
        expect(cells).toEqual([line.description, String(line.quantity),
          formatMoney(line.unitPriceMinor, invoice.baseCurrency), formatMoney(line.totalMinor, invoice.baseCurrency)]);
      }
      const row = page.locator("li").filter({ has: table });
      expect(await row.innerText()).toContain(formatMoney(invoice.netMinor, invoice.baseCurrency));
      if (invoice.discountMinor > 0) expect(await row.innerText()).toContain(`بعد خصم ${formatMoney(invoice.discountMinor, invoice.baseCurrency)}`);
    }
    // The seeded SAR invoice is exactly what was stored: 15,000 + 2 × 2,500, less 2,000.
    const sar = feed.invoices.find(row => row.invoiceNumber === SAR_INVOICE)!;
    expect(sar.items).toEqual([
      { description: "تاج زركونيا تجريبي #14", quantity: 1, unitPriceMinor: 15_000, totalMinor: 15_000 },
      { description: "تاج مؤقت تجريبي", quantity: 2, unitPriceMinor: 2_500, totalMinor: 5_000 },
    ]);
    expect(sar.netMinor).toBe(18_000);
    // Currency separation: YER lines never carry the SAR amount and vice versa.
    const yerTable = await page.getByRole("table", { name: `بنود الفاتورة ${YER_INVOICE}` }).innerText();
    expect(yerTable).toContain(formatMoney(900_000, "YER"));
    expect(yerTable).not.toContain(formatMoney(15_000, "SAR"));
    await page.context().close();
  }, 120_000);

  it("shows the agreement's total, paid and remaining beside the current due, never added to it", async () => {
    const { page, feed } = await openStatement(width);
    const agreement = feed.agreements.find(row => row.title === AGREEMENT)!;
    expect(agreement).toEqual({ title: AGREEMENT, currency: "SAR", totalMinor: 300_000, paidMinor: 120_000, remainingMinor: 180_000 });
    const card = page.locator("div").filter({ has: page.getByRole("heading", { name: `اتفاق العلاج — ${AGREEMENT}` }) }).last();
    const text = await card.innerText();
    expect(text).toContain(formatMoney(300_000, "SAR"));
    expect(text).toContain(formatMoney(120_000, "SAR"));
    expect(text).toContain(formatMoney(180_000, "SAR"));
    expect(text).toContain("لا يعني أن كامل المبلغ مستحق الآن");
    // The current SAR due is the canonical ledger due, shown separately from the agreement remaining.
    const due = feed.balances.SAR.dueMinor;
    const pageText = await page.locator("main").innerText();
    expect(pageText).toContain(formatMoney(Math.abs(due), "SAR"));
    if (due !== 0) expect(pageText).not.toContain(formatMoney(Math.abs(due) + agreement.remainingMinor, "SAR"));
    await page.context().close();
  }, 120_000);
});
