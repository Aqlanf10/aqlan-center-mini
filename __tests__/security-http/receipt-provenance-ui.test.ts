import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { ReceiptProvenance } from "../../lib/receipt-provenance";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { assertPrintPdfHeader, assertPrintPdfSignature, matchesPrintPdfWord, type PrintPdfPage } from "../helpers/print-pdf-glyphs";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
import { emitReceiptProvenanceEvidence, emitReceiptProvenanceFailedPdf, type ReceiptProvenanceEvidenceMember } from "./_receipt-provenance-evidence";

// SOURCE-ONLY CANDIDATE. All fixtures belong to the isolated HTTP database.
// The browser journey permits GET/HEAD only; it never clicks Print or a financial action.
type Payment = { id: number; receiptNumber: string; patientId: number; amountMinor: number;
  currency: string; baseAmountMinor: number; kind: "payment" | "refund"; createdAt: string };
type Feed = { payments: Payment[]; receiptProvenance: Record<string, ReceiptProvenance>; receiptRemaining?: unknown };
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let patientId = 0, invoiceId = 0, shiftId = 0;
let original: Payment, reversal: Payment, replacement: Payment, voidOriginal: Payment, voidReversal: Payment;
let ordinary: Payment, ordinaryRefund: Payment;
const artifacts = ".settings-ui-artifacts";
const sourceTimestamp = "2000-03-02T22:00:00.000Z";
const privateReason = "SYNTHETIC-PRIVATE-PROVENANCE-REASON";
const patientName = "SYNTHETIC-RECEIPT-PROVENANCE";
const stamp = Date.now().toString().replace(/\d/g, digit => "ABCDEFGHIJ"[Number(digit)]);
const ref = (payment: Payment) => ({ id: payment.id, receiptNumber: payment.receiptNumber });

async function seedReceipt(suffix: string, amount: number, reversalOfId: number | null = null) {
  const number = `SYN-PROV-${suffix}-${stamp}`;
  const { rows: [row] } = await db.query<{ id: number }>(`INSERT INTO payments
    (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate,
     base_amount_minor, base_currency, method, created_by, created_at, reversal_of_id, note)
    VALUES ($1,$2,$3,$4,$5,$6,'YER',1,$6,'YER','cash','SYNTHETIC-SIGNER',$7,$8,$9) RETURNING id`,
  [number, patientId, invoiceId, shiftId, reversalOfId === null ? "payment" : "refund", amount, sourceTimestamp,
    reversalOfId, reversalOfId === null ? null : `تصحيح السند ${ordinary.receiptNumber}: same-looking note`]);
  return { id: row.id, receiptNumber: number, patientId, amountMinor: amount, currency: "YER",
    baseAmountMinor: amount, kind: reversalOfId === null ? "payment" as const : "refund" as const, createdAt: sourceTimestamp };
}

beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(`INSERT INTO patients
    (patient_number, full_name, created_at) VALUES ($1,$2,$3) RETURNING id`, [`SYN-PROV-P-${stamp}`, patientName, sourceTimestamp]));
  ({ rows: [{ id: invoiceId }] } = await db.query<{ id: number }>(`INSERT INTO invoices
    (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
    VALUES ($1,$2,5000,0,'YER','synthetic-provenance',$3) RETURNING id`, [`SYN-PROV-I-${stamp}`, patientId, sourceTimestamp]));
  await db.query(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
    VALUES ($1,'SYNTHETIC-SERVICE',1,5000,5000)`, [invoiceId]);
  await db.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
    SELECT 'synthetic-provenance',0,0,0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status='open')`);
  ({ rows: [{ id: shiftId }] } = await db.query<{ id: number }>(`SELECT id FROM cashier_shifts WHERE status='open' LIMIT 1`));
  original = await seedReceipt("ORIGINAL", 50_000);
  const corrected = await authedMutation(`/api/payments/${original.id}/correct`, h.sessions.admin, "POST",
    JSON.stringify({ mode: "correct", reason: privateReason, amount: "5000", currency: "YER", method: "cash", target: "original" }));
  expect(corrected.status).toBe(201);
  ({ reversal, replacement } = await corrected.json() as { reversal: Payment; replacement: Payment });
  voidOriginal = await seedReceipt("VOID", 7_000);
  const voided = await authedMutation(`/api/payments/${voidOriginal.id}/correct`, h.sessions.admin, "POST",
    JSON.stringify({ mode: "void", reason: privateReason }));
  expect(voided.status).toBe(201);
  ({ reversal: voidReversal } = await voided.json() as { reversal: Payment });
  ordinary = await seedReceipt("ORDINARY", 8_000);
  ordinaryRefund = await seedReceipt("REFUND", 8_000, ordinary.id);
  await mkdir(artifacts, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { try { await browser?.close(); } finally { await db?.end(); } });

