import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { parseLegacyTreatmentRequest } from "../../lib/legacy-treatment";
import { openPeriodontalFixture } from "./_periodontal-fixture";

/** Source-only real-writer regressions. Execute only after the complete43 composition is reviewed.
 * The pristine UUID fixture never resets a pre-existing database; this file does not activate periodontal code.
 * Two-level collection/void policy is covered separately; immutable scope never allocates receipts.
 */
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>> | undefined;
let db: typeof import("../../lib/db");
let legacy: typeof import("../../lib/legacy-treatment-db");
let invoices: typeof import("../../lib/invoice-linkage-db");
let bridge = 0, doctor = 0, sequence = 0;
const TODAY = "2026-10-07";
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query<T>(sql, values)).rows;
const patient = async () => (await q<{ id: number }>("INSERT INTO patients (patient_number,full_name) VALUES ($1,'Synthetic immutable legacy patient') RETURNING id", [`SYN-IMMUTABLE-${++sequence}`]))[0].id;
function register(patientId: number, patch: Record<string, unknown> = {}) {
  const parsed = parseLegacyTreatmentRequest({ serviceId: bridge, toothCode: 14, episodeTeeth: [14,15,16], sessions: 2,
    currency: "YER", agreedAmount: "300000", previouslyPaidAmount: "120000", historicalAsOf: "2020-01-01", ...patch }, TODAY);
  if (!parsed.ok) throw new Error(parsed.message);
  return legacy.createLegacyTreatment({ patientId, request: parsed.value, actor: "synthetic-owner", actorRole: "admin",
    canEditOpening: true, templates: DEFAULT_SPECIALTY_TEMPLATES });
}
async function saved(patientId: number, patch: Record<string, unknown> = {}) {
  const result = await register(patientId, patch);
  if (!result.ok) throw new Error(result.reason);
  return result.agreement;
}
const invoiceLine = (toothCode: number) => ({ serviceId: bridge, category: "bridge", doctorId: doctor,
  description: "Synthetic bridge", quantity: 1, unitPriceMinor: 300000, toothCode, caseId: null, sessions: 2 });
const invoice = (patientId: number, toothCode: number, baseCurrency: "YER" | "SAR" = "YER") => invoices.createLinkedInvoice({
  patientId, baseCurrency, items: [invoiceLine(toothCode)], discountMinor: 0, note: null, createdBy: "synthetic-owner",
  actorRole: "admin", idempotencyKey: null, requestHash: null, auditDetails: {}, templates: DEFAULT_SPECIALTY_TEMPLATES,
});
async function draft(patientId: number, toothCode: number, planItemId: number | null, caseId: number | null) {
  const visit = await db.addVisit({ patientName: "Synthetic immutable legacy patient", patientPhone: null, note: null, patientId });
  await q("UPDATE visits SET doctor_id=$2,case_id=$3,diagnosis='Synthetic current clinical documentation' WHERE id=$1", [visit.id, doctor, caseId]);
  await db.setVisitProcedures({ visitId: visit.id, procedures: [{ serviceId: bridge, toothCode, planItemId,
    surfaces: null, quantity: 1, unitPriceMinor: 300000, priceReason: null, doctorId: null, note: null }] });
  return visit.id;
}
const sign = (visitId: number) => db.signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "synthetic-doctor", signerDoctorPartyId: doctor });
async function footprint(patientId: number) {
  return (await q(`SELECT
    (SELECT COUNT(*)::int FROM legacy_treatment_agreements WHERE patient_id=$1) AS agreements,
    (SELECT COUNT(*)::int FROM legacy_treatment_coverage_snapshots c JOIN legacy_treatment_agreements a ON a.id=c.agreement_id WHERE a.patient_id=$1) AS snapshots,
    (SELECT COUNT(*)::int FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id WHERE p.patient_id=$1) AS items,
    (SELECT COUNT(*)::int FROM patient_opening_balance_history WHERE patient_id=$1) AS history,
    (SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id=$1 AND currency='YER') AS opening,
    (SELECT COUNT(*)::int FROM invoices WHERE patient_id=$1) AS invoices,
    (SELECT COUNT(*)::int FROM payments WHERE patient_id=$1) AS payments`, [patientId]))[0];
}

