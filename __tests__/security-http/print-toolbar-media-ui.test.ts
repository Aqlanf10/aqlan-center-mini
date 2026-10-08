import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { assertPrintPdfHeader, assertPrintPdfWatermark, type PrintPdfPage } from "../helpers/print-pdf-glyphs";
import { authedGet, baseUrl, harness } from "./_server";
import { emitPrintToolbarEvidence, emitPrintToolbarFailedPdf, type PrintToolbarEvidenceMember } from "./_print-toolbar-evidence";

// Real built routes/CSS and Chromium PDFs, using only new isolated-harness
// fixtures. Never open the WhatsApp link, call window.print, or post print-log.
// displayHeaderFooter:false isolates app content; CSS cannot change the user's
// browser-owned Headers and Footers preference.
let h: Awaited<ReturnType<typeof harness>>;
let browser: Browser;
let db: Client;
let invoiceId = 0;
let receiptId = 0;
let expectedClinicName = "";
const stamp = Date.now();
const patientName = "SYNTHETIC-PRINT-PATIENT";
const invoiceNumber = `SYN-PRINT-INV-${stamp}`;
const receiptNumber = `SYN-PRINT-RCP-${stamp}`;
const artifacts = ".settings-ui-artifacts";
// Avoid current report days, P01's 2001-01-17 and commission's February 2023.
// The receipt exactly settles the invoice net, so no synthetic debtor enters top-N lists.
const fixtureTimestamp = "2000-02-02T10:00:00.000Z";

beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, phone, created_at)
     VALUES ($1, $2, '967000000000', $3) RETURNING id`,
    [`SYN-PRINT-P-${stamp}`, patientName, fixtureTimestamp]);
  const { rows: [invoice] } = await db.query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, note, created_by, created_at)
     VALUES ($1, $2, 12500, 1500, 'YER', 'SYNTHETIC-INVOICE-NOTE', 'synthetic-print', $3) RETURNING id`,
    [invoiceNumber, patient.id, fixtureTimestamp]);
  invoiceId = invoice.id;
  await db.query(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
    VALUES ($1, 'SYNTHETIC-SERVICE', 1, 12500, 12500)`, [invoiceId]);
  // A dedicated closed fixture avoids disturbing the harness's one-open-shift constraint.
  const { rows: [shift] } = await db.query<{ id: number }>(
    `INSERT INTO cashier_shifts (opened_by, status, closed_by, opened_at, closed_at)
     VALUES ('synthetic-print', 'closed', 'synthetic-print', $1, $1) RETURNING id`, [fixtureTimestamp]);
  const { rows: [receipt] } = await db.query<{ id: number }>(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor,
                           currency, exchange_rate, base_amount_minor, base_currency, method, note, created_by, created_at)
     VALUES ($1, $2, $3, $4, 'payment', 11000, 'YER', 1, 11000, 'YER', 'cash',
             'SYNTHETIC-RECEIPT-NOTE', 'SYNTHETIC-SIGNER', $5) RETURNING id`,
    [receiptNumber, patient.id, invoiceId, shift.id, fixtureTimestamp]);
  receiptId = receipt.id;
  // Exercise the existing server-selected watermark without invoking print logging.
  await db.query(`INSERT INTO document_prints (doc_type, doc_id, printed_by, printed_at)
    VALUES ('invoice', $1, 'synthetic-print', $2)`, [String(invoiceId), fixtureTimestamp]);
  const settings = await authedGet("/api/settings", h.sessions.admin);
  expect(settings.status).toBe(200);
  expectedClinicName = (await settings.json())["clinic.name"];
  expect(typeof expectedClinicName).toBe("string");
  expect(expectedClinicName.trim().length).toBeGreaterThan(3);
  await mkdir(artifacts, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);

afterAll(async () => { try { await browser?.close(); } finally { await db?.end(); } });

const plain = (text: string) => text.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
const compact = (text: string) => plain(text).replace(/\s+/g, "");

function assertPdfWords(text: string, expected: string, label: string) {
  for (const word of expected.split(/\s+/).filter(word => /\p{L}/u.test(word))) {
    const direct = compact(word), reversed = [...direct].reverse().join("");
    expect(compact(text).includes(direct) || compact(text).includes(reversed), `${label}: ${word}`).toBe(true);
  }
}

function pdfText(path: string) {
  return plain(execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], {
    encoding: "utf8", maxBuffer: 5 * 1024 * 1024,
  }));
}

