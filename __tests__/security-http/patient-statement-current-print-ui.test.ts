import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { formatAmount, formatMoney } from "../../lib/money";
import { authedMutation, baseUrl, confirmingSimilarCollection, harness } from "./_server";

// Required built-app acceptance, using only the disposable security harness DB.
// No route interception, live patient data, alternate browser launcher or local skip.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let patientId = 0;
let treatmentInvoiceId = 0;
let wideInvoiceId = 0;
const stamp = Date.now();
const patientNumber = `CUR-STMT-${stamp}`;
const treatmentNumber = `CUR-TREAT-${stamp}`;
const paidNumber = `CUR-PAID-${stamp}`;
const wideNumber = `CUR-WIDE-${stamp}`;
const cancelledNumber = `CUR-CANCELLED-${stamp}`;
const markers = Array.from({ length: 40 }, (_, index) => `TREATMENT-LINE-${String(index + 1).padStart(2, "0")}`);
const wideMinor = 8_000_000_000_000_000; // Safe integer: stresses wrapping, not a realistic clinic charge.
const directory = ".settings-ui-artifacts/patient-statement-current";
const pdfPath = `${directory}/statement-a4.pdf`;
const plain = (text: string) => text.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");

async function snapshot() {
  const rows = await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM invoices i WHERE i.patient_id=$1) AS invoices,
    (SELECT jsonb_agg(to_jsonb(ii) ORDER BY ii.id) FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.patient_id=$1) AS items,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM payments p WHERE p.patient_id=$1) AS payments`, [patientId]);
  return rows.rows[0];
}

beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  patientId = (await db.query<{ id: number }>(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'مريض كشف حالي اصطناعي للطباعة') RETURNING id`, [patientNumber])).rows[0].id;
  const shiftId = (await db.query<{ id: number }>(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd, status)
    VALUES ('synthetic-current-statement', 0, 0, 0, 'closed') RETURNING id`)).rows[0].id;
  const ids: number[] = [];
  for (const [number, currency, gross, discount, status] of [
    [cancelledNumber, "SAR", 400000, 0, "cancelled"],
    [treatmentNumber, "SAR", 400000, 5000, "open"],
    [paidNumber, "SAR", 20000, 0, "paid"],
    [wideNumber, "YER", wideMinor, 0, "open"],
  ] as const) {
    const id = (await db.query<{ id: number }>(`INSERT INTO invoices
      (invoice_number, patient_id, total_minor, discount_minor, base_currency, status, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,'synthetic-current-statement') RETURNING id`,
    [number, patientId, gross, discount, currency, status])).rows[0].id;
    ids.push(id);
  }
  treatmentInvoiceId = ids[1]; wideInvoiceId = ids[3];
  for (const marker of markers) {
    await db.query(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
      VALUES ($1,$2,2,5000,10000)`, [treatmentInvoiceId,
      `${marker} علاج عصب وترميم الأسنان مع متابعة مراحل العلاج والتأكد من راحة المريض. ${"وصف علاجي عربي طويل محفوظ في الفاتورة، وليس من أسعار الدليل الحالية. ".repeat(4)}`]);
  }
  for (const [id, description, amount] of [[ids[0], "CANCELLED-TREATMENT-MUST-NOT-PRINT", 400000],
    [ids[2], "PAID-TREATMENT", 20000], [ids[3], "WIDE-MONEY-TREATMENT", wideMinor]] as const) {
    await db.query(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
      VALUES ($1,$2,1,$3,$3)`, [id, description, amount]);
  }
  let originalReceiptId = 0;
  for (const [index, invoiceId, amount, kind] of [[0, ids[0], 100000, "payment"],
    [1, ids[0], 20000, "refund"], [2, ids[2], 20000, "payment"]] as const) {
    const receiptId = (await db.query<{ id: number }>(`INSERT INTO payments
      (receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by,reversal_of_id)
      VALUES ($1,$2,$3,$4,$5,$6,'SAR',425,$7,'YER','cash','synthetic-current-statement',$8) RETURNING id`,
    [`CUR-RECEIPT-${stamp}-${index}`, patientId, invoiceId, shiftId, kind, amount, amount / 100 * 425,
      kind === "refund" ? originalReceiptId : null])).rows[0].id;
    if (index === 0) originalReceiptId = receiptId;
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { try { await browser?.close(); } finally { await db?.end(); } });

describe("current patient statement built-app A4 acceptance", () => {
  it("prints stored treatments and discounts across pages without cancelled invoices or balance changes", async () => {
    const before = await snapshot();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
    try {
      const [name, ...value] = h.sessions.admin.cookie.split("=");
      await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
      const page = await context.newPage();
      const errors: string[] = [], writes: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => { if (!["GET", "HEAD"].includes(request.method())) writes.push(request.method()); });
      const response = await page.goto(`${baseUrl}/print/statement/${patientId}`);
      expect(response?.status()).toBe(200);
      const sheet = page.locator(".statement-sheet"); await sheet.waitFor();
      await page.evaluate(async () => { await document.fonts.ready; });
      expect(await sheet.getAttribute("dir")).toBe("rtl");
      expect(await sheet.locator(".statement-invoice").count()).toBe(3);
      const text = await sheet.innerText();
      for (const marker of [...markers, paidNumber, wideNumber, patientNumber]) expect(text).toContain(marker);
      for (const omitted of [cancelledNumber, "CANCELLED-TREATMENT-MUST-NOT-PRINT"]) expect(text).not.toContain(omitted);
      const treatment = sheet.locator(`[data-invoice-id="${treatmentInvoiceId}"]`);
      for (const [label, amount] of [["الإجمالي قبل الخصم",400000], ["الخصم المسجل",5000], ["صافي الفاتورة بعد الخصم",395000]] as const) {
        expect(await treatment.locator("tr").filter({ hasText: label }).innerText()).toContain(formatMoney(amount, "SAR"));
      }
      for (const [label, amount] of [["إجمالي المفوتر",415000], ["صافي المحصّل بعد الاستردادات وعكس السندات",100000], ["الرصيد الحالي",315000]] as const) {
        expect((await sheet.locator(".line").filter({ hasText: label }).allTextContents()).join(" ")).toContain(formatMoney(amount,"SAR"));
      }
      for (let index=0; index<3; index++) expect(text).toContain(`CUR-RECEIPT-${stamp}-${index}`);
      expect(text).toContain(`عكس سند CUR-RECEIPT-${stamp}-0`);
      expect(text).toContain(formatMoney(wideMinor, "YER"));
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: `${directory}/screen.png`, fullPage: true });
      await page.emulateMedia({ media: "print" });
      // A4 is 210 mm with the production print.css 8 mm margins: inspect the
      // same 194 mm content width, not the roomier desktop screen viewport.
      await page.setViewportSize({ width: Math.floor(194*96/25.4), height: Math.floor(281*96/25.4) });
      const wideRowHeight = await sheet.locator(`[data-invoice-id="${wideInvoiceId}"] tbody tr`).first()
        .evaluate(row=>row.getBoundingClientRect().height);
      const wideCells = await sheet.locator(`[data-invoice-id="${wideInvoiceId}"] tbody tr`).first().locator("td").evaluateAll(cells=>{
        const table=cells[0].closest("table")!.getBoundingClientRect();
        return cells.map(cell=>{const box=cell.getBoundingClientRect();return {left:(box.left-table.left)/table.width,right:(box.right-table.left)/table.width};});
      });
      const layout = await sheet.locator(".statement-invoice td.num").evaluateAll(cells => cells.map(cell => {
        const box=cell.getBoundingClientRect(), range=document.createRange(); range.selectNodeContents(cell);
        return { text: cell.textContent, whiteSpace:getComputedStyle(cell).whiteSpace, x:box.x, right:box.right,
          clientWidth:cell.clientWidth, scrollWidth:cell.scrollWidth,
          fragments:Array.from(range.getClientRects()).map(rect => ({ x:rect.x, right:rect.right, y:rect.y, bottom:rect.bottom })) };
      }));
      await writeFile(`${directory}/layout.json`, JSON.stringify({ printableWidthMm:194, wideCells, wideRowHeight, cells:layout },null,2));
      for (const cell of layout) {
        expect(cell.whiteSpace).toBe("normal"); expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth+1);
        for (const fragment of cell.fragments) {
          expect(fragment.x).toBeGreaterThanOrEqual(cell.x-1); expect(fragment.right).toBeLessThanOrEqual(cell.right+1);
        }
      }
      expect(await sheet.locator(`[data-invoice-id="${wideInvoiceId}"] thead`).evaluate(node => getComputedStyle(node).display)).toBe("table-header-group");
      await page.screenshot({ path: `${directory}/print.png`, fullPage:true });
      const pdf=await page.pdf({ path:pdfPath,format:"A4",printBackground:true,displayHeaderFooter:false,preferCSSPageSize:false });
      expect(pdf.subarray(0,5).toString("ascii")).toBe("%PDF-");
      const pdfText=plain(execFileSync("pdftotext",["-layout","-enc","UTF-8",pdfPath,"-"],{encoding:"utf8",maxBuffer:5*1024*1024}));
      const pages=pdfText.split("\f").filter(text=>text.trim());
      expect(pages.length).toBeGreaterThanOrEqual(3);
      expect(pages.filter(text=>markers.some(marker=>text.includes(marker))).length).toBeGreaterThanOrEqual(2);
      for (const marker of markers) expect(pdfText.match(new RegExp(`\\b${marker}\\b`,"g"))??[]).toHaveLength(1);
      for (const pageText of pages.filter(text=>markers.some(marker=>text.includes(marker)))) expect(pageText).toContain(treatmentNumber);
      for (const omitted of [cancelledNumber,"CANCELLED-TREATMENT-MUST-NOT-PRINT"]) expect(pdfText).not.toContain(omitted);
      for (const amount of [5000,395000,415000,100000,315000]) expect(pdfText).toContain(formatAmount(amount,"SAR"));
      expect(pdfText).toContain(paidNumber); expect(pdfText).toContain(wideNumber);
      const xml=execFileSync("pdftotext",["-bbox-layout","-enc","UTF-8",pdfPath,"-"],{encoding:"utf8",maxBuffer:5*1024*1024});
      const geometry=await page.evaluate(raw=>{
        const doc=new DOMParser().parseFromString(raw,"application/xml");
        if(doc.querySelector("parsererror")) throw new Error("Invalid PDF geometry XML");
        return Array.from(doc.getElementsByTagName("page")).map(p=>({width:Number(p.getAttribute("width")),height:Number(p.getAttribute("height")),
          words:Array.from(p.getElementsByTagName("word")).map(w=>({text:w.textContent,xMin:Number(w.getAttribute("xMin")),xMax:Number(w.getAttribute("xMax")),yMin:Number(w.getAttribute("yMin")),yMax:Number(w.getAttribute("yMax"))}))}));
      },xml);
      await writeFile(`${directory}/pdf-layout.json`,JSON.stringify(geometry,null,2));
      expect(geometry).toHaveLength(pages.length);
      expect(geometry.some(paper=>paper.words.some(word=>word.text?.includes("WIDE-MONEY-TREATMENT")))).toBe(true);
      for(const [index,paper] of geometry.entries()) {
        // Assert actual PDF number geometry against its native column, not just
        // page bounds: long amounts must not paint into an adjacent column.
        const wideMarker=paper.words.find(word=>word.text?.includes("WIDE-MONEY-TREATMENT"));
        if(wideMarker) {
          const rowCenter=(wideMarker.yMin+wideMarker.yMax)/2, rowHalfHeight=wideRowHeight*72/96/2;
          const numericWords=paper.words.filter(word=>/^[0-9][0-9,.]*$/.test(word.text??"")
            && word.yMin>=rowCenter-rowHalfHeight-2 && word.yMax<=rowCenter+rowHalfHeight+2);
          expect(numericWords.length).toBeGreaterThanOrEqual(3);
          const margin=8*72/25.4,content=paper.width-2*margin;
          for(const word of numericWords) expect(wideCells.slice(1).some(cell=>
            word.xMin>=margin+cell.left*content-1 && word.xMax<=margin+cell.right*content+1),
          `PDF monetary fragment remains in its column: ${word.text}`).toBe(true);
        }
        expect(paper.words.length).toBeGreaterThan(0);
        for(const word of paper.words) {
          expect(word.xMin).toBeGreaterThanOrEqual(0); expect(word.yMin).toBeGreaterThanOrEqual(0);
          expect(word.xMax).toBeLessThanOrEqual(paper.width); expect(word.yMax).toBeLessThanOrEqual(paper.height);
        }
        const png=execFileSync("pdftoppm",["-f",String(index+1),"-l",String(index+1),"-r","96","-png","-singlefile",pdfPath],{maxBuffer:10*1024*1024});
        await writeFile(`${directory}/page-${String(index+1).padStart(2,"0")}.png`,png);
        expect(png.subarray(0,8).toString("hex")).toBe("89504e470d0a1a0a");
        const raster = await context.newPage();
        try {
          await raster.setContent("<html><body></body></html>");
          const ink = await raster.evaluate(async ({source,boxes}) => {
            const image=new Image(); image.src=source; await image.decode();
            const canvas=document.createElement("canvas"); canvas.width=image.width; canvas.height=image.height;
            const paint=canvas.getContext("2d")!; paint.drawImage(image,0,0);
            const count=(x:number,y:number,width:number,height:number)=>{
              const pixels=paint.getImageData(x,y,width,height).data; let dark=0;
              for(let at=0;at<pixels.length;at+=4) if(pixels[at]+pixels[at+1]+pixels[at+2]<540) dark++;
              return dark;
            };
            return { page:count(0,0,image.width,image.height), markers:boxes.map(box=>count(
              Math.floor(box.xMin*96/72),Math.floor(box.yMin*96/72),
              Math.max(1,Math.ceil((box.xMax-box.xMin)*96/72)),Math.max(1,Math.ceil((box.yMax-box.yMin)*96/72)))) };
          },{source:`data:image/png;base64,${png.toString("base64")}`,boxes:paper.words.filter(word=>word.text?.includes("TREATMENT-LINE-"))});
          expect(ink.page,`visible print on PDF page ${index+1}`).toBeGreaterThan(100);
          for(const count of ink.markers) expect(count,"treatment marker must visibly paint, not only extract").toBeGreaterThan(10);
        } finally { await raster.close(); }
      }
      // Check the actual paginated PDF, after saving every page for diagnosis.
      // The old output put only the contact footer on page 8; visible ink alone
      // did not catch it. Keep the footer AND the final financial balance.
      const contactPhone = (await sheet.locator(".statement-closing span[dir='ltr']").innerText()).trim();
      expect(contactPhone).not.toBe("");
      const lastPage = pages[pages.length - 1];
      expect(lastPage, "last PDF page retains the contact footer").toContain(contactPhone);
      expect(lastPage, "contact footer must share its page with the final balance")
        .toContain(formatAmount(315000, "SAR"));
      expect(errors).toEqual([]); expect(writes).toEqual([]);
      expect(await snapshot()).toEqual(before);
    } finally { await context.close(); }
  });
});

/**
 * Current statement with an active fixed-total agreement: the PDF's invoice net/discount, net
 * collected and agreement paid/remaining agree with the fixture and with the app's own ledger
 * balances, by currency. Receipts are recorded through the built app's real /api/payments; after
 * one further on-account payment, the next PDF moves collected and agreement paid/remaining
 * together. The agreement remaining is never added to the billed principal or the current due.
 */
describe("current patient statement PDF with an active agreement and real on-account payments", () => {
  const agreementStamp = `${stamp}-AGR`;
  const agreementPatientNumber = `CUR-AGR-${agreementStamp}`;
  const agreementInvoiceNumber = `CUR-AGR-INV-${agreementStamp}`;
  const agreementCancelledNumber = `CUR-AGR-CANCELLED-${agreementStamp}`;
  const otherPatientInvoiceNumber = `CUR-AGR-OTHER-${agreementStamp}`;
  const agreementTitle = `AGREEMENT-FIXED-TOTAL-${agreementStamp}`;
  const agreementDirectory = `${directory}/agreement`;
  let agreementPatientId = 0, agreementInvoiceId = 0, agreementPlanId = 0, serial = 0;

  /** A real receipt through the built app, answering the advisory similar-receipt review only if asked. */
  async function collect(target: { invoiceId?: number; planId?: number }, amount: string) {
    const key = `cur-agr-${agreementStamp}-${++serial}`;
    const response = await confirmingSimilarCollection(headers => authedMutation("/api/payments", h.sessions.admin, "POST",
      JSON.stringify({ kind: "payment", patientId: agreementPatientId, ...target, amount, currency: "SAR", method: "cash" }),
      { "Idempotency-Key": key, ...headers }));
    expect(response.status, await response.clone().text()).toBe(201);
  }

  /** Prints the current statement, saves its PDF, and returns the rendered sheet lines, PDF text and app balances. */
  async function printCurrent(name: string) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
    try {
      const [cookieName, ...value] = h.sessions.admin.cookie.split("=");
      await context.addCookies([{ name: cookieName, value: value.join("="), url: baseUrl }]);
      const page = await context.newPage();
      const errors: string[] = [], writes: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => { if (!["GET", "HEAD"].includes(request.method())) writes.push(request.method()); });
      expect((await page.goto(`${baseUrl}/print/statement/${agreementPatientId}`))?.status()).toBe(200);
      const sheet = page.locator(".statement-sheet"); await sheet.waitFor();
      await page.evaluate(async () => { await document.fonts.ready; });
      const line = async (label: string) => (await sheet.locator(".line").filter({ hasText: label }).allTextContents()).map(plain).join(" | ");
      const lines = {
        gross: plain(await sheet.locator(`[data-invoice-id="${agreementInvoiceId}"] tr`).filter({ hasText: "الإجمالي قبل الخصم" }).innerText()),
        discount: plain(await sheet.locator(`[data-invoice-id="${agreementInvoiceId}"] tr`).filter({ hasText: "الخصم المسجل" }).innerText()),
        net: plain(await sheet.locator(`[data-invoice-id="${agreementInvoiceId}"] tr`).filter({ hasText: "صافي الفاتورة بعد الخصم" }).innerText()),
        billed: await line("إجمالي المفوتر"), collected: await line("صافي المحصّل بعد الاستردادات وعكس السندات"),
        due: await line("الرصيد الحالي"), total: await line("إجمالي الاتفاق"), paid: await line("المسدّد من الاتفاق"), remaining: await line("المتبقي من الاتفاق"),
      };
      const text = plain(await sheet.innerText());
      const ledger = await page.evaluate(async id => (await fetch(`/api/patients/${id}/ledger`, { cache: "no-store" })).json(), agreementPatientId) as
        { balances: Record<string, { billedMinor: number; collectedMinor: number; dueMinor: number }> };
      await page.emulateMedia({ media: "print" });
      await mkdir(agreementDirectory, { recursive: true });
      const path = `${agreementDirectory}/${name}.pdf`;
      const pdf = await page.pdf({ path, format: "A4", printBackground: true, displayHeaderFooter: false, preferCSSPageSize: false });
      expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      const pdfText = plain(execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }));
      await writeFile(`${agreementDirectory}/${name}.txt`, pdfText);
      expect(errors).toEqual([]); expect(writes).toEqual([]);
      return { lines, text, pdfText, sar: ledger.balances.SAR };
    } finally { await context.close(); }
  }

  /** pdftotext emits lam-alef ligatures as alef-hamza + lam and moves shadda; compare on a normalised key. */
  const arabicKey = (text: string) => text.replace(/[\u064B-\u0652]/g, "").replace(/ا([اأإآ])ل/g, "ال$1");
  /** The one PDF amount line holding a label (layout mode keeps a label and its amount on one line);
   * explanatory notes that merely mention the label carry no number. */
  function pdfLine(pdfText: string, label: string) {
    const matches = pdfText.split("\n").map(arabicKey).filter(row => row.includes(arabicKey(label)) && /\d/.test(row));
    expect(matches, `exactly one PDF line for ${label}`).toHaveLength(1);
    return matches[0];
  }

  /** The same view, as fixture amounts: what every printed number must be. */
  function expectStatement(printed: Awaited<ReturnType<typeof printCurrent>>, expected: { collected: number; paid: number }) {
    const remaining = 300_000 - expected.paid;
    // The app's own canonical ledger balances are the oracle for the summary lines.
    expect(printed.sar.billedMinor).toBe(48_000);
    expect(printed.sar.collectedMinor).toBe(expected.collected);
    for (const [label, amount] of [["gross", 50_000], ["discount", 2_000], ["net", 48_000], ["billed", 48_000], ["collected", expected.collected],
      ["total", 300_000], ["paid", expected.paid], ["remaining", remaining]] as const) {
      expect(printed.lines[label], label).toContain(formatMoney(amount, "SAR"));
    }
    const due = printed.sar.dueMinor;
    expect(printed.lines.due).toContain(due === 0 ? "المستحق الحالي مسدّد" : formatMoney(Math.abs(due), "SAR"));
    // The agreement remaining is shown beside, never added to, the billed principal or the current due.
    expect(printed.lines.billed).not.toContain(formatMoney(48_000 + 300_000, "SAR"));
    expect(printed.lines.billed).not.toContain(formatMoney(48_000 + remaining, "SAR"));
    expect(printed.lines.due).not.toContain(formatMoney(Math.abs(due + remaining), "SAR"));
    // The actual PDF carries the same amounts, each on its own labelled line.
    for (const [label, amount] of [["الإجمالي قبل الخصم", 50_000], ["الخصم المسجل", 2_000], ["صافي الفاتورة بعد الخصم", 48_000],
      ["إجمالي المفوتر", 48_000], ["صافي المحصّل بعد الاستردادات وعكس السندات", expected.collected],
      ["إجمالي الاتفاق", 300_000], ["المسدّد من الاتفاق", expected.paid], ["المتبقي من الاتفاق", remaining]] as const) {
      expect(pdfLine(printed.pdfText, label), `PDF line ${label}`).toContain(formatAmount(amount, "SAR"));
    }
    expect(pdfLine(printed.pdfText, "الرصيد الحالي")).toContain(due === 0 ? arabicKey("المستحق الحالي مسدّد") : formatAmount(Math.abs(due), "SAR"));
    for (const omitted of [agreementCancelledNumber, "AGREEMENT-CANCELLED-MUST-NOT-PRINT", otherPatientInvoiceNumber, "OTHER-PATIENT-MUST-NOT-PRINT"]) {
      expect(printed.text).not.toContain(omitted); expect(printed.pdfText).not.toContain(omitted);
    }
    for (const shown of [agreementInvoiceNumber, agreementTitle, "AGREEMENT-CROWN-LINE", "AGREEMENT-TEMPORARY-LINE"]) {
      expect(printed.text).toContain(shown); expect(printed.pdfText).toContain(shown);
    }
  }

  beforeAll(async () => {
    agreementPatientId = (await db.query<{ id: number }>(`INSERT INTO patients (patient_number, full_name)
      VALUES ($1, 'مريض اتفاق علاج اصطناعي للطباعة') RETURNING id`, [agreementPatientNumber])).rows[0].id;
    const otherPatientId = (await db.query<{ id: number }>(`INSERT INTO patients (patient_number, full_name)
      VALUES ($1, 'مريض آخر اصطناعي') RETURNING id`, [`CUR-AGR-OTHER-PATIENT-${agreementStamp}`])).rows[0].id;
    const invoice = async (number: string, patientId: number, gross: number, discount: number, status: string, lines: [string, number, number][]) => {
      const id = (await db.query<{ id: number }>(`INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, status, created_by)
        VALUES ($1,$2,$3,$4,'SAR',$5,'synthetic-current-agreement') RETURNING id`, [number, patientId, gross, discount, status])).rows[0].id;
      for (const [description, quantity, unit] of lines) await db.query(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
        VALUES ($1,$2,$3,$4,$5)`, [id, description, quantity, unit, quantity * unit]);
      return id;
    };
    agreementInvoiceId = await invoice(agreementInvoiceNumber, agreementPatientId, 50_000, 2_000, "open",
      [["AGREEMENT-CROWN-LINE تاج اصطناعي", 1, 30_000], ["AGREEMENT-TEMPORARY-LINE تاج مؤقت اصطناعي", 2, 10_000]]);
    await invoice(agreementCancelledNumber, agreementPatientId, 30_000, 0, "cancelled", [["AGREEMENT-CANCELLED-MUST-NOT-PRINT", 1, 30_000]]);
    await invoice(otherPatientInvoiceNumber, otherPatientId, 70_000, 0, "open", [["OTHER-PATIENT-MUST-NOT-PRINT", 1, 70_000]]);
    // An active fixed-total agreement (no installments): on-account receipts settle against it.
    agreementPlanId = (await db.query<{ id: number }>(`INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date, consent_at)
      VALUES ($1, $2, 300000, 'SAR', 'active', CURRENT_DATE, NOW()) RETURNING id`, [agreementPatientId, agreementTitle])).rows[0].id;
    // Synthetic local FX settings and an open drawer for the real receipts (kept if already present).
    await db.query("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140') ON CONFLICT(key) DO NOTHING");
    await db.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
      SELECT 'synthetic-current-agreement', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
    await collect({ invoiceId: agreementInvoiceId }, "100");
    await collect({ planId: agreementPlanId }, "1200");
  }, 240_000);

  it("prints invoice net/discount, net collected and agreement paid/remaining by currency; the next PDF moves them together", async () => {
    const first = await printCurrent("before-payment");
    expectStatement(first, { collected: 130_000, paid: 120_000 });

    await collect({ planId: agreementPlanId }, "70");
    const next = await printCurrent("after-payment");
    expectStatement(next, { collected: 137_000, paid: 127_000 });
    // The previous collected and agreement figures are gone from the summary and agreement lines.
    expect(next.lines.collected).not.toContain(formatMoney(130_000, "SAR"));
    expect(next.lines.paid).not.toContain(formatMoney(120_000, "SAR"));
    expect(next.lines.remaining).not.toContain(formatMoney(180_000, "SAR"));
    for (const stale of [130_000, 180_000]) expect(next.pdfText).not.toContain(formatAmount(stale, "SAR"));
  }, 240_000);
});

