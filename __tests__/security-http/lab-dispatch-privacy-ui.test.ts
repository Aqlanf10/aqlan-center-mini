import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { Client } from "pg";
import QRCode from "qrcode";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { matchesPrintPdfWord, type PrintPdfPage } from "../helpers/print-pdf-glyphs";
import { ageFromBirthYear, ageText } from "@/lib/patient";

// Actual built patient/lab/print routes and real clipboard/PDF output. No mocked
// app replies, external navigation, print-log calls or runtime outside isolated CI.
// All database setup below is new synthetic fixture data in aqlan_sec_http only.
let h: Awaited<ReturnType<typeof harness>>;
let browser: Browser;
let db: Client;
let patientId = 0;
const orderIds: number[] = [];
const stamp = Date.now();
const patientName = `SYNPRIVATEPATIENT${stamp}`;
const patientNumber = `SYNPRIVATEFILE${stamp}`;
const patientPhone = "777998877";
const privateDetails = `SYNPRIVATEDETAILS${stamp}`;
const privateNote = `SYNPRIVATENOTE${stamp}`;
const serviceName = `SYNTHETIC-DISPATCH-SERVICE-${stamp}`;
const labs = [`SYNTHETIC-DISPATCH-LAB-A-${stamp}`, `SYNTHETIC-DISPATCH-LAB-B-${stamp}`];
const fixtureBirthYear = 1984;
const fixtureSentDate = "2000-02-02";
const historicalAgeText = ageText(ageFromBirthYear(fixtureBirthYear, fixtureSentDate));
const directory = ".settings-ui-artifacts/lab-dispatch-privacy";
const PRIVATE = [patientName, patientNumber, patientPhone, privateDetails, privateNote,
  historicalAgeText, "أنثى", "العمر", "الجنس", "تاريخ الميلاد", "سنة الميلاد", "اسم المريض", "هاتف المريض", "رقم الملف"];
let observedDemographic = "";
let observedAgeText = "";
const FILES = ["patient-preview.png", "patient-print.png", "patient-parent-blank.pdf", "patient-dispatch.pdf",
  "lab-preview.png", "lab-print.png", "lab-parent-blank.pdf", "lab-dispatch.pdf"] as const;
type Member = { filename: (typeof FILES)[number]; bytes: Buffer };
const plain = (text: string) => text.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
const compact = (text: string) => plain(text).replace(/\s+/g, "");
function assertPrivateAbsent(text: string) {
  const result = compact(text);
  for (const canary of [...PRIVATE, observedDemographic, observedAgeText].filter(Boolean)) {
    expect(result, `External output must omit synthetic canary ${canary}`).not.toContain(compact(canary));
  }
}
async function assertNoDemographicMarkup(scope: Locator) {
  expect(await scope.locator('[name="gender"], [name="birthYear"], [name="birthDate"], [data-patient-age], [data-patient-gender], [data-patient-id], a[href^="/patients/"]').count()).toBe(0);
  assertPrivateAbsent(await scope.innerHTML());
}