async function pdfGeometry(page: Page, path: string): Promise<PrintPdfPage[]> {
  const xml = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", path, "-"], {
    encoding: "utf8", maxBuffer: 5 * 1024 * 1024,
  });
  const pages = await page.evaluate(raw => {
    const document = new DOMParser().parseFromString(raw, "application/xml");
    if (document.querySelector("parsererror")) throw new Error("Invalid print PDF bbox XML");
    return Array.from(document.getElementsByTagName("page")).map(node => ({
      width: Number(node.getAttribute("width")), height: Number(node.getAttribute("height")),
      words: Array.from(node.getElementsByTagName("word")).map(word => ({
        text: word.textContent ?? "", xMin: Number(word.getAttribute("xMin")), xMax: Number(word.getAttribute("xMax")),
        yMin: Number(word.getAttribute("yMin")), yMax: Number(word.getAttribute("yMax")),
      })),
    }));
  }, xml);
  expect(pages.length).toBeGreaterThan(0);
  for (const paper of pages) {
    expect(paper.width).toBeGreaterThan(0); expect(paper.height).toBeGreaterThan(0);
    for (const word of paper.words) {
      expect([word.xMin, word.xMax, word.yMin, word.yMax].every(Number.isFinite)).toBe(true);
      expect(word.xMin).toBeGreaterThanOrEqual(0); expect(word.yMin).toBeGreaterThanOrEqual(0);
      expect(word.xMax).toBeLessThanOrEqual(paper.width); expect(word.yMax).toBeLessThanOrEqual(paper.height);
    }
  }
  return pages;
}

async function assertPdfLogoInk(page: Page, path: string) {
  const png = execFileSync("pdftoppm", ["-f", "1", "-l", "1", "-r", "96", "-png", "-singlefile", path], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const ink = await page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const paint = canvas.getContext("2d")!; paint.drawImage(image, 0, 0);
    // Existing 8mm page margin, 11mm centered logo; 3px antialiasing tolerance.
    // Colored ink distinguishes the actual blue/gold logo from black header text.
    const pxPerMm = 96 / 25.4;
    const x = Math.floor(image.width / 2 - 11 * pxPerMm / 2 - 3);
    const y = Math.floor(8 * pxPerMm - 3);
    const width = Math.ceil(11 * pxPerMm + 6), height = Math.ceil(11 * pxPerMm + 6);
    const pixels = paint.getImageData(x, y, width, height).data;
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const low = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
      const high = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
      if (high - low > 35 && low < 210) colored++;
    }
    return colored;
  }, `data:image/png;base64,${png.toString("base64")}`);
  expect(ink, "PDF logo ink in the actual centered 11mm raster region").toBeGreaterThan(20);
}

