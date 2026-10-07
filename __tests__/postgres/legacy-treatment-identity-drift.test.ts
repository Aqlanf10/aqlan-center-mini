import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { parseLegacyTreatmentRequest } from "../../lib/legacy-treatment";
import { openPeriodontalFixture } from "./_periodontal-fixture";

/** Real-writer source regressions for the complete43 composition. Not run during source-only review.
 * Every corruption below is synthetic and scoped to this newly created, identity-verified UUID fixture.
 */
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>> | undefined;
let db: typeof import("../../lib/db");
let legacy: typeof import("../../lib/legacy-treatment-db");
let invoices: typeof import("../../lib/invoice-linkage-db");
let doctor = 0, sequence = 0;
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query<T>(sql, values)).rows;
const patient = async () => (await q<{ id: number }>(
  "INSERT INTO patients (patient_number,full_name) VALUES ($1,'Synthetic identity patient') RETURNING id",
  [`SYN-IDENTITY-${++sequence}`]))[0].id;
const service = async () => (await q<{ id: number }>(
  "INSERT INTO services (name,category,price_minor,price_configured) VALUES ('Synthetic identity bridge','bridge',300000,TRUE) RETURNING id"))[0].id;
function register(patientId: number, serviceId: number, patch: Record<string, unknown> = {}) {
  const parsed = parseLegacyTreatmentRequest({ serviceId, toothCode: 14, episodeTeeth: [14, 15, 16], sessions: 2,
    currency: "YER", agreedAmount: "300000", previouslyPaidAmount: "120000", historicalAsOf: "2020-01-01", ...patch }, "2026-10-07");
  if (!parsed.ok) throw new Error(parsed.message);
  return legacy.createLegacyTreatment({ patientId, request: parsed.value, actor: "synthetic-owner", actorRole: "admin",
    canEditOpening: true, templates: DEFAULT_SPECIALTY_TEMPLATES });
}
const line = (serviceId: number, toothCode = 15, category = "bridge") => ({ serviceId, category, doctorId: doctor,
  description: "Synthetic identity bridge", quantity: 1, unitPriceMinor: 300000, toothCode, caseId: null, sessions: 2 });
const invoice = (patientId: number, item: ReturnType<typeof line>, baseCurrency: "YER" | "SAR" = "YER") => invoices.createLinkedInvoice({
  patientId, baseCurrency, items: [item], discountMinor: 0, note: null, createdBy: "synthetic-owner", actorRole: "admin",
  idempotencyKey: null, requestHash: null, auditDetails: {}, templates: DEFAULT_SPECIALTY_TEMPLATES,
});
async function draft(patientId: number, serviceId: number, planItemId: number | null = null) {
  const visit = await db.addVisit({ patientName: "Synthetic identity patient", patientPhone: null, note: null, patientId });
  // Keep case null: the free/linked work fence must hold without the separate case-level signature gate.
  await q("UPDATE visits SET doctor_id=$2,diagnosis='Synthetic current documentation',case_id=NULL WHERE id=$1", [visit.id, doctor]);
  expect(await db.setVisitProcedures({ visitId: visit.id, procedures: [{ serviceId, toothCode: 15, planItemId,
    surfaces: null, quantity: 1, unitPriceMinor: 300000, priceReason: null, doctorId: null, note: null }] })).toBe(true);
  return visit.id;
}
const sign = (visitId: number) => db.signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "synthetic-doctor", signerDoctorPartyId: doctor });
async function financialState(patientIds: number[]) {
  return (await q(`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM legacy_treatment_agreements a WHERE a.patient_id=ANY($1::int[])) AS agreements,
    (SELECT COALESCE(jsonb_agg(to_jsonb(cs) ORDER BY cs.agreement_id),'[]'::jsonb) FROM legacy_treatment_coverage_snapshots cs JOIN legacy_treatment_agreements a ON a.id=cs.agreement_id WHERE a.patient_id=ANY($1::int[])) AS snapshots,
    (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.patient_id,b.currency),'[]'::jsonb) FROM patient_opening_balances b WHERE b.patient_id=ANY($1::int[])) AS balances,
    (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.id),'[]'::jsonb) FROM patient_opening_balance_history h WHERE h.patient_id=ANY($1::int[])) AS history,
    (SELECT COUNT(*)::int FROM invoices WHERE patient_id=ANY($1::int[])) AS invoices,
    (SELECT COUNT(*)::int FROM payments WHERE patient_id=ANY($1::int[])) AS payments,
    (SELECT COUNT(*)::int FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id WHERE t.patient_id=ANY($1::int[])) AS items,
    (SELECT COUNT(*)::int FROM treatment_sessions s JOIN plan_items i ON i.id=s.plan_item_id JOIN treatment_plans t ON t.id=i.plan_id WHERE t.patient_id=ANY($1::int[]) AND s.status='done') AS completed`, [patientIds]))[0];
}