beforeAll(async () => {
  expect(process.env.CI).toBe("true");
  expect(process.env.GITHUB_ACTIONS).toBe("true");
  expect(new URL(baseUrl).origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  h = await harness();
  const database = new URL(h.seeded.dbUrl);
  expect(database.pathname).toBe("/aqlan_sec_http");
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(database.hostname);
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, phone, gender, birth_year)
     VALUES ($1, $2, $3, 'female', $4) RETURNING id`, [patientNumber, patientName, patientPhone, fixtureBirthYear]);
  patientId = patient.id;
  const { rows: [service] } = await db.query<{ id: number }>(
    `INSERT INTO lab_services (name, code, category, tooth_scope, requires_shade, is_active)
     VALUES ($1, $2, 'prostho', 'multi_teeth_bridge', true, true) RETURNING id`, [serviceName, `SYN-DISPATCH-${stamp}`]);
  for (const lab of labs) {
    const { rows: [order] } = await db.query<{ id: number }>(
      `INSERT INTO lab_orders (patient_id, lab_name, lab_phone, lab_service_id, work_type,
        details, note, sent_date, due_date, status, tooth_numbers, shade, stump_shade, priority, impression_type)
       VALUES ($1, $2, '777123456', $3, $4, $5, $6, $7::date, '2000-02-05', 'sent',
        '14(Abutment), 15(Pontic), 16(Abutment)', 'A2', 'ND2', 'urgent', 'digital_scan') RETURNING id`,
      [patientId, lab, service.id, serviceName, `${privateDetails}\n`.repeat(25), privateNote, fixtureSentDate]);
    orderIds.push(order.id);
  }
  await mkdir(directory, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { try { await browser?.close(); } finally { await db?.end(); } });

async function snapshot() {
  return (await db.query(`SELECT
    (SELECT to_jsonb(p) FROM patients p WHERE id=$1) AS patient,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM lab_orders l WHERE id=ANY($2::int[])) AS orders,
    (SELECT count(*)::int FROM payables WHERE lab_order_id=ANY($2::int[])) AS payables,
    (SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments`, [patientId, orderIds])).rows[0];
}
async function paint(page: Page) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
}

async function assertPreviewActionsInViewport(overlay: Locator) {
  const controls = [
    ["copy", overlay.getByRole("button", { name: "💬 نسخ لواتساب", exact: true })],
    ["print", overlay.getByRole("link", { name: /صفحة طباعة الإرسالية/ })],
    ["close", overlay.getByRole("button", { name: "✕", exact: true })],
  ] as const;
  const facts = [];
  for (const [action, control] of controls) {
    expect(await control.count()).toBe(1);
    expect(await control.isEnabled()).toBe(true);
    const geometry = await control.evaluate(element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      return {
        left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        width: box.width, height: box.height,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
        hitTarget: hit !== null && (hit === element || element.contains(hit)),
      };
    });
    expect(geometry.width, `${action} has a real rendered box`).toBeGreaterThan(0);
    expect(geometry.height).toBeGreaterThan(0);
    expect(geometry.left, `${action} must fit wholly inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.hitTarget, `${action} must receive a native pointer action`).toBe(true);
    facts.push({ action, ...geometry });
  }
  return facts;
}

