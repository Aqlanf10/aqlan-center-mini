import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness, loginStaff } from "./_server";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { UNVERIFIED_VISIT_INVOICE_LABEL } from "../../lib/visit-financial-presentation";
import { VISIT_SOURCE_SUMMARY, type VisitFinancialContext } from "../../lib/visit-financial-context";
import { diagnoseVisitSourcePdfOcr } from "../helpers/visit-source-pdf-ocr";
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
let sourceAssistant: {cookie:string};
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
  const assistantName = `sourceassist${stamp}`;
  const assistantCreated = await authedMutation("/api/users", h.sessions.admin, "POST", JSON.stringify({
    username:assistantName, displayName:"مساعد قبول المصادر", password:"SourceAssist#Pass11", role:"assistant",
  }));
  expect(assistantCreated.status).toBeLessThan(300);
  sourceAssistant = await loginStaff(assistantName, "SourceAssist#Pass11");
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
async function read<T>(who: Who | "assistant", path: string): Promise<T> {
  const response = await authedGet(path, who === "assistant" ? sourceAssistant : h.sessions[who]);
  const text = await response.text();
  expect(response.status, `GET ${path}: ${text}`).toBe(200);
  return JSON.parse(text) as T;
}
async function patient(label: string): Promise<number> {
  return (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name, primary_doctor_id)
    VALUES ($1, $2, $3) RETURNING id`, [`ICJ-${stamp}-${label}`, `مريض قبول اصطناعي ${label}`, doctorId]))[0].id;
}
async function open(who: Who | "assistant", patientId: number, tab = "account") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar-YE" });
  contexts.add(context);
  const [name, ...value] = (who === "assistant" ? sourceAssistant : h.sessions[who]).cookie.split("=");
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
  await page.getByTestId("treatment-entry-open").click();
  await page.getByRole("button", { name: "علاج جديد", exact: true }).click();
  await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(services[category]));
  // Explicit reception choice from the authorized catalogue, never inferred from the signer.
  await page.getByTestId("invoice-provider-0").selectOption(String(doctorId));
  if (tooth === null) {
    await page.getByTestId("invoice-row-0").getByLabel("نطاق العلاج",{exact:true}).selectOption("both");
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
  const proof=page.locator('[data-testid="invoice-clinical-preview-0"][data-preview-state="ready"]');
  await proof.waitFor({state:"attached"});
  if(!await proof.isVisible())await proof.locator("..").locator("summary").click();
  await proof.waitFor();
  expect(await page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).isEnabled()).toBe(true);
  return view;
}

async function invoice(patientId: number, category: Category, tooth: number | null,
  mode: "double_click" | "lost_response" | "two_tabs" = "double_click"): Promise<Invoice> {
  const first = await invoiceDraft(patientId, category, tooth);
  const second = mode === "two_tabs" ? await invoiceDraft(patientId, category, tooth) : null;
  const keys: string[] = [];
  const bodies: unknown[] = [];
  let dropped = false;
  if (mode === "lost_response") await first.page.route("**/api/invoices", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    keys.push(String(route.request().postDataJSON().idempotencyKey ?? ""));
    bodies.push(route.request().postDataJSON());
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
    await first.page.getByRole("alert", { name: "تعذّر حفظ إجراء الحساب" }).filter({ hasText: "تعذّر الاتصال بالخادم" }).waitFor();
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toHaveLength(1);
    expect(await save.isEnabled()).toBe(false);
  }
  const [response] = await Promise.all([
    first.page.waitForResponse((response) => response.url().endsWith("/api/invoices") && response.request().method() === "POST"),
    mode === "lost_response"
      ? first.page.getByRole("button", { name: "إعادة نفس طلب الفاتورة", exact: true }).click()
      : mode === "double_click" ? save.dblclick() : save.click(),
  ]);
  expect(response.status()).toBe(mode === "lost_response" ? 200 : 201);
  const result = await response.json() as Invoice;
  await first.page.getByTestId("invoice-clinical-notice").waitFor();
  if (mode === "lost_response") {
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[1]).toEqual(bodies[0]);
  }
  if (second) {
    const refused = second.page.waitForResponse((candidate) => candidate.url().endsWith("/api/invoices") && candidate.request().method() === "POST");
    await second.page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).click();
    expect((await refused).status()).toBe(409);
    await second.page.getByRole("alert", { name: "تعذّر حفظ إجراء الحساب" }).waitFor();
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
  const sourceContext = await read<{summary:string;work:{kind:string;coverage:string;references:unknown[];reasons:string[]}[]}>("doctorA", `/api/visits/${visitId}/financial-context`);
  expect(sourceContext.work.filter(work => work.kind === "procedure")).toEqual([
    expect.objectContaining({coverage:"verified"}),
  ]);
  // The episode record has no exact RCT item edge: preserve the known gap even beside covered work.
  if ((await q("SELECT id FROM endo_visits WHERE visit_id=$1",[visitId])).length) {
    expect(sourceContext.summary).toBe("mixed");
    expect(sourceContext.work).toContainEqual(expect.objectContaining({kind:"endodontic_record",coverage:"unresolved",reasons:["endo_work_item_not_explicit"]}));
  } else expect(sourceContext.summary).toBe("verified");
  expect(sourceContext.work.every(work => work.references.length === 0)).toBe(true);

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
    await sourceAcceptance(patientId, [{ id: visitId, summary: "mixed" }], "mixed");
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

/** Supplemental acceptance: all reads below reach the built server. No response interception.
 * Only patient/catalogue bootstrap uses SQL; source identities, decisions and signatures use APIs.
 * These checks intentionally do not turn source coverage into receipts or monetary totals.
 */
async function sourceAcceptance(patientId: number, visits: {id: number; summary: VisitFinancialContext["summary"]}[], label: string) {
  const before = await q(`SELECT
    (SELECT count(*) FROM invoices WHERE patient_id=$1)::int AS invoices,
    (SELECT count(*) FROM payments WHERE patient_id=$1)::int AS payments,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM legacy_treatment_agreements a WHERE patient_id=$1) AS agreements`, [patientId]);
  for (const visit of visits) {
    for (const who of ["doctorA", "assistant", "reception", "admin"] as const) {
      const financial = who === "reception" || who === "admin";
      expect(await read<Clinical>(who, `/api/visits/${visit.id}/clinical`)).toMatchObject({id:visit.id,patientId,status:"signed",invoiceId:null});
      const data = await read<VisitFinancialContext>(who, `/api/visits/${visit.id}/financial-context`);
      expect(data).toMatchObject({ visitId: visit.id, patientId, signed: true, summary: visit.summary, directReference: null, directReferenceState: "missing" });
      expect(JSON.stringify(data)).not.toMatch(/"[^" ]*(?:Minor|total|paid|remaining)[^" ]*"/i);
      if (!financial) expect(data.work.every(line => line.references.length === 0)).toBe(true);
      if (financial && visit.summary === "mixed") {
        expect(data.work).toContainEqual(expect.objectContaining({coverage:"verified",references:expect.arrayContaining([expect.objectContaining({kind:"invoice",state:"current"})])}));
        expect(data.work).toContainEqual(expect.objectContaining({kind:"endodontic_record",coverage:"unresolved"}));
      }
      const view = await open(who, patientId);
      const reads: {path:string;status:number}[] = [];
      const observedPaths = new Set([`/api/visits/${visit.id}/clinical`, `/api/visits/${visit.id}/financial-context`, "/api/services", "/api/parties", "/api/auth/me"]);
      view.page.on("response", response => {
        const path = new URL(response.url()).pathname;
        if (response.request().method() === "GET" && observedPaths.has(path) && reads.length < 20) reads.push({path,status:response.status()});
      });
      try {
        await view.page.goto(`${baseUrl}/visits/${visit.id}`);
        if (who === "assistant") {
          // API admission does not grant the standalone page. Keep its existing denial.
          expect(new URL(view.page.url()).pathname).toBe("/");
          await view.page.goto(`${baseUrl}/patients/${patientId}?tab=today&visitId=${visit.id}`);
        }
        const panel = view.page.getByRole("region", {name: "مصادر عمل الزيارة"});
        try {
          await panel.waitFor(); // Preserve the existing 20-second timeout and visibility assertion.
        } catch (error) {
          const diagnostic = await view.page.evaluate(() => {
            const visible = (node:Element) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
            const text = (node:Element) => (node.textContent ?? "").replace(/\s+/g," ").trim().slice(0,180);
            const bounded = (selector:string) => [...document.querySelectorAll(selector)].filter(visible).slice(0,8).map(text);
            const regions = [...document.querySelectorAll('[aria-label="مصادر عمل الزيارة"]')];
            const readMessages = [...document.querySelectorAll("p")].filter(visible).map(text)
              .filter(value => /جارٍ تحميل الزيارة الحالية|تعذّر.*الزيارة|بيانات الزيارة|جارٍ التحقق من مصادر العمل|تعذّر التحقق من مصادر العمل/.test(value)).slice(0,6);
            return {
              // Omit query/hash values: never include credentials or arbitrary navigation parameters.
              actualPageUrl:location.origin + location.pathname,
              omittedQueryOrHash:Boolean(location.search || location.hash),
              headings:bounded("h1,h2"), statusOrErrors:bounded('[role="status"],[role="alert"]'), readMessages,
              clinicalWorkSectionMounted:Boolean(document.querySelector("#visit-procedures")),
              clinicalReadStateVisible:readMessages.length > 0,
              confirmedSignMarker:Boolean(document.querySelector('[data-testid="clinical-sign-confirmed"]')),
              sourceRegion:regions.length === 0 ? "absent" : regions.some(visible) ? "visible" : "hidden",
            };
          }).catch(() => ({diagnosticUnavailable:true}));
          const context = {role:who,requestedPatientId:patientId,requestedVisitId:visit.id,...diagnostic,reads,
            sourceGetRefused:reads.some(read => read.path.endsWith("/financial-context") && [401,403,404].includes(read.status))};
          if (error instanceof Error) { error.message += `\nBounded synthetic source diagnostic: ${JSON.stringify(context)}`; throw error; }
          throw error;
        }
        if (who === "assistant") {
          expect(await view.page.getByTestId("clinical-context-visit").getByText(`الزيارة المحددة #${visit.id}`, {exact:true}).count()).toBe(1);
          expect(new URL(view.page.url()).searchParams.get("visitId")).toBe(String(visit.id));
        }
        expect(await panel.innerText()).toContain(VISIT_SOURCE_SUMMARY[visit.summary]);
        const invoices = data.work.flatMap(line => line.references).filter(source => source.kind === "invoice" && source.state === "current");
        const expectedLinks = [...new Set(invoices.map(source => `/print/invoice/${source.id}`))];
        const actualLinks = await panel.locator("a").evaluateAll(nodes => nodes.map(node => node.getAttribute("href")));
        expect([...new Set(actualLinks)].sort()).toEqual(financial ? expectedLinks.sort() : []);
        if (!financial) expect(await panel.innerText()).not.toMatch(/(?:فاتورة|اتفاق سابق|اتفاق معتمد|جدول خطة) #/);
        for (const source of data.work.flatMap(line => line.references).filter(source => source.kind === "historical_agreement")) {
          expect(await panel.innerText()).toContain(`اتفاق سابق #${source.id}`);
          expect(await panel.locator(`a[href*="${source.id}"]`).count()).toBe(0);
        }
      } finally { await close(view.context); }
    }
  }
  if (label === "mixed") await assistantNavigationRefusals(patientId, visits[0].id);
  const params = new URLSearchParams({report:"visits",preset:"today",patientId:String(patientId)});
  const report = await read<{result:{rows:{patientId:number;workSource:string;invoiceText:string;collection:string}[]}}>("admin", `/api/reports?${params}`);
  // Exact visit IDs were asserted above. The report has no visit ID field; compare the complete multiset.
  expect(report.result.rows).toHaveLength(visits.length);
  expect(report.result.rows.map(row => row.workSource).sort()).toEqual(visits.map(visit => VISIT_SOURCE_SUMMARY[visit.summary]).sort());
  expect(report.result.rows.every(row => row.patientId === patientId && row.collection === "—" && row.invoiceText === UNVERIFIED_VISIT_INVOICE_LABEL)).toBe(true);
  const printParams = new URLSearchParams(params);
  printParams.set("columns", "patientNumber,workSource,invoiceText,collection");
  const print = await open("admin", patientId);
  try {
    const response = await print.page.goto(`${baseUrl}/print/report?${printParams}`);
    expect(response?.status()).toBe(200);
    await print.page.getByText("مصادر العمل — تحقق حالي", {exact:true}).waitFor();
    for (const summary of new Set(visits.map(visit => VISIT_SOURCE_SUMMARY[visit.summary]))) {
      expect(await print.page.getByRole("cell", {name:summary,exact:true}).count()).toBe(visits.filter(visit => VISIT_SOURCE_SUMMARY[visit.summary] === summary).length);
    }
    await print.page.emulateMedia({media:"print"});
    await print.page.evaluate(() => document.fonts.ready);
    const directory = "artifacts/visit-source-acceptance";
    await mkdir(directory, {recursive:true});
    const path = `${directory}/${label}.pdf`;
    await writeFile(path, await print.page.pdf({preferCSSPageSize:true,printBackground:true}));
    expect(execFileSync("pdfinfo", [path], {encoding:"utf8"})).toMatch(/Pages:\s+[1-9]/);
    if(label==="same-day-decisions") {
      // This is a fresh raster of the EXACT, unmodified PDF being asserted below,
      // not a browser screenshot or an OCR re-render. The printed text expectation
      // remains strictly unchanged. A reviewer must inspect this raster if
      // Poppler's Arabic text extraction and the visible glyphs disagree.
      execFileSync("pdftoppm",["-f","1","-l","1","-r","200","-png","-singlefile",
        path,`${directory}/same-day-decisions-raster`],{maxBuffer:1024*1024});
      const raw = execFileSync("pdftotext",["-raw",path,"-"],{encoding:"utf8"});
      const exact=VISIT_SOURCE_SUMMARY.no_new_charge;
      console.info("Bounded original PDF raw text inspection:",JSON.stringify({
        exactPhraseInRaw:raw.includes(exact),
        reversedPhraseInRaw:raw.includes("قرار بال رسوم مثبت للعمل المسجل"),
        rasterOfOriginalPdf:"same-day-decisions-raster.png",
      }));
    }
    const noChargeRow=report.result.rows.findIndex(row=>row.workSource===VISIT_SOURCE_SUMMARY.no_new_charge);
    const ocrDiagnostic=label==="same-day-decisions" ? await diagnoseVisitSourcePdfOcr(print.page,browser,directory,noChargeRow,report.result.rows.length) : null;
    if(ocrDiagnostic) console.info("Bounded fresh PDF OCR diagnostic:",JSON.stringify(ocrDiagnostic));
    const text = execFileSync("pdftotext", ["-layout",path,"-"], {encoding:"utf8"}).replace(/[\u202a-\u202e]/g, "").replace(/\s+/g," ");
    expect(text).toContain("مصادر العمل");
    try {
      for (const summary of new Set(visits.map(visit => VISIT_SOURCE_SUMMARY[visit.summary]))) {
        expect(text).toContain(summary.replace(/\s+/g," "));
      }
    } catch(error) {
      if(error instanceof Error && ocrDiagnostic) error.message += `\nBounded fresh PDF OCR diagnostic: ${JSON.stringify(ocrDiagnostic)}`;
      throw error;
    }
    if(ocrDiagnostic) expect(ocrDiagnostic.verdict,JSON.stringify(ocrDiagnostic)).toBe("correct_visible_phrase");
  } finally { await close(print.context); }
  expect(await q(`SELECT
    (SELECT count(*) FROM invoices WHERE patient_id=$1)::int AS invoices,
    (SELECT count(*) FROM payments WHERE patient_id=$1)::int AS payments,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM legacy_treatment_agreements a WHERE patient_id=$1) AS agreements`, [patientId])).toEqual(before);
}

