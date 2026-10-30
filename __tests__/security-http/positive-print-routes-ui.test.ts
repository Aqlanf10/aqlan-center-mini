import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedGet, baseUrl, harness } from "./_server";

/** Real built Next routes and persisted synthetic rows: no page imports, reader
 * mocks, intercepted API responses or substituted HTML. Never run against Stage. */
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let patientId: number, appointmentId: number, prescriptionId: number;
let invoiceId: number, expenseId: number, visitId: number, shiftId: number;
const marker = `SYN-PRINT-${Date.now()}`;
const output = ".settings-ui-artifacts/positive-print-routes";
const drug = "SyntheticStoredMedicine";

beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  const database = new URL(h.seeded.dbUrl);
  expect(database.hostname).toBe("127.0.0.1");
  expect(database.pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const doctorId = (await db.query("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
  patientId = (await db.query(`INSERT INTO patients (patient_number,full_name,primary_doctor_id,created_at)
    VALUES ($1,$2,$3,'2031-01-04T09:00:00Z') RETURNING id`, [marker, marker, doctorId])).rows[0].id;
  appointmentId = (await db.query(`INSERT INTO appointments (patient_id,doctor_id,scheduled_date,scheduled_time,duration_minutes,status)
    VALUES ($1,$2,'2031-01-04','09:30',30,'booked') RETURNING id`, [patientId, doctorId])).rows[0].id;
  visitId = (await db.query(`INSERT INTO visits (patient_id,patient_name,doctor_id,status,note,arrived_at,finished_at)
    VALUES ($1,$2,$3,'done',$2,'2031-01-04T09:00:00Z','2031-01-04T09:30:00Z') RETURNING id`, [patientId, marker, doctorId])).rows[0].id;
  prescriptionId = (await db.query(`INSERT INTO prescriptions
    (patient_id,visit_id,diagnosis,notes,instructions_lang,items,created_by,doctor_party_id,created_at)
    VALUES ($1,$2,$3,$3,'both',$4::jsonb,'secdoctora',$5,'2031-01-04T09:00:00Z') RETURNING id`,
  [patientId, visitId, marker, JSON.stringify([{ name: drug, dose: "fixture dose", instructions: "تعليمات اصطناعية", instructionsEn: "Synthetic instructions" }]), doctorId])).rows[0].id;
  invoiceId = (await db.query(`INSERT INTO invoices
    (invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by,created_at)
    VALUES ($1,$2,5000,0,'YER','synthetic-positive-print','2031-01-04T09:00:00Z') RETURNING id`, [marker, patientId])).rows[0].id;
  await db.query(`INSERT INTO invoice_items (invoice_id,description,quantity,unit_price_minor,total_minor)
    VALUES ($1,$2,1,5000,5000)`, [invoiceId, marker]);
  shiftId = (await db.query(`INSERT INTO cashier_shifts (opened_by,opening_yer,opening_sar,opening_usd,status,opened_at,closed_at)
    VALUES ('synthetic-positive-print',0,0,0,'closed','2031-01-04T08:00:00Z','2031-01-04T10:00:00Z') RETURNING id`)).rows[0].id;
  expenseId = (await db.query(`INSERT INTO expenses
    (voucher_number,category,payee_text,shift_id,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,note,created_by,created_at)
    VALUES ($1,'materials',$1,$2,5000,'YER',1,5000,'YER',$1,'synthetic-positive-print','2031-01-04T09:00:00Z') RETURNING id`, [marker, shiftId])).rows[0].id;
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
// Financial rows are append-only (including expenses_no_delete). Retain only
// these marked, future-dated rows until the owned harness drops its entire
// ephemeral database. Never disable a trigger or attempt per-row financial deletion.
afterAll(async () => { try { await browser?.close(); } finally { await db?.end(); } });

const fixtures = {
  prescription: () => ({ path: `/print/prescription/${patientId}?rx=${prescriptionId}`, title: "وصفة طبية (روشتة)", extra: drug }),
  card: () => ({ path: `/print/card/${appointmentId}`, title: "بطاقة موعد", extra: marker }),
  "patient-card": () => ({ path: `/print/patient-card/${patientId}`, title: "بطاقة المريض", extra: marker }),
  "post-op": () => ({ path: `/print/post-op/${patientId}`, title: "إرشادات وتعليمات العناية ما بعد المعالجة السنية", extra: marker }),
  invoice: () => ({ path: `/print/invoice/${invoiceId}`, title: "فاتورة", extra: marker }),
  voucher: () => ({ path: `/print/voucher/${expenseId}`, title: "سند صرف", extra: marker }),
  walkout: () => ({ path: `/print/walkout/${visitId}`, title: "ملخّص الزيارة", extra: "لا توجد إجراءات مسجلة" }),
};

describe("positive persisted print routes on the built app", () => {
  it.each(Object.keys(fixtures) as (keyof typeof fixtures)[])("renders %s through its real authenticated route", async (name) => {
    const fixture = fixtures[name]();
    const context = await browser.newContext({ locale: "ar-YE", viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
    const [cookieName, ...cookieValue] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name: cookieName, value: cookieValue.join("="), url: baseUrl }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      const response = await page.goto(`${baseUrl}${fixture.path}`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      // Persist diagnostic evidence BEFORE any content/status assertion, including failures.
      await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
      const format = name === "invoice" ? "A4" : ["card", "patient-card", "voucher"].includes(name) ? "A6" : "A5";
      const pdfPath = `${output}/${name}.pdf`;
      await page.pdf({ path: pdfPath, format, printBackground: true, preferCSSPageSize: true });
      const pdfText = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], { encoding: "utf8" });
      const xml = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", pdfPath, "-"], { encoding: "utf8" });
      const papers = await page.evaluate(raw => {
        const doc = new DOMParser().parseFromString(raw, "application/xml");
        if (doc.querySelector("parsererror")) throw new Error("Invalid print PDF bbox XML");
        return Array.from(doc.getElementsByTagName("page")).map(paper => ({
          width: Number(paper.getAttribute("width")), height: Number(paper.getAttribute("height")),
          words: Array.from(paper.getElementsByTagName("word")).map(word => ({
            xMin: Number(word.getAttribute("xMin")), xMax: Number(word.getAttribute("xMax")),
            yMin: Number(word.getAttribute("yMin")), yMax: Number(word.getAttribute("yMax")),
          })),
        }));
      }, xml);
      const text = await page.locator("body").innerText();
      await writeFile(`${output}/${name}.json`, JSON.stringify({ path: fixture.path, status: response?.status(), marker, format, papers, errors, text, pdfText }, null, 2));
      expect(response?.status()).toBe(200);
      expect(papers.length).toBeGreaterThan(0);
      const [width, height] = format === "A4" ? [210, 297] : format === "A5" ? [148, 210] : [105, 148];
      for (const paper of papers) {
        expect(Math.abs(paper.width - width * 72 / 25.4)).toBeLessThan(1);
        expect(Math.abs(paper.height - height * 72 / 25.4)).toBeLessThan(1);
        expect(paper.words.length).toBeGreaterThan(0);
        for (const word of paper.words) {
          expect(Object.values(word).every(Number.isFinite)).toBe(true);
          expect(word.xMin).toBeGreaterThanOrEqual(0); expect(word.yMin).toBeGreaterThanOrEqual(0);
          expect(word.xMax).toBeLessThanOrEqual(paper.width); expect(word.yMax).toBeLessThanOrEqual(paper.height);
        }
      }
      const compactPdf = pdfText.replace(/[\s\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
      expect(compactPdf).toContain(marker);
      if (name === "prescription") expect(compactPdf).toContain(drug);
      if (name === "post-op") {
        const phone = (await page.locator(".print-contact-footer span[dir='ltr']").innerText()).trim();
        expect(phone).toBe("04-253028"); // Seeded clinic fixture, not production settings.
        const nativeText = pdfText.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
        expect(nativeText.split(phone)).toHaveLength(3); // emergency line and footer
        expect(nativeText).not.toContain("253028-04");
        expect(await page.locator("bdi[dir='ltr']").innerText()).toBe(phone);
      }
      if (name === "patient-card") {
        // A short native A6 card must keep its contact footer with the patient
        // and appointment, not silently overflow into a footer-only sheet.
        expect(papers).toHaveLength(1);
        expect(compactPdf).toContain("04/01/2031");
        expect(compactPdf).toContain("9:30");
        const footerPhone = await page.locator(".print-contact-footer span[dir='ltr']").innerText();
        expect(footerPhone.trim().length).toBeGreaterThan(0);
        expect(compactPdf).toContain(footerPhone.trim());
        expect(await page.locator(".print-metadata").count()).toBe(0);
      }
      expect(text).toContain(fixture.title);
      expect(text).toContain(marker);
      expect(text).toContain(fixture.extra);
      expect(text).not.toMatch(/Application error|server error occurred|This page couldn.t load/);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  it("retains saved-prescription ownership and missing-record refusals", async () => {
    for (const path of [`/print/prescription/${patientId}`, `/print/prescription/${h.seeded.patientBId}?rx=${prescriptionId}`]) {
      expect((await authedGet(path, h.sessions.admin)).status).toBe(404);
    }
    expect((await authedGet(`/print/prescription/${patientId}?rx=${prescriptionId}`, h.sessions.reception)).status).toBe(404);
  });
});
