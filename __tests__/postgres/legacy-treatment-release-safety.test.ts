import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { parseLegacyTreatmentRequest } from "../../lib/legacy-treatment";

/**
 * SOURCE-ONLY REGRESSION PROPOSAL. Not run, not an implementation or a release approval.
 * Intended for PR285 composed onto the reviewed prospective PR274/278 repair.
 * The ordinary isolated PostgreSQL test harness is mandatory; never run against Production.
 * No aggregate payment-allocation rule is assumed here.
 */
assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { createLegacyTreatment, voidLegacyTreatment } = await import("../../lib/legacy-treatment-db");
const { createLinkedInvoice, previewInvoiceLinkage } = await import("../../lib/invoice-linkage-db");
const TODAY = "2026-10-06";
let doctor = 0;
let rct = 0;
let crown = 0;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.getPool().query(sql, params)).rows as T[];
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  doctor = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'Legacy safety test doctor') RETURNING id`))[0].id;
  const service = async (name: string, category: string) => (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category)
     VALUES ($1, 300000, TRUE, TRUE, $2) RETURNING id`, [name, category]))[0].id;
  rct = await service("Legacy safety root canal", "rct");
  crown = await service("Legacy safety crown", "crown");
  await db.openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

const patient = async (name: string) => (await q<{ id: number }>(
  `INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id`, [name]))[0].id;

async function register(patientId: number, patch: Record<string, unknown> = {}) {
  const parsed = parseLegacyTreatmentRequest({
    serviceId: rct, toothCode: 36, currency: "YER", agreedAmount: "300000",
    previouslyPaidAmount: "120000", historicalAsOf: "2026-09-30", sessions: 2, ...patch,
  }, TODAY);
  if (!parsed.ok) throw new Error(parsed.message);
  return createLegacyTreatment({
    patientId, request: parsed.value, actor: "admin", actorRole: "admin", canEditOpening: true,
    templates: DEFAULT_SPECIALTY_TEMPLATES,
  });
}

async function legacy(patientId: number, patch: Record<string, unknown> = {}) {
  const result = await register(patientId, patch);
  if (!result.ok) throw new Error(result.reason);
  return result.agreement;
}

async function consent(planId: number) {
  const result = await db.recordPlanConsent({ planId, actor: "doctor", note: "Explicit test consent after registration" });
  expect(result.ok).toBe(true);
}

async function visit(patientId: number, planItemId: number | null, caseId: number | null) {
  const created = await db.addVisit({ patientName: "Legacy safety patient", patientPhone: null, note: null, patientId });
  await q(`UPDATE visits SET doctor_id = $2, case_id = $3, diagnosis = 'متابعة' WHERE id = $1`, [created.id, doctor, caseId]);
  await db.setVisitProcedures({
    visitId: created.id,
    procedures: [{ serviceId: rct, toothCode: 36, surfaces: null, quantity: 1, unitPriceMinor: 300000,
      priceReason: null, doctorId: doctor, note: null, planItemId }],
  });
  return created.id;
}
const sign = (visitId: number) => db.signClinicalVisit({
  visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctor,
});
const voidAgreement = (patientId: number, agreementId: number) => voidLegacyTreatment({
  patientId, agreementId, reason: "Historical agreement requires correction", actor: "admin", actorRole: "admin",
});

describe("legacy registration preserves historical facts without inventing current events", () => {
  it("records 300000 agreed / 120000 previously paid / only 180000 opening, with no synthetic clinical consent", async () => {
    const id = await patient("LEG-SAFE-CONSENT");
    const agreement = await legacy(id);
    expect(agreement).toMatchObject({ agreedMinor: 300000, previouslyPaidMinor: 120000, remainingMinor: 180000 });
    expect(await q(`SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id = $1 AND currency = 'YER'`, [id]))
      .toEqual([{ amount_minor: "180000" }]);
    expect(await q(`SELECT consent_at, consent_by, consent_note FROM treatment_plans WHERE id = $1`, [agreement.planId]))
      .toEqual([{ consent_at: null, consent_by: null, consent_note: null }]);
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM payments WHERE patient_id = $1`, [id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM patient_opening_balance_history WHERE patient_id = $1`, [id])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM treatment_sessions WHERE plan_item_id = $1 AND status = 'done'`, [agreement.planItemId])).toHaveLength(0);
    expect(await q(`SELECT doctor_id, billed_invoice_id, origin_invoice_id FROM plan_items WHERE id = $1`, [agreement.planItemId]))
      .toEqual([{ doctor_id: null, billed_invoice_id: null, origin_invoice_id: null }]);
    expect(await q(`SELECT primary_doctor_id FROM treatment_plans WHERE id = $1`, [agreement.planId]))
      .toEqual([{ primary_doctor_id: null }]);
  });

  it("allows a clinical draft before consent, refuses signature, then includes the work after explicit consent", async () => {
    const id = await patient("LEG-SAFE-EXPLICIT");
    const agreement = await legacy(id);
    const draft = await visit(id, agreement.planItemId, agreement.caseId);
    await expect(sign(draft)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await q(`SELECT 1 FROM visits WHERE id = $1 AND signed_at IS NOT NULL`, [draft])).toHaveLength(0);
    await consent(agreement.planId);
    expect(await sign(draft)).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0 });
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM payments WHERE patient_id = $1`, [id])).toHaveLength(0);
  });
});

