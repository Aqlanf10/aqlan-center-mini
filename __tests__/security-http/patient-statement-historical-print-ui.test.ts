import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { formatAmount, formatMoney } from "../../lib/money";
import { authedMutation, baseUrl, confirmingSimilarCollection, harness } from "./_server";

/**
 * Built-app acceptance: the CURRENT printed statement shows historical treatment agreements (no invoices)
 * from their saved revision, in the invoice detail layout, across A4 pages with repeated headings.
 * Real endpoints create the synthetic history and collections. Disposable harness DB only.
 */
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
const stamp = Date.now();
const directory = ".settings-ui-artifacts/patient-statement-historical";
const plain = (text: string) => text.normalize("NFKC").replace(/[‎‏‪-‮⁦-⁩]/g, "");
const TEETH = [11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 35, 36, 37, 38];
let savedDocument: { id: number; lines: { discountMinor: number; netMinor: number }[] };
let receipt: { id: number; receiptNumber: string };
let rct = 0, patientId = 0, otherPatientId = 0, documentId = 0, otherDocumentId = 0, serial = 0;
const serviceMarker = `HISTORICAL-RCT-${stamp}`;
/** A long Arabic treatment description (the saved line description), led by a Latin marker for row counting. */
const serviceName = `${serviceMarker} علاج عصب وحشو قنوات الجذر مع ترميم نهائي ومتابعة مراحل العلاج والتأكد من راحة المريض`;
const otherServiceName = `OTHER-PATIENT-HISTORY-${stamp}`;

async function createDocument(patient: number, serviceId: number, teeth: number[], amounts: { discount: string; paid: string; remaining: number }) {
  const key = `statement-history-ui-${stamp}-${++serial}`;
  const body = { patientId: patient, currency: "YER", items: teeth.map((toothCode) => ({ serviceId, quantity: 1, price: "50000", catalogPriceMinor: 50000, toothCode })),
    discount: amounts.discount, discountReason: "Synthetic historical discount", previouslyPaidAmount: amounts.paid, historicalAsOf: "2026-09-20", note: null,
    idempotencyKey: key, repaymentTerms: { mode: "installments", installments: [{ dueDate: "2026-12-12", amountMinor: amounts.remaining, kind: "installment" }] },
    repaymentRemainingMinor: amounts.remaining, repaymentVersion: 0, repaymentSourceHash: null };
  const response = await authedMutation(`/api/patients/${patient}/historical-documents`, h.sessions.admin, "POST", JSON.stringify(body));
  const json = await response.json();
  expect(response.status, JSON.stringify(json)).toBe(201);
  return json.document as { id: number; lines: { discountMinor: number; netMinor: number }[] };
}

async function collect(body: Record<string, unknown>) {
  const response = await confirmingSimilarCollection((headers) => authedMutation("/api/payments", h.sessions.admin, "POST",
    JSON.stringify({ patientId, currency: "YER", method: "cash", ...body }), { "Idempotency-Key": `statement-history-pay-${stamp}-${++serial}`, ...headers }));
  const json = await response.clone().json();
  expect(response.status, JSON.stringify(json)).toBe(201);
  return json as { id: number; receiptNumber: string };
}

