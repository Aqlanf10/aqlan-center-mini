import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
import { formatAmount } from "../../lib/money";

/** Three independent journeys on the existing built-app/isolated PG harness.
 * Invoice tooth selection, clinical plan staging and collection use real browser controls.
 * Queue, specialty records, signing and scheduling use the real authenticated HTTP APIs.
 * SQL seeds only synthetic patients/services/shift and reads persisted evidence; it never
 * manufactures a visit, consent, invoice, signed record, completed session or appointment.
 */
type Category = "ortho" | "rct" | "crown";
type Who = "reception" | "doctorA" | "admin";
interface Link { planItemId: number; caseId: number; specialty: string }
interface Invoice { id: number; totalMinor: number; discountMinor: number; clinical: { planId: number; links: Link[] } }
interface Planned { id: number; sequence: number; status: string; sessionStatus: string; visitId: number | null }
interface Clinical {
  id: number; patientId: number; doctorId: number | null; status: string; signedAt: string | null;
  invoiceId: number | null; duesMinor?: number;
  procedures: { planItemId: number; serviceId: number; toothCode: number | null; surfaces: string | null; doctorId: number; unitPriceMinor: number }[];
  outstanding: { planItemId: number; serviceId: number; toothCode: number | null; surfaces?: string | null;
    clinicalConsentRecorded?: boolean; financialReviewRequired?: boolean; unmetRequirements?: string[] }[];
  nextPlannedVisit?: { id: number; suggestedDate: string | null } | null;
}
let h: Awaited<ReturnType<typeof harness>>;
let browser: Browser;
let db: Client;
let doctorId = 0;
const stamp = Date.now();
const services: Record<Category, number> = { ortho: 0, rct: 0, crown: 0 };
const prices: Record<Category, number> = { ortho: 30000000, rct: 6000000, crown: 9000000 };
const contexts = new Set<BrowserContext>();
let scheduleOffset = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ party_id: doctorId }] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`));
  for (const category of Object.keys(services) as Category[]) {
    ({ rows: [{ id: services[category] }] } = await db.query<{ id: number }>(`INSERT INTO services
      (name, price_minor, is_active, price_configured, category) VALUES ($1, $2, TRUE, TRUE, $3) RETURNING id`,
    [`قبول رحلة ${category} ${stamp}`, prices[category], category]));
  }
  await db.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
    SELECT 'invoice-clinic-acceptance', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => {
  await Promise.all([...contexts].map((context) => context.close()));
  await browser?.close();
  await db?.end();
});

async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, values)).rows as T[];
}
async function mutate<T>(who: Who, method: "POST" | "PUT" | "PATCH", path: string, body: unknown, status = 200): Promise<T> {
  const response = await authedMutation(path, h.sessions[who], method, JSON.stringify(body));
  const text = await response.text();
  expect(response.status, `${method} ${path}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}