function assertNoWhatsAppAnnotation(path: string) {
  const urls = execFileSync("pdfinfo", ["-url", path], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  expect(urls, "WhatsApp toolbar must not survive as a link annotation in the actual PDF").not.toContain("wa.me/");
}

async function financialSnapshot() {
  return (await db.query(`SELECT
    (SELECT to_jsonb(i) FROM invoices i WHERE id=$1) AS invoice,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoice_items i WHERE invoice_id=$1) AS items,
    (SELECT to_jsonb(p) FROM payments p WHERE id=$2) AS receipt,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM document_prints p
      WHERE (doc_type='invoice' AND doc_id=$1::text) OR (doc_type='receipt' AND doc_id=$2::text)) AS prints`,
  [invoiceId, receiptId])).rows[0];
}

async function settlePaint(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

describe("print toolbar containment on real built financial documents", () => {
  it("keeps invoice actions on screen, removes them from paper, and preserves invoice and A6 receipt content", async () => {
    const before = await financialSnapshot();
    expect(before.invoice).toMatchObject({ total_minor: 12500, discount_minor: 1500, status: "open" });
    expect(before.receipt).toMatchObject({ amount_minor: 11000, base_amount_minor: 11000, currency: "YER" });
    expect(before.invoice.total_minor - before.invoice.discount_minor).toBe(before.receipt.base_amount_minor);
    const evidence: PrintToolbarEvidenceMember[] = [];
    const generatedPdf: { current?: { kind: "invoice" | "receipt"; bytes: Buffer } } = {};
    const context = await browser.newContext({ viewport: { width: 1280, height: 1200 }, locale: "ar-YE" });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const unexpected: string[] = [];
    const errors: string[] = [];
    const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== baseUrl || !["GET", "HEAD"].includes(request.method())) {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
        await route.abort();
      } else {
        await route.continue();
      }
    });
    try {
      await guard.run(async () => {
        const page = await context.newPage();
        page.on("pageerror", error => errors.push(error.message));
        for (const spec of [
          { kind: "invoice", id: invoiceId, paper: "A4", widthMm: 210, title: "فاتورة", number: invoiceNumber, reprint: true },
          { kind: "receipt", id: receiptId, paper: "A6", widthMm: 105, title: "سند قبض", number: receiptNumber, reprint: false },
        ] as const) {
          generatedPdf.current = undefined;
          await page.emulateMedia({ media: "screen" });
          const response = await page.goto(`${baseUrl}/print/${spec.kind}/${spec.id}`, { waitUntil: "load" });
          expect(response?.status()).toBe(200);
          await settlePaint(page);
          const sheet = page.locator(`.sheet-${spec.paper.toLowerCase()}`);
          const actions = page.locator(".print-root .print-actions");
          const toolbar = page.locator(".print-root > .no-print");
          const whatsApp = page.getByRole("link", { name: /إرسال الفاتورة عبر واتساب/ });
          expect(await page.evaluate(() => matchMedia("screen").matches)).toBe(true);
          expect(await actions.isVisible()).toBe(true);
          expect(await page.getByRole("button", { name: "اطبع", exact: true }).isVisible()).toBe(true);
          const screenWidth = await sheet.evaluate(element => element.getBoundingClientRect().width);
          expect(Math.abs(screenWidth - spec.widthMm * 96 / 25.4)).toBeLessThan(0.2);
          if (spec.kind === "invoice") {
            expect(await toolbar.evaluate(element => (element as HTMLElement).style.display)).toBe("flex");
            expect(await toolbar.isVisible()).toBe(true);
            expect(await whatsApp.isVisible()).toBe(true);
            expect(await whatsApp.getAttribute("href")).toMatch(/^https:\/\/wa\.me\/967000000000\?/);
          } else {
            expect(await toolbar.count()).toBe(0);
            expect(await whatsApp.count()).toBe(0);
          }
          const screenContent = await sheet.innerText();
          const screenHeader = await sheet.locator("header").innerText();
          expect(await sheet.locator(".clinic-name").innerText()).toBe(expectedClinicName);
          expect(await sheet.locator(".doc-title").innerText()).toBe(spec.title);
          for (const text of [patientName, spec.number]) expect(screenContent).toContain(text);
          const screenFilename = `print-toolbar-${spec.kind}-screen.png`;
          evidence.push({ filename: screenFilename, mime: "image/png",
            bytes: await page.screenshot({ path: `${artifacts}/${screenFilename}`, fullPage: true }) });

          await page.emulateMedia({ media: "print" });
          await settlePaint(page);
          expect(await page.evaluate(() => matchMedia("print").matches)).toBe(true);
          expect(await page.evaluate(() => matchMedia("screen").matches)).toBe(false);
          expect(await actions.isVisible()).toBe(false);
          if (spec.kind === "invoice") {
            expect(await toolbar.evaluate(element => getComputedStyle(element).display)).toBe("none");
            expect(await toolbar.boundingBox()).toBeNull();
            expect(await whatsApp.isVisible()).toBe(false);
          }
          expect(await sheet.innerText()).toBe(screenContent);
          expect(await sheet.locator("header").innerText()).toBe(screenHeader);
          for (const selector of ["header", ".print-logo", ".clinic-name", ".doc-title", ".sign-row", ".footer-note"]) {
            expect(await sheet.locator(selector).first().isVisible(), `${spec.kind} ${selector} remains visible in print`).toBe(true);
          }
          expect(await page.locator(".reprint-mark").isVisible()).toBe(spec.reprint);
          const printFilename = `print-toolbar-${spec.kind}-print.png`;
          evidence.push({ filename: printFilename, mime: "image/png",
            bytes: await page.screenshot({ path: `${artifacts}/${printFilename}`, fullPage: true }) });
          const path = `${artifacts}/print-toolbar-${spec.kind}.pdf`;
          const pdf = await page.pdf({ path, format: spec.paper, printBackground: true,
            displayHeaderFooter: false, preferCSSPageSize: false });
          generatedPdf.current = { kind: spec.kind, bytes: pdf };
          expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
          evidence.push({ filename: `print-toolbar-${spec.kind}.pdf`, mime: "application/pdf", bytes: pdf });
          const text = pdfText(path);
          for (const expected of [patientName, spec.number]) expect(text).toContain(expected);
          const [paper] = await pdfGeometry(page, path);
          // Calibrated against the retained failed PDF's actual bbox glyphs and
          // pixels: ordered header-region words preserve lam-alef glyph pairs.
          assertPrintPdfHeader(paper, screenHeader);
          await assertPdfLogoInk(page, path);
          assertPdfWords(text, await sheet.locator(".sign-row").innerText(), "PDF signature word");
          assertPrintPdfWatermark(paper, spec.reprint);
          assertNoWhatsAppAnnotation(path);
          if (spec.kind === "invoice") {
            for (const expected of ["SYNTHETIC-SERVICE", "SYNTHETIC-INVOICE-NOTE", "E-INVOICE", "VERIFIED", "12,500", "1,500", "11,000"]) {
              expect(text).toContain(expected);
            }
            // Independent actual-PDF controls: losing the header/logo must
            // fail their oracles while the watermark still passes, and vice versa.
            for (const region of ["header", "watermark"] as const) {
              const target = region === "header" ? sheet.locator("header") : page.locator(".reprint-mark");
              const savedStyle = await target.getAttribute("style");
              try {
                await target.evaluate(element => (element as HTMLElement).style.setProperty("visibility", "hidden", "important"));
                const negative = `${artifacts}/print-toolbar-${region}-hidden.pdf`;
                await page.pdf({ path: negative, format: "A4", printBackground: true, displayHeaderFooter: false });
                const [negativePaper] = await pdfGeometry(page, negative);
                if (region === "header") {
                  expect(() => assertPrintPdfHeader(negativePaper, screenHeader)).toThrow(/PDF header/);
                  await expect(assertPdfLogoInk(page, negative)).rejects.toThrow(/PDF logo ink/);
                  assertPrintPdfWatermark(negativePaper, true);
                } else {
                  expect(() => assertPrintPdfWatermark(negativePaper, true)).toThrow(/PDF watermark/);
                  assertPrintPdfHeader(negativePaper, screenHeader);
                  await assertPdfLogoInk(page, negative);
                }
              } finally {
                await target.evaluate((element, style) => {
                  if (style === null) element.removeAttribute("style"); else element.setAttribute("style", style);
                }, savedStyle);
              }
            }
            // A genuine negative PDF witness: restoring the inline flex toolbar
            // must make the same PDF oracle refuse the WhatsApp annotation.
            const originalStyle = await toolbar.getAttribute("style");
            try {
              await toolbar.evaluate(element => (element as HTMLElement).style.setProperty("display", "flex", "important"));
              expect(await whatsApp.isVisible()).toBe(true);
              const negativePath = `${artifacts}/print-toolbar-negative-control.pdf`;
              await page.pdf({ path: negativePath, format: "A4", printBackground: true, displayHeaderFooter: false });
              expect(() => assertNoWhatsAppAnnotation(negativePath)).toThrow(/WhatsApp toolbar/);
            } finally {
              await toolbar.evaluate((element, style) => {
                if (style === null) element.removeAttribute("style"); else element.setAttribute("style", style);
              }, originalStyle);
            }
            expect(await whatsApp.isVisible()).toBe(false);
          } else {
            for (const expected of ["SYNTHETIC-RECEIPT-NOTE", "SYNTHETIC-SIGNER", "11,000"]) expect(text).toContain(expected);
          }
          await page.emulateMedia({ media: "screen" });
          await settlePaint(page);
          expect(await actions.isVisible()).toBe(true);
          expect(await sheet.innerText()).toBe(screenContent);
          if (spec.kind === "invoice") expect(await whatsApp.isVisible()).toBe(true);
        }
      }, () => {
        expect(unexpected, "no external requests or app mutations, including print-log").toEqual([]);
        expect(errors).toEqual([]);
      });
      expect(await financialSnapshot()).toEqual(before);
      // Publish only the six positive in-memory outputs after every content,
      // media, negative-control, no-write, teardown and exact-row assertion.
      emitPrintToolbarEvidence(evidence);
    } catch (error) {
      // The exact generated synthetic PDF is needed to distinguish missing
      // pixels from Poppler's Arabic glyph/ligature extraction. Keep the failing
      // assertion and original error; failure diagnostics cannot count as a pass.
      const diagnostic = generatedPdf.current;
      if (diagnostic) {
        try { emitPrintToolbarFailedPdf(diagnostic.kind, diagnostic.bytes); }
        catch (diagnosticError) { throw new AggregateError([error, diagnosticError], "Print acceptance failed; diagnostic transport also rejected"); }
      }
      throw error;
    }
  }, 120_000);
});