async function historyState() {
  return (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM legacy_treatment_document_revisions r JOIN legacy_treatment_documents d ON d.id=r.document_id WHERE d.patient_id=$1) AS revisions,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM payments p WHERE p.patient_id=$1) AS payments,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.currency) FROM patient_opening_balances o WHERE o.patient_id=$1) AS openings,
    (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices`, [patientId])).rows[0];
}

beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  await db.query("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO NOTHING");
  rct = (await db.query<{ id: number }>("INSERT INTO services(name,category,price_minor,price_sar_minor,price_configured,is_active) VALUES($1,'rct',50000,5000000,TRUE,TRUE) RETURNING id", [serviceName])).rows[0].id;
  const otherService = (await db.query<{ id: number }>("INSERT INTO services(name,category,price_minor,price_sar_minor,price_configured,is_active) VALUES($1,'rct',50000,5000000,TRUE,TRUE) RETURNING id", [otherServiceName])).rows[0].id;
  patientId = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'مريض اتفاقات تاريخية اصطناعي') RETURNING id", [`HIST-PRINT-${stamp}`])).rows[0].id;
  otherPatientId = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'مريض آخر اصطناعي') RETURNING id", [`HIST-OTHER-${stamp}`])).rows[0].id;
  // 24 lines × 50,000 = 1,200,000; discount 20,000; agreed 1,180,000; paid before 180,000; carried 1,000,000.
  savedDocument = await createDocument(patientId, rct, TEETH, { discount: "20000", paid: "180000", remaining: 1_000_000 });
  documentId = savedDocument.id;
  otherDocumentId = (await createDocument(otherPatientId, otherService, [46], { discount: "0", paid: "0", remaining: 50_000 })).id;
  await db.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
    SELECT 'synthetic-historical-statement', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
  receipt = await collect({ kind: "payment", amount: "40000", openingCurrency: "YER" });
  await collect({ kind: "refund", amount: "10000", reversalOfId: receipt.id });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { try { await browser?.close(); } finally { await db?.end(); } });

async function openPrint(role: "admin" | "doctorA" | "accountant", target = patientId) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
  const [name, ...value] = h.sessions[role].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (!["GET", "HEAD"].includes(request.method())) writes.push(request.method()); });
  const response = await page.goto(`${baseUrl}/print/statement/${target}`);
  return { context, page, errors, writes, status: response?.status() };
}

/** Raw pdftotext output: no NFKC, no ligature or mark normalisation. */
const rawPdfText = (path: string) => execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
/** The single raw PDF line carrying exactly this label, with its exact amount on the same line. The amount is a
 * whole token: bounded by whitespace or the bidi embedding controls pdftotext writes around numbers. The labels
 * asserted this way contain no lam-alef ligature or combining mark, so their raw extraction is their logical text. */
function rawLabelled(raw: string, label: string, amountMinor: number) {
  const lines = raw.split("\n").filter((line) => line.includes(label));
  expect(lines, `exactly one raw PDF line with ${label}`).toHaveLength(1);
  expect(lines[0], `raw PDF amount for ${label}`).toMatch(new RegExp(`(^|[\\s\\u202a-\\u202e])${formatAmount(amountMinor, "YER").replace(/[.,]/g, "\\$&")}([\\s\\u202a-\\u202e]|ر)`));
  return lines[0];
}
/** Internal provenance / implementation prose that must never reach the patient handout. */
const INTERNAL = ["تسجيل اتفاق تاريخي", "أُضيف إلى الرصيد السابق", "سجل تاريخي", "ليس سند قبض", "قبل بدء العمل بالبرنامج", "النسخة", "لا فواتير حالية"];

async function printPdf(name: string) {
  const opened = await openPrint("admin");
  const { context, page } = opened;
  expect(opened.status).toBe(200);
  const sheet = page.locator(".statement-sheet"); await sheet.waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
  const ledger = await page.evaluate(async (id) => (await fetch(`/api/patients/${id}/ledger`, { cache: "no-store" })).json(), patientId) as
    { balances: Record<string, { billedMinor: number; collectedMinor: number; dueMinor: number }> };
  const text = plain(await sheet.innerText());
  const receipts = (await sheet.locator("table.items:not(.statement-invoice) tbody tr").allInnerTexts()).map(plain);
  await mkdir(directory, { recursive: true });
  await page.emulateMedia({ media: "print" });
  await page.setViewportSize({ width: Math.floor(194 * 96 / 25.4), height: Math.floor(281 * 96 / 25.4) });
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
  const pdfPath = `${directory}/${name}.pdf`;
  const pdf = await page.pdf({ path: pdfPath, format: "A4", printBackground: true, displayHeaderFooter: false, preferCSSPageSize: false });
  expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  const raw = rawPdfText(pdfPath);
  await writeFile(`${directory}/${name}.txt`, raw);
  return { ...opened, sheet, ledger, text, receipts, pdfPath, raw };
}

describe("patient-facing current statement with historical treatment (synthetic full Arabic example)", () => {
  it("prints the agreement lines, recorded discount, prior payment, current payment/refund and one reconciled final balance on RTL A4", async () => {
    const before = await historyState();
    const printed = await printPdf("statement-historical-a4");
    const { context, page, sheet, errors, writes } = printed;
    try {
      expect(await sheet.getAttribute("dir")).toBe("rtl");
      const table = sheet.locator(`[data-historical-kind="document"][data-historical-id="${documentId}"]`);
      expect(await table.count()).toBe(1);
      expect(await sheet.locator("[data-historical-kind]").count()).toBe(1);
      const rows = table.locator("tbody tr:not(.statement-total)");
      expect(await rows.count()).toBe(TEETH.length);
      for (const [index, tooth] of TEETH.entries()) {
        const cells = (await rows.nth(index).locator("td").allInnerTexts()).map(plain);
        expect(cells.slice(0, 4)).toEqual([serviceName, String(tooth), "1", formatMoney(50000, "YER")]);
        expect(cells[5]).toBe(formatMoney(50000 - savedDocument.lines[index].discountMinor, "YER"));
      }
      const total = async (label: string) => plain(await table.locator("tr.statement-total").filter({ hasText: label }).innerText());
      expect(await total("الإجمالي قبل الخصم")).toContain(formatMoney(1_200_000, "YER"));
      expect(await total("الخصم المسجل")).toContain(formatMoney(20_000, "YER"));
      expect(await total("المبلغ المتفق عليه")).toContain(formatMoney(1_180_000, "YER"));
      expect(await total("المدفوع من قبل")).toContain(formatMoney(180_000, "YER"));
      expect(await total("المبلغ المتبقي")).toContain(formatMoney(1_000_000, "YER"));
      // Current movements: one payment and its genuine reversal, each once, with receipt numbers.
      expect(printed.receipts).toHaveLength(2);
      expect(printed.receipts.join(" | ")).toContain(`عكس سند ${receipt.receiptNumber}`);
      expect(printed.receipts.filter((row) => row.includes(receipt.receiptNumber))).toHaveLength(2);
      // One reconciled final balance: 1,000,000 carried − 40,000 + 10,000 = 970,000, equal to the canonical ledger.
      expect(printed.ledger.balances.YER).toMatchObject({ billedMinor: 0, collectedMinor: 30_000, dueMinor: 970_000 });
      const finals = (await sheet.locator(".line-strong").filter({ hasText: "الرصيد الحالي" }).allTextContents()).map(plain);
      expect(finals).toEqual([expect.stringContaining(formatMoney(970_000, "YER"))]);
      for (const internal of INTERNAL) expect(printed.text, internal).not.toContain(internal);
      expect(printed.text).not.toContain(`#${documentId}`);
      expect(printed.text).not.toContain("الفواتير وتفاصيل العلاج");
      expect(printed.text).not.toContain(otherServiceName);
      expect(await table.locator("thead").evaluate((node) => getComputedStyle(node).display)).toBe("table-header-group");
      const layout = await table.locator("td.num").evaluateAll((cells) => cells.map((cell) => ({ scrollWidth: cell.scrollWidth, clientWidth: cell.clientWidth })));
      for (const cell of layout) expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth + 1);

      // Raw PDF: exact labelled amounts, no normalisation.
      const raw = printed.raw;
      rawLabelled(raw, "الخصم المسجل", 20_000);
      rawLabelled(raw, "المبلغ المتفق عليه", 1_180_000);
      rawLabelled(raw, "المدفوع من قبل", 180_000);
      rawLabelled(raw, "المبلغ المتبقي", 1_000_000);
      rawLabelled(raw, "الرصيد الحالي", 970_000);
      const rawPages = raw.split("\f").filter((pageText) => pageText.trim());
      expect(rawPages.length).toBeGreaterThanOrEqual(2);
      // Every page carrying historical lines repeats the agreement heading and the column headings.
      const withLines = rawPages.filter((pageText) => pageText.includes(serviceMarker));
      expect(withLines.length).toBeGreaterThanOrEqual(2);
      for (const pageText of withLines) for (const heading of ["اتفاق", "بتاريخ", "سعر الوحدة", "الموضع", "الكمية", "الصافي"]) expect(pageText).toContain(heading);
      expect(raw.match(new RegExp(serviceMarker, "g")) ?? []).toHaveLength(TEETH.length);
      expect(raw).not.toContain(otherServiceName);
      // Actual PDF geometry: A4 pages, every word inside its page; RTL: each description sits right of its amounts.
      const xml = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", printed.pdfPath, "-"], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
      const geometry = await page.evaluate((source) => {
        const doc = new DOMParser().parseFromString(source, "application/xml");
        if (doc.querySelector("parsererror")) throw new Error("Invalid PDF geometry XML");
        return Array.from(doc.getElementsByTagName("page")).map((p) => ({ width: Number(p.getAttribute("width")), height: Number(p.getAttribute("height")),
          words: Array.from(p.getElementsByTagName("word")).map((w) => ({ text: w.textContent ?? "", xMin: Number(w.getAttribute("xMin")), xMax: Number(w.getAttribute("xMax")),
            yMin: Number(w.getAttribute("yMin")), yMax: Number(w.getAttribute("yMax")) })) }));
      }, xml);
      await writeFile(`${directory}/pdf-layout.json`, JSON.stringify(geometry, null, 2));
      expect(geometry).toHaveLength(rawPages.length);
      for (const paper of geometry) {
        // A4 = 595.28 × 841.89 pt; Chromium rounds the media box to whole points.
        expect(Math.abs(paper.width - 595.28)).toBeLessThan(1.5); expect(Math.abs(paper.height - 841.89)).toBeLessThan(1.5);
        for (const word of paper.words) {
          expect(word.xMin).toBeGreaterThanOrEqual(0); expect(word.xMax).toBeLessThanOrEqual(paper.width);
          expect(word.yMin).toBeGreaterThanOrEqual(0); expect(word.yMax).toBeLessThanOrEqual(paper.height);
        }
        for (const marker of paper.words.filter((word) => word.text === serviceMarker)) {
          // The long Arabic description wraps; the row's amounts are vertically centred within its first ~45 pt.
          const amounts = paper.words.filter((word) => /^50,000$/.test(word.text) && word.yMin >= marker.yMin - 6 && word.yMin < marker.yMin + 45);
          expect(amounts.length).toBeGreaterThanOrEqual(1);
          for (const amount of amounts) expect(amount.xMax).toBeLessThan(marker.xMin);
        }
      }
      expect(errors).toEqual([]); expect(writes).toEqual([]);
    } finally { await context.close(); }
    expect(await historyState()).toEqual(before);
  });

  it("a further current payment updates the movements and the single final balance once, in DOM, ledger and raw PDF", async () => {
    const third = await collect({ kind: "payment", amount: "5000", openingCurrency: "YER" });
    const before = await historyState();
    const printed = await printPdf("statement-historical-second-payment");
    try {
      expect(printed.receipts).toHaveLength(3);
      expect(printed.receipts.filter((row) => row.includes(third.receiptNumber))).toHaveLength(1);
      expect(printed.ledger.balances.YER).toMatchObject({ billedMinor: 0, collectedMinor: 35_000, dueMinor: 965_000 });
      const finals = (await printed.sheet.locator(".line-strong").filter({ hasText: "الرصيد الحالي" }).allTextContents()).map(plain);
      expect(finals).toEqual([expect.stringContaining(formatMoney(965_000, "YER"))]);
      expect(rawLabelled(printed.raw, "الرصيد الحالي", 965_000)).not.toContain(formatAmount(970_000, "YER"));
      // The agreement's own facts do not move with current payments.
      rawLabelled(printed.raw, "المبلغ المتبقي", 1_000_000);
      rawLabelled(printed.raw, "المدفوع من قبل", 180_000);
      expect(printed.errors).toEqual([]); expect(printed.writes).toEqual([]);
    } finally { await printed.context.close(); }
    expect(await historyState()).toEqual(before);
  });

  it("keeps money roles and patient ownership: doctor 404, other patient's history never on this sheet", async () => {
    const doctor = await openPrint("doctorA");
    try { expect(doctor.status).toBe(404); expect(await doctor.page.content()).not.toContain(serviceName); } finally { await doctor.context.close(); }
    const other = await openPrint("admin", otherPatientId);
    try {
      expect(other.status).toBe(200);
      const sheet = other.page.locator(".statement-sheet"); await sheet.waitFor();
      expect(await sheet.locator(`[data-historical-id="${otherDocumentId}"]`).count()).toBe(1);
      expect(await sheet.locator(`[data-historical-id="${documentId}"]`).count()).toBe(0);
      expect(plain(await sheet.innerText())).not.toContain(serviceName);
    } finally { await other.context.close(); }
    // A tampered patientId query cannot retarget the sheet to another patient.
    const tampered = await browser.newContext();
    try {
      const [name, ...value] = h.sessions.admin.cookie.split("=");
      await tampered.addCookies([{ name, value: value.join("="), url: baseUrl }]);
      const page = await tampered.newPage();
      expect((await page.goto(`${baseUrl}/print/statement/${patientId}?patientId=${otherPatientId}`))?.status()).toBe(404);
    } finally { await tampered.close(); }
  });
});