async function assertLongPreviewReachable(page: Page, overlay: Locator, sheet: Locator) {
  await paint(page);
  const initial = await assertPreviewActionsInViewport(overlay);
  const viewport = page.viewportSize()!;
  const scrolling = await overlay.evaluate(element => ({
    clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop,
  }));
  // Exercise the actual long prescription, not a shortened or mocked card.
  expect(scrolling.scrollHeight).toBeGreaterThan(scrolling.clientHeight);
  expect(scrolling.scrollTop).toBe(0);
  await page.mouse.move(viewport.width - 12, viewport.height / 2);
  await page.mouse.wheel(0, scrolling.scrollHeight);
  await expect.poll(() => overlay.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const footer = sheet.getByText("توقيع واستلام فني المعمل", { exact: true });
  await expect.poll(async () => {
    const box = await footer.boundingBox();
    return box !== null && box.y >= 0 && box.y + box.height <= viewport.height;
  }).toBe(true);
  const bottomScrollTop = await overlay.evaluate(element => element.scrollTop);
  await page.mouse.wheel(0, -scrolling.scrollHeight);
  await expect.poll(() => overlay.evaluate(element => element.scrollTop)).toBe(0);
  await paint(page);
  const returned = await assertPreviewActionsInViewport(overlay);
  return { viewport, ...scrolling, bottomScrollTop, footerVisible: true, initial, returned };
}

async function inspectPdf(page: Page, filename: string, blank: boolean) {
  const path = `${directory}/${filename}`;
  const text = plain(execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8", maxBuffer: 6 * 1024 * 1024 }));
  const info = execFileSync("pdfinfo", [path], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const metadata = execFileSync("pdfinfo", ["-meta", path], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const urls = execFileSync("pdfinfo", ["-url", path], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const xml = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8", maxBuffer: 6 * 1024 * 1024 });
  const geometry: PrintPdfPage[] = await page.evaluate(raw => {
    const document = new DOMParser().parseFromString(raw, "application/xml");
    if (document.querySelector("parsererror")) throw new Error("Invalid PDF bbox output");
    return Array.from(document.getElementsByTagName("page")).map(paper => ({
      width: Number(paper.getAttribute("width")), height: Number(paper.getAttribute("height")),
      words: Array.from(paper.getElementsByTagName("word")).map(word => ({ text: word.textContent ?? "",
        xMin: Number(word.getAttribute("xMin")), xMax: Number(word.getAttribute("xMax")),
        yMin: Number(word.getAttribute("yMin")), yMax: Number(word.getAttribute("yMax")) })),
    }));
  }, xml);
  // pdftotext processes every page, not just the first screenshot/page.
  for (const output of [text, info, metadata, urls, filename]) assertPrivateAbsent(output);
  expect(urls).not.toContain("wa.me");
  expect(urls).not.toContain("/patients/");
  const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  expect(pages).toBeGreaterThan(0);
  expect(geometry).toHaveLength(pages);
  const allWords = geometry.flatMap(paper => paper.words);
  // Poppler may emit Arabic glyphs in visual order. Use the existing calibrated
  // glyph matcher for the demographic canaries, not only logical text search.
  for (const word of ["أنثى", "العمر", "الجنس", "سنة", "سنوات"]) expect(allWords.some(actual => matchesPrintPdfWord(actual.text, word))).toBe(false);
  if (blank) { expect(text.trim()).toBe(""); expect(allWords).toEqual([]); }
  else {
    const expected = ["مراجعة", "فنية", "مطلوبة"];
    const warningVisible = geometry.some(paper => paper.words.some(anchor => {
      if (!matchesPrintPdfWord(anchor.text, expected[0])) return false;
      const row = paper.words.filter(word => Math.abs(word.yMin - anchor.yMin) <= 2
        && word.xMin >= 0 && word.xMax <= paper.width && word.yMin >= 0 && word.yMax <= paper.height)
        .sort((a, b) => b.xMin - a.xMin);
      const index = row.indexOf(anchor);
      return index >= 0 && expected.every((word, offset) => row[index + offset] && matchesPrintPdfWord(row[index + offset].text, word));
    }));
    expect(warningVisible, "Technical review warning must be visible in actual PDF glyph geometry").toBe(true);
  }
  return { text, pages };
}

async function assertActualQr(image: Locator, reference: string, width: number, color: string) {
  const payload = JSON.stringify({ rx: reference });
  // Independent expected payload, not the product projector. Browser canvas and
  // Node PNG encoders may serialize PNG bytes differently; compare every pixel.
  const expected = await QRCode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 1, width,
    color: { dark: color, light: "#ffffff" } });
  await expect.poll(() => image.count()).toBe(1);
  const result = await image.evaluate(async (element, expectedUrl) => {
    const actual = element as HTMLImageElement;
    await actual.decode();
    const expectedImage = new Image(); expectedImage.src = expectedUrl; await expectedImage.decode();
    const pixels = (source: HTMLImageElement) => {
      const canvas = document.createElement("canvas"); canvas.width = source.naturalWidth; canvas.height = source.naturalHeight;
      const context = canvas.getContext("2d")!; context.drawImage(source, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const left = pixels(actual), right = pixels(expectedImage);
    const equal = actual.naturalWidth === expectedImage.naturalWidth && actual.naturalHeight === expectedImage.naturalHeight
      && left.length === right.length && left.every((value, index) => value === right[index]);
    type Decoder = { new(options: { formats: string[] }): { detect(source: HTMLImageElement): Promise<Array<{ rawValue: string }>> }; getSupportedFormats(): Promise<string[]> };
    const NativeDecoder = (window as unknown as { BarcodeDetector?: Decoder }).BarcodeDetector;
    let decoded: string[] | null = null;
    if (NativeDecoder && (await NativeDecoder.getSupportedFormats()).includes("qr_code")) {
      decoded = (await new NativeDecoder({ formats: ["qr_code"] }).detect(actual)).map(item => item.rawValue);
    }
    return { equal, width: actual.naturalWidth, decoded };
  }, expected);
  expect(result.equal, "Actual emitted QR pixels must equal the reference-only payload").toBe(true);
  expect(result.width).toBe(width);
  if (result.decoded !== null) expect(result.decoded).toEqual([payload]);
  return { reference, pixelEquality: true, nativeDecode: result.decoded === null ? "unavailable" : "passed" };
}

function emitEvidence(members: Member[], facts: unknown) {
  expect(members.map(member => member.filename).sort()).toEqual([...FILES].sort());
  let total = 0;
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const checkoutSha = process.env.GITHUB_SHA ?? "";
  expect(runId).toMatch(/^\d{1,24}$/); expect(checkoutSha).toMatch(/^[a-f0-9]{40}$/);
  const prepared = members.map(member => {
    const pdf = member.filename.endsWith(".pdf");
    expect(member.bytes.length).toBeGreaterThan(0);
    expect(member.bytes.length).toBeLessThanOrEqual((pdf ? 2 : 1) * 1024 * 1024);
    expect(pdf ? member.bytes.subarray(0, 5).toString("ascii") : member.bytes.subarray(0, 8).toString("hex"))
      .toBe(pdf ? "%PDF-" : "89504e470d0a1a0a");
    if (pdf) expect(member.bytes.subarray(-1024).toString("ascii")).toContain("%%EOF");
    total += member.bytes.length;
    const base64 = member.bytes.toString("base64");
    return { base64, metadata: { file: member.filename, mime: pdf ? "application/pdf" : "image/png", bytes: member.bytes.length,
      sha256: createHash("sha256").update(member.bytes).digest("hex"), chunks: Math.ceil(base64.length / 4096), runId, checkoutSha, synthetic: true } };
  });
  expect(total).toBeLessThanOrEqual(10 * 1024 * 1024);
  const prefix = "SYNTHETIC_LAB_DISPATCH_PRIVACY_V1";
  const sources = ["__tests__/security-http/lab-dispatch-privacy-ui.test.ts", "lib/lab.ts", "components/LabPrescriptionModal.tsx", "app/print/lab/[id]/page.tsx"]
    .map(path => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }));
  for (const { base64, metadata } of prepared) {
    console.log(`${prefix} BEGIN ${JSON.stringify(metadata)}`);
    for (let i = 0; i < metadata.chunks; i++) console.log(`${prefix} CHUNK ${metadata.file} ${i + 1}/${metadata.chunks} ${base64.slice(i * 4096, (i + 1) * 4096)}`);
    console.log(`${prefix} END ${JSON.stringify(metadata)}`);
  }
  console.log(`${prefix} MANIFEST ${JSON.stringify({ runId, checkoutSha, synthetic: true, files: prepared.map(item => item.metadata), sources, facts })}`);
}

describe("lab dispatch privacy on actual built browser and PDF outputs", () => {
  it("both entrypoints omit patient identity, isolate print, keep only the QR reference, and preserve internal records", async () => {
    const before = await snapshot();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
    const unexpected: string[] = [], errors: string[] = [];
    const printStatuses = new Map<string, number>();
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    context.on("response", response => {
      const url = new URL(response.url());
      if (url.origin === baseUrl && /^\/print\/lab\/\d+$/.test(url.pathname) && response.request().isNavigationRequest()) {
        printStatuses.set(url.pathname, response.status());
      }
    });
    const members: Member[] = [];
    const qrFacts: Awaited<ReturnType<typeof assertActualQr>>[] = [];
    const reachabilityFacts: Array<{ entry: "patient" | "lab"; geometry: Awaited<ReturnType<typeof assertLongPreviewReachable>> }> = [];
    const pdfFacts: Array<{ filename: string; pages: number }> = [];
    const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort(); return;
      }
      await route.continue();
    });
    await guard.run(async () => {
      const page = await context.newPage();
      for (const entry of ["patient", "lab"] as const) {
        const orderIndex = entry === "patient" ? 0 : 1;
        const orderId = orderIds[orderIndex], reference = `RX-${orderId}`;
        const response = await page.goto(entry === "patient" ? `${baseUrl}/patients/${patientId}?tab=treatment&sub=lab` : `${baseUrl}/lab`, { waitUntil: "domcontentloaded" });
        expect(response?.status()).toBe(200);
        const openButton = entry === "patient"
          ? page.getByRole("region", { name: "طلبات المعمل والتركيبات", exact: true }).getByText(labs[orderIndex], { exact: true })
            .locator("xpath=ancestor::div[contains(@class, 'rounded-2xl')][1]").getByTitle("عرض وطباعة الاستمارة السريرية", { exact: true })
          : page.locator("li").filter({ has: page.getByRole("link", { name: patientName, exact: true }), hasText: labs[orderIndex] })
            .getByTitle("عرض وطباعة استمارة طلب المختبر الرسمية بمخطط الأسنان السريري", { exact: true });
        await expect.poll(() => openButton.count()).toBe(1);
        if (entry === "patient") {
          // Witness the actual internal age display before asserting its absence
          // outside. Never assume age at today's date equals age at sent_date,
          // and never search for an age number alone (it could be an order ID).
          // Treatment renders the compact identity and keeps the expanded
          // details mounted but hidden. Witness the one visible identity,
          // rather than counting its hidden demographic duplicate as well.
          const identity = page.getByTestId("patient-compact-identity");
          await expect.poll(() => identity.count()).toBe(1);
          await expect.poll(() => identity.isVisible()).toBe(true);
          const demographic = identity.locator("span")
            .filter({ hasText: /^أنثى\s*·\s*\d+\s+سنة$/ });
          await expect.poll(() => demographic.count()).toBe(1);
          expect(await demographic.isVisible()).toBe(true);
          observedDemographic = plain(await demographic.innerText()).trim();
          const age = observedDemographic.match(/^أنثى\s*·\s*(\d+\s+سنة)$/);
          expect(age).not.toBeNull();
          observedAgeText = age![1];
          expect(observedAgeText.length).toBeGreaterThan(3);
        }
        if (entry === "lab") {
          const row = page.locator("li").filter({ has: page.getByRole("link", { name: patientName, exact: true }), hasText: labs[orderIndex] });
          const href = await row.getByRole("link", { name: "استعجال المعمل", exact: true }).getAttribute("href");
          const url = new URL(href!);
          expect(url.origin).toBe("https://wa.me"); expect(url.pathname).toBe("/967777123456");
          assertPrivateAbsent(decodeURIComponent(url.href));
          const message = url.searchParams.get("text")!;
          expect(message).toContain(reference); expect(message).toContain(serviceName);
          expect(message).toContain("توجد تعليمات داخلية غير مرفقة");
          // Never click, prefetch or visit the external WhatsApp link.
        }
        await openButton.click();
        const overlay = page.getByRole("heading", { name: "استمارة طلب العمل المخبري", exact: true })
          .locator("xpath=ancestor::div[contains(@class, 'fixed')][1]");
        const sheet = overlay.locator("#lab-prescription-print-root");
        await expect.poll(() => sheet.isVisible()).toBe(true);
        await paint(page);
        await assertNoDemographicMarkup(overlay);
        expect(await sheet.innerText()).toContain(reference);
        expect(await sheet.innerText()).toContain("توجد تعليمات داخلية غير مرفقة");
        qrFacts.push(await assertActualQr(sheet.getByRole("img", { name: `مرجع الطلب ${reference}`, exact: true }), reference, 160, "#0a192f"));
        reachabilityFacts.push({ entry, geometry: await assertLongPreviewReachable(page, overlay, sheet) });
        await page.setViewportSize({ width: 390, height: 844 });
        reachabilityFacts.push({ entry, geometry: await assertLongPreviewReachable(page, overlay, sheet) });
        await assertNoDemographicMarkup(overlay);
        // Native clipboard setup prevents a previous successful copy from masking
        // a failed action. The product handler is reached only by the real click.
        await page.evaluate(() => navigator.clipboard.writeText("SYNTHETIC_DISPATCH_BEFORE_MOBILE_COPY"));
        await overlay.getByRole("button", { name: "💬 نسخ لواتساب", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(reference);
        const mobileCopy = await page.evaluate(() => navigator.clipboard.readText());
        assertPrivateAbsent(mobileCopy);
        expect(mobileCopy).toContain(serviceName);
        expect(mobileCopy).toContain("توجد تعليمات داخلية غير مرفقة");
        await overlay.getByRole("button", { name: "✕", exact: true }).click();
        await expect.poll(() => sheet.count()).toBe(0);
        // Restore the original full desktop privacy/PDF/eight-artifact journey.
        await page.setViewportSize({ width: 1280, height: 1100 });
        await openButton.click();
        await expect.poll(() => sheet.isVisible()).toBe(true);
        await paint(page);
        await assertPreviewActionsInViewport(overlay);
        await assertNoDemographicMarkup(overlay);
        qrFacts.push(await assertActualQr(sheet.getByRole("img", { name: `مرجع الطلب ${reference}`, exact: true }), reference, 160, "#0a192f"));
        await page.evaluate(() => navigator.clipboard.writeText("SYNTHETIC_DISPATCH_BEFORE_DESKTOP_COPY"));
        await overlay.getByRole("button", { name: "💬 نسخ لواتساب", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(reference);
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        assertPrivateAbsent(copied); expect(copied).toContain(serviceName); expect(copied).toContain("توجد تعليمات داخلية غير مرفقة");
        members.push({ filename: `${entry}-preview.png`, bytes: await overlay.screenshot({ path: `${directory}/${entry}-preview.png` }) });

        await page.emulateMedia({ media: "print" }); await paint(page);
        expect(await page.locator("body").evaluate(body => getComputedStyle(body).display)).toBe("none");
        const blankFilename = `${entry}-parent-blank.pdf` as const;
        const blankPdf = await page.pdf({ path: `${directory}/${blankFilename}`, format: "A4", printBackground: true, displayHeaderFooter: false });
        pdfFacts.push({ filename: blankFilename, pages: (await inspectPdf(page, blankFilename, true)).pages });
        members.push({ filename: blankFilename, bytes: blankPdf });
        await page.emulateMedia({ media: "screen" }); await paint(page);
        expect(await sheet.isVisible()).toBe(true);
        const [printPage] = await Promise.all([context.waitForEvent("page"), overlay.getByRole("link", { name: /صفحة طباعة الإرسالية/ }).click()]);
        await printPage.waitForURL(`**/print/lab/${orderId}`);
        await printPage.waitForLoadState("load");
        expect(new URL(printPage.url()).pathname).toBe(`/print/lab/${orderId}`);
        expect(printStatuses.get(`/print/lab/${orderId}`)).toBe(200);
        await paint(printPage);
        assertPrivateAbsent(await printPage.content()); assertPrivateAbsent(await printPage.title());
        await assertNoDemographicMarkup(printPage.locator(".sheet"));
        expect(await printPage.locator(".sheet").innerText()).toContain(reference);
        qrFacts.push(await assertActualQr(printPage.getByRole("img", { name: `مرجع الطلب ${reference}`, exact: true }), reference, 140, "#0f172a"));
        members.push({ filename: `${entry}-print.png`, bytes: await printPage.screenshot({ path: `${directory}/${entry}-print.png`, fullPage: true }) });
        const filename = `${entry}-dispatch.pdf` as const;
        const pdf = await printPage.pdf({ path: `${directory}/${filename}`, format: "A4", preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
        const inspected = await inspectPdf(printPage, filename, false);
        for (const expected of [reference, serviceName, labs[orderIndex], "A2", "ND2"]) expect(compact(inspected.text)).toContain(compact(expected));
        pdfFacts.push({ filename, pages: inspected.pages }); members.push({ filename, bytes: pdf });
        await printPage.close();
        await overlay.getByRole("button", { name: "✕", exact: true }).click();
        await expect.poll(() => sheet.count()).toBe(0);
        // Close/reopen is a real product action; no QR promise or app state is stubbed.
        await openButton.click();
        await expect.poll(() => sheet.isVisible()).toBe(true);
        qrFacts.push(await assertActualQr(sheet.getByRole("img", { name: `مرجع الطلب ${reference}`, exact: true }), reference, 160, "#0a192f"));
        await assertNoDemographicMarkup(overlay);
        await overlay.getByRole("button", { name: "✕", exact: true }).click();
        await expect.poll(() => sheet.count()).toBe(0);
      }
    }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); });
    expect(await snapshot()).toEqual(before);
    emitEvidence(members, { entrypoints: ["patient", "lab"], clipboard: "passed", urgencyUrl: "passed-without-navigation",
      fullPdfTextAndMetadata: "passed", parentPrintIsolation: "passed", readOnlySnapshot: "unchanged", qr: qrFacts, pdfs: pdfFacts,
      actionReachability: reachabilityFacts, nativeClipboardViewports: [1280, 390],
      syntheticInternalDemographicWitness: observedDemographic, syntheticHistoricalAgeCanary: historicalAgeText,
      limits: "390px proves action geometry, native wheel recovery, copy and close; retained images and full PDF journey are 1280px only. Natural close/reopen only; no deliberately delayed encoder. Native QR pixel decoding only when reported passed; pixel equality always required. Browser print headers disabled; no user save-dialog filename claim." });
  }, 180_000);
});
