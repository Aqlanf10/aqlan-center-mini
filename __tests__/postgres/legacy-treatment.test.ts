import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { parseLegacyTreatmentRequest, type LegacyTreatmentRequest } from "../../lib/legacy-treatment";

/**
 * (INV-LEGACY) علاجٌ بدأ قبل النظام — على PostgreSQL 18.
 * اتفاق 300,000 دُفع منه 120,000 قبل النظام ⇒ رصيدٌ سابق 180,000 وحده بمحرّك الرصيد الافتتاحي؛ لا سند ولا فاتورة ولا
 * حركة وردية؛ بند خطة مغطّى (الزيارة لا تفوتره، وشدّات التقويم مشمولة)؛ حالة موسومة لا تحتاج تقييمًا أوليًّا؛ إعادة
 * الطلب وتزامنه وتكراره؛ والإبطال يحرّر التغطية ويصحّح الرصيد بمسار المحرّك نفسه دون حذف.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { createLegacyTreatment, voidLegacyTreatment, listLegacyTreatments } = await import("../../lib/legacy-treatment-db");
const { createLinkedInvoice } = await import("../../lib/invoice-linkage-db");
const {
  ensureSchema, getPool, resetPoolForTesting, listPatientCases, addVisit, setVisitProcedures, signClinicalVisit,
  createOrthoCase, previewVisitBilling, openShift, recordPayment, setPatientOpeningBalance, patientWorkflow,
  listPatientPlans,
} = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

const TODAY = "2026-10-06";
let doctor = 0;
const services: Record<string, number> = {};

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  doctor = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. عقلان') RETURNING id`))[0].id;
  for (const [key, name, category] of [
    ["ortho", "تقويم ثابت", "ortho"], ["rct", "علاج عصب", "rct"], ["crown", "تاج زركونيا", "crown"], ["consult", "كشف", "consultation"],
  ] as const) {
    services[key] = (await q<{ id: number }>(
      `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 100000, TRUE, TRUE, $2) RETURNING id`,
      [name, category]))[0].id;
  }
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

const newPatient = async (n: string) => (await q<{ id: number }>(
  `INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id`, [n]))[0].id;

function request(body: Record<string, unknown>): LegacyTreatmentRequest {
  const parsed = parseLegacyTreatmentRequest({
    currency: "YER", agreedAmount: "300000", previouslyPaidAmount: "120000", historicalAsOf: "2026-09-30", ...body,
  }, TODAY);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}
const create = (patientId: number, body: Record<string, unknown>, canEditOpening = false) => createLegacyTreatment({
  patientId, request: request(body), actor: canEditOpening ? "admin" : "reception", actorRole: canEditOpening ? "admin" : "reception",
  canEditOpening, templates: DEFAULT_SPECIALTY_TEMPLATES,
});
const opening = async (patientId: number, currency = "YER") => (await q<{ amount_minor: string; as_of_date: string }>(
  `SELECT amount_minor::text, as_of_date::text FROM patient_opening_balances WHERE patient_id = $1 AND currency = $2`,
  [patientId, currency]))[0] ?? null;
const visitOn = async (patientId: number, serviceId: number, planItemId: number, toothCode: number | null, caseId: number | null) => {
  const visit = await addVisit({ patientName: "م", patientPhone: null, note: null, patientId });
  await q(`UPDATE visits SET doctor_id = $2, case_id = $3, diagnosis = 'متابعة' WHERE id = $1`, [visit.id, doctor, caseId]);
  await setVisitProcedures({
    visitId: visit.id,
    procedures: [{ serviceId, toothCode, surfaces: null, quantity: 1, unitPriceMinor: 0, priceReason: null, doctorId: null, note: null, planItemId }],
  });
  return visit.id;
};
const sign = (visitId: number) => signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr", signerDoctorPartyId: doctor });

describe("ortho 300,000 agreed / 120,000 paid before the system", () => {
  it("records only the 180,000 remaining through the opening engine; no receipt, invoice or shift movement", async () => {
    const patient = await newPatient("LEG-ORTHO");
    const shiftsBefore = await q(`SELECT id FROM cashier_shifts`);
    const result = await create(patient, { serviceId: services.ortho, idempotencyKey: "legacy:ortho-300k" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replayed).toBe(false);
    expect(result.agreement).toMatchObject({
      agreedMinor: 300_000, previouslyPaidMinor: 120_000, remainingMinor: 180_000,
      historicalAsOf: "2026-09-30", currency: "YER", openingEffect: "created", status: "live", specialty: "orthodontics",
      createdBy: "reception",
    });
    // money: no receipt, no invoice, no shift; only the remaining as the opening, with its engine history row
    expect(await q(`SELECT 1 FROM payments WHERE patient_id = $1`, [patient])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patient])).toHaveLength(0);
    expect(await q(`SELECT id FROM cashier_shifts`)).toEqual(shiftsBefore);
    expect(await opening(patient)).toEqual({ amount_minor: "180000", as_of_date: "2026-09-30" });
    const history = await q<{ id: number; action: string; after_amount_minor: string; actor: string }>(
      `SELECT id, action, after_amount_minor::text, actor FROM patient_opening_balance_history WHERE patient_id = $1`, [patient]);
    expect(history).toEqual([{ id: result.agreement.openingHistoryId, action: "set", after_amount_minor: "180000", actor: "reception" }]);
    const ledger = await db.patientLedger(patient);
    const balances = db.ledgerBalancesByCurrency(patient, ledger, new Map());
    expect(balances.YER.dueMinor).toBe(180_000);

    // work identity: one consented plan, one covered item, one legacy-labelled ortho case (not needing assessment)
    const [item] = await q<{ id: number; billing_status: string; case_id: number; unit_price_minor: string; consent_at: Date | null; origin: string | null }>(
      `SELECT i.id, i.billing_status, i.case_id, i.unit_price_minor::text, t.consent_at, i.origin
         FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1`, [patient]);
    expect(item).toMatchObject({ id: result.agreement.planItemId, billing_status: "included_in_package", unit_price_minor: "300000" });
    expect(item.consent_at).not.toBeNull();
    const cases = await listPatientCases(patient);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ id: item.case_id, specialty: "orthodontics", origin: "clinical", legacy: true, needsAssessment: false });
    expect(cases[0].title).toContain("حالة بدأت قبل النظام");
    expect((await patientWorkflow(patient, TODAY)).assessmentCases).toEqual([]);
    const [plan] = await listPatientPlans(patient, TODAY);
    expect(plan.items[0].legacyAgreementId).toBe(result.agreement.id);
    expect(await q(`SELECT 1 FROM ortho_cases WHERE patient_id = $1`, [patient])).toHaveLength(0); // nothing ortho invented

    const actions = (await q<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = $1::text AND entity = 'patient' ORDER BY id`, [patient])).map((r) => r.action);
    for (const action of ["plan.create", "case.create", "plan.item_case", "opening_balance.set", "legacy_treatment.create"]) {
      expect(actions).toContain(action);
    }

    // the same key + body replays; a different body with the same key conflicts
    const replay = await create(patient, { serviceId: services.ortho, idempotencyKey: "legacy:ortho-300k" });
    expect(replay).toMatchObject({ ok: true, replayed: true, agreement: { id: result.agreement.id } });
    expect(await q(`SELECT 1 FROM patient_opening_balance_history WHERE patient_id = $1`, [patient])).toHaveLength(1);
    expect(await create(patient, { serviceId: services.ortho, previouslyPaidAmount: "100000", idempotencyKey: "legacy:ortho-300k" }))
      .toEqual({ ok: false, reason: "idempotency_conflict" });
    // a second live agreement for the same service/scope is refused
    expect(await create(patient, { serviceId: services.ortho })).toEqual({ ok: false, reason: "duplicate_live" });
    expect(await q(`SELECT 1 FROM legacy_treatment_agreements WHERE patient_id = $1`, [patient])).toHaveLength(1);
  });

  it("ortho adjustments on the legacy case are included (not pending); the doctor's ortho case bridges the legacy case", async () => {
    const patient = await newPatient("LEG-ORTHO-ADJ");
    const result = await create(patient, { serviceId: services.ortho });
    if (!result.ok) throw new Error(result.reason);
    const opened = await createOrthoCase({
      patientId: patient, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null,
      startDate: TODAY, plannedMonths: 18, planId: null, note: null, createdBy: "dr",
    });
    if (!opened.ok) throw new Error(opened.message);
    const [kase] = await q<{ ortho_case_id: number }>(`SELECT ortho_case_id FROM clinical_cases WHERE id = $1`, [result.agreement.caseId]);
    expect(kase.ortho_case_id).toBe(opened.id);
    const visit = await addVisit({ patientName: "م", patientPhone: null, note: null, patientId: patient });
    const preview = await previewVisitBilling(visit.id);
    expect(preview?.orthoAdjustment).toBe("LEGACY_INCLUDED");
    expect(preview?.zeroReason).toBe("شدّة تقويم مشمولة بالعلاج السابق");
    // a session on the covered item itself creates no invoice
    await q(`UPDATE visits SET doctor_id = $2, case_id = $3, diagnosis = 'متابعة' WHERE id = $1`, [visit.id, doctor, result.agreement.caseId]);
    await setVisitProcedures({
      visitId: visit.id,
      procedures: [{ serviceId: services.ortho, toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 0, priceReason: null,
        doctorId: null, note: null, planItemId: result.agreement.planItemId }],
    });
    const signed = await sign(visit.id);
    expect(signed.reason).toBeNull();
    expect(signed.invoiceId).toBeNull();
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patient])).toHaveLength(0);
    expect((await listPatientCases(patient)).find((c) => c.id === result.agreement.caseId)?.legacy).toBe(true);
  });

  it("an existing active ortho_cases row is bridged, never duplicated", async () => {
    const patient = await newPatient("LEG-ORTHO-BRIDGE");
    const [{ id: orthoId }] = await q<{ id: number }>(`INSERT INTO ortho_cases (patient_id, created_by) VALUES ($1, 'dr') RETURNING id`, [patient]);
    const result = await create(patient, { serviceId: services.ortho });
    if (!result.ok) throw new Error(result.reason);
    const cases = await q<{ ortho_case_id: number; title: string }>(`SELECT ortho_case_id, title FROM clinical_cases WHERE patient_id = $1`, [patient]);
    expect(cases).toEqual([{ ortho_case_id: orthoId, title: "تقويم الأسنان" }]);
    expect(await q(`SELECT 1 FROM ortho_cases WHERE patient_id = $1`, [patient])).toHaveLength(1);
  });
});

describe("validation, duplicates and concurrency", () => {
  it("paid > agreed, future cutoff, zero agreement and a non-clinical service are refused", async () => {
    expect(parseLegacyTreatmentRequest({ serviceId: 1, currency: "YER", agreedAmount: "100", previouslyPaidAmount: "150", historicalAsOf: "2026-09-01" }, TODAY))
      .toMatchObject({ ok: false });
    expect(parseLegacyTreatmentRequest({ serviceId: 1, currency: "YER", agreedAmount: "100", previouslyPaidAmount: "50", historicalAsOf: "2026-10-07" }, TODAY))
      .toMatchObject({ ok: false });
    expect(parseLegacyTreatmentRequest({ serviceId: 1, currency: "YER", agreedAmount: "0", previouslyPaidAmount: "0", historicalAsOf: "2026-09-01" }, TODAY))
      .toMatchObject({ ok: false });
    const patient = await newPatient("LEG-BADSVC");
    expect(await create(patient, { serviceId: services.consult })).toEqual({ ok: false, reason: "bad_service" });
    expect(await q(`SELECT 1 FROM patient_opening_balances WHERE patient_id = $1`, [patient])).toHaveLength(0);
  });

  it("paid == agreed: no opening entry, the agreement is settled historically and the item stays covered", async () => {
    const patient = await newPatient("LEG-SETTLED");
    const result = await create(patient, { serviceId: services.rct, toothCode: 36, agreedAmount: "80000", previouslyPaidAmount: "80000" });
    expect(result).toMatchObject({ ok: true, agreement: { remainingMinor: 0, openingEffect: "none", openingHistoryId: null } });
    if (!result.ok) return;
    expect(await opening(patient)).toBeNull();
    expect(await q(`SELECT 1 FROM patient_opening_balance_history WHERE patient_id = $1`, [patient])).toHaveLength(0);
    const session = await visitOn(patient, services.rct, result.agreement.planItemId, 36, result.agreement.caseId);
    const signed = await sign(session);
    expect(signed.reason).toBeNull();
    expect(signed.invoiceId).toBeNull();
  });

  it("concurrent double submit (two keys, same work) creates exactly one agreement and one opening", async () => {
    const patient = await newPatient("LEG-RACE");
    const results = await Promise.all([
      create(patient, { serviceId: services.crown, toothCode: 46, idempotencyKey: "legacy:race-a1" }),
      create(patient, { serviceId: services.crown, toothCode: 46, idempotencyKey: "legacy:race-b2" }),
    ]);
    expect(results.filter((one) => one.ok)).toHaveLength(1);
    expect(results.filter((one) => !one.ok)).toEqual([{ ok: false, reason: "duplicate_live" }]);
    expect(await q(`SELECT 1 FROM legacy_treatment_agreements WHERE patient_id = $1`, [patient])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM patient_opening_balance_history WHERE patient_id = $1`, [patient])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1`, [patient])).toHaveLength(1);
  });

  it("concurrent same-key retry replays the first agreement", async () => {
    const patient = await newPatient("LEG-RACE-KEY");
    const results = await Promise.all([
      create(patient, { serviceId: services.rct, toothCode: 11, idempotencyKey: "legacy:same-key-1" }),
      create(patient, { serviceId: services.rct, toothCode: 11, idempotencyKey: "legacy:same-key-1" }),
    ]);
    expect(results.every((one) => one.ok)).toBe(true);
    expect(results.filter((one) => one.ok && one.replayed)).toHaveLength(1);
    expect(await q(`SELECT 1 FROM legacy_treatment_agreements WHERE patient_id = $1`, [patient])).toHaveLength(1);
  });

  it("same service on another tooth is a separate agreement; an open plan item for the same work is refused", async () => {
    const patient = await newPatient("LEG-TEETH");
    expect((await create(patient, { serviceId: services.rct, toothCode: 36, agreedAmount: "80000", previouslyPaidAmount: "80000" })).ok).toBe(true);
    expect((await create(patient, { serviceId: services.rct, toothCode: 46, agreedAmount: "80000", previouslyPaidAmount: "80000" })).ok).toBe(true);
    const invoiced = await newPatient("LEG-INVOICED");
    const invoice = await createLinkedInvoice({
      patientId: invoiced, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "reception", actorRole: "reception",
      items: [{ serviceId: services.rct, category: "rct", doctorId: null, description: "عصب", quantity: 1, unitPriceMinor: 80_000, toothCode: 36, caseId: null, sessions: null }],
      templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: null, requestHash: null, auditDetails: {},
    });
    expect(invoice.ok).toBe(true);
    expect(await create(invoiced, { serviceId: services.rct, toothCode: 36 })).toEqual({ ok: false, reason: "open_item_exists" });
    expect(await opening(invoiced)).toBeNull();
  });

  it("an invoice for work already covered by a live legacy agreement is refused (no double money)", async () => {
    const patient = await newPatient("LEG-THEN-INVOICE");
    expect((await create(patient, { serviceId: services.crown, toothCode: 26 })).ok).toBe(true);
    const invoice = await createLinkedInvoice({
      patientId: patient, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "reception", actorRole: "reception",
      items: [{ serviceId: services.crown, category: "crown", doctorId: null, description: "تاج", quantity: 1, unitPriceMinor: 30_000_000, toothCode: 26, caseId: null, sessions: null }],
      templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: null, requestHash: null, auditDetails: {},
    });
    expect(invoice).toMatchObject({ ok: false, reason: "legacy_covered" });
  });
});

describe("opening composition and authority", () => {
  it("a manual opening in the currency is never double counted; reception cannot add onto an existing opening; admin composes agreement-owned openings", async () => {
    const manual = await newPatient("LEG-MANUAL-OPENING");
    await setPatientOpeningBalance({ patientId: manual, currency: "YER", amountMinor: 180_000, asOfDate: "2026-09-01", note: null, createdBy: "admin", reason: null });
    expect(await create(manual, { serviceId: services.ortho }, true)).toEqual({ ok: false, reason: "opening_not_owned" });
    expect(await create(manual, { serviceId: services.ortho })).toEqual({ ok: false, reason: "opening_not_owned" });
    expect(await opening(manual)).toEqual({ amount_minor: "180000", as_of_date: "2026-09-01" });

    const composed = await newPatient("LEG-COMPOSE");
    expect((await create(composed, { serviceId: services.ortho })).ok).toBe(true);
    expect(await create(composed, { serviceId: services.crown, toothCode: 16, agreedAmount: "50000", previouslyPaidAmount: "10000" }))
      .toEqual({ ok: false, reason: "opening_edit_forbidden" });
    const second = await create(composed, { serviceId: services.crown, toothCode: 16, agreedAmount: "50000", previouslyPaidAmount: "10000", historicalAsOf: "2026-08-15" }, true);
    expect(second).toMatchObject({ ok: true, agreement: { openingEffect: "increased", remainingMinor: 40_000 } });
    expect(await opening(composed)).toEqual({ amount_minor: "220000", as_of_date: "2026-08-15" });
    // another currency is its own opening
    expect((await create(composed, { serviceId: services.rct, toothCode: 21, currency: "SAR", agreedAmount: "900", previouslyPaidAmount: "400" })).ok).toBe(true);
    expect(await opening(composed, "SAR")).toEqual({ amount_minor: "50000", as_of_date: "2026-09-30" });
  });
});

describe("void: coverage released, opening corrected by the engine, nothing deleted", () => {
  it("void of an untouched agreement clears its opening through the engine history and cancels the agreement's plan", async () => {
    const patient = await newPatient("LEG-VOID");
    const result = await create(patient, { serviceId: services.ortho });
    if (!result.ok) throw new Error(result.reason);
    expect(await voidLegacyTreatment({ patientId: patient, agreementId: result.agreement.id, reason: "x", actor: "admin", actorRole: "admin" }))
      .toEqual({ ok: false, reason: "bad_reason" });
    const voided = await voidLegacyTreatment({ patientId: patient, agreementId: result.agreement.id, reason: "أُدخل لمريضٍ آخر", actor: "admin", actorRole: "admin" });
    expect(voided).toMatchObject({ ok: true, agreement: { status: "void", voidedBy: "admin", voidReason: "أُدخل لمريضٍ آخر" } });
    expect(await opening(patient)).toBeNull();
    const history = await q<{ action: string; before_amount_minor: string | null }>(
      `SELECT action, before_amount_minor::text FROM patient_opening_balance_history WHERE patient_id = $1 ORDER BY id`, [patient]);
    expect(history).toEqual([{ action: "set", before_amount_minor: null }, { action: "clear", before_amount_minor: "180000" }]);
    const [item] = await q<{ billing_status: string; plan_status: string }>(
      `SELECT i.billing_status, t.status AS plan_status FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE i.id = $1`,
      [result.agreement.planItemId]);
    expect(item).toEqual({ billing_status: "unbilled", plan_status: "cancelled" });
    expect(await q(`SELECT 1 FROM clinical_cases WHERE patient_id = $1`, [patient])).toHaveLength(1); // the case is kept
    expect((await listPatientCases(patient))[0].legacy).toBe(false);
    expect(await q(`SELECT 1 FROM legacy_treatment_agreements WHERE patient_id = $1`, [patient])).toHaveLength(1); // row kept, void
    expect(await voidLegacyTreatment({ patientId: patient, agreementId: result.agreement.id, reason: "مرة ثانية", actor: "admin", actorRole: "admin" }))
      .toEqual({ ok: false, reason: "already_void" });
    // a correct re-entry is possible after the mistaken one was voided
    expect((await create(patient, { serviceId: services.ortho, previouslyPaidAmount: "150000" })).ok).toBe(true);
    expect(await opening(patient)).toMatchObject({ amount_minor: "150000" });
    expect(await listLegacyTreatments(patient)).toHaveLength(2);
  });

  it("void after work started keeps the plan, releases coverage: the next session is billed by its rule", async () => {
    const patient = await newPatient("LEG-VOID-STARTED");
    const result = await create(patient, { serviceId: services.rct, toothCode: 36, agreedAmount: "90000", previouslyPaidAmount: "30000", sessions: 2 });
    if (!result.ok) throw new Error(result.reason);
    const first = await sign(await visitOn(patient, services.rct, result.agreement.planItemId, 36, result.agreement.caseId));
    expect(first.invoiceId).toBeNull();
    expect((await voidLegacyTreatment({ patientId: patient, agreementId: result.agreement.id, reason: "اتفاق خاطئ", actor: "admin", actorRole: "admin" })).ok).toBe(true);
    const [plan] = await q<{ status: string }>(`SELECT t.status FROM treatment_plans t JOIN plan_items i ON i.plan_id = t.id WHERE i.id = $1`, [result.agreement.planItemId]);
    expect(plan.status).toBe("active");
    const second = await sign(await visitOn(patient, services.rct, result.agreement.planItemId, 36, result.agreement.caseId));
    expect(second.reason).toBeNull();
    expect(second.invoiceId).not.toBeNull();
    expect(await q(`SELECT 1 FROM visit_procedures pr JOIN visits v ON v.id = pr.visit_id WHERE v.patient_id = $1`, [patient])).toHaveLength(2);
  });

  it("void is refused when the opening has been collected beyond what stays covered; composed openings are reduced, not cleared", async () => {
    const patient = await newPatient("LEG-VOID-PAID");
    const ortho = await create(patient, { serviceId: services.ortho }, true);
    const crown = await create(patient, { serviceId: services.crown, toothCode: 16, agreedAmount: "50000", previouslyPaidAmount: "10000" }, true);
    if (!ortho.ok || !crown.ok) throw new Error("create");
    expect(await opening(patient)).toMatchObject({ amount_minor: "220000" });
    await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
    const paid = await recordPayment({
      patientId: patient, invoiceId: null, openingCurrency: "YER", kind: "payment",
      amountMinor: 50_000, currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "cashier",
    });
    expect(paid.reason).toBeNull();
    // voiding the ortho agreement would leave 40,000 principal against 50,000 collected ⇒ refused
    expect(await voidLegacyTreatment({ patientId: patient, agreementId: ortho.agreement.id, reason: "تجربة", actor: "admin", actorRole: "admin" }))
      .toEqual({ ok: false, reason: "opening_settled" });
    // voiding the crown leaves 180,000 ≥ 50,000 collected ⇒ reduced through the engine (set, with reason)
    expect((await voidLegacyTreatment({ patientId: patient, agreementId: crown.agreement.id, reason: "تاج مكرر", actor: "admin", actorRole: "admin" })).ok).toBe(true);
    expect(await opening(patient)).toMatchObject({ amount_minor: "180000" });
    const [last] = await q<{ action: string; reason: string }>(
      `SELECT action, reason FROM patient_opening_balance_history WHERE patient_id = $1 ORDER BY id DESC LIMIT 1`, [patient]);
    expect(last.action).toBe("set");
    expect(last.reason).toContain("تاج مكرر");
  });

  it("the agreement table is append-only: no delete, no rewrite of history", async () => {
    const patient = await newPatient("LEG-GUARD");
    const result = await create(patient, { serviceId: services.crown, toothCode: 11 });
    if (!result.ok) throw new Error(result.reason);
    await expect(q(`UPDATE legacy_treatment_agreements SET agreed_minor = 1 WHERE id = $1`, [result.agreement.id])).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM legacy_treatment_agreements WHERE id = $1`, [result.agreement.id])).rejects.toThrow(/append-only/);
    // the financial footprint guard keeps the patient file (and its historical agreement)
    const deleted = await db.deletePatientCascade(patient, { actor: "admin", actorRole: "admin" });
    expect(deleted).toMatchObject({ ok: false, reason: "has_financial_history" });
  });
});

describe("(INV-LINK TOOTH) the legacy agreement follows the same tooth/site rules as an invoice line", () => {
  it("a tooth-bound legacy treatment without a tooth is refused before any opening is written", async () => {
    const patient = await newPatient("LEGACY-TOOTH-REQ");
    expect(await create(patient, { serviceId: services.rct })).toMatchObject({ ok: false, reason: "tooth_required" });
    expect(await create(patient, { serviceId: services.rct, toothCode: 36, episodeTeeth: [36, 46] }))
      .toMatchObject({ ok: false, reason: "episode_split_required" });
    expect(await opening(patient)).toBeNull();
    expect(await q(`SELECT 1 FROM legacy_treatment_agreements WHERE patient_id = $1`, [patient])).toHaveLength(0);
  });

  it("a legacy crown/bridge episode keeps all its teeth on the case site; ortho keeps its arch scope", async () => {
    const patient = await newPatient("LEGACY-BRIDGE");
    const bridge = await create(patient, { serviceId: services.crown, toothCode: 14, episodeTeeth: [16, 14, 15] });
    expect(bridge.ok).toBe(true);
    const [kase] = await q<{ site: string; title: string }>(`SELECT site, title FROM clinical_cases WHERE patient_id = $1`, [patient]);
    expect(kase.site).toBe("14، 15، 16");
    expect(kase.title).toContain("حالة بدأت قبل النظام");
    const [item] = await q<{ tooth_code: number; note: string }>(
      `SELECT i.tooth_code, i.note FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1`, [patient]);
    expect(item).toMatchObject({ tooth_code: 14, note: "الأسنان: 14، 15، 16" });

    const ortho = await newPatient("LEGACY-ORTHO-SCOPE");
    expect(await create(ortho, { serviceId: services.ortho, toothCode: 11 })).toMatchObject({ ok: false, reason: "bad_scope" });
    expect((await create(ortho, { serviceId: services.ortho, scope: "both" })).ok).toBe(true);
    expect((await q<{ site: string }>(`SELECT site FROM clinical_cases WHERE patient_id = $1`, [ortho]))[0].site).toBe("الفكّان");
    expect((await opening(ortho))?.amount_minor).toBe("180000");
  });
});
