import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { authedMutation, baseUrl, confirmingSimilarCollection, harness, loginPortal, type Session } from "./_server";
import { formatMoney, type Currency } from "../../lib/money";
import { friendlyDateLong } from "../../lib/reminders";

/**
 * Portal «العلاج السابق» journey on the built app (synthetic data, disposable harness DB only). Real
 * endpoints create the historical documents and the opening collection; each synthetic patient logs into
 * the portal with its own phone and number. The "حسابي" tab must show the same saved agreement lines and
 * totals as the printed statement, in the agreement's own currency (YER and SAR ×100), compared with the
 * API feed read in the same browser session, with no other patient's history and no internal ids.
 */
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
const stamp = Date.now();
let serial = 0;
type Line = { description: string; site: string | null; quantity: number; unitPriceMinor: number | null; discountMinor: number | null; netMinor: number };
type Agreement = { historicalAsOf: string; currency: Currency; lines: Line[]; grossMinor: number | null; discountMinor: number | null; agreedMinor: number; previouslyPaidMinor: number; remainingMinor: number };
type Feed = { historical: { available: boolean; agreements: Agreement[]; undetailed: unknown[] }; balances: Record<Currency, { dueMinor: number }> };
const patients: Record<"YER" | "SAR", { id: number; portal: Session; marker: string }> = {} as never;

async function createDocument(patientId: number, currency: Currency, serviceId: number, catalogMinor: number, teeth: number[], price: string, amounts: { discount: string; paid: string; remaining: number }) {
  const body = { patientId, currency, items: teeth.map((toothCode) => ({ serviceId, quantity: 1, price, catalogPriceMinor: catalogMinor, toothCode })),
    discount: amounts.discount, discountReason: Number(amounts.discount) > 0 ? "Synthetic historical discount" : null, previouslyPaidAmount: amounts.paid,
    historicalAsOf: "2026-09-20", note: null, idempotencyKey: `portal-history-ui-${stamp}-${++serial}`,
    repaymentTerms: { mode: "installments", installments: [{ dueDate: "2026-12-12", amountMinor: amounts.remaining, kind: "installment" }] },
    repaymentRemainingMinor: amounts.remaining, repaymentVersion: 0, repaymentSourceHash: null };
  const response = await authedMutation(`/api/patients/${patientId}/historical-documents`, h.sessions.admin, "POST", JSON.stringify(body));
  const json = await response.json();
  expect(response.status, JSON.stringify(json)).toBe(201);
}

beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  await db.query("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO NOTHING");
  for (const [currency, phone] of [["YER", `7771${String(stamp).slice(-5)}`], ["SAR", `7772${String(stamp).slice(-5)}`]] as const) {
    const number = `PH${currency[0]}-${String(stamp).slice(-8)}`;
    const id = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES($1,$2,$3) RETURNING id",
      [number, `مريض بوابة تاريخي اصطناعي ${currency}`, phone])).rows[0].id;
    patients[currency] = { id, portal: await loginPortal(phone, number), marker: `PORTAL-HIST-${currency}-${stamp}` };
  }
  // YER: 3 × 50,000 = 150,000; discount 15,000; agreed 135,000; paid before 35,000; carried 100,000.
  const yerService = (await db.query<{ id: number }>("INSERT INTO services(name,category,price_minor,price_sar_minor,price_configured,is_active) VALUES($1,'rct',50000,5000000,TRUE,TRUE) RETURNING id",
    [`${patients.YER.marker} علاج عصب تجريبي طويل الوصف مع ترميم نهائي`])).rows[0].id;
  await createDocument(patients.YER.id, "YER", yerService, 50000, [14, 15, 16], "50000", { discount: "15000", paid: "35000", remaining: 100_000 });
  // SAR ×100: one crown at 1,500.50; paid before 500.00; carried 1,000.50.
  const sarService = (await db.query<{ id: number }>("INSERT INTO services(name,category,price_minor,price_sar_minor,price_configured,is_active) VALUES($1,'crown',300000,150050,TRUE,TRUE) RETURNING id",
    [`${patients.SAR.marker} تاج زركونيا تجريبي`])).rows[0].id;
  await createDocument(patients.SAR.id, "SAR", sarService, 150050, [11], "1500.50", { discount: "0", paid: "500", remaining: 100_050 });
  await db.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
    SELECT 'portal-history-ui', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
  const response = await confirmingSimilarCollection((headers) => authedMutation("/api/payments", h.sessions.admin, "POST",
    JSON.stringify({ patientId: patients.YER.id, currency: "YER", method: "cash", kind: "payment", amount: "40000", openingCurrency: "YER" }),
    { "Idempotency-Key": `portal-history-pay-${stamp}-${++serial}`, ...headers }));
  expect(response.status, await response.clone().text()).toBe(201);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { try { await browser?.close(); } finally { await db?.end(); } });

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}
async function openStatement(currency: "YER" | "SAR", width: number): Promise<{ page: Page; feed: Feed; raw: string }> {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(patients[currency].portal.cookie), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/portal`);
  await page.getByRole("button", { name: "حسابي" }).click();
  await page.getByRole("heading", { name: "العلاج السابق" }).waitFor({ timeout: 30_000 });
  const raw = await page.evaluate(async () => (await fetch("/api/portal/statement", { cache: "no-store" })).text());
  return { page, feed: JSON.parse(raw) as Feed, raw };
}

describe.each([390, 1280])("portal «العلاج السابق» at %ipx", (width) => {
  it.each([
    ["YER", 3, { gross: 150_000, discount: 15_000, agreed: 135_000, paid: 35_000, remaining: 100_000 }],
    ["SAR", 1, { gross: 150_050, discount: 0, agreed: 150_050, paid: 50_000, remaining: 100_050 }],
  ] as const)("%s: renders the saved lines and totals exactly as the feed, in the agreement's currency", async (currency, lines, totals) => {
    const { page, feed, raw } = await openStatement(currency, width);
    expect(feed.historical.available).toBe(true);
    expect(feed.historical.agreements).toHaveLength(1);
    const [agreement] = feed.historical.agreements;
    expect({ currency: agreement.currency, gross: agreement.grossMinor, discount: agreement.discountMinor, agreed: agreement.agreedMinor,
      paid: agreement.previouslyPaidMinor, remaining: agreement.remainingMinor }).toEqual({ currency, ...totals });
    expect(agreement.lines).toHaveLength(lines);
    // No internal identifiers or the other synthetic patient's history in this patient's feed.
    expect(JSON.stringify(feed.historical)).not.toMatch(/"(id|kind|version|documentId)"\s*:/);
    expect(raw).not.toContain(patients[currency === "YER" ? "SAR" : "YER"].marker);
    const heading = `اتفاق علاج بتاريخ ${friendlyDateLong(agreement.historicalAsOf)}`;
    const table = page.getByRole("table", { name: heading });
    const rows = table.locator("tbody tr");
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBe(lines);
    for (const [index, line] of agreement.lines.entries()) {
      const cells = (await rows.nth(index).locator("td").allInnerTexts()).map((text) => text.trim());
      expect(cells).toEqual([line.description, line.site ?? "—", String(line.quantity),
        line.unitPriceMinor === null ? "غير مسجل" : formatMoney(line.unitPriceMinor, currency),
        line.discountMinor === null ? "غير مسجل" : formatMoney(line.discountMinor, currency), formatMoney(line.netMinor, currency)]);
    }
    const section = await page.getByRole("region", { name: "العلاج السابق" }).innerText();
    for (const [label, minor] of [["الإجمالي قبل الخصم", totals.gross], ["الخصم المسجل", totals.discount], ["المبلغ المتفق عليه", totals.agreed],
      ["المدفوع من قبل", totals.paid], ["المبلغ المتبقي", totals.remaining]] as const) {
      expect(section).toContain(label);
      expect(section).toContain(formatMoney(minor, currency));
    }
    // Currency separation: the other currency's amounts never appear in this section.
    expect(section).not.toContain(formatMoney(currency === "YER" ? 100_050 : 100_000, currency === "YER" ? "SAR" : "YER"));
    // The current due is still the canonical ledger due (YER opening collected 40,000 once).
    expect(feed.balances[currency].dueMinor).toBe(currency === "YER" ? 60_000 : 100_050);
    await page.context().close();
  }, 120_000);
});
