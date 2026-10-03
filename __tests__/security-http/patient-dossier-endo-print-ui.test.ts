import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { mkdir, readFile } from "node:fs/promises";
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
const stamp = Date.now();
const patientNumber = `DOS-ENDO-${stamp}`;
const originalNote = "نص سريري أصلي اصطناعي";
const addendumText = "ملحق تصحيح سريري اصطناعي مع بقاء الأصل";
const planSentinel = "SYN-PRIVATE-CROWN-NO-PRINT";
const visitHistoryNotes: string[] = [];
const pdfPath = ".settings-ui-artifacts/patient-dossier-endo-a4.pdf";
async function send(path: string, method: "POST" | "PUT" | "PATCH", body: unknown, status: number) {
  const response = await authedMutation(path, h.sessions.admin, method, JSON.stringify(body));
  expect(response.status, path).toBe(status);
  return response;
}
async function newVisit() {
  const ordinal = visitHistoryNotes.length + 1;
  const note = `سجل زيارة اصطناعي ${ordinal}`;
  const id = (await db.query<{ id: number }>(`INSERT INTO visits (patient_id, patient_name, doctor_id, status, note, arrived_at)
    VALUES ($1, 'مريض ملف عصب اصطناعي', $2, 'in_chair', $3, NOW() - ($4::int * INTERVAL '1 minute')) RETURNING id`,
  [patientId, doctorPartyId, note, ordinal])).rows[0].id;
  visitHistoryNotes.push(note);
  return id;
}
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  doctorPartyId = (await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username='secdoctora'`)).rows[0].party_id;
  patientId = (await db.query<{ id: number }>(`INSERT INTO patients (patient_number, full_name, primary_doctor_id)
    VALUES ($1, 'مريض ملف عصب اصطناعي', $2) RETURNING id`, [patientNumber, doctorPartyId])).rows[0].id;
  caseId = (await (await send(`/api/patients/${patientId}/cases`, "POST", { specialty: "endodontics", title: "حالة عصب اصطناعية للطباعة", site: "36" }, 201)).json() as { id: number }).id;
  treatmentId = (await (await send(`/api/patients/${patientId}/endo`, "POST", { caseId, toothCode: 36 }, 201)).json() as { id: number }).id;
  signedVisitId = await newVisit();
  const saved = await send(`/api/patients/${patientId}/endo/${treatmentId}/visits`, "PUT", {
    visitId: signedVisitId, stage: "assessment", note: originalNote, pulpalDiagnosis: "pulp_necrosis", mobilityGrade: 0,
    canals: [{ label: "MB", workingLengthMm: 20.5, referencePoint: "cusp_tip", measurementMethod: "both" }],
  }, 201);
  const endoVisitId = (await saved.json() as { visits: { id: number; visitId: number }[] }).visits.find((visit) => visit.visitId === signedVisitId)!.id;
  await send(`/api/visits/${signedVisitId}/clinical`, "POST", { action: "sign" }, 200);
  await send(`/api/patients/${patientId}/endo/${treatmentId}/visits/${endoVisitId}/addenda`, "POST", {
    requestKey: `dossier:addendum:${stamp}`, text: addendumText,
  }, 201);
  draftVisitId = await newVisit();
  await send(`/api/patients/${patientId}/endo/${treatmentId}/visits`, "PUT", { visitId: draftVisitId, stage: "review", note: "مسودة سريرية اصطناعية" }, 201);
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
