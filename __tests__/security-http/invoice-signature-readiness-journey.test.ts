import { mkdir, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

/** Built-browser signature controls backed by real persisted invoice/plan/visit state.
 * Negative transport fixtures alter only an already-validated real GET response. They
 * never fabricate approval, alter the database or count a mocked signature as success.
 */
interface Fixture { patientId: number; visitId: number; planId: number; itemId: number; invoiceId: number }
interface Evidence {
  id: number; patientId: number; signedAt: string | null;
  procedures: { id: number; planItemId: number | null }[];
  sessionPricing: { procedureId: number; planItemId: number; financialReviewRequired?: boolean; clinicalConsentRecorded?: boolean }[];
  [key: string]: unknown;
}
let h: Awaited<ReturnType<typeof harness>>;
let browser: Browser;
let db: Client;
let doctorId = 0;
let serviceId = 0;
const stamp = Date.now();
const contexts = new Set<BrowserContext>();
const ARTIFACTS = ".settings-ui-artifacts";

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ party_id: doctorId }] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`));
  ({ rows: [{ id: serviceId }] } = await db.query<{ id: number }>(`INSERT INTO services
    (name, category, price_minor, price_configured, is_active) VALUES ($1, 'rct', 6000000, TRUE, TRUE) RETURNING id`, [`عصب قبول التوقيع ${stamp}`]));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(ARTIFACTS, { recursive: true });
}, 240_000);
afterAll(async () => {
  await Promise.all([...contexts].map((context) => context.close()));
  await browser?.close();
  await db?.end();
});

async function mutation<T>(who: "reception" | "doctorA", path: string, body: unknown, status: number): Promise<T> {
  const response = await authedMutation(path, h.sessions[who], "POST", JSON.stringify(body));
  const text = await response.text();
  expect(response.status, `${path}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}
async function consent(f: Fixture) {
  await mutation("reception", `/api/plans/${f.planId}/consent`, { note: "موافقة سريرية صريحة للاختبار" }, 201);
}
async function fixture(label: string, knownProvider: boolean, withConsent: boolean): Promise<Fixture> {
  const { rows: [{ id: patientId }] } = await db.query<{ id: number }>(`INSERT INTO patients
    (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`, [`ISR-${stamp}-${label}`, `مريض قبول التوقيع ${label}`, doctorId]);
  const invoice = await mutation<{ id: number; clinical: { planId: number; links: { planItemId: number }[] } }>("reception", "/api/invoices", {
    patientId, currency: "YER", items: [{ serviceId, toothCode: 36, ...(knownProvider ? { doctorId } : {}) }],
  }, 201);
  const itemId = invoice.clinical.links[0].planItemId;
  const { rows: [{ planned_visit_id: plannedVisitId }] } = await db.query<{ planned_visit_id: number }>(
    `SELECT planned_visit_id FROM treatment_sessions WHERE plan_item_id = $1 ORDER BY sequence LIMIT 1`, [itemId]);
  const visit = await mutation<{ id: number }>("reception", "/api/visits", { plannedVisitId }, 201);
  const f = { patientId, itemId, planId: invoice.clinical.planId, invoiceId: invoice.id, visitId: visit.id };
  if (withConsent) await consent(f);
  return f;
}
async function open(f: Fixture): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar-YE" });
  contexts.add(context);
  const [name, ...value] = h.sessions.doctorA.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(`${baseUrl}/patients/${f.patientId}?tab=today`, { waitUntil: "domcontentloaded" });
  return { context, page };
}
async function close(context: BrowserContext) { await context.close(); contexts.delete(context); }
async function stage(page: Page, f: Fixture) {
  const execute = page.getByTestId(`planned-item-${f.itemId}`).getByRole("button", { name: "+ نفّذ اليوم", exact: true });
  await expect.poll(() => execute.isEnabled()).toBe(true);
  await page.getByLabel("الطبيب المعالج", { exact: false }).selectOption(String(doctorId));
  await execute.click();
  const saved = page.waitForResponse((response) => response.url().endsWith(`/api/visits/${f.visitId}/clinical`)
    && response.request().method() === "POST" && response.request().postDataJSON()?.action !== "sign");
  await page.getByRole("button", { name: "احفظ بلا توقيع", exact: true }).click();
  expect((await saved).status()).toBe(200);
  expect((await db.query(`SELECT plan_item_id, doctor_id, tooth_code FROM visit_procedures WHERE visit_id = $1`, [f.visitId])).rows)
    .toEqual([{ plan_item_id: f.itemId, doctor_id: doctorId, tooth_code: 36 }]);
}
async function evidence(f: Fixture): Promise<Evidence> {
  const response = await authedGet(`/api/visits/${f.visitId}/clinical`, h.sessions.doctorA);
  expect(response.status).toBe(200);
  const dto = await response.json() as Evidence;
  expect(dto).toMatchObject({ id: f.visitId, patientId: f.patientId, signedAt: null });
  expect(dto.procedures).toHaveLength(1);
  expect(dto.sessionPricing).toHaveLength(1);
  expect(dto.sessionPricing[0]).toMatchObject({ procedureId: dto.procedures[0].id, planItemId: f.itemId });
  return dto;
}
async function unchanged(f: Fixture) {
  expect((await db.query(`SELECT signed_at, invoice_id FROM visits WHERE id = $1`, [f.visitId])).rows)
    .toEqual([{ signed_at: null, invoice_id: null }]);
  expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [f.patientId])).rows).toEqual([{ id: f.invoiceId }]);
  expect((await db.query(`SELECT id FROM treatment_sessions WHERE visit_id = $1 AND status = 'done'`, [f.visitId])).rows).toEqual([]);
  expect((await db.query(`SELECT doctor_id FROM visit_procedures WHERE visit_id = $1`, [f.visitId])).rows).toEqual([{ doctor_id: doctorId }]);
}
async function review(page: Page) {
  await page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "مراجعة وإنهاء الزيارة", exact: true });
  await dialog.waitFor();
  return dialog;
}
async function capture(page: Page, name: string, proof: Record<string, unknown>) {
  await page.screenshot({ path: `${ARTIFACTS}/invoice-signature-${name}.png`, fullPage: true });
  await writeFile(`${ARTIFACTS}/invoice-signature-${name}.json`, JSON.stringify(proof, null, 2));
}