async function read<T>(who: Who, path: string): Promise<T> {
  const response = await authedGet(path, h.sessions[who]);
  const text = await response.text();
  expect(response.status, `GET ${path}: ${text}`).toBe(200);
  return JSON.parse(text) as T;
}
async function patient(label: string): Promise<number> {
  return (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name, primary_doctor_id)
    VALUES ($1, $2, $3) RETURNING id`, [`ICJ-${stamp}-${label}`, `مريض قبول اصطناعي ${label}`, doctorId]))[0].id;
}
async function open(who: Who, patientId: number, tab = "account") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar-YE" });
  contexts.add(context);
  const [name, ...value] = h.sessions[who].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(`${baseUrl}/patients/${patientId}?tab=${tab}`, { waitUntil: "domcontentloaded" });
  return { context, page };
}
async function close(context: BrowserContext) { await context.close(); contexts.delete(context); }

async function invoiceDraft(patientId: number, category: Category, tooth: number | null) {
  const view = await open("reception", patientId);
  const { page } = view;
  await page.getByRole("button", { name: "فاتورة يدوية", exact: true }).click();
  await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(services[category]));
  // Explicit reception choice from the authorized catalogue, never inferred from the signer.
  await page.getByTestId("invoice-provider-0").selectOption(String(doctorId));
  if (tooth === null) {
    await page.getByTestId("invoice-row-0").getByTestId("scope-both").click();
    expect(await page.getByTestId("invoice-tooth-button-0").count()).toBe(0);
  } else {
    await page.getByTestId("invoice-tooth-button-0").click();
    const dialog = page.getByTestId("tooth-dialog");
    await dialog.getByTestId(`odontogram-tooth-${tooth}`).click();
    expect(await dialog.getByTestId(`odontogram-tooth-${tooth}`).getAttribute("aria-pressed")).toBe("true");
    await page.getByTestId("tooth-dialog-confirm").click();
    await dialog.waitFor({ state: "detached" });
    expect(await page.getByTestId("invoice-row-0").getAttribute("data-tooth")).toBe(String(tooth));
    // A cancelled edit must not change the selected tooth or write an invoice.
    await page.getByTestId("invoice-tooth-button-0").click();
    await dialog.getByTestId("odontogram-tooth-11").click();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(await page.getByTestId("invoice-row-0").getAttribute("data-tooth")).toBe(String(tooth));
  }
  await page.locator('[data-testid="invoice-clinical-preview-0"][data-preview-state="ready"]').waitFor();
  expect(await page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).isEnabled()).toBe(true);
  return view;
}

async function invoice(patientId: number, category: Category, tooth: number | null,
  mode: "double_click" | "lost_response" | "two_tabs" = "double_click"): Promise<Invoice> {
  const first = await invoiceDraft(patientId, category, tooth);
  const second = mode === "two_tabs" ? await invoiceDraft(patientId, category, tooth) : null;
  const keys: string[] = [];
  let dropped = false;
  if (mode === "lost_response") await first.page.route("**/api/invoices", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    keys.push(String(route.request().postDataJSON().idempotencyKey ?? ""));
    if (!dropped) {
      dropped = true;
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      await route.abort("failed");
    } else await route.continue();
  });
  const save = first.page.getByRole("button", { name: "احفظ الفاتورة", exact: true });
  if (mode === "lost_response") {
    await save.click();
    await first.page.getByRole("alert", { name: "خطأ حساب المريض" }).filter({ hasText: "تعذّر الاتصال بالخادم" }).waitFor();
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toHaveLength(1);
  }
  const responsePromise = first.page.waitForResponse((response) => response.url().endsWith("/api/invoices") && response.request().method() === "POST");
  if (mode === "double_click") await save.dblclick(); else await save.click();
  const response = await responsePromise;
  expect(response.status()).toBe(mode === "lost_response" ? 200 : 201);
  const result = await response.json() as Invoice;
  await first.page.getByTestId("invoice-clinical-notice").waitFor();
  if (mode === "lost_response") {
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(keys[1]).toBe(keys[0]);
  }
  if (second) {
    const refused = second.page.waitForResponse((candidate) => candidate.url().endsWith("/api/invoices") && candidate.request().method() === "POST");
    await second.page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).click();
    expect((await refused).status()).toBe(409);
    await second.page.getByRole("alert", { name: "خطأ حساب المريض" }).waitFor();
    await close(second.context);
  }
  await close(first.context);
  expect(result.clinical.links).toHaveLength(1);
  const link = result.clinical.links[0];
  expect((await q(`SELECT plan_item_id, doctor_id FROM invoice_items WHERE invoice_id = $1`, [result.id]))[0])
    .toEqual({ plan_item_id: link.planItemId, doctor_id: doctorId });
  expect((await q(`SELECT tooth_code, surfaces, case_id, origin_invoice_id FROM plan_items WHERE id = $1`, [link.planItemId]))[0])
    .toEqual({ tooth_code: tooth, surfaces: null, case_id: link.caseId, origin_invoice_id: result.id });
  expect((await q(`SELECT patient_id, specialty, site FROM clinical_cases WHERE id = $1`, [link.caseId]))[0])
    .toEqual({ patient_id: patientId, specialty: link.specialty, site: tooth === null ? "الفكّان" : String(tooth) });
  expect((await q(`SELECT consent_at FROM treatment_plans WHERE id = $1`, [result.clinical.planId]))[0]).toEqual({ consent_at: null });
  return result;
}

async function consent(planId: number) {
  await mutate("reception", "POST", `/api/plans/${planId}/consent`, { note: "موافقة صريحة اصطناعية بعد تقييم الطبيب" }, 201);
  expect((await q(`SELECT consent_at FROM treatment_plans WHERE id = $1`, [planId]))[0].consent_at).not.toBeNull();
}
async function planned(itemId: number): Promise<Planned[]> {
  return q<Planned>(`SELECT pv.id, ts.sequence, pv.status, ts.status AS "sessionStatus", ts.visit_id AS "visitId" FROM treatment_sessions ts
    JOIN planned_visits pv ON pv.id = ts.planned_visit_id WHERE ts.plan_item_id = $1 ORDER BY ts.sequence`, [itemId]);
}
async function pendingSession(itemId: number, sequence: number): Promise<Planned> {
  // Invoice-origin, non-template sessions initially share one planned visit.
  // Signing closes it and reassigns the next session to a new planned visit;
  // a cached pre-sign array is not the next appointment's current identity.
  const sessions = await planned(itemId);
  const matches = sessions.filter((session) => session.sequence === sequence);
  expect(matches, `one persisted session at sequence ${sequence}`).toHaveLength(1);
  const next = matches[0];
  expect(next).toMatchObject({ status: "planned", sessionStatus: "planned", visitId: null });
  for (const earlier of sessions.filter((session) => session.sequence < sequence)) {
    expect(earlier.sessionStatus, `earlier session ${earlier.sequence} completed through signing`).toBe("done");
  }
  return next;
}
async function nextAfterSign(itemId: number, sequence: number, previousId: number, signed: Clinical): Promise<Planned> {
  const next = await pendingSession(itemId, sequence);
  expect(next.id, "next session cannot reuse the completed planned visit").not.toBe(previousId);
  expect(signed.nextPlannedVisit).toMatchObject({ id: next.id });
  return next;
}
async function arriveAndSeat(patientId: number, plannedVisitId: number): Promise<number> {
  const visit = await mutate<{ id: number; status: string }>("reception", "POST", "/api/visits", { plannedVisitId }, 201);
  expect(visit.status).toBe("waiting");
  await mutate("reception", "POST", "/api/visits", { plannedVisitId }, 409);
  expect(await q(`SELECT id FROM visits WHERE planned_visit_id = $1`, [plannedVisitId])).toEqual([{ id: visit.id }]);
  expect((await q(`SELECT patient_id FROM visits WHERE id = $1`, [visit.id]))[0]).toEqual({ patient_id: patientId });
  await mutate("reception", "PATCH", `/api/visits/${visit.id}`, { action: "clear" });
  const [{ chair }] = await q<{ chair: number }>(`SELECT n AS chair FROM generate_series(1, 20) n
    WHERE NOT EXISTS (SELECT 1 FROM visits WHERE chair = n AND status IN ('called', 'in_chair')) ORDER BY n LIMIT 1`);
  expect(chair).toBeGreaterThan(0);
  await mutate("reception", "PATCH", `/api/visits/${visit.id}`, { action: "call", chair });
  expect((await q(`SELECT status, chair FROM visits WHERE id = $1`, [visit.id]))[0]).toEqual({ status: "called", chair });
  await mutate("reception", "PATCH", `/api/visits/${visit.id}`, { action: "return" });
  expect((await q(`SELECT status, chair FROM visits WHERE id = $1`, [visit.id]))[0]).toEqual({ status: "waiting", chair: null });
  await mutate("reception", "PATCH", `/api/visits/${visit.id}`, { action: "call", chair });
  await mutate("reception", "PATCH", `/api/visits/${visit.id}`, { action: "seat", chair });
  expect((await q(`SELECT status, chair FROM visits WHERE id = $1`, [visit.id]))[0]).toEqual({ status: "in_chair", chair });
  return visit.id;
}

async function stageThroughUi(patientId: number, visitId: number, itemId: number, category: Category, tooth: number | null) {
  const before = await read<Clinical>("doctorA", `/api/visits/${visitId}/clinical`);
  expect(before.patientId).toBe(patientId);
  expect(before.outstanding.find((item) => item.planItemId === itemId)).toMatchObject({
    serviceId: services[category], toothCode: tooth, surfaces: null, clinicalConsentRecorded: true, financialReviewRequired: false,
  });
  const { page, context } = await open("doctorA", patientId, "today");
  await page.getByLabel("الطبيب المعالج", { exact: false }).selectOption(String(doctorId));
  await page.getByTestId(`planned-item-${itemId}`).getByRole("button", { name: "+ نفّذ اليوم", exact: true }).click();
  const saving = page.waitForResponse((response) => response.url().endsWith(`/api/visits/${visitId}/clinical`)
    && response.request().method() === "POST" && response.request().postDataJSON()?.action !== "sign");
  await page.getByRole("button", { name: "احفظ بلا توقيع", exact: true }).click();
  expect((await saving).status()).toBe(200);
  // One review dismissal proves cancellation does not sign, consume a session or charge.
  if (category !== "ortho") {
    await page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true }).click();
    const review = page.getByRole("dialog", { name: "مراجعة وإنهاء الزيارة", exact: true });
    await review.getByRole("button", { name: "رجوع — أكمل العمل", exact: true }).click();
    expect((await q(`SELECT signed_at FROM visits WHERE id = $1`, [visitId]))[0]).toEqual({ signed_at: null });
    expect(await q(`SELECT id FROM treatment_sessions WHERE visit_id = $1 AND status = 'done'`, [visitId])).toEqual([]);
  }
  await close(context);
  const loaded = await read<Clinical>("doctorA", `/api/visits/${visitId}/clinical`);
  expect(loaded.procedures).toHaveLength(1);
  expect(loaded.procedures[0]).toMatchObject({ planItemId: itemId, serviceId: services[category], toothCode: tooth,
    surfaces: null, doctorId, unitPriceMinor: 0 });
  expect(await q(`SELECT plan_item_id, service_id, tooth_code, surfaces, doctor_id, unit_price_minor::int
    FROM visit_procedures WHERE visit_id = $1`, [visitId])).toEqual([{
    plan_item_id: itemId, service_id: services[category], tooth_code: tooth, surfaces: null, doctor_id: doctorId, unit_price_minor: 0,
  }]);
}
async function signOnce(patientId: number, visitId: number, expectedInvoices: number, itemId: number, session: Planned) {
  const responses = await Promise.all([0, 1].map(() => authedMutation(`/api/visits/${visitId}/clinical`, h.sessions.doctorA,
    "POST", JSON.stringify({ action: "sign" }))));
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  const signed = await responses.find((response) => response.status === 200)!.json() as Clinical;
  expect(signed).toMatchObject({ id: visitId, patientId, status: "signed", invoiceId: null, duesMinor: 0 });
  const persisted = await read<Clinical>("doctorA", `/api/visits/${visitId}/clinical`);
  expect(persisted).toMatchObject({ id: visitId, patientId, status: "signed", invoiceId: null });
  expect(persisted.signedAt).not.toBeNull();
  expect(await q(`SELECT ii.doctor_id FROM invoice_items ii JOIN visit_procedures vp ON vp.plan_item_id = ii.plan_item_id
    WHERE vp.visit_id = $1 AND ii.source_type = 'plan_item'`, [visitId])).toEqual([{ doctor_id: doctorId }]);
  expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toHaveLength(expectedInvoices);
  expect(await q(`SELECT ii.id FROM invoice_items ii JOIN visit_procedures vp ON vp.id = ii.source_id
    WHERE ii.source_type = 'visit_procedure' AND vp.visit_id = $1`, [visitId])).toEqual([]);
  expect(await q(`SELECT id FROM treatment_sessions WHERE visit_id = $1 AND status = 'done'`, [visitId])).toHaveLength(1);
  expect((await q(`SELECT status FROM visits WHERE id = $1`, [visitId]))[0]).toEqual({ status: "done" });
  expect((await planned(itemId)).find((current) => current.sequence === session.sequence)).toEqual({
    id: session.id, sequence: session.sequence, status: "completed", sessionStatus: "done", visitId,
  });
  expect(await q(`SELECT status, visit_id FROM planned_visits WHERE id = $1`, [session.id]))
    .toEqual([{ status: "completed", visit_id: visitId }]);
  return signed;
}

async function collectThroughUi(patientId: number, target: Invoice, loseResponse = false) {
  const { context, page } = await open("reception", patientId);
  await page.getByRole("button", { name: "قبض دفعة", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "تحصيل دفعة", exact: true });
  await dialog.getByLabel("فاتورة الهدف", { exact: true }).selectOption(String(target.id));
  await dialog.getByLabel("المبلغ", { exact: true }).fill(formatAmount(target.totalMinor - target.discountMinor, "YER"));
  const keys: string[] = [];
  let dropped = false;
  await page.route("**/api/payments", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    if (loseResponse && !dropped) {
      dropped = true;
      expect((await route.fetch()).status()).toBe(201);
      await route.abort("failed");
    } else await route.continue();
  });
  const submit = dialog.getByRole("button", { name: "سجّل الدفعة واطبع السند", exact: true });
  if (loseResponse) {
    await submit.click();
    await dialog.getByRole("button", { name: "إعادة التحقق من العملية السابقة", exact: true }).waitFor();
    expect(await submit.isDisabled()).toBe(true);
    expect(await q(`SELECT id FROM payments WHERE patient_id = $1 AND invoice_id = $2`, [patientId, target.id])).toHaveLength(1);
  }
  const response = page.waitForResponse((candidate) => candidate.url().endsWith("/api/payments") && candidate.request().method() === "POST");
  await (loseResponse ? dialog.getByRole("button", { name: "إعادة التحقق من العملية السابقة", exact: true }) : submit).click();
  expect((await response).status()).toBe(loseResponse ? 200 : 201);
  await dialog.waitFor({ state: "hidden" });
  expect(new Set(keys).size).toBe(1);
  expect(keys).toHaveLength(loseResponse ? 2 : 1);
  expect(keys[0]).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  expect(await q(`SELECT invoice_id, amount_minor::int, currency FROM payments WHERE patient_id = $1 AND invoice_id = $2`, [patientId, target.id]))
    .toEqual([{ invoice_id: target.id, amount_minor: target.totalMinor - target.discountMinor, currency: "YER" }]);
  await close(context);
}
async function checkoutAndNext(patientId: number, visitId: number, nextId: number, expectedInvoices: number) {
  const before = await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId]);
  const checkout = await read<{ lines: { billingClass: string }[]; summary: { currency: string; currentBalanceMinor: number; dueNowMinor: number }[] }>(
    "reception", `/api/visits/${visitId}/walkout`);
  expect(checkout.lines).toEqual([expect.objectContaining({ billingClass: "INCLUDED" })]);
  expect(checkout.summary.find((line) => line.currency === "YER")).toMatchObject({ currentBalanceMinor: 0, dueNowMinor: 0 });
  expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toEqual(before);
  expect(before).toHaveLength(expectedInvoices);
  expect(await q(`SELECT patient_id, status, appointment_id, visit_id FROM planned_visits WHERE id = $1`, [nextId]))
    .toEqual([{ patient_id: patientId, status: "planned", appointment_id: null, visit_id: null }]);
  // A distinct future weekday per journey avoids a shared-harness capacity collision.
  const date = new Date(Date.now() + (28 + scheduleOffset++ * 7) * 86_400_000);
  while (date.getUTCDay() !== 0) date.setUTCDate(date.getUTCDate() + 1);
  const scheduledDate = date.toISOString().slice(0, 10);
  const booking = await mutate<{ appointmentId: number }>("reception", "POST", `/api/planned-visits/${nextId}/schedule`,
    { date: scheduledDate, time: "17:00" }, 201);
  await mutate("reception", "POST", `/api/planned-visits/${nextId}/schedule`, { date: scheduledDate, time: "17:00" }, 409);
  expect(await q(`SELECT id, patient_id, status, scheduled_date::text AS scheduled_date FROM appointments WHERE id = $1`, [booking.appointmentId]))
    .toEqual([{ id: booking.appointmentId, patient_id: patientId, status: "booked", scheduled_date: scheduledDate }]);
  expect((await q(`SELECT status, appointment_id, visit_id FROM planned_visits WHERE id = $1`, [nextId]))[0])
    .toEqual({ status: "scheduled", appointment_id: booking.appointmentId, visit_id: null });
  const after = await read<{ nextAppointment: { date: string; time: string } }>("reception", `/api/visits/${visitId}/walkout`);
  expect(after.nextAppointment).toMatchObject({ date: scheduledDate, time: "17:00" });
}

async function openEndo(patientId: number, source: Invoice, tooth: number) {
  return mutate<{ id: number }>("doctorA", "POST", `/api/patients/${patientId}/endo`, { toothCode: tooth, caseId: source.clinical.links[0].caseId }, 201);
}
async function recordEndo(patientId: number, treatmentId: number, visitId: number, stage: "assessment" | "shaping" | "obturation", staleWitness = false) {
  const path = `/api/patients/${patientId}/endo/${treatmentId}/visits`;
  const body = { visitId, stage, pulpalDiagnosis: "pulp_necrosis", apicalDiagnosis: "chronic_apical_abscess",
    canalsFound: 3, note: "سجل قبول اصطناعي", restorationAfter: stage === "obturation" ? "permanent" : "none",
    canals: ["MB", "ML", "D"].map((label, index) => ({ label, workingLengthMm: 20 + index,
      referencePoint: "cusp_tip", measurementMethod: "both", obturated: stage === "obturation" })) };
  await mutate("doctorA", "PUT", path, body, 201);
  await mutate("doctorA", "PUT", path, body, 200);
  if (staleWitness) {
    await mutate("doctorA", "PUT", path, { ...body, note: "التعديل الأحدث", expectedVersion: 1 });
    await mutate("doctorA", "PUT", path, { ...body, note: "تبويب قديم", expectedVersion: 1 }, 409);
    expect(await q(`SELECT note, version FROM endo_visits WHERE visit_id = $1`, [visitId])).toEqual([{ note: "التعديل الأحدث", version: 2 }]);
  }
  expect(await q(`SELECT visit_id FROM endo_visits WHERE treatment_id = $1 AND visit_id = $2`, [treatmentId, visitId])).toEqual([{ visit_id: visitId }]);
}

describe("Reception to next appointment: three invoice-origin clinical journeys", () => {
  it("Ortho: one invoice identity → actual specialty intake → waiting/chair → linked clinical work → sign → collection → checkout → next appointment", async () => {
    const patientId = await patient("ortho");
    const created = await invoice(patientId, "ortho", null, "double_click");
    const ortho = await mutate<{ id: number }>("doctorA", "POST", "/api/ortho", {
      patientId, planId: created.clinical.planId, appliance: "fixed_metal", arches: "both", slot: "022", plannedMonths: 18,
    }, 201);
    expect(await q(`SELECT id, ortho_case_id FROM clinical_cases WHERE patient_id = $1`, [patientId]))
      .toEqual([{ id: created.clinical.links[0].caseId, ortho_case_id: ortho.id }]);
    await consent(created.clinical.planId);
    const sessions = await planned(created.clinical.links[0].planItemId);
    expect(sessions.length).toBeGreaterThan(1);
    const first = await pendingSession(created.clinical.links[0].planItemId, 1);
    const visitId = await arriveAndSeat(patientId, first.id);
    await stageThroughUi(patientId, visitId, created.clinical.links[0].planItemId, "ortho", null);
    const signed = await signOnce(patientId, visitId, 1, created.clinical.links[0].planItemId, first);
    const next = await nextAfterSign(created.clinical.links[0].planItemId, 2, first.id, signed);
    await collectThroughUi(patientId, created);
    await checkoutAndNext(patientId, visitId, next.id, 1);
  }, 240_000);

  it("Endo tooth 36: lost invoice response, stale clinical tab and addendum preserve one treatment through collection and the next appointment", async () => {
    const patientId = await patient("endo36");
    const created = await invoice(patientId, "rct", 36, "lost_response");
    const endo = await openEndo(patientId, created, 36);
    await consent(created.clinical.planId);
    const first = await pendingSession(created.clinical.links[0].planItemId, 1);
    const visitId = await arriveAndSeat(patientId, first.id);
    await stageThroughUi(patientId, visitId, created.clinical.links[0].planItemId, "rct", 36);
    await recordEndo(patientId, endo.id, visitId, "assessment", true);
    const signed = await signOnce(patientId, visitId, 1, created.clinical.links[0].planItemId, first);
    const next = await nextAfterSign(created.clinical.links[0].planItemId, 2, first.id, signed);
    const [{ id: recordId }] = await q<{ id: number }>(`SELECT id FROM endo_visits WHERE visit_id = $1`, [visitId]);
    const path = `/api/patients/${patientId}/endo/${endo.id}/visits`;
    await mutate("doctorA", "PUT", path, { visitId, stage: "assessment", note: "كتابة فوق الموقّع", expectedVersion: 2 }, 409);
    const addition = { requestKey: `clinic:addendum-${stamp}`, text: "تصحيح اصطناعي يحفظ السجل الأصلي" };
    await mutate("doctorA", "POST", `${path}/${recordId}/addenda`, addition, 201);
    await mutate("doctorA", "POST", `${path}/${recordId}/addenda`, addition, 200);
    expect((await q(`SELECT note FROM endo_visits WHERE id = $1`, [recordId]))[0]).toEqual({ note: "التعديل الأحدث" });
    await collectThroughUi(patientId, created, true);
    await checkoutAndNext(patientId, visitId, next.id, 1);
  }, 240_000);

  it("Endo → Crown tooth 46: two stale invoice tabs, one patient/master, real signed RCT completion, then an exact linked crown visit", async () => {
    const patientId = await patient("endo-crown46");
    const rct = await invoice(patientId, "rct", 46, "two_tabs");
    const crown = await invoice(patientId, "crown", 46);
    expect(crown.clinical.planId).toBe(rct.clinical.planId);
    const endo = await openEndo(patientId, rct, 46);
    const linked = await mutate<{ crown: string }>("doctorA", "PATCH", `/api/patients/${patientId}/endo/${endo.id}/crown`, {
      crownRequired: true, rctPlanItemId: rct.clinical.links[0].planItemId, crownPlanItemId: crown.clinical.links[0].planItemId,
    });
    expect(linked.crown).toBe("waiting_rct");
    expect(await q(`SELECT item_id, requires_item_id, requirement FROM plan_item_dependencies WHERE item_id = $1`, [crown.clinical.links[0].planItemId]))
      .toEqual([{ item_id: crown.clinical.links[0].planItemId, requires_item_id: rct.clinical.links[0].planItemId, requirement: "completed" }]);
    await consent(rct.clinical.planId);
    const rctSessions = await planned(rct.clinical.links[0].planItemId);
    expect(rctSessions).toHaveLength(3);
    for (let index = 0; index < rctSessions.length; index += 1) {
      const session = await pendingSession(rct.clinical.links[0].planItemId, index + 1);
      const visitId = await arriveAndSeat(patientId, session.id);
      await stageThroughUi(patientId, visitId, rct.clinical.links[0].planItemId, "rct", 46);
      await recordEndo(patientId, endo.id, visitId, (["assessment", "shaping", "obturation"] as const)[index]);
      const signed = await signOnce(patientId, visitId, 2, rct.clinical.links[0].planItemId, session);
      if (index + 1 < rctSessions.length) {
        await nextAfterSign(rct.clinical.links[0].planItemId, index + 2, session.id, signed);
      } else {
        await nextAfterSign(crown.clinical.links[0].planItemId, 1, session.id, signed);
      }
    }
    expect((await q(`SELECT status FROM plan_items WHERE id = $1`, [rct.clinical.links[0].planItemId]))[0]).toEqual({ status: "done" });
    const completed = await mutate<{ status: string; crown: string }>("doctorA", "PATCH", `/api/patients/${patientId}/endo/${endo.id}`, { status: "completed" });
    expect(completed).toMatchObject({ status: "completed", crown: "ready" });
    const crownSessions = await planned(crown.clinical.links[0].planItemId);
    expect(crownSessions.length).toBeGreaterThan(1);
    const crownFirst = await pendingSession(crown.clinical.links[0].planItemId, 1);
    const crownVisitId = await arriveAndSeat(patientId, crownFirst.id);
    await stageThroughUi(patientId, crownVisitId, crown.clinical.links[0].planItemId, "crown", 46);
    const crownSigned = await signOnce(patientId, crownVisitId, 2, crown.clinical.links[0].planItemId, crownFirst);
    const crownNext = await nextAfterSign(crown.clinical.links[0].planItemId, 2, crownFirst.id, crownSigned);
    await collectThroughUi(patientId, rct);
    await collectThroughUi(patientId, crown);
    await checkoutAndNext(patientId, crownVisitId, crownNext.id, 2);
    expect(await q(`SELECT id FROM patients WHERE id = $1`, [patientId])).toHaveLength(1);
    expect(await q(`SELECT id FROM treatment_plans WHERE patient_id = $1`, [patientId])).toHaveLength(1);
    expect(await q(`SELECT specialty, site FROM clinical_cases WHERE patient_id = $1 ORDER BY specialty`, [patientId]))
      .toEqual([{ specialty: "endodontics", site: "46" }, { specialty: "prosthodontics", site: "46" }]);
  }, 360_000);
});