describe("void preserves historical work identity and cannot make its full price collectible again", () => {
  it("keeps the started item and clinical record in financial review; the next linked session cannot rebill", async () => {
    const id = await patient("LEG-SAFE-VOID-LINKED");
    const agreement = await legacy(id);
    await consent(agreement.planId);
    const first = await visit(id, agreement.planItemId, agreement.caseId);
    expect(await sign(first)).toMatchObject({ reason: null, invoiceId: null });
    expect((await voidAgreement(id, agreement.id)).ok).toBe(true);
    expect(await q(`SELECT status, plan_item_id FROM legacy_treatment_agreements WHERE id = $1`, [agreement.id]))
      .toEqual([{ status: "void", plan_item_id: agreement.planItemId }]);
    expect(await q(`SELECT billing_status, unit_price_minor::text, case_id FROM plan_items WHERE id = $1`, [agreement.planItemId]))
      .toEqual([{ billing_status: "needs_financial_review", unit_price_minor: "300000", case_id: agreement.caseId }]);
    expect(await q(`SELECT 1 FROM treatment_sessions WHERE plan_item_id = $1 AND status = 'done'`, [agreement.planItemId])).toHaveLength(1);
    const next = await visit(id, agreement.planItemId, agreement.caseId);
    await expect(sign(next)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM visit_procedures WHERE visit_id = $1`, [next])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM visits WHERE id = $1 AND signed_at IS NOT NULL`, [next])).toHaveLength(0);
  });

  it("cannot bypass historical review by omitting the plan-item link from a new procedure", async () => {
    const id = await patient("LEG-SAFE-VOID-FREE");
    const agreement = await legacy(id);
    await consent(agreement.planId);
    expect((await voidAgreement(id, agreement.id)).ok).toBe(true);
    const draft = await visit(id, null, agreement.caseId);
    let refused = false;
    try {
      const result = await sign(draft);
      refused = result.reason !== null;
    } catch (error) {
      expect(error).toBeInstanceOf(db.ClinicalPlanConflict);
      refused = true;
    }
    expect(refused).toBe(true);
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM visits WHERE id = $1 AND signed_at IS NOT NULL`, [draft])).toHaveLength(0);
  });
});

async function structuredDraft(patientId: number, caseId: number | null) {
  const draft = await db.addVisit({ patientName: "Legacy structured visit", patientPhone: null, note: null, patientId });
  await q(`UPDATE visits SET doctor_id = $2, case_id = $3, diagnosis = 'متابعة الحالة السابقة',
    treatment_done = 'توثيق الفحص السريري الحالي دون إجراء مرتبط' WHERE id = $1`, [draft.id, doctor, caseId]);
  expect(await q(`SELECT 1 FROM visit_procedures WHERE visit_id = $1`, [draft.id])).toHaveLength(0);
  return draft.id;
}

describe("case-level signing cannot bypass historical protection without a linked procedure", () => {
  it("retains a structured clinical draft and refuses signature after its consented legacy case is voided", async () => {
    const id = await patient("LEG-SAFE-CASE-VOID");
    const agreement = await legacy(id);
    await consent(agreement.planId); // Isolate financial review from the separate consent guard.
    expect((await voidAgreement(id, agreement.id)).ok).toBe(true);
    const draft = await structuredDraft(id, agreement.caseId);
    const before = await q(`SELECT case_id, diagnosis, treatment_done, signed_at FROM visits WHERE id = $1`, [draft]);
    await expect(sign(draft)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await q(`SELECT case_id, diagnosis, treatment_done, signed_at FROM visits WHERE id = $1`, [draft])).toEqual(before);
    expect(before[0]).toMatchObject({ case_id: agreement.caseId, signed_at: null });
    expect(await q(`SELECT 1 FROM visit_procedures WHERE visit_id = $1`, [draft])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM treatment_sessions WHERE plan_item_id = $1 AND status = 'done'`, [agreement.planItemId])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM payments WHERE patient_id = $1`, [id])).toHaveLength(0);
  });

  it("requires actual clinical consent for a structured-only visit on a live legacy case", async () => {
    const id = await patient("LEG-SAFE-CASE-CONSENT");
    const agreement = await legacy(id);
    const draft = await structuredDraft(id, agreement.caseId);
    const before = await q(`SELECT case_id, diagnosis, treatment_done, signed_at FROM visits WHERE id = $1`, [draft]);
    await expect(sign(draft)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await q(`SELECT case_id, diagnosis, treatment_done, signed_at FROM visits WHERE id = $1`, [draft])).toEqual(before);
    expect(await q(`SELECT consent_at FROM treatment_plans WHERE id = $1`, [agreement.planId])).toEqual([{ consent_at: null }]);
    await consent(agreement.planId);
    expect(await sign(draft)).toMatchObject({ reason: null, invoiceId: null, sessionsCompleted: 0 });
    expect(await q(`SELECT 1 FROM visits WHERE id = $1 AND signed_at IS NOT NULL`, [draft])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM visit_procedures WHERE visit_id = $1`, [draft])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM treatment_sessions WHERE plan_item_id = $1 AND status = 'done'`, [agreement.planItemId])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM payments WHERE patient_id = $1`, [id])).toHaveLength(0);
  });
});