beforeAll(async () => {
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  db = fixture.db;
  await db.ensureSchema();
  legacy = await import("../../lib/legacy-treatment-db");
  invoices = await import("../../lib/invoice-linkage-db");
  doctor = (await q<{ id: number }>("INSERT INTO parties (kind,name) VALUES ('doctor','Synthetic coverage doctor') RETURNING id"))[0].id;
  bridge = (await q<{ id: number }>("INSERT INTO services (name,category,price_minor,price_configured) VALUES ('Synthetic bridge','bridge',300000,TRUE) RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await fixture?.close(); }, 30_000);

describe("complete historical episode coverage stays one financial and clinical identity", () => {
  it("keeps one300000 item, one180000 opening, immutable14/15/16, identical replay and no historical events", async () => {
    const id = await patient();
    const agreement = await saved(id, { idempotencyKey: "immutable:one-bridge" });
    expect(agreement).toMatchObject({ agreedMinor: 300000, previouslyPaidMinor: 120000, remainingMinor: 180000,
      coverageState: "verified", coverageSite: { toothCode: 14, episodeTeeth: [14,15,16] } });
    const expected = { agreements: 1, snapshots: 1, items: 1, history: 1, opening: "180000", invoices: 0, payments: 0 };
    expect(await footprint(id)).toEqual(expected);
    expect(await register(id, { idempotencyKey: "immutable:one-bridge" })).toMatchObject({ ok: true, replayed: true, agreement: { id: agreement.id } });
    expect(await footprint(id)).toEqual(expected);
    expect(await q("SELECT quantity,unit_price_minor::text,doctor_id FROM plan_items WHERE id=$1", [agreement.planItemId]))
      .toEqual([{ quantity: 1, unit_price_minor: "300000", doctor_id: null }]);
    expect(await q("SELECT consent_at,consent_by FROM treatment_plans WHERE id=$1", [agreement.planId])).toEqual([{ consent_at: null, consent_by: null }]);
    expect(await q("SELECT 1 FROM treatment_sessions WHERE plan_item_id=$1 AND status='done'", [agreement.planItemId])).toHaveLength(0);
  });
  it("blocks the secondary tooth in preview/save across currencies and in overlapping re-registration", async () => {
    const id = await patient();
    await saved(id);
    const before = await footprint(id);
    for (const baseCurrency of ["YER", "SAR"] as const) {
      expect((await invoices.previewInvoiceLinkage({ patientId: id, baseCurrency, items: [invoiceLine(15)] }))[0].refusal).toBe("legacy_covered");
      expect(await invoice(id, 15, baseCurrency)).toMatchObject({ ok: false, reason: "legacy_covered" });
    }
    expect(await register(id, { toothCode: 16, episodeTeeth: [16,17] })).toEqual({ ok: false, reason: "duplicate_live" });
    expect(await footprint(id)).toEqual(before);
  });
  it("blocks free secondary-tooth billing while preserving its clinical draft", async () => {
    const id = await patient();
    const agreement = await saved(id);
    expect(await db.recordPlanConsent({ planId: agreement.planId, actor: "synthetic-doctor", note: "Explicit current consent before the free-member guard test" })).toMatchObject({ ok: true });
    const visitId = await draft(id, 15, null, agreement.caseId);
    const before = await footprint(id);
    expect(await sign(visitId)).toMatchObject({ reason: "plan_session_unlinked", invoiceId: null });
    expect(await q("SELECT 1 FROM visit_procedures WHERE visit_id=$1", [visitId])).toHaveLength(1);
    expect(await q("SELECT 1 FROM visits WHERE id=$1 AND signed_at IS NOT NULL", [visitId])).toHaveLength(0);
    expect(await q("SELECT 1 FROM treatment_sessions WHERE plan_item_id=$1 AND status='done'", [agreement.planItemId])).toHaveLength(0);
    expect(await footprint(id)).toEqual(before);
  });
  it("keeps a forged duplicate draft item from bypassing the canonical legacy work", async () => {
    const id = await patient();
    const agreement = await saved(id);
    const duplicate = (await q<{ id: number }>(`INSERT INTO plan_items
      (plan_id,service_id,service_name,category,tooth_code,unit_price_minor,case_id,session_count)
      VALUES ($1,$2,'Synthetic duplicate','bridge',15,300000,$3,1) RETURNING id`, [agreement.planId, bridge, agreement.caseId]))[0].id;
    await q("INSERT INTO treatment_sessions (plan_item_id,sequence) VALUES ($1,1)", [duplicate]);
    expect(await db.recordPlanConsent({ planId: agreement.planId, actor: "synthetic-doctor", note: "Synthetic explicit consent" })).toMatchObject({ ok: true });
    const visitId = await draft(id, 15, duplicate, agreement.caseId);
    await expect(sign(visitId)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await q("SELECT 1 FROM visits WHERE id=$1 AND signed_at IS NOT NULL", [visitId])).toHaveLength(0);
    expect((await footprint(id)).invoices).toBe(0);
  });
  it("signs only the canonical anchor after explicit current consent, with one session and no invoice", async () => {
    const id = await patient();
    const agreement = await saved(id);
    const visitId = await draft(id, 14, agreement.planItemId, agreement.caseId);
    await expect(sign(visitId)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await db.recordPlanConsent({ planId: agreement.planId, actor: "synthetic-doctor", note: "Explicit current consent for this documented episode" })).toMatchObject({ ok: true });
    expect(await sign(visitId)).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0 });
    expect(await q("SELECT 1 FROM treatment_sessions WHERE plan_item_id=$1 AND status='done'", [agreement.planItemId])).toHaveLength(1);
    expect(await q("SELECT 1 FROM tooth_conditions WHERE patient_id=$1 AND tooth_code IN (15,16) AND stage='completed'", [id])).toHaveLength(0);
    expect((await footprint(id)).invoices).toBe(0);
  });
  it("ignores narrowed mutable case labels and allows genuinely disjoint verified work", async () => {
    const id = await patient();
    const agreement = await saved(id);
    await q("UPDATE clinical_cases SET site='14',title='Synthetic mutable label' WHERE id=$1", [agreement.caseId]);
    expect((await invoices.previewInvoiceLinkage({ patientId: id, baseCurrency: "YER", items: [invoiceLine(15)] }))[0].refusal).toBe("legacy_covered");
    expect(await invoice(id, 15)).toMatchObject({ ok: false, reason: "legacy_covered" });
    const separate = await register(id, { toothCode: 17, episodeTeeth: [17,18], agreedAmount: "50000", previouslyPaidAmount: "10000" });
    expect(separate.ok).toBe(true);
    expect(await footprint(id)).toEqual({ agreements: 2, snapshots: 2, items: 2, history: 2, opening: "220000", invoices: 0, payments: 0 });
    expect((await legacy.listLegacyTreatments(id)).find((row) => row.id === agreement.id)?.coverageSite?.episodeTeeth).toEqual([14,15,16]);
  });
  it("serializes two partially overlapping registrations without duplicate money", async () => {
    const id = await patient();
    const results = await Promise.all([register(id, { idempotencyKey: "immutable:race-a" }),
      register(id, { toothCode: 16, episodeTeeth: [16,17], idempotencyKey: "immutable:race-b" })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "duplicate_live" }]);
    expect(await footprint(id)).toEqual({ agreements: 1, snapshots: 1, items: 1, history: 1, opening: "180000", invoices: 0, payments: 0 });
  });
  it("refuses to claim existing billed secondary-tooth work as a new historical bridge", async () => {
    const id = await patient();
    const billed = await invoice(id, 15);
    expect(billed.ok).toBe(true);
    if (!billed.ok) throw new Error(billed.reason);
    await q("UPDATE clinical_cases SET site='48' WHERE patient_id=$1", [id]);
    const before = await footprint(id);
    expect(await register(id)).toMatchObject({ ok: false, reason: "needs_financial_review" });
    expect(await footprint(id)).toEqual(before);
    expect(before).toMatchObject({ agreements: 0, snapshots: 0, history: 0, opening: null, invoices: 1 });
  });
  it.each(["planned", "in_progress"] as const)("refuses existing ordinary %s tooth15 before creating a historical bridge anchored14", async (status) => {
    const id = await patient();
    const plan = (await q<{ id: number }>("INSERT INTO treatment_plans (patient_id,title,total_minor,total_from_items) VALUES ($1,'Synthetic ordinary plan',300000,TRUE) RETURNING id", [id]))[0].id;
    const existingCase = await db.createClinicalCase({ patientId: id, specialty: "prosthodontics", title: "Synthetic ordinary tooth15",
      site: "15", problem: null, responsiblePartyId: null, orthoCaseId: null, actor: "synthetic-doctor", actorRole: "doctor" });
    if (!existingCase.ok) throw new Error("Synthetic ordinary case refused");
    await q(`INSERT INTO plan_items (plan_id,service_id,service_name,category,tooth_code,unit_price_minor,case_id,status)
      VALUES ($1,$2,'Synthetic ordinary secondary tooth','bridge',15,300000,$3,$4)`, [plan,bridge,existingCase.case.id,status]);
    await q("UPDATE clinical_cases SET site='48' WHERE id=$1", [existingCase.case.id]);
    const before = await footprint(id);
    expect(await register(id)).toMatchObject({ ok: false, reason: "open_item_exists" });
    expect(await footprint(id)).toEqual(before);
  });
  it("rolls back the actual registration if snapshot insertion fails after the opening write", async () => {
    const id = await patient();
    const before = await footprint(id);
    await q(`CREATE FUNCTION synthetic_coverage_failure() RETURNS trigger AS $$ BEGIN
      RAISE EXCEPTION 'Synthetic coverage snapshot insertion failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER synthetic_coverage_failure BEFORE INSERT ON legacy_treatment_coverage_snapshots
      FOR EACH ROW EXECUTE FUNCTION synthetic_coverage_failure()`);
    try { await expect(register(id)).rejects.toThrow("Synthetic coverage snapshot insertion failure"); }
    finally { await q("DROP TRIGGER synthetic_coverage_failure ON legacy_treatment_coverage_snapshots; DROP FUNCTION synthetic_coverage_failure()"); }
    expect(await footprint(id)).toEqual(before);
    expect(await q("SELECT 1 FROM clinical_cases WHERE patient_id=$1", [id])).toHaveLength(0);
  });
});

describe("old0042 evidence remains unknown without losing money or stored consent", () => {
  it("preserves old agreement/opening/history/consent while refusing signature and current-consent laundering", async () => {
    const id = await patient();
    await db.setPatientOpeningBalance({ patientId: id, currency: "YER", amountMinor: 180000, asOfDate: "2020-01-01",
      note: "Synthetic original0042 opening", createdBy: "synthetic-old-owner", addOnly: true });
    const history = (await q<{ id: number }>("SELECT id FROM patient_opening_balance_history WHERE patient_id=$1", [id]))[0].id;
    const plan = (await q<{ id: number }>(`INSERT INTO treatment_plans
      (patient_id,title,total_minor,total_from_items,consent_at,consent_by,consent_note)
      VALUES ($1,'Synthetic old0042 plan',300000,TRUE,'2001-02-03T04:05:06Z','synthetic-old-actor','Preserve old evidence') RETURNING id`, [id]))[0].id;
    const caseId = (await q<{ id: number }>("INSERT INTO clinical_cases (patient_id,specialty,title,site,created_by,origin) VALUES ($1,'prosthodontics','Synthetic old0042 case','14','synthetic-old-actor','clinical') RETURNING id", [id]))[0].id;
    const item = (await q<{ id: number }>(`INSERT INTO plan_items
      (plan_id,service_id,service_name,category,tooth_code,quantity,unit_price_minor,case_id,session_count,billing_status)
      VALUES ($1,$2,'Synthetic old0042 bridge','bridge',14,1,300000,$3,2,'included_in_package') RETURNING id`, [plan,bridge,caseId]))[0].id;
    await q("INSERT INTO treatment_sessions (plan_item_id,sequence) VALUES ($1,1),($1,2)", [item]);
    const agreementId = (await q<{ id: number }>(`INSERT INTO legacy_treatment_agreements
      (patient_id,plan_item_id,case_id,service_id,service_name,specialty,tooth_code,currency,agreed_minor,previously_paid_minor,
       remaining_minor,historical_as_of,opening_effect,opening_history_id,created_by)
      VALUES ($1,$2,$3,$4,'Synthetic old0042 service','prosthodontics',14,'YER',300000,120000,180000,'2020-01-01','created',$5,'synthetic-old-owner') RETURNING id`,
    [id,item,caseId,bridge,history]))[0].id;
    const before = await footprint(id);
    const consentBefore = await q("SELECT consent_at::text,consent_by,consent_note FROM treatment_plans WHERE id=$1", [plan]);
    const historyBefore = await q("SELECT to_jsonb(h) AS history FROM patient_opening_balance_history h WHERE patient_id=$1 ORDER BY id", [id]);
    expect((await legacy.listLegacyTreatments(id))[0]).toMatchObject({ id: agreementId, coverageState: "unknown", coverageSite: null, remainingMinor: 180000 });
    const visitId = await draft(id, 14, item, caseId);
    await expect(sign(visitId)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await db.recordPlanConsent({ planId: plan, actor: "synthetic-doctor", note: "This cannot verify unknown historical coverage" })).toMatchObject({ ok: false });
    expect((await invoices.previewInvoiceLinkage({ patientId: id, baseCurrency: "YER", items: [invoiceLine(15)] }))[0].refusal).toBe("needs_financial_review");
    expect(await invoice(id, 15)).toMatchObject({ ok: false, reason: "needs_financial_review" });
    expect(await footprint(id)).toEqual(before);
    expect(await q("SELECT consent_at::text,consent_by,consent_note FROM treatment_plans WHERE id=$1", [plan])).toEqual(consentBefore);
    expect(await q("SELECT to_jsonb(h) AS history FROM patient_opening_balance_history h WHERE patient_id=$1 ORDER BY id", [id])).toEqual(historyBefore);
    expect(await q("SELECT 1 FROM legacy_treatment_coverage_snapshots WHERE agreement_id=$1", [agreementId])).toHaveLength(0);
    expect(await q("SELECT 1 FROM visits WHERE id=$1 AND signed_at IS NOT NULL", [visitId])).toHaveLength(0);
    // A completed/closed label is insufficient to bypass unknown immutable coverage.
    await q("UPDATE plan_items SET status='done' WHERE id=$1", [item]);
    await q("UPDATE clinical_cases SET status='closed', completed_at=NOW() WHERE id=$1", [caseId]);
    const different = await db.createClinicalCase({ patientId: id, specialty: "prosthodontics", title: "Synthetic new episode",
      site: "15", problem: null, responsiblePartyId: null, orthoCaseId: null, actor: "synthetic-doctor", actorRole: "doctor" });
    if (!different.ok) throw new Error("Synthetic distinct case refused");
    const newLine = { ...invoiceLine(15), caseId: different.case.id };
    expect((await invoices.previewInvoiceLinkage({ patientId: id, baseCurrency: "YER", items: [newLine] }))[0].refusal).toBe("needs_financial_review");
    expect(await invoices.createLinkedInvoice({ patientId: id, baseCurrency: "YER", items: [newLine], discountMinor: 0,
      note: null, createdBy: "synthetic-owner", actorRole: "admin", idempotencyKey: null, requestHash: null, auditDetails: {},
      templates: DEFAULT_SPECIALTY_TEMPLATES })).toMatchObject({ ok: false, reason: "needs_financial_review" });
    expect(await footprint(id)).toEqual(before);
  });
});
