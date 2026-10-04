import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Request } from "playwright";
import { Client } from "pg";
import { mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { authedMutation, baseUrl, harness } from "./_server";

// Only the isolated security-harness DB and newly created synthetic patient.
// Clinical records are created/signed/appended through the real existing APIs.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let patientId = 0;
let doctorPartyId = 0;
let caseId = 0;
let signedVisitId = 0;
let draftVisitId = 0;
let emptyVisitId = 0;
let treatmentId = 0;
let signedRecordId = 0;
const stamp = Date.now();
const patientNumber = `DOS-ENDO-${stamp}`;
const patientName = "مريض ملف عصب اصطناعي باسم طويل للتحقق من التفاف الهوية على صفحات الطباعة مع استمرار ظهور رقم الملف DOSSIER-PATIENT";
const continuationMarkers = Array.from({ length: 80 }, (_, index) => `A4-CONTINUATION-${String(index + 1).padStart(2, "0")}`);
const originalNote = ["نص سريري أصلي اصطناعي", ...continuationMarkers.map((marker) => `${marker} سطر`)].join("\n");
const draftNote = "مسودة سريرية اصطناعية DOSSIER-DRAFT-END";
const addendumText = "ملحق تصحيح سريري اصطناعي مع بقاء الأصل";
const planSentinel = "SYN-PRIVATE-CROWN-NO-PRINT";
const visitHistoryNotes: string[] = [];
const pdfPath = ".settings-ui-artifacts/patient-dossier-endo-a4.pdf";
async function assertMobilePrintPaint(page: Page, prepare: () => Promise<unknown>, screenshotPath?: string) {
  const printWrites: string[] = [];
  const trackWrites = (request: Request) => {
    if (!["GET", "HEAD"].includes(request.method())) printWrites.push(request.method());
  };
  page.on("request", trackWrites);
  try {
    await prepare();
    await page.evaluate(async () => {
      await document.fonts.ready; window.scrollTo(0, 0);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const printButton = page.getByRole("button", { name: "اطبع", exact: true });
    const identity = page.locator(".dossier-demographics-grid").getByText(patientName, { exact: true });
    await expect.poll(async () => printButton.isVisible()).toBe(true);
    const printBounds = await printButton.boundingBox(), identityBounds = await identity.boundingBox();
    for (const bounds of [printBounds, identityBounds]) {
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
    }
    for (const target of [printButton, identity]) {
      expect(await target.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        return hit === element || !!hit && element.contains(hit);
      })).toBe(true);
    }
    expect(await page.locator(".sheet-a4").getAttribute("dir")).toBe("rtl");
    expect(await page.getByRole("region", { name: "سجل علاج الجذور" }).innerText()).toContain(draftNote);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.evaluate(() => {
      delete document.documentElement.dataset.syntheticPrintInvoked;
      window.print = () => { document.documentElement.dataset.syntheticPrintInvoked = "true"; };
    });
    await printButton.click();
    await expect.poll(async () => page.locator("html").getAttribute("data-synthetic-print-invoked")).toBe("true");
    expect(await printButton.isEnabled()).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const mobilePng = await page.screenshot(screenshotPath ? { path: screenshotPath } : {});
    const paintPage = await page.context().newPage();
    try {
      await paintPage.setContent("<html><body></body></html>");
      const painted = await paintPage.evaluate(async ({ source, boxes }) => {
        const image = new Image(); image.src = source; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        const paint = canvas.getContext("2d")!; paint.drawImage(image, 0, 0);
        return { width: image.width, height: image.height, ink: boxes.map(box => {
          const pixels = paint.getImageData(Math.floor(box.x), Math.floor(box.y), Math.ceil(box.width), Math.ceil(box.height)).data;
          let count = 0;
          for (let index = 0; index < pixels.length; index += 4) if (pixels[index] + pixels[index + 1] + pixels[index + 2] < 540) count++;
          return count;
        }) };
      }, { source: `data:image/png;base64,${mobilePng.toString("base64")}`, boxes: [printBounds!, identityBounds!] });
      expect(painted).toMatchObject({ width: 390, height: 844 });
      expect(painted.ink[0], "Print control must visibly paint in the actual mobile PNG").toBeGreaterThan(100);
      expect(painted.ink[1], "patient identity must visibly paint in the actual mobile PNG").toBeGreaterThan(100);
    } finally { await paintPage.close(); }
    expect(printWrites).toEqual([]);
  } finally { page.off("request", trackWrites); }
}

async function send(path: string, method: "POST" | "PUT" | "PATCH", body: unknown, status: number) {
  const response = await authedMutation(path, h.sessions.admin, method, JSON.stringify(body));
  expect(response.status, path).toBe(status);
  return response;
}
async function newVisit() {
  const ordinal = visitHistoryNotes.length + 1;
  const note = `سجل زيارة اصطناعي ${ordinal}`;
  const id = (await db.query<{ id: number }>(`INSERT INTO visits (patient_id, patient_name, doctor_id, status, note, arrived_at)
    VALUES ($1, $5, $2, 'in_chair', $3, NOW() - ($4::int * INTERVAL '1 minute')) RETURNING id`,
  [patientId, doctorPartyId, note, ordinal, patientName])).rows[0].id;
  visitHistoryNotes.push(note);
  return id;
}
beforeAll(async () => {
  expect(patientName.length).toBeLessThanOrEqual(120);
  expect(originalNote.length).toBeLessThanOrEqual(2000);
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  doctorPartyId = (await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username='secdoctora'`)).rows[0].party_id;
  patientId = (await db.query<{ id: number }>(`INSERT INTO patients (patient_number, full_name, primary_doctor_id)
    VALUES ($1, $3, $2) RETURNING id`, [patientNumber, doctorPartyId, patientName])).rows[0].id;
  caseId = (await (await send(`/api/patients/${patientId}/cases`, "POST", { specialty: "endodontics", title: "حالة عصب اصطناعية للطباعة", site: "36" }, 201)).json() as { id: number }).id;
  treatmentId = (await (await send(`/api/patients/${patientId}/endo`, "POST", { caseId, toothCode: 36 }, 201)).json() as { id: number }).id;
  signedVisitId = await newVisit();
  const saved = await send(`/api/patients/${patientId}/endo/${treatmentId}/visits`, "PUT", {
    visitId: signedVisitId, stage: "assessment", note: originalNote, pulpalDiagnosis: "pulp_necrosis", mobilityGrade: 0,
    canals: [{ label: "MB", workingLengthMm: 20.5, referencePoint: "cusp_tip", measurementMethod: "both" }],
  }, 201);
  signedRecordId = (await saved.json() as { visits: { id: number; visitId: number }[] }).visits.find((visit) => visit.visitId === signedVisitId)!.id;
  await send(`/api/visits/${signedVisitId}/clinical`, "POST", { action: "sign" }, 200);
  await send(`/api/patients/${patientId}/endo/${treatmentId}/visits/${signedRecordId}/addenda`, "POST", {
    requestKey: `dossier:addendum:${stamp}`, text: addendumText,
  }, 201);
  draftVisitId = await newVisit();
  await send(`/api/patients/${patientId}/endo/${treatmentId}/visits`, "PUT", { visitId: draftVisitId, stage: "review", note: draftNote }, 201);
  emptyVisitId = await newVisit();
  await send(`/api/patients/${patientId}/endo/${treatmentId}/visits`, "PUT", { visitId: emptyVisitId, stage: "assessment" }, 201);
  // All eight history notes must survive printing, including rows beyond the old six-visit cap.
  for (let index = 0; index < 5; index++) await newVisit();
  const planId = (await db.query<{ id: number }>(`INSERT INTO treatment_plans (patient_id, title, total_minor, status)
    VALUES ($1, 'SYN-PRIVATE-PLAN', 10000, 'active') RETURNING id`, [patientId])).rows[0].id;
  const crownId = (await db.query<{ id: number }>(`INSERT INTO plan_items (plan_id, service_name, category, tooth_code, unit_price_minor, status)
    VALUES ($1, $2, 'crown', 36, 10000, 'done') RETURNING id`, [planId, planSentinel])).rows[0].id;
  const rctId = (await db.query<{ id: number }>(`INSERT INTO plan_items (plan_id, service_name, category, tooth_code, case_id, unit_price_minor)
    VALUES ($1, 'SYN-RCT', 'rct', 36, $2, 0) RETURNING id`, [planId, caseId])).rows[0].id;
  await send(`/api/patients/${patientId}/endo/${treatmentId}/crown`, "PATCH", { crownRequired: true, crownPlanItemId: crownId, rctPlanItemId: rctId }, 200);
  await db.query(`INSERT INTO tooth_conditions (patient_id, tooth_code, condition, stage, note, visit_id, recorded_by, recorded_at)
    SELECT $1, 36, 'caries', 'existing', 'سجل مخطط اصطناعي ' || n, $2, 'synthetic-dossier', NOW() - (n || ' hours')::interval
    FROM generate_series(1,12) n`, [patientId, signedVisitId]);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });
const direct = (who: "admin" | "doctorA" | "doctorB" | "accountant") => fetch(`${baseUrl}/print/dossier/${patientId}`, {
  headers: { cookie: h.sessions[who].cookie }, redirect: "manual",
});

describe("existing dossier ENDO print on the built app", () => {
  it("prints signed originals, addenda and labeled drafts without plan/finance disclosure to a restricted doctor", async () => {
    const { rows: [user] } = await db.query<{ permissions: string | null }>(`SELECT permissions FROM users WHERE username='secdoctora'`);
    const permissions = { ...JSON.parse(user.permissions ?? "{}"), canViewPlans: false, canEditPlans: false, canViewPatientPayments: false };
    await db.query(`UPDATE users SET permissions=$1 WHERE username='secdoctora'`, [JSON.stringify(permissions)]);
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
    try {
      const response = await direct("doctorA"); expect(response.status).toBe(200);
      const cacheControl = response.headers.get("cache-control") ?? "";
      expect(cacheControl).toContain("private");
      expect(cacheControl).toContain("no-store");
      const csp = response.headers.get("content-security-policy") ?? "";
      for (const directive of ["default-src 'self'", "'strict-dynamic'", "frame-ancestors 'none'", "object-src 'none'"]) expect(csp).toContain(directive);
      expect(csp).toMatch(/'nonce-[^']+'/);
      expect(csp).not.toContain("unsafe-eval");
      const html = await response.text();
      for (const hidden of [planSentinel, "SYN-PRIVATE-PLAN", "الرصيد المتبقي (الذمة)", "crownPlanItem"]) expect(html).not.toContain(hidden);
      const [name, ...value] = h.sessions.doctorA.cookie.split("=");
      await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
      const page = await context.newPage(); const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}/print/dossier/${patientId}`, { waitUntil: "load" });
      const records = page.getByRole("region", { name: "سجل علاج الجذور" }); await records.waitFor();
      await page.evaluate(async () => { await document.fonts.ready; });
      const scope = await page.getByTestId("patient-dossier-scope").innerText();
      expect(scope).toContain("لا يشمل جميع سجلات التخصصات أو المستندات أو تفاصيل الخطة العلاجية");
      expect(scope).toContain("الملخص المالي، إن ظهر، يخضع للصلاحيات ولا يغني عن كشف الحساب المالي");
      const text = await records.innerText();
      for (const expected of [originalNote, addendumText, "secadmin", `الحالة #${caseId}`, `زيارة #${signedVisitId}`, `زيارة #${draftVisitId}`, "زيارة موقّعة", "مسودة غير موقّعة", "20.5 مم"]) expect(text).toContain(expected);
      expect(text).not.toContain(`زيارة #${emptyVisitId}`);
      expect(text.indexOf(originalNote)).toBeLessThan(text.indexOf(addendumText));
      expect(await page.locator(".sheet-a4").innerText()).toContain("أحدث 50 زيارة كحد أقصى");
      expect(visitHistoryNotes).toHaveLength(8);
      for (const note of visitHistoryNotes) expect(await page.getByText(note, { exact: true }).count()).toBe(1);
      expect(await page.getByText("سجل مخطط اصطناعي 12", { exact: true }).count()).toBe(1);
      await mkdir(".settings-ui-artifacts", { recursive: true });
      await page.locator(".sheet-a4").screenshot({ path: ".settings-ui-artifacts/patient-dossier-endo-screen.png" });
      // Isolate mobile paint from the oversized desktop element screenshot.
      // Native bounds/hit tests alone do not prove that a screenshot painted.
      const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
      try {
        await mobile.addCookies([{ name, value: value.join("="), url: baseUrl }]);
        const mobilePage = await mobile.newPage();
        mobilePage.on("pageerror", error => errors.push(error.message));
        await assertMobilePrintPaint(mobilePage,
          () => mobilePage.goto(`${baseUrl}/print/dossier/${patientId}`, { waitUntil: "load" }),
          ".settings-ui-artifacts/patient-dossier-endo-mobile-390.png");
      } finally { await mobile.close(); }
      // Also preserve the original desktop screenshot -> resize/repaint -> Print
      // path. Its PNG is inspected in memory, retaining the exact four artifacts.
      await assertMobilePrintPaint(page, () => page.setViewportSize({ width: 390, height: 844 }));
      await page.setViewportSize({ width: 1280, height: 1100 });
      await page.evaluate(() => { window.scrollTo(0, 0); });
      await page.emulateMedia({ media: "print" });
      expect(await records.innerText()).toContain(addendumText);
      expect(await page.locator(".sheet-a4").innerText()).not.toContain(planSentinel);
      await page.locator(".sheet-a4").screenshot({ path: ".settings-ui-artifacts/patient-dossier-endo-print.png" });
      // This is Chromium's actual paginated output; the print-media PNG above is not paper proof.
      // Every PDF page still needs manual review for clipping, splits, and patient/record context.
      await page.evaluate(async () => { await document.fonts.ready; });
      const pdf = await page.pdf({ path: pdfPath, format: "A4", landscape: false,
        printBackground: true, displayHeaderFooter: false, preferCSSPageSize: false });
      expect(pdf.length).toBeGreaterThan(1000);
      expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      expect(pdf.subarray(-1024).toString("ascii")).toContain("%%EOF");
      expect(await readFile(pdfPath)).toEqual(pdf);
      // Read the actual paginated artifact, not the screen DOM. Native CSS/DOM
      // supplies identity and numbering; PDF-only header/footer templates stay off.
      const pdfText = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], {
        encoding: "utf8", maxBuffer: 5 * 1024 * 1024,
      }).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
      const pdfPages = pdfText.split("\f").filter((text) => text.trim());
      expect(pdfPages.length).toBeGreaterThanOrEqual(2);
      expect(pdfPages.filter((pageText) => continuationMarkers.some((marker) => pageText.includes(marker))).length,
        "the same clinical record must exercise real continuation").toBeGreaterThanOrEqual(2);
      for (const [index, pageText] of pdfPages.entries()) {
        expect(pageText, `patient number on PDF page ${index + 1}`).toContain(patientNumber);
        expect(pageText, `patient name on PDF page ${index + 1}`).toContain("DOSSIER-PATIENT");
        expect(pageText, `native page counter on PDF page ${index + 1}`).toMatch(new RegExp(`\\b${index + 1}\\s*/\\s*${pdfPages.length}\\b`));
        if (continuationMarkers.some((marker) => pageText.includes(marker))) {
          const normalized = pageText.replace(/\s+/g, " ");
          for (const context of [`Case #${caseId}`, "Tooth 36", `Record #${signedRecordId}`, `Visit #${signedVisitId}`, "Signed"]) {
            expect(normalized, `clinical record context on PDF page ${index + 1}`).toContain(context);
          }
        }
      }
      for (const marker of [...continuationMarkers, "DOSSIER-DRAFT-END"]) {
        expect(pdfText.match(new RegExp(`\\b${marker}\\b`, "g")) ?? [], `clinical marker ${marker} occurs exactly once`).toHaveLength(1);
      }
      // Extracted PDF text can exist inside a clipped/overpainted table header.
      // Compare its actual rasterized identity band on every page with page one.
      // This catches that failure even when all text and bounding boxes survive.
      const rasterPage = await context.newPage();
      try {
        await rasterPage.setContent("<html><body></body></html>");
        const identityBands: number[][] = [];
        for (let index = 0; index < pdfPages.length; index++) {
          const png = execFileSync("pdftoppm", ["-f", String(index + 1), "-l", String(index + 1),
            "-r", "96", "-png", "-singlefile", pdfPath], { maxBuffer: 10 * 1024 * 1024 });
          identityBands.push(await rasterPage.evaluate(async (dataUrl) => {
            const image = new Image();
            image.src = dataUrl;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width; canvas.height = image.height;
            const paint = canvas.getContext("2d")!;
            paint.drawImage(image, 0, 0);
            const pxPerMm = 96 / 25.4;
            // The repeating patient header occupies this 8–24mm band.
            return Array.from(paint.getImageData(Math.ceil(8 * pxPerMm), Math.ceil(8 * pxPerMm),
              image.width - Math.ceil(16 * pxPerMm), Math.floor(16 * pxPerMm)).data);
          }, `data:image/png;base64,${png.toString("base64")}`));
        }
        const inkCount = (band: number[]) => band.reduce((count, _value, index) =>
          index % 4 === 0 && band[index] + band[index + 1] + band[index + 2] < 540 ? count + 1 : count, 0);
        const reference = identityBands[0];
        expect(inkCount(reference), "first-page identity must render visible ink").toBeGreaterThan(500);
        for (const [index, band] of identityBands.entries()) {
          expect(band.length).toBe(reference.length);
          let changed = 0;
          for (let pixel = 0; pixel < band.length; pixel += 4) {
            if (Math.max(...[0, 1, 2].map((channel) => Math.abs(band[pixel + channel] - reference[pixel + channel]))) > 30) changed++;
          }
          expect(changed / (band.length / 4), `visible identity band on PDF page ${index + 1}`).toBeLessThan(0.005);
          expect(inkCount(band), `patient identity ink on PDF page ${index + 1}`).toBeGreaterThan(inkCount(reference) * 0.95);
        }
      } finally { await rasterPage.close(); }
      expect(pdfPages.at(-1), "document footer survives on the final PDF page").toContain("Clinical summary");
      expect(errors).toEqual([]);
      // Reading/printing never duplicates or changes clinical or financial work.
      expect((await db.query(`SELECT note FROM endo_visits WHERE treatment_id=$1 AND visit_id=$2`, [treatmentId, signedVisitId])).rows[0].note).toBe(originalNote);
      expect((await db.query(`SELECT a.id FROM endo_addenda a JOIN endo_visits v ON v.id=a.endo_visit_id WHERE v.treatment_id=$1`, [treatmentId])).rows).toHaveLength(1);
      expect((await db.query(`SELECT id FROM invoices WHERE patient_id=$1`, [patientId])).rows).toHaveLength(0);
    } finally {
      await context.close();
      await db.query(`UPDATE users SET permissions=$1 WHERE username='secdoctora'`, [user.permissions]);
    }
  });

  it("keeps unrelated doctors and financial-only roles outside the clinical dossier", async () => {
    expect((await direct("doctorB")).status).toBe(404);
    expect((await direct("accountant")).status).toBe(307);
    expect((await direct("admin")).status).toBe(200);
  });
});
