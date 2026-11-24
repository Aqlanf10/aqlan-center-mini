import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedGet, baseUrl, harness, type Session } from "./_server";
import { fictionalPrintBrand as brand, installFictionalPrintBrand } from "./_positive-print-branding";
import { friendlyDateLong } from "../../lib/reminders";

/** Real built Next routes and persisted synthetic rows: no page imports, reader
 * mocks, intercepted API responses or substituted HTML. Only static logo
 * images are substituted to keep the generated evidence fictional. */
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let restoreBrand: (() => Promise<void>) | undefined;
let patientId: number, appointmentId: number, prescriptionId: number;
let invoiceId: number, expenseId: number, visitId: number, shiftId: number;
const marker = `SYN-PRINT-${Date.now()}`;
const output = ".settings-ui-artifacts/positive-print-routes";
const drug = "SyntheticStoredMedicine";
// The standalone server has a 5s process-local Settings cache (lib/db.ts).
const settingsCacheCooldownMs = 5_200;
const fixtureLogo = '<svg xmlns="http://www.w3.org/2000/svg" width="97" height="82" viewBox="0 0 97 82"><rect x="18" y="11" width="61" height="60" rx="12" fill="#405875"/><path d="M34 42h29M48 28v28" stroke="#fff" stroke-width="6"/></svg>';
const productLogoPaths = new Set(["/logo.png", "/logo-white.png"]);