describe("canonical legacy work and site linkage", () => {
  it("reuses the sole compatible unconsented master and never cancels it when another agreement remains", async () => {
    const id = await patient("LEG-SAFE-MASTER");
    const first = await legacy(id);
    const second = await legacy(id, { serviceId: crown, toothCode: 16, agreedAmount: "50000", previouslyPaidAmount: "10000" });
    expect(second.planId).toBe(first.planId);
    expect(await q(`SELECT id FROM treatment_plans WHERE patient_id = $1 AND status = 'active'`, [id])).toHaveLength(1);
    expect((await voidAgreement(id, first.id)).ok).toBe(true);
    expect(await q(`SELECT status FROM treatment_plans WHERE id = $1`, [first.planId])).toEqual([{ status: "active" }]);
    expect(await q(`SELECT status FROM legacy_treatment_agreements WHERE id = $1`, [second.id])).toEqual([{ status: "live" }]);
    expect(await q(`SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id = $1 AND currency = 'YER'`, [id]))
      .toEqual([{ amount_minor: "40000" }]);
  });

  it("refuses an explicit case for a different tooth before opening or work writes", async () => {
    const id = await patient("LEG-SAFE-WRONG-SITE");
    const wrongCase = await clinicalCase(id, "46");
    expect(await register(id, { caseId: wrongCase })).toEqual({ ok: false, reason: "bad_case" });
    expect(await footprint(id)).toEqual({ agreements: 0, plans: 0, items: 0, openings: 0, openingHistory: 0, invoices: 0, payments: 0 });
    expect(await q(`SELECT id, site FROM clinical_cases WHERE patient_id = $1`, [id])).toEqual([{ id: wrongCase, site: "46" }]);
  });
});

async function clinicalCase(patientId: number, site: string): Promise<number> {
  const result = await db.createClinicalCase({
    patientId, specialty: "endodontics", title: `Root canal ${site}`, site, problem: null,
    responsiblePartyId: null, orthoCaseId: null, actor: "doctor", actorRole: "doctor",
  });
  if (!result.ok || result.case.id === null) throw new Error("Clinical case fixture was refused");
  return result.case.id;
}

async function footprint(patientId: number) {
  const [counts] = await q<{
    agreements: number; plans: number; items: number; openings: number; openingHistory: number; invoices: number; payments: number;
  }>(`SELECT
    (SELECT COUNT(*)::int FROM legacy_treatment_agreements WHERE patient_id = $1) AS agreements,
    (SELECT COUNT(*)::int FROM treatment_plans WHERE patient_id = $1) AS plans,
    (SELECT COUNT(*)::int FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1) AS items,
    (SELECT COUNT(*)::int FROM patient_opening_balances WHERE patient_id = $1) AS openings,
    (SELECT COUNT(*)::int FROM patient_opening_balance_history WHERE patient_id = $1) AS "openingHistory",
    (SELECT COUNT(*)::int FROM invoices WHERE patient_id = $1) AS invoices,
    (SELECT COUNT(*)::int FROM payments WHERE patient_id = $1) AS payments`, [patientId]);
  return counts;
}