describe("Real review/confirmation button obeys authoritative clinical-financial readiness", () => {
  it("missing consent permits real draft care, blocks the real confirmation, then explicit consent enables a real signature", async () => {
    const f = await fixture("consent", true, false);
    const { page, context } = await open(f);
    await stage(page, f);
    const before = await evidence(f);
    expect(before.sessionPricing[0]).toMatchObject({ financialReviewRequired: false, clinicalConsentRecorded: false });
    let signRequests = 0;
    page.on("request", (request) => {
      if (request.url().endsWith(`/api/visits/${f.visitId}/clinical`) && request.method() === "POST"
        && request.postDataJSON()?.action === "sign") signRequests += 1;
    });
    const blocked = await review(page);
    expect(await blocked.getByRole("button", { name: "التوقيع متوقف لحين استكمال المراجعة", exact: true }).isDisabled()).toBe(true);
    expect(await page.getByTestId("visit-signature-blocked").innerText()).toContain("الموافقة السريرية");
    expect(signRequests).toBe(0);
    await unchanged(f);
    await capture(page, "missing-consent", { case: "persisted_missing_consent", blocked: true, signRequests, visitId: f.visitId });
    await blocked.getByRole("button", { name: "رجوع — أكمل العمل", exact: true }).click();
    await consent(f);
    await page.reload({ waitUntil: "domcontentloaded" });
    const ready = await evidence(f);
    expect(ready.sessionPricing[0]).toMatchObject({ financialReviewRequired: false, clinicalConsentRecorded: true });
    const allowed = await review(page);
    const confirm = allowed.getByRole("button", { name: /وقّع الزيارة|تأكيد إنهاء الزيارة/ });
    expect(await confirm.isEnabled()).toBe(true);
    await capture(page, "ready", { case: "persisted_explicit_consent", enabled: true, visitId: f.visitId });
    const signedResponse = page.waitForResponse((response) => response.url().endsWith(`/api/visits/${f.visitId}/clinical`)
      && response.request().method() === "POST" && response.request().postDataJSON()?.action === "sign");
    await confirm.click();
    const signed = await signedResponse;
    expect(signed.status()).toBe(200);
    expect(await signed.json()).toMatchObject({ id: f.visitId, invoiceId: null, duesMinor: 0 });
    expect(signRequests).toBe(1);
    expect((await db.query(`SELECT signed_at FROM visits WHERE id = $1`, [f.visitId])).rows[0].signed_at).not.toBeNull();
    expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [f.patientId])).rows).toEqual([{ id: f.invoiceId }]);
    expect((await db.query(`SELECT id FROM treatment_sessions WHERE visit_id = $1 AND status = 'done'`, [f.visitId])).rows).toHaveLength(1);
    await close(context);
  }, 180_000);

  it("persisted unknown financial provider permits the actual clinician's draft, but confirmation remains blocked", async () => {
    const f = await fixture("review", false, true);
    const { page, context } = await open(f);
    await stage(page, f);
    expect((await evidence(f)).sessionPricing[0]).toMatchObject({ financialReviewRequired: true, clinicalConsentRecorded: true });
    const dialog = await review(page);
    expect(await dialog.getByRole("button", { name: "التوقيع متوقف لحين استكمال المراجعة", exact: true }).isDisabled()).toBe(true);
    await unchanged(f);
    expect((await db.query(`SELECT doctor_id FROM invoice_items WHERE invoice_id = $1`, [f.invoiceId])).rows).toEqual([{ doctor_id: null }]);
    await mutation("reception", `/api/visits/${f.visitId}/clinical`, { action: "sign" }, 403);
    await unchanged(f);
    await capture(page, "financial-review", { case: "persisted_unknown_provider", blocked: true, actualDoctorId: doctorId, visitId: f.visitId });
    await close(context);
  }, 120_000);

  it.each(["truncated", "missing_flags", "wrong_correlation", "duplicate"] as const)(
    "a valid persisted fixture with %s read evidence cannot enable confirmation", async (fault) => {
      const f = await fixture(fault, true, true);
      const { page, context } = await open(f);
      await stage(page, f);
      const canonical = await evidence(f);
      expect(canonical.sessionPricing[0]).toMatchObject({ financialReviewRequired: false, clinicalConsentRecorded: true });
      let alteredReads = 0;
      let signRequests = 0;
      page.on("request", (request) => {
        if (request.url().endsWith(`/api/visits/${f.visitId}/clinical`) && request.method() === "POST"
          && request.postDataJSON()?.action === "sign") signRequests += 1;
      });
      await page.route(`**/api/visits/${f.visitId}/clinical`, async (route) => {
        if (route.request().method() !== "GET") { await route.continue(); return; }
        const actual = await route.fetch();
        expect(actual.status()).toBe(200);
        const body = await actual.json() as Evidence;
        expect(body.sessionPricing[0]).toMatchObject({ financialReviewRequired: false, clinicalConsentRecorded: true });
        if (fault === "truncated") body.sessionPricing = [];
        if (fault === "missing_flags") delete body.sessionPricing[0].financialReviewRequired;
        if (fault === "wrong_correlation") body.sessionPricing[0].procedureId += 1000000;
        if (fault === "duplicate") body.sessionPricing.push({ ...body.sessionPricing[0] });
        alteredReads += 1;
        await route.fulfill({ response: actual, json: body });
      });
      // The supported review=1 entry opens the real dialog directly from the read.
      // It avoids a fresh successful save replacing the deliberately malformed GET.
      await page.goto(`${baseUrl}/patients/${f.patientId}?tab=today&review=1`, { waitUntil: "domcontentloaded" });
      const dialog = page.getByRole("dialog", { name: "مراجعة وإنهاء الزيارة", exact: true });
      await dialog.waitFor();
      expect(await dialog.getByRole("button", { name: "التوقيع متوقف لحين استكمال المراجعة", exact: true }).isDisabled()).toBe(true);
      expect(alteredReads).toBeGreaterThan(0);
      expect(signRequests).toBe(0);
      await unchanged(f);
      await capture(page, fault, { case: `negative_read_${fault}`, canonicalServerReady: true, alteredReads, signRequests, blocked: true, visitId: f.visitId });
      await close(context);
    }, 120_000);

  it("a denied clinical read retires the prior valid visit and exposes no usable confirmation", async () => {
    const f = await fixture("denied", true, true);
    const { page, context } = await open(f);
    await stage(page, f);
    expect((await evidence(f)).sessionPricing[0]).toMatchObject({ financialReviewRequired: false, clinicalConsentRecorded: true });
    await page.route(`**/api/visits/${f.visitId}/clinical`, async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "غير مصرّح لك بقراءة الزيارة" }) });
    });
    const denied = page.waitForResponse((response) => response.url().endsWith(`/api/visits/${f.visitId}/clinical`) && response.status() === 403);
    const saved = page.waitForResponse((response) => response.url().endsWith(`/api/visits/${f.visitId}/clinical`)
      && response.request().method() === "POST" && response.request().postDataJSON()?.action !== "sign");
    // Keep the editor mounted: a real ordinary save succeeds, then its authoritative
    // reload is denied. Previously authorized controls must retire in this same owner.
    await page.getByRole("button", { name: "احفظ بلا توقيع", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await denied;
    await page.getByRole("button", { name: "أعد تحميل الزيارة", exact: true }).waitFor();
    await expect.poll(() => page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true }).count()).toBe(0);
    expect(await page.getByRole("dialog", { name: "مراجعة وإنهاء الزيارة", exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: /وقّع الزيارة|تأكيد إنهاء الزيارة/ }).count()).toBe(0);
    await unchanged(f);
    await capture(page, "denied", { case: "mounted_editor_reload_denied", previousServerReady: true, realDraftSaveSucceeded: true,
      confirmationExposed: false, visitId: f.visitId });
    await close(context);
  }, 120_000);
});