async function createSyntheticPrintContext(session: Session): Promise<{ context: BrowserContext; unexpected: string[] }> {
  const context = await browser.newContext({ locale: "ar-YE", viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
  const [cookieName, ...cookieValue] = session.cookie.split("=");
  await context.addCookies([{ name: cookieName, value: cookieValue.join("="), url: baseUrl }]);
  const unexpected: string[] = [];
  await context.route("**/*", async route => {
    const { origin, pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (origin !== baseUrl || (method !== "GET" && method !== "HEAD")) {
      unexpected.push(method + " " + pathname);
      return route.abort();
    }
    if (productLogoPaths.has(pathname)) {
      return route.fulfill({ contentType: "image/svg+xml", body: fixtureLogo });
    }
    return route.continue();
  });
  return { context, unexpected };
}

async function expectFictionalPrintIdentity(page: Page, expandedHeader = false) {
  // Run before writing any screenshot/PDF. A settings fallback should fail
  // without capturing a real name, phone number, or logo in an artifact.
  const header = page.locator(".print-brand-header");
  const footer = page.locator(".print-contact-footer");
  expect((await header.locator(".clinic-name").innerText()).trim() === brand["clinic.name"], "fictional clinic name").toBe(true);
  const lead = `${brand["clinic.lead_doctor"]} — ${brand["clinic.lead_doctor_title"]}`;
  expect((await header.locator(".clinic-sub").allInnerTexts()).join(" | ").trim() ===
    (expandedHeader ? `${lead} | ${brand["clinic.lead_doctor_credentials"]}` : lead), "fictional clinic lead identity").toBe(true);
  expect((await footer.innerText()).includes(brand["clinic.address"]), "fictional clinic address").toBe(true);
  expect((await footer.locator("span[dir='ltr']").innerText()).trim() === brand["clinic.phone"], "fictional clinic phone").toBe(true);
  for (const image of [header.locator("img.print-logo"), page.locator("img.print-document-watermark-image")]) {
    expect(await image.evaluate(img => img instanceof HTMLImageElement && img.complete
      && img.naturalWidth === 97 && img.naturalHeight === 82), "fictional logo image loaded").toBe(true);
  }
}

const variedRx = {
  "short-ar": { lang: "ar", count: 1 },
  "short-en": { lang: "en", count: 1 },
  "long-ar": { lang: "ar", count: 20 },
  "long-en": { lang: "en", count: 20 },
} as const;
type RxVariant = keyof typeof variedRx;
const rxVariantIds = new Map<RxVariant, number>();
const rxPatientName = "SYNTHETIC PATIENT LONG PRINT IDENTITY MARKER END";
const rxFile = "SYNTHETIC-RX-GEOMETRY-FILE";
const unknownDoctor = "اسم الطبيب غير موثق في الوصفة المحفوظة";
const seedAccountName = "SYNTHETIC-ISSUER-ACCOUNT-NOT-TREATING-DOCTOR";
const arInstruction = "تمرين بصري اصطناعي بلا إرشاد علاجي";
const enInstruction = "Fictional print layout text only, not for treatment.";
let rxAcceptancePatientId: number;

function fictionalItems(variant: RxVariant) {
  const { count } = variedRx[variant];
  return Array.from({ length: count }, (_, index) => {
    const n = String(index + 1).padStart(2, "0");
    return {
      name: `SYNMED${n}`, dose: `SYNDOSE${n}`, form: `SYNFORM${n}`,
      frequency: `SYNFREQ${n}`, duration: `SYNDURATION${n}`,
      instructions: `${Array(count === 20 ? 4 : 1).fill(arInstruction).join(" ")} ARONLY${n}`,
      instructionsEn: `${Array(count === 20 ? 4 : 1).fill(enInstruction).join(" ")} ENONLY${n}`,
    };
  });
}

type PaperFormat = "A4" | "A5" | "A6";
const paperSizeMm: Record<PaperFormat, readonly [number, number]> = {
  A4: [210, 297], A5: [148, 210], A6: [105, 148],
};
type PdfPaper = { width: number; height: number; words: Array<{
  text: string; xMin: number; xMax: number; yMin: number; yMax: number;
}> };

async function pdfGeometry(page: Page, pdf: Buffer): Promise<PdfPaper[]> {
  const xml = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", "-", "-"], { input: pdf, encoding: "utf8" });
  return page.evaluate(raw => {
    const doc = new DOMParser().parseFromString(raw, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("Invalid print PDF bbox XML");
    const metric = (node: Element, key: string) => {
      const value = node.getAttribute(key);
      return value === null || value.trim() === "" ? Number.NaN : Number(value);
    };
    return Array.from(doc.getElementsByTagName("page")).map(paper => ({
      width: metric(paper, "width"), height: metric(paper, "height"),
      words: Array.from(paper.getElementsByTagName("word")).map(word => ({
        text: word.textContent ?? "",
        xMin: metric(word, "xMin"), xMax: metric(word, "xMax"),
        yMin: metric(word, "yMin"), yMax: metric(word, "yMax"),
      })),
    }));
  }, xml);
}

async function expectRxHeadingOnPhysicalSides(page: Page) {
  const row = page.locator(".rx-dosage-heading");
  const mark = row.getByText("℞", { exact: true });
  const heading = row.locator(":scope > [dir='rtl']");
  expect(await heading.evaluate(node => getComputedStyle(node).direction)).toBe("rtl");
  expect(await heading.evaluate(node => getComputedStyle(node).textAlign)).toBe("right");
  const rowBox = (await row.boundingBox())!;
  const markBox = (await mark.boundingBox())!;
  const titleBox = (await heading.boundingBox())!;
  expect(Math.abs(markBox.x - rowBox.x)).toBeLessThan(1);
  expect(markBox.x + markBox.width).toBeLessThan(titleBox.x);
  expect(Math.abs(titleBox.x + titleBox.width - (rowBox.x + rowBox.width))).toBeLessThan(1);
}

function expectRxHeadingPdfOrder(papers: PdfPaper[]) {
  const firstPage = papers[0];
  expect(firstPage).toBeDefined();
  const mark = firstPage.words.find(word => word.text === "℞");
  const heading = firstPage.words.find(word => word.text === "Prescription");
  expect(mark, "the printed Rx symbol is present on the first PDF page").toBeDefined();
  expect(heading, "the printed dosage heading is present on the first PDF page").toBeDefined();
  expect(mark!.xMax).toBeLessThan(heading!.xMin);
  expect(mark!.yMin).toBeLessThan(heading!.yMax);
  expect(mark!.yMax).toBeGreaterThan(heading!.yMin);
}

function expectPaperBounds(papers: PdfPaper[], format: PaperFormat) {
  const [width, height] = paperSizeMm[format];
  expect(papers.length).toBeGreaterThan(0);
  for (const paper of papers) {
    expect(Math.abs(paper.width - width * 72 / 25.4)).toBeLessThan(1);
    expect(Math.abs(paper.height - height * 72 / 25.4)).toBeLessThan(1);
    expect(paper.words.length).toBeGreaterThan(0);
    for (const { xMin, xMax, yMin, yMax } of paper.words) {
      expect([xMin, xMax, yMin, yMax].every(Number.isFinite)).toBe(true);
      expect(xMin).toBeGreaterThanOrEqual(0); expect(yMin).toBeGreaterThanOrEqual(0);
      expect(xMax).toBeGreaterThanOrEqual(xMin); expect(yMax).toBeGreaterThanOrEqual(yMin);
      expect(xMax).toBeLessThanOrEqual(paper.width); expect(yMax).toBeLessThanOrEqual(paper.height);
    }
  }
}

const textWithoutBidiControls = (value: string) => value.normalize("NFKC").replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "");
const compact = (value: string) => textWithoutBidiControls(value).replace(/\s+/gu, "");
const singleSpaced = (value: string) => textWithoutBidiControls(value).replace(/\s+/gu, " ").trim();

function pdfHasCompletePatientIdentity(pageText: string) {
  // Raw PDF content order keeps the separately wrapped name and file fields
  // intact. Spatial `-layout` intentionally reads the opposite RTL grid
  // column between the two rows of the name.
  return singleSpaced(pageText).includes(rxPatientName) && compact(pageText).includes(rxFile);
}

function containsLocalizedWords(value: string, phrase: string) {
  const body = compact(value);
  const words = phrase.normalize("NFKC").split(/\s+/u).map(compact).filter(Boolean);
  // Poppler may give an Arabic word in visual rather than logical order.
  return words.length > 0 && words.every(word =>
    body.includes(word) || (/\p{Script=Arabic}/u.test(word) && body.includes([...word].reverse().join(""))));
}

function expectFictionalPdfIdentity(text: string, expandedHeader = false) {
  for (const part of [brand["clinic.name"], brand["clinic.lead_doctor"], brand["clinic.lead_doctor_title"],
    brand["clinic.address"], brand["clinic.phone"], ...(expandedHeader ? [brand["clinic.lead_doctor_credentials"]] : [])]) {
    expect(containsLocalizedWords(text, part), `generated PDF contains fictional identity: ${part}`).toBe(true);
  }
}

function itemTokens(item: ReturnType<typeof fictionalItems>[number], lang: "ar" | "en") {
  return [item.name, item.dose, item.form, item.frequency, item.duration, (lang === "ar" ? item.instructions : item.instructionsEn).split(" ").at(-1)!];
}

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
  rxAcceptancePatientId = (await db.query(
    "INSERT INTO patients(patient_number, full_name, primary_doctor_id) VALUES($1,$2,$3) RETURNING id",
    [rxFile, rxPatientName, doctorId],
  )).rows[0].id;
  for (const variant of Object.keys(variedRx) as RxVariant[]) {
    const saved = await db.query(`INSERT INTO prescriptions
      (patient_id,diagnosis,notes,instructions_lang,items,created_by,doctor_party_id,created_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,'2031-01-04T22:30:00Z') RETURNING id`, [
      rxAcceptancePatientId, `SYN-DIAGNOSIS-${variant}`, `SYN-FINAL-NOTES-${variant}`,
      variedRx[variant].lang, JSON.stringify(fictionalItems(variant)), seedAccountName, doctorId,
    ]);
    rxVariantIds.set(variant, saved.rows[0].id);
  }
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
  restoreBrand = await installFictionalPrintBrand(db);
  await delay(settingsCacheCooldownMs);
}, 240_000);
// Financial rows are append-only (including expenses_no_delete). Retain only
// these marked, future-dated rows until the owned harness drops its entire
// ephemeral database. Never disable a trigger or attempt per-row financial deletion.
afterAll(async () => {
  try { await browser?.close(); } finally {
    try {
      if (restoreBrand) {
        await restoreBrand();
        await delay(settingsCacheCooldownMs);
      }
    } finally { await db?.end(); }
  }
});

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
    const { context, unexpected } = await createSyntheticPrintContext(h.sessions.admin);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      const response = await page.goto(`${baseUrl}${fixture.path}`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      expect(response?.status()).toBe(200);
      await expectFictionalPrintIdentity(page, name === "invoice");
      expect(unexpected).toEqual([]);
      const format = name === "invoice" ? "A4" : ["card", "patient-card", "voucher"].includes(name) ? "A6" : "A5";
      const pdf = await page.pdf({ ...(name === "patient-card" ? {} : { format }), printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false });
      const pdfText = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], { input: pdf, encoding: "utf8" });
      expectFictionalPdfIdentity(pdfText, name === "invoice");
      // Persist diagnostics only after DOM, logo and PDF identity checks.
      await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
      await writeFile(`${output}/${name}.pdf`, pdf);
      const papers = await pdfGeometry(page, pdf);
      const text = await page.locator("body").innerText();
      await writeFile(`${output}/${name}.json`, JSON.stringify({ path: fixture.path, status: response?.status(), marker, format, papers, errors, text, pdfText }, null, 2));
      expectPaperBounds(papers, format);
      const compactPdf = pdfText.replace(/[\s\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
      expect(compactPdf).toContain(marker);
      if (name === "prescription") {
        expect(compactPdf).toContain(drug);
        await expectRxHeadingOnPhysicalSides(page);
        expectRxHeadingPdfOrder(papers);
      }
      if (name === "post-op") {
        const phone = brand["clinic.phone"];
        const nativeText = pdfText.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
        expect(nativeText.split(phone)).toHaveLength(3); // emergency line and footer
        expect(nativeText).not.toContain(phone.split("-").reverse().join("-"));
        expect(await page.locator("bdi[dir='ltr']").innerText()).toBe(phone);
      }
      if (name === "patient-card") {
        // A short native A6 card must keep its contact footer with the patient
        // and appointment, not silently overflow into a footer-only sheet.
        expect(papers).toHaveLength(1);
        expect(compactPdf).toContain("04/01/2031");
        expect(compactPdf).toContain("9:30");
        expect(compactPdf).toContain(brand["clinic.phone"]);
        expect(await page.locator(".print-metadata").count()).toBe(0);
      }
      expect(text).toContain(fixture.title);
      expect(text).toContain(marker);
      expect(text).toContain(fixture.extra);
      expect(text).not.toMatch(/Application error|server error occurred|This page couldn.t load/);
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  it.each(Object.keys(variedRx) as RxVariant[])("prints persisted %s Rx on operator-selected generated paper", async variant => {
    const { lang, count } = variedRx[variant];
    const savedId = rxVariantIds.get(variant)!;
    const exactPath = `/print/prescription/${rxAcceptancePatientId}?rx=${savedId}`;
    const { context, unexpected } = await createSyntheticPrintContext(h.sessions.doctorA);
    const errors: string[] = [];
    try {
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      const response = await page.goto(baseUrl + exactPath, { waitUntil: "load" });
      expect(response?.status()).toBe(200);
      await page.evaluate(() => document.fonts.ready);
      await expectFictionalPrintIdentity(page);
      expect(unexpected).toEqual([]);
      const sheet = page.locator(".sheet-a5");
      const sign = (await sheet.locator(".sign-row").innerText()).trim();
      const body = await sheet.innerText();
      const metadata = sheet.locator(".print-metadata");
      const items = fictionalItems(variant);
      const finalItemTokens = itemTokens(items.at(-1)!, lang);
      const allItemTokens = items.flatMap(item => itemTokens(item, lang));
      expect(await sheet.evaluate(element => getComputedStyle(element).direction)).toBe("rtl");
      await expectRxHeadingOnPhysicalSides(page);
      expect(await metadata.getByText(rxPatientName, { exact: true }).count()).toBe(1);
      expect(await metadata.getByText(rxFile, { exact: true }).count()).toBe(1);
      expect(body).toContain(friendlyDateLong("2031-01-05"));
      expect(body).not.toContain(friendlyDateLong("2031-01-04"));
      expect(sign).toContain(unknownDoctor);
      expect(sign).not.toContain(seedAccountName);
      expect(body).not.toContain("UNAPPROVED DRAFT");
      for (const item of items) {
        const shown = lang === "ar" ? item.instructions : item.instructionsEn;
        const hidden = lang === "ar" ? item.instructionsEn : item.instructions;
        const direction = lang === "ar" ? "rtl" : "ltr";
        const line = sheet.locator(`div[dir="${direction}"]`).filter({ hasText: shown }).last();
        expect(await line.innerText()).toContain(shown);
        expect(await line.evaluate(element => getComputedStyle(element).direction)).toBe(direction);
        expect(body).not.toContain(hidden);
      }

      const formats: readonly PaperFormat[] = variant === "short-en" ? ["A5", "A4", "A6"] : variant === "short-ar" ? ["A5", "A6"] : ["A5"];
      for (const format of formats) {
        const basename = `rx-persisted-${variant}-${format.toLowerCase()}`;
        const pdf = await page.pdf({ format, preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
        const text = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], { input: pdf, encoding: "utf8" });
        expectFictionalPdfIdentity(text);
        const papers = await pdfGeometry(page, pdf);
        const rawPages = execFileSync("pdftotext", ["-raw", "-enc", "UTF-8", "-", "-"], { input: pdf, encoding: "utf8" }).split("\f");
        if (rawPages.at(-1)?.trim() === "") rawPages.pop();
        expect(rawPages).toHaveLength(papers.length);
        const actual = compact(text);
        const pageTexts = papers.map(paper => paper.words.map(word => word.text).join(" "));
        const lastPage = compact(pageTexts.at(-1) ?? "");
        const historicalA5Parity = {
          applies: format === "A5" && count === 20,
          brandingByPage: pageTexts.map(paper => containsLocalizedWords(paper, brand["clinic.name"])),
          patientAndFileByPage: rawPages.map(pdfHasCompletePatientIdentity),
          rxNumberByPage: pageTexts.map(paper => compact(paper).includes(`Rx#${savedId}`)),
          documentedDoctorAvailable: !sign.includes(unknownDoctor),
          lastPageHasCompleteFinalItem: finalItemTokens.every(token => lastPage.includes(token)),
          lastPageHasSignature: ["Physician", "Signature", "Stamp"].every(word => lastPage.includes(word)),
        };
        // Keep parity observations explicit but separate from current Stage
        // acceptance: this patch does not import the historical repeat header
        // or its final-item/signature pagination controls.
        await writeFile(`${output}/${basename}.pdf`, pdf);
        await writeFile(`${output}/${basename}.json`, JSON.stringify({
          syntheticOnly: true, variant, format, pageCount: papers.length,
          pageGeometry: papers.map(paper => ({ width: paper.width, height: paper.height, words: paper.words.length })),
          historicalA5Parity,
        }, null, 2));

        expectPaperBounds(papers, format);
        expectRxHeadingPdfOrder(papers);
        if (count === 20) expect(papers.length).toBeGreaterThan(1);
        else if (format === "A5" || format === "A4") expect(papers).toHaveLength(1);
        for (const token of allItemTokens) expect(actual, `${variant} ${format}: ${token}`).toContain(token);
        expect(pdfHasCompletePatientIdentity(rawPages[0]), `${variant} ${format}: complete name and file on first page`).toBe(true);
        for (const token of ["Physician", "Signature", "Stamp",
          `SYN-DIAGNOSIS-${variant}`, `SYN-FINAL-NOTES-${variant}`]) expect(actual).toContain(token);
        expect(containsLocalizedWords(text, unknownDoctor)).toBe(true);
        expect(actual).not.toContain(seedAccountName);
        expect(actual).not.toContain(lang === "ar" ? "ENONLY" : "ARONLY");
        if (lang === "ar") {
          // Poppler may decode the printed lam-alef glyph as alef-lam. Accept
          // only that exact alternate within the complete, known sentence.
          const printOrder = arInstruction.replaceAll("لا", "ال");
          expect([arInstruction, printOrder].some(phrase => actual.includes(compact(phrase)))).toBe(true);
        } else expect(actual).toContain(compact(enInstruction));
      }
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  it("retains saved-prescription ownership and missing-record refusals", async () => {
    for (const path of [`/print/prescription/${patientId}`, `/print/prescription/${h.seeded.patientBId}?rx=${prescriptionId}`]) {
      expect((await authedGet(path, h.sessions.admin)).status).toBe(404);
    }
    expect((await authedGet(`/print/prescription/${patientId}?rx=${prescriptionId}`, h.sessions.reception)).status).toBe(404);
    const wrongClinician = await authedGet(`/print/prescription/${rxAcceptancePatientId}?rx=${rxVariantIds.get("short-ar")}`, h.sessions.doctorB);
    expect(wrongClinician.status).toBe(404);
    expect(await wrongClinician.text()).not.toContain("SYNMED01");
    const mixedPatients = await authedGet(`/print/prescription/${patientId}?rx=${rxVariantIds.get("short-ar")}`, h.sessions.admin);
    expect(mixedPatients.status).toBe(404);
    expect(await mixedPatients.text()).not.toContain("SYNMED01");
  });

  it("refuses legacy draft print queries without rendering clinical fields or logging a print", async () => {
    const root = `/print/prescription/${patientId}`;
    const privateDraft = "SYNTHETIC-UNSAVED-RX-ONLY / نص اصطناعي";
    const encodedDraft = encodeURIComponent(privateDraft);
    const encodedItems = encodeURIComponent(JSON.stringify([{ name: privateDraft }]));
    const transports: Array<{ suffix: string; headers: Record<string, string>; type: string }> = [
      { suffix: "", headers: {}, type: "text/html" },
      { suffix: "&_rsc=", headers: { RSC: "1" }, type: "text/x-component" },
    ];
    const printCount = async () => (await db.query(
      "SELECT count(*)::int AS n FROM document_prints WHERE doc_type='prescription' AND doc_id=$1", [String(prescriptionId)],
    )).rows[0].n;
    const before = await printCount();
    for (const staff of [h.sessions.admin, h.sessions.doctorA]) {
      for (const { suffix, headers, type } of transports) {
        const saved = await authedGet(`${root}?rx=${prescriptionId}${suffix}`, staff, headers);
        expect(saved.status).toBe(200);
        expect(saved.headers.get("content-type")).toContain(type);
        expect(await saved.text()).toContain(drug);
        for (const search of [
          `draft=1&items=${encodedItems}`,
          `rx=${prescriptionId}&draft=`,
          `rx=${prescriptionId}&items=${encodedItems}`,
          `rx=${prescriptionId}&diagnosis=${encodedDraft}`,
          `rx=${prescriptionId}&notes=&notes=${encodedDraft}`,
        ]) {
          const response = await authedGet(`${root}?${search}${suffix}`, staff, headers);
          expect(response.status).toBe(404);
          const text = await response.text();
          expect(text).not.toContain(drug);
          expect(text).not.toContain(privateDraft);
          expect(text).not.toContain(encodedDraft);
          expect(text).not.toContain(encodedItems);
          expect(text.length).toBe(0);
          expect(response.headers.get("location")).toBeNull();
          expect(response.headers.get("referrer-policy")).toBe("no-referrer");
          expect(response.headers.get("cache-control")).toContain("no-store");
          const outputHeaders = JSON.stringify([...response.headers]);
          expect(outputHeaders).not.toContain(privateDraft);
          expect(outputHeaders).not.toContain(encodedDraft);
          expect(outputHeaders).not.toContain(encodedItems);
        }
      }
      const duplicate = await authedGet(`${root}?rx=${prescriptionId}&rx=${prescriptionId}`, staff);
      expect(duplicate.status).toBe(404);
      expect(await duplicate.text()).not.toContain(drug);
    }
    expect(await printCount()).toBe(before);
  });
});