type InvoiceLine = Parameters<typeof createLinkedInvoice>[0]["items"][number];
const invoiceLine = (patch: Partial<InvoiceLine> = {}): InvoiceLine => ({
  serviceId: rct, category: "rct", doctorId: doctor, description: "Current root canal episode",
  quantity: 1, unitPriceMinor: 80000, toothCode: 36, caseId: null as number | null, sessions: 2, ...patch,
});
const invoice = (patientId: number, patch: Partial<InvoiceLine> = {}) => createLinkedInvoice({
  patientId, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "admin", actorRole: "admin",
  items: [invoiceLine(patch)], templates: DEFAULT_SPECIALTY_TEMPLATES,
  idempotencyKey: null, requestHash: null, auditDetails: {},
});

async function ordinaryPlan(patientId: number, toothCode = 46) {
  const result = await db.createPlanV2({
    patientId, title: "Ordinary planned work", specialty: "endodontics", primaryDoctorId: null,
    billingMode: "per_procedure", baseCurrency: "YER", startDate: TODAY, note: null, createdBy: "doctor",
    items: [{ serviceId: rct, serviceName: "Root canal", category: "rct", toothCode, surfaces: null,
      quantity: 1, unitPriceMinor: 80000, billingRule: "on_completion", sessionCount: 2, note: null }],
    installments: [],
  });
  if (!result.ok) throw new Error(result.message);
  return result.planId;
}

const paymentInput = (patientId: number, patch: Partial<Parameters<typeof db.recordPayment>[0]> = {}) => ({
  patientId, invoiceId: null, kind: "payment" as const, amountMinor: 10000,
  currency: "YER" as const, baseCurrency: "YER" as const, exchangeRate: 1,
  method: "cash", note: null, createdBy: "cashier", ...patch,
});

const installment = (patientId: number, planId: number) => db.recordPlanInstallment({
  patientId, planId, planTitle: "Existing work", installmentNumber: 1, amountMinor: 10000,
  currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "cashier",
});

