import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";
import { authedGet, authedMutation, baseUrl, confirmingSimilarCollection, harness, loginPortal, type Session } from "./_server";
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
const directory = ".settings-ui-artifacts/portal-historical-evidence";
const unavailableNotice = "تفاصيل العلاج السابق غير متاحة حاليًا، والأرصدة المعروضة لا تعتمد عليها. راجع المركز للاطلاع على التفاصيل.";
type Line = { description: string; site: string | null; quantity: number; unitPriceMinor: number | null; discountMinor: number | null; netMinor: number };
type Agreement = { historicalAsOf: string; currency: Currency; lines: Line[]; grossMinor: number | null; discountMinor: number | null; agreedMinor: number; previouslyPaidMinor: number; remainingMinor: number };
type Feed = { historical: { available: boolean; agreements: Agreement[]; undetailed: unknown[] }; balances: Record<Currency, { dueMinor: number }> };
const patients: Record<"YER" | "SAR", { id: number; documentId: number; portal: Session; marker: string }> = {} as never;

async function createDocument(patientId: number, currency: Currency, serviceId: number, catalogMinor: number, teeth: number[], price: string, amounts: { discount: string; paid: string; remaining: number }) {
  const body = { patientId, currency, items: teeth.map((toothCode) => ({ serviceId, quantity: 1, price, catalogPriceMinor: catalogMinor, toothCode })),
    discount: amounts.discount, discountReason: Number(amounts.discount) > 0 ? "Synthetic historical discount" : null, previouslyPaidAmount: amounts.paid,
    historicalAsOf: "2026-09-20", note: null, idempotencyKey: `portal-history-ui-${stamp}-${++serial}`,
    repaymentTerms: { mode: "installments", installments: [{ dueDate: "2026-12-12", amountMinor: amounts.remaining, kind: "installment" }] },
    repaymentRemainingMinor: amounts.remaining, repaymentVersion: 0, repaymentSourceHash: null };
  const response = await authedMutation(`/api/patients/${patientId}/historical-documents`, h.sessions.admin, "POST", JSON.stringify(body));
  const json = await response.json();
  expect(response.status, JSON.stringify(json)).toBe(201);
  return (json.document as { id: number }).id;
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
    patients[currency] = { id, documentId: 0, portal: await loginPortal(phone, number), marker: `PORTAL-HIST-${currency}-${stamp}` };
  }
  // YER: 3 × 50,000 = 150,000; discount 15,000; agreed 135,000; paid before 35,000; carried 100,000.
  const yerService = (await db.query<{ id: number }>("INSERT INTO services(name,category,price_minor,price_sar_minor,price_configured,is_active) VALUES($1,'rct',50000,5000000,TRUE,TRUE) RETURNING id",
    [`${patients.YER.marker} علاج عصب تجريبي طويل الوصف مع ترميم نهائي`])).rows[0].id;
  patients.YER.documentId = await createDocument(patients.YER.id, "YER", yerService, 50000, [14, 15, 16], "50000", { discount: "15000", paid: "35000", remaining: 100_000 });
  // SAR ×100: one crown at 1,500.50; paid before 500.00; carried 1,000.50.
  const sarService = (await db.query<{ id: number }>("INSERT INTO services(name,category,price_minor,price_sar_minor,price_configured,is_active) VALUES($1,'crown',300000,150050,TRUE,TRUE) RETURNING id",
    [`${patients.SAR.marker} تاج زركونيا تجريبي`])).rows[0].id;
  patients.SAR.documentId = await createDocument(patients.SAR.id, "SAR", sarService, 150050, [11], "1500.50", { discount: "0", paid: "500", remaining: 100_050 });
  await db.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
    SELECT 'portal-history-ui', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
  const response = await confirmingSimilarCollection((headers) => authedMutation("/api/payments", h.sessions.admin, "POST",
    JSON.stringify({ patientId: patients.YER.id, currency: "YER", method: "cash", kind: "payment", amount: "40000", openingCurrency: "YER" }),
    { "Idempotency-Key": `portal-history-pay-${stamp}-${++serial}`, ...headers }));
  expect(response.status, await response.clone().text()).toBe(201);
}, 240_000);
afterAll(async () => { try { await browser?.close(); } finally { await db?.end(); } });

async function getBrowser() {
  return browser ??= await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}
async function openStatement(currency: "YER" | "SAR", width: number, available = true): Promise<{ page: Page; feed: Feed; raw: string }> {
  const context = await (await getBrowser()).newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(patients[currency].portal.cookie), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/portal`);
  await page.getByRole("button", { name: "حسابي" }).click();
  await (available ? page.getByRole("heading", { name: "العلاج السابق" }) : page.getByRole("status")).waitFor({ timeout: 30_000 });
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

/** Only synthetic patient rows in the disposable harness DB; reading a statement must not change them. */
async function patientState(patientId: number) {
  return (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM legacy_treatment_document_revisions r JOIN legacy_treatment_documents d ON d.id=r.document_id WHERE d.patient_id=$1) AS revisions,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM payments p WHERE p.patient_id=$1) AS payments,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.currency) FROM patient_opening_balances o WHERE o.patient_id=$1) AS openings,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM invoices i WHERE i.patient_id=$1) AS invoices`, [patientId])).rows[0];
}