async function walkIn(patientId: number) {
  const visit = await mutate<{id:number}>("reception", "POST", "/api/visits", {patientId,patientName:"قبول مصادر اصطناعي",doctorId}, 201);
  await mutate("reception", "PATCH", `/api/visits/${visit.id}`, {action:"clear"});
  const [{chair}] = await q<{chair:number}>(`SELECT n AS chair FROM generate_series(1,20) n WHERE NOT EXISTS
    (SELECT 1 FROM visits WHERE chair=n AND status IN ('called','in_chair')) ORDER BY n LIMIT 1`);
  await mutate("reception", "PATCH", `/api/visits/${visit.id}`, {action:"call",chair});
  await mutate("reception", "PATCH", `/api/visits/${visit.id}`, {action:"seat",chair});
  return visit.id;
}

describe("Supplemental visit source acceptance through canonical writers", () => {
  it("distinguishes a signed unresolved adjustment from an explicit no-charge decision in same-day visits, reader and printed report", async () => {
    const patientId = await patient("source-decisions");
    const ortho = await mutate<{id:number}>("doctorA", "POST", "/api/ortho", {patientId,appliance:"fixed_metal",arches:"both",slot:"022",plannedMonths:18}, 201);
    const visits: {id:number;summary:VisitFinancialContext["summary"]}[] = [];
    for (const noCharge of [false,true]) {
      const id = await walkIn(patientId);
      const signed = await mutate<Clinical>("doctorA", "POST", `/api/visits/${id}/clinical`, {
        action:"sign", orthoSession:{caseId:ortho.id,upperWire:"016 NiTi",lowerWire:null,elastics:"none",elasticNote:null,done:"متابعة قبول اصطناعية",nextWeeks:4},
        outsideContractDecision:noCharge ? {decision:"no_charge",reason:"قرار متابعة اصطناعي صريح"} : null,
      });
      expect(signed).toMatchObject({id,invoiceId:null,status:"signed"});
      visits.push({id,summary:noCharge ? "no_new_charge" : "unresolved"});
    }
    expect(visits[0].id).not.toBe(visits[1].id);
    expect(await q(`SELECT count(DISTINCT (arrived_at AT TIME ZONE 'Asia/Aden')::date)::int AS days FROM visits WHERE id=ANY($1::int[])`,[visits.map(v=>v.id)])).toEqual([{days:1}]);
    await sourceAcceptance(patientId,visits,"same-day-decisions");
    const first = await read<VisitFinancialContext>("admin",`/api/visits/${visits[0].id}/financial-context`);
    const second = await read<VisitFinancialContext>("admin",`/api/visits/${visits[1].id}/financial-context`);
    expect(first.work.map(w=>w.decision)).toEqual(["none"]);
    expect(second.work.map(w=>w.decision)).toEqual(["no_charge"]);
    expect(first.work.some(a=>second.work.some(b=>a.key===b.key))).toBe(false);
    expect(await q("SELECT id FROM invoices WHERE patient_id=$1",[patientId])).toEqual([]);
  },240_000);

  it("renders one valid historical agreement across two same-day signed visits without creating invoices or receipts", async () => {
    const patientId = await patient("source-history");
    const created = await mutate<{document:{id:number;lines:{planItemId:number;agreementId:number}[]}}>("admin","POST",`/api/patients/${patientId}/historical-documents`,{
      patientId,currency:"YER",items:[{serviceId:services.rct,doctorId,quantity:1,sessions:3,price:String(prices.rct),catalogPriceMinor:prices.rct,toothCode:16}],
      discount:"0",previouslyPaidAmount:String(prices.rct),historicalAsOf:"2026-10-01",idempotencyKey:`source-acceptance-${stamp}`,
      repaymentTerms:{mode:"full",installments:[]},repaymentRemainingMinor:0,repaymentVersion:0,repaymentSourceHash:null,
    },201);
    const item = created.document.lines[0];
    const principal = await q("SELECT id,agreed_minor,previously_paid_minor,remaining_minor FROM legacy_treatment_agreements WHERE patient_id=$1",[patientId]);
    const [{plan_id:planId}] = await q<{plan_id:number}>("SELECT plan_id FROM plan_items WHERE id=$1",[item.planItemId]);
    await consent(planId);
    const visits: {id:number;summary:VisitFinancialContext["summary"]}[] = [];
    for (let index=0;index<2;index++) {
      const id = await walkIn(patientId);
      await stageThroughUi(patientId,id,item.planItemId,"rct",16);
      const signed = await mutate<Clinical>("doctorA","POST",`/api/visits/${id}/clinical`,{action:"sign"});
      expect(signed).toMatchObject({id,invoiceId:null,status:"signed"});
      const evidence = await read<VisitFinancialContext>("admin",`/api/visits/${id}/financial-context`);
      expect(evidence.work).toHaveLength(1);
      expect(evidence.work[0].references).toEqual([{kind:"historical_agreement",id:item.agreementId,state:"current",path:"plan_item"}]);
      visits.push({id,summary:"verified"});
    }
    await sourceAcceptance(patientId,visits,"historical-agreement");
    expect(await q("SELECT id FROM invoices WHERE patient_id=$1",[patientId])).toEqual([]);
    expect(await q("SELECT id FROM payments WHERE patient_id=$1",[patientId])).toEqual([]);
    expect(await q("SELECT id FROM legacy_treatment_agreements WHERE patient_id=$1",[patientId])).toEqual([{id:item.agreementId}]);
    expect(await q("SELECT id,agreed_minor,previously_paid_minor,remaining_minor FROM legacy_treatment_agreements WHERE patient_id=$1",[patientId])).toEqual(principal);
  },240_000);
});