describe("canonical master incompatibilities and bounded unsupported episodes", () => {
  it("reuses a compatible preexisting ordinary master without changing real clinical consent fields", async () => {
    const id = await patient("LEG-SAFE-REUSE-ORDINARY");
    const planId = await ordinaryPlan(id);
    const agreement = await legacy(id);
    expect(agreement.planId).toBe(planId);
    expect(await q(`SELECT consent_at, consent_by, consent_note FROM treatment_plans WHERE id = $1`, [planId]))
      .toEqual([{ consent_at: null, consent_by: null, consent_note: null }]);
    expect(await q(`SELECT id FROM treatment_plans WHERE patient_id = $1`, [id])).toHaveLength(1);
  });

  it("refuses a consented master and preserves its genuine consent rather than overwriting it", async () => {
    const id = await patient("LEG-SAFE-CONSENTED-MASTER");
    const planId = await ordinaryPlan(id);
    await consent(planId);
    const before = await footprint(id);
    const priorConsent = await q(`SELECT consent_at, consent_by, consent_note FROM treatment_plans WHERE id = $1`, [planId]);
    expect(await register(id)).toEqual({ ok: false, reason: "incompatible_plan" });
    expect(await footprint(id)).toEqual(before);
    expect(await q(`SELECT consent_at, consent_by, consent_note FROM treatment_plans WHERE id = $1`, [planId])).toEqual(priorConsent);
  });

  it("refuses ordinary open work for the same service and tooth without adding historical debt", async () => {
    const id = await patient("LEG-SAFE-OPEN-WORK");
    await ordinaryPlan(id, 36);
    const before = await footprint(id);
    expect(await register(id)).toEqual({ ok: false, reason: "open_item_exists" });
    expect(await footprint(id)).toEqual(before);
  });

  it("refuses multiple active masters rather than choosing one", async () => {
    const id = await patient("LEG-SAFE-AMBIGUOUS-MASTER");
    await ordinaryPlan(id, 46);
    await ordinaryPlan(id, 47);
    const before = await footprint(id);
    expect(await register(id)).toEqual({ ok: false, reason: "incompatible_plan" });
    expect(await footprint(id)).toEqual(before);
  });

  it("keeps separate root-canal teeth split even after multi-tooth bridge coverage is supported", async () => {
    const id = await patient("LEG-SAFE-MULTI-rct");
    const before = await footprint(id);
    expect(await register(id, { serviceId: rct, episodeTeeth: [36, 46], toothCode: 36 }))
      .toEqual({ ok: false, reason: "episode_split_required" });
    expect(await footprint(id)).toEqual(before);
    expect(await q(`SELECT 1 FROM clinical_cases WHERE patient_id = $1`, [id])).toHaveLength(0);
  });

  it("captures a crown episode once without multiplying its historical price or opening", async () => {
    const id = await patient("LEG-SAFE-MULTI-crown");
    const result = await register(id, { serviceId: crown, episodeTeeth: [14, 15, 16], toothCode: 14 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(await footprint(id)).toEqual({ agreements: 1, plans: 1, items: 1, openings: 1, openingHistory: 1, invoices: 0, payments: 0 });
    expect(result.agreement).toMatchObject({ agreedMinor: 300000, remainingMinor: 180000,
      coverageState: "verified", coverageSite: { episodeTeeth: [14, 15, 16] } });
  });
});

describe("durable history protects ordinary invoice, draft, replacement and mutation paths", () => {
  it.each(["live", "void"] as const)("keeps %s legacy lineage distinct from invoice lineage", async (status) => {
    const id = await patient(`LEG-SAFE-LINEAGE-${status}`);
    const agreement = await legacy(id);
    if (status === "void") expect((await voidAgreement(id, agreement.id)).ok).toBe(true);
    const [row] = await q<{
      legacy: boolean; invoice: boolean; financial: boolean; covered: boolean; prepaid: boolean; review: boolean;
    }>(`SELECT ${db.PLAN_ITEM_LEGACY_LINEAGE_SQL} AS legacy, ${db.PLAN_ITEM_INVOICE_LINEAGE_SQL} AS invoice,
      ${db.PLAN_ITEM_FINANCIAL_LINEAGE_SQL} AS financial, ${db.PLAN_ITEM_LEGACY_COVERED_SQL} AS covered,
      ${db.PLAN_ITEM_PREBILLED_SQL} AS prepaid, ${db.PLAN_ITEM_FINANCIAL_REVIEW_SQL} AS review
      FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE i.id = $1`, [agreement.planItemId]);
    expect(row).toEqual({ legacy: true, invoice: false, financial: true, covered: status === "live", prepaid: false, review: status === "void" });
    expect((await db.listPatientPlans(id, TODAY))[0].items.find((item) => item.id === agreement.planItemId)?.legacyAgreementId).toBe(agreement.id);
  });

  it("preview and save both refuse rebilling voided work; a status edit alone cannot erase history", async () => {
    const id = await patient("LEG-SAFE-VOID-REINVOICE");
    const agreement = await legacy(id);
    expect((await voidAgreement(id, agreement.id)).ok).toBe(true);
    // Simulate stale/imported mutable status. Durable history must remain authoritative.
    await q(`UPDATE plan_items SET billing_status = 'unbilled' WHERE id = $1`, [agreement.planItemId]);
    const before = await footprint(id);
    expect(await db.getPool().query(`SELECT ${db.PLAN_ITEM_FINANCIAL_REVIEW_SQL} AS review
      FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE i.id = $1`, [agreement.planItemId]))
      .toMatchObject({ rows: [{ review: true }] });
    expect((await previewInvoiceLinkage({ patientId: id, baseCurrency: "YER", items: [invoiceLine()] }))[0])
      .toMatchObject({ refusal: "needs_financial_review" });
    expect(await invoice(id)).toMatchObject({ ok: false, reason: "needs_financial_review" });
    expect(await register(id)).toEqual({ ok: false, reason: "needs_financial_review" });
    expect(await footprint(id)).toEqual(before);
  });

  it("refuses destructive/financial mutation gracefully and blocks same-work additions while allowing another tooth", async () => {
    const id = await patient("LEG-SAFE-MUTATION");
    const agreement = await legacy(id);
    expect((await voidAgreement(id, agreement.id)).ok).toBe(true);
    const before = await q(`SELECT * FROM plan_items WHERE id = $1`, [agreement.planItemId]);
    await expect(db.removePlanItem(agreement.planId, agreement.planItemId, { actor: "admin", actorRole: "admin" }))
      .resolves.toMatchObject({ ok: false });
    expect(await db.updatePlanItem({ planId: agreement.planId, itemId: agreement.planItemId,
      sessionCount: 3, billingRule: "per_session", doctorId: doctor, actor: "admin", actorRole: "admin" }))
      .toMatchObject({ ok: false });
    expect(await db.setPlanItemCase({ itemId: agreement.planItemId, caseId: null, priority: null, actor: "admin" }))
      .toEqual({ ok: false, reason: "billed_case_lock" });
    const draft = { planId: agreement.planId, serviceId: rct, serviceName: "Root canal", category: "rct",
      toothCode: 36, surfaces: null, quantity: 1, unitPriceMinor: 80000, note: null };
    expect(await db.addPlanItem(draft)).toMatchObject({ ok: false });
    expect(await q(`SELECT * FROM plan_items WHERE id = $1`, [agreement.planItemId])).toEqual(before);
    expect(await db.addPlanItem({ ...draft, toothCode: 46 })).toMatchObject({ ok: true });
  });

  it("does not block ordinary new work on a different tooth while a historical item needs review", async () => {
    const id = await patient("LEG-SAFE-UNRELATED-TOOTH");
    const agreement = await legacy(id);
    expect((await voidAgreement(id, agreement.id)).ok).toBe(true);
    const result = await invoice(id, { toothCode: 46 });
    expect(result.ok).toBe(true);
    expect(await q(`SELECT billing_status FROM plan_items WHERE id = $1`, [agreement.planItemId]))
      .toEqual([{ billing_status: "needs_financial_review" }]);
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(1);
  });

  it("refuses a duplicate replacement draft even if it was inserted by an older writer", async () => {
    const id = await patient("LEG-SAFE-OLD-DUPLICATE");
    const agreement = await legacy(id);
    expect((await voidAgreement(id, agreement.id)).ok).toBe(true);
    // Fixture represents persisted bad historical data, not the supported addPlanItem path.
    const [{ id: duplicateId }] = await q<{ id: number }>(`INSERT INTO plan_items
      (plan_id, service_id, service_name, category, tooth_code, quantity, unit_price_minor, session_count, billing_rule, case_id)
      VALUES ($1, $2, 'Old duplicate', 'rct', 36, 1, 80000, 2, 'on_completion', $3) RETURNING id`,
    [agreement.planId, rct, agreement.caseId]);
    await consent(agreement.planId);
    const draft = await visit(id, duplicateId, agreement.caseId);
    await expect(sign(draft)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await q(`SELECT 1 FROM visits WHERE id = $1 AND signed_at IS NOT NULL`, [draft])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM treatment_sessions WHERE plan_item_id = $1 AND status = 'done'`, [duplicateId])).toHaveLength(0);
  });

  it("permits a genuinely new same-tooth episode only with a different explicit case after old care is done and closed", async () => {
    const id = await patient("LEG-SAFE-NEW-EPISODE");
    const agreement = await legacy(id, { previouslyPaidAmount: "300000", sessions: 1 });
    await consent(agreement.planId);
    expect(await sign(await visit(id, agreement.planItemId, agreement.caseId))).toMatchObject({ reason: null, invoiceId: null });
    expect(await q(`SELECT status FROM plan_items WHERE id = $1`, [agreement.planItemId])).toEqual([{ status: "done" }]);
    if (agreement.caseId === null) throw new Error("Expected a legacy endodontic case");
    expect(await db.changeClinicalCaseStatus({ id: agreement.caseId, status: "completed", outcome: "Treatment completed", actor: "doctor" }))
      .toMatchObject({ ok: true });
    expect(await db.setPlanStatus(agreement.planId, "completed", { actor: "doctor", actorRole: "doctor" })).toBe("ok");
    const newCaseId = await clinicalCase(id, "36");
    // No selected episode remains ambiguous historical work.
    expect((await invoice(id)).ok).toBe(false);
    expect((await invoice(id, { caseId: newCaseId })).ok).toBe(true);
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(1);
    expect(await q(`SELECT status, case_id FROM legacy_treatment_agreements WHERE id = $1`, [agreement.id]))
      .toEqual([{ status: "live", case_id: agreement.caseId }]);
  });

  it("cannot manufacture a new episode while old historical review remains unresolved", async () => {
    const id = await patient("LEG-SAFE-REVIEW-EPISODE");
    const agreement = await legacy(id, { sessions: 1 });
    await consent(agreement.planId);
    expect(await sign(await visit(id, agreement.planItemId, agreement.caseId))).toMatchObject({ reason: null, invoiceId: null });
    expect((await voidAgreement(id, agreement.id)).ok).toBe(true);
    if (agreement.caseId === null) throw new Error("Expected a legacy endodontic case");
    expect(await db.changeClinicalCaseStatus({ id: agreement.caseId, status: "completed", outcome: "Treatment completed", actor: "doctor" }))
      .toMatchObject({ ok: true });
    expect(await db.setPlanStatus(agreement.planId, "completed", { actor: "doctor", actorRole: "doctor" })).toBe("ok");
    const newCaseId = await clinicalCase(id, "36");
    expect(await invoice(id, { caseId: newCaseId })).toMatchObject({ ok: false, reason: "needs_financial_review" });
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(0);
  });
});

describe("settlement target boundaries preserve legitimate receipts and corrections", () => {
  it("still accepts new direct-plan receipts on an ordinary nonlegacy master", async () => {
    const id = await patient("LEG-SAFE-ORDINARY-PAYMENT");
    const planId = await ordinaryPlan(id);
    const result = await db.recordPayment(paymentInput(id, { planId }));
    expect(result).toMatchObject({ reason: null, payment: { patientId: id, planId, invoiceId: null, openingCurrency: null, amountMinor: 10000 } });
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(0);
  });

  it("refuses new legacy/mixed-master direct receipts but accepts explicit invoice and opening targets", async () => {
    const id = await patient("LEG-SAFE-MIXED-TARGETS");
    const agreement = await legacy(id);
    const current = await invoice(id, { toothCode: 46 });
    if (!current.ok) throw new Error(current.reason);
    const [{ plan_id: invoicePlanId }] = await q<{ plan_id: number }>(`SELECT plan_id FROM plan_items WHERE id = $1`, [current.links[0].planItemId]);
    expect(invoicePlanId).toBe(agreement.planId);
    expect(await db.recordPayment(paymentInput(id, { planId: agreement.planId })))
      .toMatchObject({ reason: "invalid_plan_target", payment: null });
    expect(await db.recordPayment(paymentInput(id, { invoiceId: current.invoice.id })))
      .toMatchObject({ reason: null, payment: { invoiceId: current.invoice.id, planId: null } });
    expect(await db.recordPayment(paymentInput(id, { openingCurrency: "YER" })))
      .toMatchObject({ reason: null, payment: { invoiceId: null, planId: null, openingCurrency: "YER" } });
    expect(await q(`SELECT 1 FROM payments WHERE patient_id = $1`, [id])).toHaveLength(2);
  });

  it("keeps an earlier direct-plan success replayable, refundable and correctable by its inherited target", async () => {
    const id = await patient("LEG-SAFE-HISTORICAL-RECEIPTS");
    const planId = await ordinaryPlan(id);
    const originalInput = paymentInput(id, { planId, idempotencyKey: "legacy:safe-prior-receipt" });
    const first = await db.recordPayment(originalInput);
    const second = await db.recordPayment(paymentInput(id, { planId, amountMinor: 20000 }));
    if (first.reason !== null || second.reason !== null || !first.payment || !second.payment) throw new Error("Receipt fixture failed");
    const agreement = await legacy(id);
    expect(agreement.planId).toBe(planId);
    expect(await db.recordPayment(originalInput)).toMatchObject({ reason: null, replayed: true, payment: { id: first.payment.id } });
    expect(await q(`SELECT 1 FROM payments WHERE patient_id = $1`, [id])).toHaveLength(2);
    expect(await db.recordPayment(paymentInput(id, { planId }))).toMatchObject({ reason: "invalid_plan_target", payment: null });
    // Refund passes no new target: it inherits the locked original receipt's target.
    expect(await db.recordPayment(paymentInput(id, { kind: "refund", amountMinor: 4000, reversalOfId: first.payment.id })))
      .toMatchObject({ reason: null, payment: { kind: "refund", amountMinor: 4000, planId, invoiceId: null } });
    const corrected = await db.correctPayment({
      paymentId: second.payment.id, reason: "Correct receipt amount", actor: "admin", actorRole: "admin",
      replacement: { amountMinor: 15000, currency: "YER", exchangeRate: 1, method: "cash", target: { kind: "original" } },
    });
    expect(corrected).toMatchObject({ reason: null,
      reversal: { kind: "refund", amountMinor: 20000, planId }, replacement: { kind: "payment", amountMinor: 15000, planId } });
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(0);
    expect(await q(`SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id = $1`, [id]))
      .toEqual([{ amount_minor: "180000" }]);
  });

  it.each(["live", "void"] as const)("rejects new schedule and installment invoices for %s legacy history", async (status) => {
    const id = await patient(`LEG-SAFE-INSTALLMENT-${status}`);
    const agreement = await legacy(id);
    await consent(agreement.planId);
    if (status === "void") expect((await voidAgreement(id, agreement.id)).ok).toBe(true);
    expect(await db.schedulePlanInstallments({ planId: agreement.planId, count: 2, everyDays: 30, firstDueDate: TODAY }))
      .toMatchObject({ ok: false });
    expect(await installment(id, agreement.planId)).toHaveProperty("reason");
    expect(await q(`SELECT 1 FROM plan_installments WHERE plan_id = $1`, [agreement.planId])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM payments WHERE patient_id = $1`, [id])).toHaveLength(0);
  });

  it("retains the installment prohibition after invoice cancellation", async () => {
    const id = await patient("LEG-SAFE-CANCELLED-INVOICE");
    const issued = await invoice(id);
    if (!issued.ok || issued.links[0].planItemId === null) throw new Error("Invoice fixture failed");
    const [{ plan_id: planId }] = await q<{ plan_id: number }>(`SELECT plan_id FROM plan_items WHERE id = $1`, [issued.links[0].planItemId]);
    await consent(planId);
    expect(await db.setInvoiceStatus(issued.invoice.id, "cancelled", { actor: "admin", actorRole: "admin" }))
      .toMatchObject({ status: "cancelled" });
    expect(await db.schedulePlanInstallments({ planId, count: 2, everyDays: 30, firstDueDate: TODAY })).toMatchObject({ ok: false });
    expect(await installment(id, planId)).toHaveProperty("reason");
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM payments WHERE patient_id = $1`, [id])).toHaveLength(0);
  });

  it("rejects new installments for invoice lineage while ordinary invoice settlement remains available", async () => {
    const id = await patient("LEG-SAFE-INVOICE-INSTALLMENT");
    const issued = await invoice(id);
    if (!issued.ok || issued.links[0].planItemId === null) throw new Error("Invoice fixture failed");
    const [{ plan_id: planId }] = await q<{ plan_id: number }>(`SELECT plan_id FROM plan_items WHERE id = $1`, [issued.links[0].planItemId]);
    await consent(planId);
    expect(await db.schedulePlanInstallments({ planId, count: 2, everyDays: 30, firstDueDate: TODAY })).toMatchObject({ ok: false });
    expect(await installment(id, planId)).toHaveProperty("reason");
    expect(await db.recordPayment(paymentInput(id, { invoiceId: issued.invoice.id })))
      .toMatchObject({ reason: null, payment: { invoiceId: issued.invoice.id } });
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [id])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM payments WHERE patient_id = $1`, [id])).toHaveLength(1);
  });
});