/** Corrupt/restore a single synthetic revision, never production data or an application write path. */
async function setSyntheticRevisionLines(revisionId: number, lines: unknown) {
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL session_replication_role = replica");
    expect((await db.query("UPDATE legacy_treatment_document_revisions SET lines=$1::jsonb WHERE id=$2 AND document_id=$3",
      [JSON.stringify(lines), revisionId, patients.YER.documentId])).rowCount).toBe(1);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}

describe("proposed portal fallback evidence, not owner policy approval", () => {
  it.each([390, 1280])("at %ipx: a corrupt saved fact shows the Arabic notice without details or changed canonical figures", async (width) => {
    const before = await patientState(patients.YER.id);
    const healthy = await openStatement("YER", width);
    const balanceCard = (page: Page) => page.getByText("المتبقي على حسابك", { exact: true }).locator("..");
    const healthyBalanceText = await balanceCard(healthy.page).innerText();
    await healthy.page.context().close();
    const ledgerResponse = await authedGet(`/api/patients/${patients.YER.id}/ledger`, h.sessions.admin);
    expect(ledgerResponse.status).toBe(200);
    const ledger = await ledgerResponse.json();
    expect(healthy.feed.balances).toEqual(ledger.balances);
    const { rows: [revision] } = await db.query<{ id: number; lines: Record<string, unknown>[] }>(
      "SELECT id, lines FROM legacy_treatment_document_revisions WHERE document_id=$1 ORDER BY version DESC LIMIT 1", [patients.YER.documentId]);
    expect(revision).toBeDefined();
    const corrupt = structuredClone(revision.lines);
    corrupt[0].unitPriceMinor = String(corrupt[0].unitPriceMinor); // malformed saved type, not a ledger change
    try {
      await setSyntheticRevisionLines(revision.id, corrupt);
      const degraded = await openStatement("YER", width, false);
      try {
        expect(await degraded.page.getByRole("status").innerText()).toBe(unavailableNotice);
        expect(degraded.feed.historical).toEqual({ available: false });
        const { historical: _healthy, ...healthyRest } = healthy.feed;
        const { historical: _degraded, ...degradedRest } = degraded.feed;
        expect(degradedRest).toEqual(healthyRest);
        expect(degraded.feed.balances).toEqual(ledger.balances);
        expect(degraded.feed.balances.YER.dueMinor).toBe(60_000);
        expect(await balanceCard(degraded.page).innerText()).toBe(healthyBalanceText);
        expect(await balanceCard(degraded.page).innerText()).toContain("60,000 ر.ي");
        expect(await degraded.page.getByRole("region", { name: "العلاج السابق" }).count()).toBe(0);
        expect(await degraded.page.getByRole("heading", { name: "العلاج السابق" }).count()).toBe(0);
        expect(await degraded.page.getByRole("table", { name: /اتفاق علاج بتاريخ/ }).count()).toBe(0);
        const text = await degraded.page.locator("body").innerText();
        expect(text).not.toContain(patients.YER.marker);
        expect(text).not.toContain(patients.SAR.marker);
        expect(degraded.raw).not.toMatch(/StatementHistoricalDetailsError|document_id|unitPriceMinor|legacy_treatment_document_revisions/);
        await mkdir(directory, { recursive: true });
        await degraded.page.screenshot({ path: `${directory}/corrupt-history-${width}.png`, fullPage: true });
      } finally { await degraded.page.context().close(); }
    } finally { await setSyntheticRevisionLines(revision.id, revision.lines); }
    expect(await patientState(patients.YER.id)).toEqual(before);
    const recovered = await authedGet("/api/portal/statement", patients.YER.portal);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual(healthy.feed);
  });

  it("a real database error is an exact generic HTTP 500, never swallowed as unavailable history", async () => {
    // This suite is serial; the temporary column rename only touches its disposable database. No app
    // fault-injection hook, permissions change, or Production/Staging operation is introduced.
    expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
    const before = await patientState(patients.YER.id);
    const healthy = await authedGet("/api/portal/statement", patients.YER.portal);
    expect(healthy.status).toBe(200);
    const healthyFeed = await healthy.json();
    const column = "synthetic_private_history_lines";
    await db.query(`ALTER TABLE legacy_treatment_document_revisions RENAME COLUMN lines TO ${column}`);
    try {
      const response = await authedGet("/api/portal/statement", patients.YER.portal);
      const raw = await response.text();
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(JSON.parse(raw)).toEqual({ message: "تعذّر تحميل كشف الحساب." });
      // Exact response equality above excludes every internal id/key; also name the regression risks.
      expect(raw).not.toMatch(/SELECT|FROM|legacy_treatment|document_id|patientId|historical|available|42703|column|does not exist|stack|synthetic_private_history_lines/);
      await mkdir(directory, { recursive: true });
      await writeFile(`${directory}/database-error-response.json`, JSON.stringify({ status: response.status, body: JSON.parse(raw) }, null, 2));
    } finally { await db.query(`ALTER TABLE legacy_treatment_document_revisions RENAME COLUMN ${column} TO lines`); }
    expect(await patientState(patients.YER.id)).toEqual(before);
    const recovered = await authedGet("/api/portal/statement", patients.YER.portal);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual(healthyFeed);
  });
});