/** Real, already-permitted patient pages. Never substitute API responses or grant access. */
async function assistantNavigationRefusals(patientId: number, visitId: number) {
  const otherPatientId = await patient("source-navigation-other");
  await walkIn(otherPatientId); // Canonical arrival makes this synthetic patient's file readable today.
  const [{planId}] = await q<{planId:number}>(`SELECT i.plan_id AS "planId" FROM visit_procedures p
    JOIN plan_items i ON i.id=p.plan_item_id WHERE p.visit_id=$1 ORDER BY p.id LIMIT 1`, [visitId]);
  expect(planId).toBeGreaterThan(0);
  const view = await open("assistant", patientId, "today");
  try {
    const wrongRead = view.page.waitForResponse(response => new URL(response.url()).pathname === `/api/visits/${visitId}/clinical`
      && response.request().method() === "GET");
    await view.page.goto(`${baseUrl}/patients/${otherPatientId}?tab=today&visitId=${visitId}`);
    const originalVisit = await wrongRead;
    expect(originalVisit.status()).toBe(200); // Both files are permitted; the requested pairing is not.
    expect(await originalVisit.json()).toMatchObject({id:visitId,patientId});
    const refused = view.page.getByTestId("clinical-context-state");
    await expect.poll(() => refused.getAttribute("role")).toBe("alert");
    expect(await view.page.getByTestId("clinical-context-visit").count()).toBe(0);
    expect(await view.page.getByRole("region",{name:"مصادر عمل الزيارة"}).count()).toBe(0);

    const forbiddenReads:string[]=[];
    view.page.on("request", request => {
      const path=new URL(request.url()).pathname;
      if (request.method()==="GET" && (path===`/api/patients/${patientId}/clinical-context`
        || path===`/api/visits/${visitId}/financial-context` || path===`/api/visits/${visitId}/clinical`)) forbiddenReads.push(path);
    });
    await view.page.goto(`${baseUrl}/patients/${patientId}?tab=today&visitId=${visitId}&planId=${planId}`);
    await expect.poll(() => view.page.getByTestId("clinical-context-state").getAttribute("role")).toBe("alert");
    expect(forbiddenReads).toEqual([]); // Refuse the mixed graph before borrowing any visit read.
    expect(await view.page.getByTestId("clinical-context-visit").count()).toBe(0);
    expect(await view.page.getByRole("region",{name:"مصادر عمل الزيارة"}).count()).toBe(0);
  } finally { await close(view.context); }
}