beforeAll(async () => {
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  db = fixture.db;
  await db.ensureSchema();
  legacy = await import("../../lib/legacy-treatment-db");
  invoices = await import("../../lib/invoice-linkage-db");
  doctor = (await q<{ id: number }>("INSERT INTO parties (kind,name) VALUES ('doctor','Synthetic identity doctor') RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await fixture?.close(); }, 30_000);

describe.each(["live", "void"] as const)("immutable %s legacy identity survives mutable drift", (status) => {
  it.each(["service", "patient", "patient_and_service"] as const)("holds original secondary-tooth invoice, registration and signing after %s drift", async (drift) => {
    const originalPatient = await patient(), otherPatient = await patient();
    const originalService = await service(), otherService = await service();
    const registered = await register(originalPatient, originalService);
    if (!registered.ok) throw new Error(registered.reason);
    const agreement = registered.agreement;
    if (status === "void") {
      expect(await legacy.voidLegacyTreatment({ patientId: originalPatient, agreementId: agreement.id,
        reason: "Synthetic void before identity drift", actor: "synthetic-owner", actorRole: "admin" })).toMatchObject({ ok: true });
      await q("UPDATE plan_items SET status='cancelled' WHERE id=$1", [agreement.planItemId]);
      await q("UPDATE treatment_plans SET status='cancelled' WHERE id=$1", [agreement.planId]);
    }
    if (drift !== "patient") await q("UPDATE plan_items SET service_id=$2 WHERE id=$1", [agreement.planItemId, otherService]);
    if (drift !== "service") {
      await q("UPDATE treatment_plans SET patient_id=$2 WHERE id=$1", [agreement.planId, otherPatient]);
      await q("UPDATE plan_items SET service_name='Synthetic foreign private clinical label' WHERE id=$1", [agreement.planItemId]);
    }
    // Neither cancellation, narrowed labels nor a different displayed anchor removes immutable member15.
    await q("UPDATE clinical_cases SET site='14' WHERE id=$1", [agreement.caseId]);
    const before = await financialState([originalPatient, otherPatient]);
    for (const baseCurrency of ["YER", "SAR"] as const) {
      expect((await invoices.previewInvoiceLinkage({ patientId: originalPatient, baseCurrency,
        items: [line(originalService)] }))[0].refusal).toBe("needs_financial_review");
      expect(await invoice(originalPatient, line(originalService), baseCurrency)).toMatchObject({ ok: false, reason: "needs_financial_review" });
    }
    // Preserve the pre-existing fence for the mutable row's current patient/service as well.
    const currentPatient = drift === "service" ? originalPatient : otherPatient;
    const currentService = drift === "patient" ? originalService : otherService;
    expect((await invoices.previewInvoiceLinkage({ patientId: currentPatient, baseCurrency: "YER",
      items: [line(currentService)] }))[0].refusal).toBe("needs_financial_review");
    expect(await register(originalPatient, originalService, { toothCode: 16, episodeTeeth: [16, 17] }))
      .toEqual({ ok: false, reason: "needs_financial_review" });
    const freeVisit = await draft(originalPatient, originalService);
    const warning = (await db.getClinicalVisit(freeVisit))?.planWarning;
    expect(warning).toContain(agreement.serviceName);
    expect(warning).not.toContain("Synthetic foreign private clinical label");
    const signed = await sign(freeVisit);
    expect(signed).toMatchObject({ reason: "plan_session_unlinked", invoiceId: null });
    expect(signed.sessionConflicts?.join(" ")).toContain(agreement.serviceName);
    expect(signed.sessionConflicts?.join(" ")).not.toContain("Synthetic foreign private clinical label");
    expect(await q("SELECT 1 FROM visit_procedures WHERE visit_id=$1", [freeVisit])).toHaveLength(1);
    expect(await q("SELECT 1 FROM visits WHERE id=$1 AND signed_at IS NOT NULL", [freeVisit])).toHaveLength(0);

    // Catalog reclassification into a financial-only line must use the same immutable identity fence.
    await q("UPDATE services SET category='consultation' WHERE id=$1", [originalService]);
    expect((await invoices.previewInvoiceLinkage({ patientId: originalPatient, baseCurrency: "YER",
      items: [line(originalService, 15, "consultation")] }))[0].refusal).toBe("needs_financial_review");
    expect(await invoice(originalPatient, line(originalService, 15, "consultation")))
      .toMatchObject({ ok: false, reason: "needs_financial_review" });
    await q("UPDATE services SET category='bridge' WHERE id=$1", [originalService]);
    expect(await financialState([originalPatient, otherPatient])).toEqual(before);

    // A forged duplicate has its own valid current patient/service; the original-service projection must still find history.
    const duplicatePlan = (await q<{ id: number }>(`INSERT INTO treatment_plans
      (patient_id,title,total_minor,total_from_items,consent_at,consent_by)
      VALUES ($1,'Synthetic duplicate plan',300000,TRUE,NOW(),'synthetic-current-owner') RETURNING id`, [originalPatient]))[0].id;
    const duplicate = (await q<{ id: number }>(`INSERT INTO plan_items
      (plan_id,service_id,service_name,category,tooth_code,unit_price_minor,session_count)
      VALUES ($1,$2,'Synthetic duplicate member','bridge',15,300000,1) RETURNING id`, [duplicatePlan, originalService]))[0].id;
    await q("INSERT INTO treatment_sessions (plan_item_id,sequence) VALUES ($1,1)", [duplicate]);
    const linkedVisit = await draft(originalPatient, originalService, duplicate);
    const linkedBefore = await financialState([originalPatient, otherPatient]);
    const clinical = await db.getClinicalVisit(linkedVisit);
    expect(clinical?.outstanding.find((item) => item.planItemId === duplicate)?.financialReviewRequired).toBe(true);
    expect(clinical?.sessionPricing.find((item) => item.planItemId === duplicate)?.financialReviewRequired).toBe(true);
    await expect(db.previewVisitBilling(linkedVisit)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    await expect(sign(linkedVisit)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await q("SELECT 1 FROM visits WHERE id=$1 AND signed_at IS NOT NULL", [linkedVisit])).toHaveLength(0);
    expect(await q("SELECT 1 FROM visit_procedures WHERE visit_id=$1", [linkedVisit])).toHaveLength(1);
    expect(await financialState([originalPatient, otherPatient])).toEqual(linkedBefore);
  });
});

describe("agreement history reads preserve patient display ownership", () => {
  it("does not display a moved foreign case title for the original agreement patient", async () => {
    const originalPatient = await patient(), otherPatient = await patient(), serviceId = await service();
    const registered = await register(originalPatient, serviceId);
    if (!registered.ok || registered.agreement.caseId === null) throw new Error("Synthetic historical case is required");
    const agreement = registered.agreement;
    await q("UPDATE clinical_cases SET patient_id=$2,title='Synthetic foreign case title' WHERE id=$1", [agreement.caseId, otherPatient]);
    const before = await financialState([originalPatient, otherPatient]);
    const history = await legacy.listLegacyTreatments(originalPatient);
    expect(history.find((one) => one.id === agreement.id)).toMatchObject({ patientId: originalPatient, caseTitle: null,
      serviceName: agreement.serviceName, agreedMinor: agreement.agreedMinor, remainingMinor: agreement.remainingMinor });
    expect(JSON.stringify(history)).not.toContain("Synthetic foreign case title");
    expect(await financialState([originalPatient, otherPatient])).toEqual(before);
  });
});

describe("immutable identity fence remains scoped", () => {
  it("preserves disjoint verified work, unrelated patients/services and ordinary work without history", async () => {
    const originalPatient = await patient(), unrelatedPatient = await patient();
    const originalService = await service(), unrelatedService = await service();
    const registered = await register(originalPatient, originalService);
    if (!registered.ok) throw new Error(registered.reason);
    for (const [patientId, serviceId, tooth] of [[originalPatient, originalService, 48],
      [unrelatedPatient, originalService, 15], [originalPatient, unrelatedService, 15]] as const) {
      expect((await invoices.previewInvoiceLinkage({ patientId, baseCurrency: "YER", items: [line(serviceId, tooth)] }))[0].refusal).toBeNull();
    }
    expect(await invoice(originalPatient, line(originalService, 48))).toMatchObject({ ok: true });
    expect(await invoice(unrelatedPatient, line(originalService))).toMatchObject({ ok: true });
  });
});