describe("actual Arabic SAR statement PDF, not a DOM-only scaling proof", () => {
  it("extracts labelled SAR major amounts from the PDF and renders its RTL A4 page without changing any facts", async () => {
    const before = await patientState(patients.SAR.id);
    const context = await (await getBrowser()).newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
    await context.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
    const page = await context.newPage();
    const errors: string[] = [], writes: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (!["GET", "HEAD"].includes(request.method())) writes.push(request.method()); });
    try {
      expect((await page.goto(`${baseUrl}/print/statement/${patients.SAR.id}`))?.status()).toBe(200);
      const sheet = page.locator(".statement-sheet");
      await sheet.waitFor();
      await page.evaluate(async () => { await document.fonts.ready; });
      expect(await sheet.getAttribute("dir")).toBe("rtl");
      const table = sheet.locator(`[data-historical-kind="document"][data-historical-id="${patients.SAR.documentId}"]`);
      expect(await table.count()).toBe(1);
      const row = await table.locator("tbody tr:not(.statement-total)").first().innerText();
      expect(row).toContain("1,500.50 ر.س"); // literal oracle, independent of the shared formatter
      const ledgerResponse = await authedGet(`/api/patients/${patients.SAR.id}/ledger`, h.sessions.admin);
      expect(ledgerResponse.status).toBe(200);
      const ledger = await ledgerResponse.json();
      expect(ledger.balances.SAR.dueMinor).toBe(100_050);
      await mkdir(directory, { recursive: true });
      await page.emulateMedia({ media: "print" });
      const pdfPath = `${directory}/statement-historical-sar-a4.pdf`;
      const pdf = await page.pdf({ path: pdfPath, format: "A4", printBackground: true, displayHeaderFooter: false });
      expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      const raw = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], { encoding: "utf8" });
      await writeFile(`${directory}/statement-historical-sar-a4.txt`, raw);
      const expected = [
        ["الخصم المسجل", "0.00"], ["المبلغ المتفق عليه", "1,500.50"],
        ["المدفوع من قبل", "500.00"], ["المبلغ المتبقي", "1,000.50"], ["الرصيد الحالي", "1,000.50"],
      ] as const;
      const labelled: Record<string, string> = {};
      for (const [label, amount] of expected) {
        const lines = raw.split("\n").filter((line) => line.includes(label));
        expect(lines, `one raw PDF line for ${label}`).toHaveLength(1);
        expect(lines[0]).toMatch(new RegExp(`(^|[\\s\\u202a-\\u202e])${amount.replace(/[.,]/g, "\\$&")}([\\s\\u202a-\\u202e]|ر)`));
        // pdftotext may insert directional controls inside ر.س. Remove only those controls;
        // keep the raw labelled numeric-token check above and every Arabic letter/digit unchanged.
        expect(lines[0].replace(/[\u202a-\u202e\u2066-\u2069]/g, "")).toContain("ر.س");
        labelled[label] = lines[0];
      }
      expect(raw).not.toContain(patients.YER.marker);
      expect(raw.replace(/[\u202a-\u202e\u2066-\u2069]/g, "")).not.toMatch(/150,050|100,050|50,000|ر\.ي/);
      expect(raw.split("\f").filter((text) => text.trim())).toHaveLength(1);
      // Render the actual PDF bytes for human visual review, not a screenshot of a separate DOM.
      execFileSync("pdftoppm", ["-singlefile", "-r", "120", "-png", pdfPath, `${directory}/statement-historical-sar-a4-rendered`]);
      const info = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
      expect(info).toMatch(/Page size:\s+595(?:\.\d+)? x 842(?:\.\d+)? pts \(A4\)/);
      expect(errors).toEqual([]);
      expect(writes).toEqual([]);
      await writeFile(`${directory}/sar-pdf-evidence.json`, JSON.stringify({ currency: "SAR", minorUnitsPerMajor: 100,
        stored: { agreedMinor: 150_050, previouslyPaidMinor: 50_000, remainingMinor: 100_050 }, canonicalDueMinor: ledger.balances.SAR.dueMinor,
        expectedMajorAmounts: Object.fromEntries(expected), rawLabelledLines: labelled, pdfInfo: info, errors, writes }, null, 2));
    } finally { await context.close(); }
    expect(await patientState(patients.SAR.id)).toEqual(before);
  });
});