describe("deterministic patient-first void serialization", () => {
  it("waits on the patient before holding any plan or item lock", async () => {
    const id = await patient("LEG-SAFE-LOCK-ORDER");
    const agreement = await legacy(id);
    const blocker = await db.getPool().connect();
    let pending: ReturnType<typeof voidAgreement> | null = null;
    try {
      await blocker.query("BEGIN");
      const { rows: [{ pid }] } = await blocker.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
      await blocker.query(`SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE`, [id]);
      pending = voidAgreement(id, agreement.id);
      void pending.catch(() => undefined); // Await and assert below, but avoid an unhandled rejection while observing locks.
      // Observe the actual database wait; no elapsed-time success assertion or Promise.all race.
      let waiter: { query: string } | undefined;
      const deadline = Date.now() + 5000;
      while (!waiter && Date.now() < deadline) {
        [waiter] = await q<{ query: string }>(`SELECT query FROM pg_stat_activity
          WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))`, [pid]);
        if (!waiter) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiter, "void must reach a lock wait on the patient").toBeDefined();
      expect(waiter?.query).toMatch(/FROM patients[\s\S]*FOR NO KEY UPDATE/i);
      // If void acquired the item first (old implementation), NOWAIT fails here with 55P03.
      await blocker.query(`SELECT id FROM treatment_plans WHERE id = $1 FOR UPDATE NOWAIT`, [agreement.planId]);
      await blocker.query(`SELECT id FROM plan_items WHERE id = $1 FOR UPDATE NOWAIT`, [agreement.planItemId]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      if (pending) expect((await pending).ok).toBe(true);
    }
    expect(await q(`SELECT billing_status FROM plan_items WHERE id = $1`, [agreement.planItemId]))
      .toEqual([{ billing_status: "needs_financial_review" }]);
  }, 15000);
});