const payments = () => [original, reversal, replacement, voidOriginal, voidReversal, ordinary, ordinaryRefund];
async function snapshot() {
  return (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p WHERE patient_id=$1) AS payments,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i WHERE patient_id=$1) AS invoices,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoice_items i WHERE invoice_id=$2) AS items,
    (SELECT to_jsonb(s) FROM cashier_shifts s WHERE id=$3) AS shift,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a WHERE entity='payment'
      AND entity_id=ANY($4::text[])) AS audit,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM document_prints d WHERE doc_type='receipt'
      AND doc_id=ANY($4::text[])) AS prints,
    (SELECT COUNT(*)::int FROM payments) AS payment_count,
    (SELECT COUNT(*)::int FROM journal_manual) AS journal_count,
    (SELECT COUNT(*)::int FROM journal_manual_lines) AS journal_line_count`,
  [patientId, invoiceId, shiftId, payments().map(payment => String(payment.id))])).rows[0];
}
function assertProjection(feed: Feed) {
  const projection = feed.receiptProvenance;
  expect(projection).toBeDefined();
  expect(Object.keys(projection).sort()).toEqual(feed.payments.map(payment => String(payment.id)).sort());
  expect(projection[original.id]).toMatchObject({ status: "available",
    reversal: { state: "full", reversedMinor: 50_000, remainingMinor: 0 },
    correction: { mode: "correct", reversal: ref(reversal), replacement: ref(replacement) } });
  expect(projection[reversal.id].correctionReversal).toEqual({ mode: "correct", original: ref(original) });
  expect(projection[replacement.id].replacementOf).toEqual(ref(original));
  expect(projection[voidOriginal.id].correction).toEqual({ mode: "void", reversal: ref(voidReversal), replacement: null });
  expect(projection[ordinaryRefund.id]).toMatchObject({ reversalOf: ref(ordinary), correctionReversal: null });
  const text = JSON.stringify(projection);
  for (const hidden of [privateReason, "secadmin", "details", "actor", "summary"]) expect(text).not.toContain(hidden);
  const originalDto = feed.payments.find(payment => payment.id === original.id);
  expect(originalDto).toMatchObject({ amountMinor: 50_000, baseAmountMinor: 50_000, kind: "payment", createdAt: sourceTimestamp });
  expect(originalDto).not.toHaveProperty("receiptProvenance");
  expect(originalDto).not.toHaveProperty("reversalOfId");
}

describe("receipt provenance through existing authorized read routes", () => {
  it("adds a separate privacy-minimal projection without changing existing financial permissions or DTOs", async () => {
    const before = await snapshot();
    for (const role of ["admin", "reception", "cashier", "accountant"] as const) {
      const ledger = await authedGet(`/api/patients/${patientId}/ledger`, h.sessions[role]);
      expect(ledger.status).toBe(200);
      const body = await ledger.json() as Feed;
      assertProjection(body);
      if (role !== "admin") expect(body.receiptRemaining).toBeUndefined();
      const shift = await authedGet("/api/shifts", h.sessions[role]);
      expect(shift.status).toBe(200);
      assertProjection(await shift.json() as Feed);
    }
    for (const role of ["doctorA", "doctorB", "portalA", "portalB"] as const) {
      for (const path of [`/api/patients/${patientId}/ledger`, "/api/shifts", `/print/receipt/${original.id}`]) {
        const response = await authedGet(path, h.sessions[role]);
        expect(response.status).toBeGreaterThanOrEqual(300);
        const body = await response.text();
        expect(body).not.toContain(original.receiptNumber);
        expect(body).not.toContain(privateReason);
      }
    }
    expect(await snapshot()).toEqual(before);
  });
});

const plain = (text: string) => text.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
async function settled(page: Page) {
  await page.evaluate(async () => { await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
}
async function pdfPages(page: Page, path: string): Promise<PrintPdfPage[]> {
  const xml = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
  const papers = await page.evaluate(raw => {
    const xmlDocument = new DOMParser().parseFromString(raw, "application/xml");
    if (xmlDocument.querySelector("parsererror")) throw new Error("Invalid receipt PDF bbox XML");
    return Array.from(xmlDocument.getElementsByTagName("page")).map(node => ({
      width: Number(node.getAttribute("width")), height: Number(node.getAttribute("height")),
      words: Array.from(node.getElementsByTagName("word")).map(word => ({ text: word.textContent ?? "",
        xMin: Number(word.getAttribute("xMin")), xMax: Number(word.getAttribute("xMax")),
        yMin: Number(word.getAttribute("yMin")), yMax: Number(word.getAttribute("yMax")) })),
    }));
  }, xml);
  expect(papers).toHaveLength(1);
  expect(Math.abs(papers[0].width - 105 * 72 / 25.4)).toBeLessThan(1);
  expect(Math.abs(papers[0].height - 148 * 72 / 25.4)).toBeLessThan(1);
  for (const word of papers[0].words) {
    expect([word.xMin, word.xMax, word.yMin, word.yMax].every(Number.isFinite)).toBe(true);
    expect(word.xMin).toBeGreaterThanOrEqual(0); expect(word.yMin).toBeGreaterThanOrEqual(0);
    expect(word.xMax).toBeLessThanOrEqual(papers[0].width); expect(word.yMax).toBeLessThanOrEqual(papers[0].height);
  }
  return papers;
}
function assertOriginalPdf(paper: PrintPdfPage, text: string) {
  expect(paper.words.some(word => matchesPrintPdfWord(word.text, "بالكامل.")), "PDF full reversal status").toBe(true);
  expect(text, "PDF reversal receipt reference").toContain(reversal.receiptNumber);
  expect(text, "PDF replacement receipt reference").toContain(replacement.receiptNumber);
}

describe("receipt provenance on real built pages and native A6 paper", () => {
  it("keeps the recorded face amount when optional provenance is absent or malformed, then recovers", async () => {
    const before = await snapshot();
    const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: "ar-YE" });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    let mode: "legacy" | "missing-key" | "bad-total" | "pass" = "legacy";
    const unexpected: string[] = [], errors: string[] = [];
    const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== baseUrl || !["GET", "HEAD"].includes(request.method())) {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort(); return;
      }
      if (url.pathname !== `/api/patients/${patientId}/ledger` || mode === "pass") {
        await route.continue(); return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const body = await response.json() as Partial<Feed>;
      if (mode === "legacy") delete body.receiptProvenance;
      if (mode === "missing-key") delete body.receiptProvenance![original.id];
      if (mode === "bad-total") body.receiptProvenance![original.id].reversal = {
        state: "full", reversedMinor: 1, remainingMinor: 0,
      };
      await route.fulfill({ response, json: body });
    });
    await guard.run(async () => {
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      for (const state of ["legacy", "missing-key", "bad-total", "pass"] as const) {
        mode = state;
        await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "load" });
        await page.getByRole("button", { name: /الحساب/ }).first().click();
        const region = page.getByRole("region", { name: "الدفعات" });
        await region.getByText(original.receiptNumber, { exact: false }).first().waitFor();
        // Incoming lineage on another row can also mention the original number.
        // Select the original row by its own existing receipt-action link.
        const row = region.locator("li").filter({ has: page.locator(`a.rounded-xl[href="/print/receipt/${original.id}"]`) });
        expect(await row.locator("p.text-sm").first().innerText()).toContain("50,000");
        const marker = row.locator(`[data-receipt-provenance="${original.id}"]`);
        if (state === "legacy") {
          expect(await marker.count()).toBe(0);
        } else if (state === "pass") {
          await marker.waitFor();
          expect(await marker.innerText()).toContain("عُكس بالكامل");
        } else {
          await marker.waitFor();
          expect(await marker.innerText()).toContain("حالة السند غير متحققة");
          expect(await marker.innerText()).not.toContain("عُكس بالكامل");
          expect(await marker.locator("a").count()).toBe(0);
        }
      }
    }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); });
    expect(await snapshot()).toEqual(before);
  }, 180_000);

  it("keeps face values and timestamps, shows structural lineage at both widths, and prints truthful reversal labels", async () => {
    const before = await snapshot();
    const evidence: ReceiptProvenanceEvidenceMember[] = [];
    const generated: { current?: { scene: "original" | "reversal" | "replacement" | "void"; bytes: Buffer } } = {};
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE" });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const unexpected: string[] = [], errors: string[] = [];
    const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== baseUrl || !["GET", "HEAD"].includes(request.method())) {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort();
      } else await route.continue();
    });
    await guard.run(async () => {
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      for (const width of [1280, 390] as const) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "load" });
        await page.getByRole("button", { name: /الحساب/ }).first().click();
        const region = page.getByRole("region", { name: "الدفعات" });
        const marker = region.locator(`[data-receipt-provenance="${original.id}"]`);
        await marker.waitFor();
        expect(await marker.getAttribute("data-reversal-state")).toBe("full");
        expect(await marker.getAttribute("data-correction-mode")).toBe("correct");
        expect(await marker.innerText()).toContain("عُكس بالكامل");
        expect(await marker.innerText()).not.toContain(privateReason);
        for (const linked of [reversal, replacement]) {
          expect(await marker.locator(`a[href="/print/receipt/${linked.id}"]`).innerText()).toContain(linked.receiptNumber);
        }
        const originalRow = region.locator("li").filter({ has: marker });
        expect(await originalRow.locator("p.text-sm").first().innerText()).toContain("50,000");
        expect(await region.locator(`[data-receipt-provenance="${replacement.id}"]`).getAttribute("data-replacement-of")).toBe(String(original.id));
        expect(await region.locator(`[data-receipt-provenance="${reversal.id}"]`).getAttribute("data-correction-reversal")).toBe("correct");
        expect(await region.locator(`[data-receipt-provenance="${ordinaryRefund.id}"]`).getAttribute("data-correction-reversal")).toBe("");
        await settled(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        evidence.push({ filename: `receipt-provenance-patient-${width}.png`, mime: "image/png",
          bytes: await region.screenshot({ path: `${artifacts}/receipt-provenance-patient-${width}.png` }) });

        await page.goto(`${baseUrl}/finance`, { waitUntil: "load" });
        await page.getByPlaceholder("بحث باسم المريض أو رقم السند…").fill(patientName);
        const cashOriginal = page.locator(`[data-receipt-provenance="${original.id}"]`);
        await cashOriginal.waitFor();
        expect(await cashOriginal.getAttribute("data-reversal-state")).toBe("full");
        const reversalCard = page.locator("div.rounded-2xl").filter({ has: page.locator(`[data-receipt-provenance="${reversal.id}"]`) }).last();
        expect(await reversalCard.innerText()).toContain("قيد عكس لتصحيح سند");
        expect(await reversalCard.innerText()).not.toContain("استرداد");
        await settled(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await cashOriginal.scrollIntoViewIfNeeded();
        evidence.push({ filename: `receipt-provenance-cash-${width}.png`, mime: "image/png",
          bytes: await page.screenshot({ path: `${artifacts}/receipt-provenance-cash-${width}.png` }) });
      }

      await page.setViewportSize({ width: 1280, height: 1000 });
      for (const spec of [
        { scene: "original", payment: original, title: "سند قبض", references: [reversal, replacement] },
        { scene: "reversal", payment: reversal, title: "قيد عكس لتصحيح سند", references: [original] },
        { scene: "replacement", payment: replacement, title: "سند قبض", references: [original] },
        { scene: "void", payment: voidReversal, title: "قيد إبطال سند", references: [voidOriginal] },
      ] as const) {
        generated.current = undefined;
        await page.emulateMedia({ media: "screen" });
        const response = await page.goto(`${baseUrl}/print/receipt/${spec.payment.id}`, { waitUntil: "load" });
        expect(response?.status()).toBe(200);
        await settled(page);
        const sheet = page.locator(".sheet-a6");
        const provenance = sheet.locator(`[data-receipt-provenance="${spec.payment.id}"]`);
        expect(await sheet.locator(".doc-title").innerText()).toBe(spec.title);
        expect(await sheet.locator("time").getAttribute("datetime")).toBe(spec.payment.createdAt);
        if (spec.scene === "original") expect(await sheet.locator("time").innerText()).toContain("03/03/2000");
        expect(await sheet.locator(".amount-box").innerText()).toContain(spec.payment.amountMinor.toLocaleString("en-US"));
        if (spec.payment.kind === "refund") {
          expect(await sheet.innerText()).toContain("المريض");
          expect(await sheet.innerText()).not.toContain("صُرف إلى");
        }
        expect(await provenance.innerText()).not.toContain(privateReason);
        for (const reference of spec.references) {
          expect(await provenance.locator(`a[href="/print/receipt/${reference.id}"]`).innerText()).toContain(reference.receiptNumber);
        }
        const header = await sheet.locator("header").innerText();
        const signature = await sheet.locator(".sign-row").innerText();
        const content = await sheet.innerText();
        if (spec.scene === "original" || spec.scene === "reversal") {
          evidence.push({ filename: `receipt-provenance-${spec.scene}-screen.png`, mime: "image/png",
            bytes: await page.screenshot({ path: `${artifacts}/receipt-provenance-${spec.scene}-screen.png`, fullPage: true }) });
        }
        await page.emulateMedia({ media: "print" });
        await settled(page);
        expect(await sheet.innerText()).toBe(content);
        expect(await page.getByRole("button", { name: "اطبع", exact: true }).isVisible()).toBe(false);
        const path = `${artifacts}/receipt-provenance-${spec.scene}.pdf`;
        const bytes = await page.pdf({ path, format: "A6", displayHeaderFooter: false, printBackground: true, preferCSSPageSize: false });
        generated.current = { scene: spec.scene, bytes };
        const text = plain(execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8" }));
        const [paper] = await pdfPages(page, path);
        expect(text).toContain(spec.payment.receiptNumber);
        expect(text).toContain(patientName);
        expect(text).toContain(spec.payment.amountMinor.toLocaleString("en-US"));
        for (const reference of spec.references) expect(text).toContain(reference.receiptNumber);
        for (const word of spec.title.split(" ")) expect(paper.words.some(actual => matchesPrintPdfWord(actual.text, word))).toBe(true);
        assertPrintPdfHeader(paper, header);
        assertPrintPdfSignature(paper, signature);
        if (spec.scene === "original") {
          assertOriginalPdf(paper, text);
          const saved = await provenance.getAttribute("style");
          try {
            await provenance.evaluate(element => (element as HTMLElement).style.setProperty("visibility", "hidden", "important"));
            const negative = `${artifacts}/receipt-provenance-hidden-control.pdf`;
            await page.pdf({ path: negative, format: "A6", displayHeaderFooter: false, printBackground: true });
            const [negativePage] = await pdfPages(page, negative);
            const negativeText = plain(execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", negative, "-"], { encoding: "utf8" }));
            expect(() => assertOriginalPdf(negativePage, negativeText)).toThrow(/PDF/);
            expect(negativeText).toContain(original.receiptNumber);
            expect(negativeText).toContain("50,000");
            assertPrintPdfHeader(negativePage, header);
            assertPrintPdfSignature(negativePage, signature);
          } finally {
            await provenance.evaluate((element, style) => style === null ? element.removeAttribute("style") : element.setAttribute("style", style), saved);
          }
        }
        evidence.push({ filename: `receipt-provenance-${spec.scene}.pdf`, mime: "application/pdf", bytes });
        generated.current = undefined;
      }
      // A structurally linked ordinary refund stays neutral even with a correction-looking note.
      await page.emulateMedia({ media: "screen" });
      await page.goto(`${baseUrl}/print/receipt/${ordinaryRefund.id}`, { waitUntil: "load" });
      expect(await page.locator(".doc-title").innerText()).toBe("سند عكس مرتبط");
      expect(await page.locator(".sheet-a6").innerText()).not.toContain("صُرف إلى");
      expect(await page.locator(`[data-receipt-provenance="${ordinaryRefund.id}"]`).getAttribute("data-correction-reversal")).toBe("");
    }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); }).catch(error => {
      if (generated.current) emitReceiptProvenanceFailedPdf(generated.current.scene, generated.current.bytes);
      throw error;
    });
    expect(await snapshot()).toEqual(before);
    emitReceiptProvenanceEvidence(evidence);
  }, 240_000);
});
