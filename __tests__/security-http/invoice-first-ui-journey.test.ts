import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

/**
 * (INV-LINK D) رحلة الفاتورة العلاجية في المتصفح على التطبيق المبني وقاعدة معزولة:
 * الاستقبال يصدر فاتورة تقويم ← المعاينة تقول ما سيحدث ← الحفظ مرةً واحدة رغم النقر المزدوج ← الطبيب يرى
 * «بدء التقييم السريري — تقويم» ← تبويب التقويم يعرض الحالة التي تحتاج تقييمًا.
 */

let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let serviceId = 0;
let doctorId = 0;
const stamp = Date.now();

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  doctorId = doctor.party_id;
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض فاتورة التقويم', $2) RETURNING id`,
    [`IFJ-${stamp}`, doctor.party_id]));
  ({ rows: [{ id: serviceId }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 30000000, TRUE, TRUE, 'ortho') RETURNING id`,
    [`تقويم ثابت رحلة ${stamp}`]));
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function open(who: "reception" | "doctorA", path: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions[who].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
  return { context, page };
}

describe("INV-LINK D — invoice-first journey", () => {
  it("reception: preview says a new intake case will be created; a double click saves one invoice", async () => {
    const { context, page } = await open("reception", `/patients/${patientId}?tab=account`);
    await page.getByRole("button", { name: "فاتورة يدوية" }).click();
    await page.getByLabel("الخدمة", { exact: true }).selectOption(String(serviceId));
    await page.getByTestId("invoice-provider-0").selectOption(String(doctorId));
    await page.getByTestId("invoice-row-0").getByTestId("scope-both").click();
    const preview = page.getByTestId("invoice-clinical-preview-0");
    await preview.filter({ hasText: "سيتم إنشاء حالة أولية تحتاج تقييم الطبيب" }).waitFor();
    expect(await preview.innerText()).toContain("بند خطة جديد");
    const save = page.getByRole("button", { name: "احفظ الفاتورة" });
    await save.dblclick();
    await page.getByTestId("invoice-clinical-notice").waitFor();
    expect(await page.getByTestId("invoice-clinical-notice").innerText()).toContain("حالة أولية تحتاج تقييم الطبيب");
    const { rows } = await db.query(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patientId]);
    expect(rows).toHaveLength(1);
    const { rows: cases } = await db.query<{ specialty: string; origin: string }>(`SELECT specialty, origin FROM clinical_cases WHERE patient_id = $1`, [patientId]);
    expect(cases).toEqual([{ specialty: "orthodontics", origin: "invoice" }]);
    await context.close();
  });

  it("doctor: the next action is the clinical assessment and the ortho tab shows the pending case", async () => {
    const { context, page } = await open("doctorA", `/patients/${patientId}`);
    const action = page.getByRole("button", { name: /بدء التقييم السريري — تقويم/ });
    await action.waitFor();
    await action.click();
    const banner = page.getByTestId("assessment-banner-orthodontics");
    await banner.waitFor();
    expect(await banner.innerText()).toContain("تحتاج تقييمًا سريريًّا");
    expect(await banner.innerText()).toContain("حالة مرتبطة بفاتورة وتنتظر تقييم الطبيب");
    expect(await banner.innerText()).toContain("الفاتورة لا تثبت الموافقة السريرية أو اكتمال السداد");
    expect(await banner.innerText()).not.toContain("مقبول ماليًّا");
    // nothing clinical was invented: no ortho_cases row exists yet
    expect((await db.query(`SELECT 1 FROM ortho_cases WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
    // A real intake must retire the same-mounted pending-assessment banner without
    // leaving the tab, reloading the document, or relying on a window-focus refresh.
    await page.locator('[data-testid="patient-ortho-workspace"][data-read-state="ready"]').waitFor();
    const workspace = await page.getByTestId("patient-ortho-workspace").elementHandle();
    let navigations = 0;
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
    await page.evaluate(() => {
      const state = { count: 0 };
      (window as unknown as { invoiceAssessmentFocusProbe: { count: number } }).invoiceAssessmentFocusProbe = state;
      window.addEventListener("focus", () => { state.count++; });
    });
    await page.getByRole("button", { name: "+ فتح حالة تقويم جديدة", exact: true }).click();
    await page.getByLabel("الفكّان المعالَجان", { exact: true }).selectOption("both");
    const refreshedWorkflow = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/patients/${patientId}/workflow`
      && response.request().method() === "GET");
    await page.getByRole("button", { name: "افتح الحالة", exact: true }).click();
    const response = await refreshedWorkflow;
    expect(response.ok()).toBe(true);
    const workflow = await response.json() as { patient: { id: number }; assessmentCases: unknown[] };
    expect(workflow.patient.id).toBe(patientId);
    expect(workflow.assessmentCases).toEqual([]);
    // Canonical persistence is checked independently of the banner's read path.
    const bridged = await db.query<{ ortho_case_id: number }>(
      `SELECT ortho_case_id FROM clinical_cases WHERE patient_id = $1 AND origin = 'invoice' AND specialty = 'orthodontics'`, [patientId]);
    expect(bridged.rows).toHaveLength(1); expect(bridged.rows[0].ortho_case_id).toBeGreaterThan(0);
    await banner.waitFor({ state: "detached" });
    expect(await workspace!.evaluate((element) => element.isConnected)).toBe(true);
    expect(navigations).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { invoiceAssessmentFocusProbe: { count: number } }).invoiceAssessmentFocusProbe.count)).toBe(0);
    expect((await db.query(`SELECT id FROM ortho_cases WHERE patient_id = $1`, [patientId])).rows).toHaveLength(1);
    expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(1);
    await context.close();
  });

  it("cancelled before intake: the rendered hint promises only a clinical bridge and preserves financial review", async () => {
    const { rows: [{ id: cancelledPatientId }] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض تقييم بعد إلغاء الفاتورة', $2) RETURNING id`,
      [`IFJ-CANCEL-${stamp}`, doctorId]);
    const createdResponse = await authedMutation("/api/invoices", h.sessions.reception, "POST", JSON.stringify({
      patientId: cancelledPatientId, currency: "YER", items: [{ serviceId, doctorId, scope: "both" }],
    }));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as {
      id: number; clinical: { planId: number; links: { caseId: number; planItemId: number }[] };
    };
    expect(created.clinical.links).toHaveLength(1);
    const { caseId, planItemId } = created.clinical.links[0];
    const cancelledResponse = await authedMutation(`/api/invoices/${created.id}`, h.sessions.admin, "PATCH", JSON.stringify({
      status: "cancelled", reason: "إلغاء الفاتورة قبل التقييم السريري للاختبار",
    }));
    expect(cancelledResponse.status).toBe(200);
    const financialState = async () => ({
      invoices: (await db.query(`SELECT id, status FROM invoices WHERE patient_id = $1 ORDER BY id`, [cancelledPatientId])).rows,
      plans: (await db.query(`SELECT id, consent_at FROM treatment_plans WHERE patient_id = $1 ORDER BY id`, [cancelledPatientId])).rows,
      items: (await db.query(`SELECT i.id, i.plan_id, i.case_id, i.billing_status, i.billed_invoice_id, i.origin_invoice_id
        FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1 ORDER BY i.id`, [cancelledPatientId])).rows,
      invoiceItems: (await db.query(`SELECT i.id FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id
        WHERE v.patient_id = $1 ORDER BY i.id`, [cancelledPatientId])).rows,
      installments: (await db.query(`SELECT i.id FROM plan_installments i JOIN treatment_plans t ON t.id = i.plan_id
        WHERE t.patient_id = $1 ORDER BY i.id`, [cancelledPatientId])).rows,
    });
    const cancelled = await financialState();
    expect(cancelled).toMatchObject({
      invoices: [{ id: created.id, status: "cancelled" }],
      plans: [{ id: created.clinical.planId, consent_at: null }],
      items: [{ id: planItemId, plan_id: created.clinical.planId, case_id: caseId,
        billing_status: "needs_financial_review", billed_invoice_id: created.id, origin_invoice_id: created.id }],
      installments: [],
    });
    expect(cancelled.invoiceItems).toHaveLength(1);
    const workflowResponse = await authedGet(`/api/patients/${cancelledPatientId}/workflow`, h.sessions.doctorA);
    expect(workflowResponse.status).toBe(200);
    expect((await workflowResponse.json()).assessmentCases)
      .toEqual([expect.objectContaining({ id: caseId, specialty: "orthodontics" })]);
    expect((await db.query(`SELECT id FROM ortho_cases WHERE patient_id = $1`, [cancelledPatientId])).rows).toEqual([]);

    const { context, page } = await open("doctorA", `/patients/${cancelledPatientId}`);
    try {
      await page.getByRole("button", { name: /بدء التقييم السريري — تقويم/ }).click();
      const banner = page.getByTestId("assessment-banner-orthodontics");
      await banner.waitFor();
      const text = await banner.innerText();
      expect(text).toContain("حالة مرتبطة بفاتورة وتنتظر تقييم الطبيب");
      expect(text).toContain("الفاتورة لا تثبت الموافقة السريرية أو اكتمال السداد");
      expect(text).toContain("بعد تقييم الطبيب، افتح حالة التقويم بالنطاق المطابق. ربط السجل السريري لا يثبت التغطية المالية؛ راجع حالة الفاتورة وبند العلاج قبل التوقيع.");
      expect(text).not.toContain("بباقتها المفوترة تلقائيًا");
      expect(text).not.toContain("مقبول ماليًّا");
      await page.locator('[data-testid="patient-ortho-workspace"][data-read-state="ready"]').waitFor();
      const workspace = await page.getByTestId("patient-ortho-workspace").elementHandle();
      let navigations = 0;
      page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
      await page.getByRole("button", { name: "+ فتح حالة تقويم جديدة", exact: true }).click();
      await page.getByLabel("الفكّان المعالَجان", { exact: true }).selectOption("both");
      const intake = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/ortho"
        && response.request().method() === "POST");
      const refreshedWorkflow = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/patients/${cancelledPatientId}/workflow`
        && response.request().method() === "GET");
      await page.getByRole("button", { name: "افتح الحالة", exact: true }).click();
      const intakeResponse = await intake;
      expect(intakeResponse.ok()).toBe(true);
      expect(intakeResponse.request().postDataJSON()).toMatchObject({ patientId: cancelledPatientId, arches: "both" });
      expect(intakeResponse.request().postDataJSON()).not.toHaveProperty("planId");
      const refreshedResponse = await refreshedWorkflow;
      expect(refreshedResponse.ok()).toBe(true);
      expect(await refreshedResponse.json()).toMatchObject({ patient: { id: cancelledPatientId }, assessmentCases: [] });
      await banner.waitFor({ state: "detached" });
      expect(await workspace!.evaluate((element) => element.isConnected)).toBe(true);
      expect(navigations).toBe(0);
      // The current funding contract requires an explicit same-patient installment agreement.
      const { rows: orthoCases } = await db.query<{ id: number; plan_id: number | null; funded: boolean }>(
        `SELECT c.id, c.plan_id, EXISTS (SELECT 1 FROM treatment_plans p JOIN plan_installments i ON i.plan_id = p.id
          WHERE p.id = c.plan_id AND p.patient_id = c.patient_id AND p.status <> 'cancelled') AS funded
         FROM ortho_cases c WHERE c.patient_id = $1`, [cancelledPatientId]);
      expect(orthoCases).toEqual([{ id: expect.any(Number), plan_id: null, funded: false }]);
      expect((await db.query(`SELECT id, origin, ortho_case_id FROM clinical_cases WHERE patient_id = $1`, [cancelledPatientId])).rows)
        .toEqual([{ id: caseId, origin: "invoice", ortho_case_id: orthoCases[0].id }]);
      expect(await financialState()).toEqual(cancelled);
    } finally {
      await context.close();
    }
  });
});
