import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionPayload } from "../../lib/auth";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { isTreatmentFinancialContext } from "../../lib/treatment-financial-context-validation";

// Disposable, synthetic PostgreSQL acceptance only. Never use a clinic/shared database.
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const auth = await import("../../lib/auth");
const documents = await import("../../lib/legacy-treatment-document-db");
const { collectDebtInstallment } = await import("../../lib/debt-installment-collection");
const { listTreatmentFinancialReferences } = await import("../../lib/treatment-financial-context-db");
const { patientLegacyOnboarding } = await import("../../lib/legacy-onboarding-db");
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.getPool().query(sql, params)).rows as T[];
let session: SessionPayload;
let endo = 0;
let ortho = 0;
let serial = 0;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
  // The owned acceptance runner separately proves the exact database name, OID, owner, port and data directory.
  await dropPublicSchema(url.toString());
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-reference-acceptance");
  const [user] = await q<{ id: number }>(`INSERT INTO users(username,display_name,password_hash,role,is_active)
    VALUES('historical-reference-owner','Synthetic reference owner',$1,'admin',TRUE) RETURNING id`, [hash]);
  session = { userId: user.id, username: "historical-reference-owner", role: "admin",
    credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
  endo = (await q<{ id: number }>(`INSERT INTO services(name,category,price_minor,price_configured,is_active)
    VALUES('Synthetic reference endodontics','rct',55000,TRUE,TRUE) RETURNING id`))[0].id;
  ortho = (await q<{ id: number }>(`INSERT INTO services(name,category,price_minor,price_configured,is_active)
    VALUES('Synthetic reference orthodontics','ortho',210000,TRUE,TRUE) RETURNING id`))[0].id;
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  await q(`INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530')
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

const patient = async () => (await q<{ id: number }>(`INSERT INTO patients(patient_number,full_name)
  VALUES($1,'Synthetic historical reference patient') RETURNING id`, [`HIST-REFERENCE-${++serial}`]))[0].id;
const terms = (amountMinor: number) => ({ mode: "installments", installments: [{ dueDate: "2026-11-12", amountMinor, kind: "installment" }] });
async function createDocument(scheduled = true) {
  const patientId = await patient();
  const saved = await documents.createHistoricalDocument(patientId, { patientId, currency: "YER",
    items: [{ serviceId: endo, quantity: 1, price: "55000", catalogPriceMinor: 55000, toothCode: 16 },
      { serviceId: endo, quantity: 1, price: "55000", catalogPriceMinor: 55000, toothCode: 17 },
      { serviceId: ortho, quantity: 1, price: "210000", catalogPriceMinor: 210000, scope: "both" }],
    discount: "20000", discountReason: "Synthetic original discount", previouslyPaidAmount: "120000", historicalAsOf: "2026-10-01",
    idempotencyKey: `historical-reference-create-${serial}`,
    repaymentTerms: scheduled ? terms(180000) : { mode: "full", installments: [] }, repaymentRemainingMinor: 180000,
    repaymentVersion: 0, repaymentSourceHash: null }, session);
  return saved.document;
}

async function createMatchingOrthoCase(patientId: number) {
  const created = await db.createOrthoCase({ patientId, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: null, startDate: "2026-10-01", plannedMonths: 18, planId: null, note: null, createdBy: session.username });
  if (!created.ok) throw new Error(created.message);
  expect((await q<{ plan_id: number | null }>("SELECT plan_id FROM ortho_cases WHERE id=$1", [created.id]))[0].plan_id).toBeNull();
  return created.id;
}
async function expectHistoricalOrthoReference(document: Awaited<ReturnType<typeof createDocument>>, orthoCaseId: number, scheduled: boolean) {
  const orthoLine = document.lines.find(line => line.serviceId === ortho)!;
  const before = await moneyFootprint();
  const onboarding = await patientLegacyOnboarding(document.patientId, orthoCaseId);
  expect(onboarding?.financialReference).toEqual({ state: "linked", clinicalCaseIds: [orthoLine.caseId], hasRecordedSchedule: scheduled,
    sources: [{ kind: "historical_agreement", sourceId: orthoLine.agreementId, planId: orthoLine.planId,
      planItemId: orthoLine.planItemId, clinicalCaseId: orthoLine.caseId, current: true }] });
  expect(onboarding?.adjustmentClass).toBe("LEGACY_INCLUDED");
  expect(await moneyFootprint()).toEqual(before);
}

/** Whole-table facts are safe here because this suite exclusively owns a disposable synthetic DB. */
async function moneyFootprint() {
  const tables = ["invoices", "invoice_items", "payments", "patient_opening_balances", "patient_opening_balance_history",
    "legacy_treatment_documents", "legacy_treatment_document_revisions", "legacy_treatment_agreements",
    "debt_repayment_arrangements", "debt_repayment_revisions", "plan_installments", "doctor_commission_history"];
  return Promise.all(tables.map(table => q(`SELECT to_jsonb(t) AS facts FROM ${table} t ORDER BY to_jsonb(t)::text`)));
}

describe("real historical document revision financial references", () => {
  it("reads one multi-case document, then the current correction, without writing or allocating cash to a case", async () => {
    const original = await createDocument();
    const orthoCaseId = await createMatchingOrthoCase(original.patientId);
    await expectHistoricalOrthoReference(original, orthoCaseId, true);
    const beforeOriginalRead = await moneyFootprint();
    const first = await listTreatmentFinancialReferences(original.patientId);
    expect(first?.historicalDocuments).toHaveLength(1);
    expect(first?.historicalDocuments[0]).toMatchObject({ documentId: original.id, version: 1,
      agreedMinor: 300000, previouslyPaidMinor: 120000, remainingAtRevisionMinor: 180000 });
    expect(await moneyFootprint()).toEqual(beforeOriginalRead);

    await collectDebtInstallment({ patientId: original.patientId, arrangementId: original.repayment!.arrangementId,
      amountMinor: 20000, idempotencyKey: `historical-reference-payment-${serial}`, currency: "YER", expectedVersion: 1,
      method: "cash", note: null, session });
    const [view] = await documents.listHistoricalDocuments(original.patientId);
    const correction = { idempotencyKey: `historical-reference-correct-${serial}`, expectedVersion: 1,
      expectedSourceHash: view.sourceHash, prices: ["65000", "65000", "220000"], discount: "20000",
      discountReason: "Synthetic current discount", previouslyPaidAmount: "130000", historicalAsOf: "2026-10-02",
      reason: "Synthetic corrected document facts", repaymentTerms: terms(180000), repaymentRemainingMinor: 180000,
      repaymentVersion: view.scheduleVersion };
    const corrected = await documents.correctHistoricalDocument(original.patientId, original.id, correction, session);
    expect(corrected.document).toMatchObject({ version: 2, agreedMinor: 330000, previouslyPaidMinor: 130000, remainingMinor: 200000 });
    await expectHistoricalOrthoReference(corrected.document, orthoCaseId, true);
    const beforeCurrentRead = await moneyFootprint();
    const result = await listTreatmentFinancialReferences(original.patientId);
    expect(isTreatmentFinancialContext(result, original.patientId)).toBe(true);
    expect(result?.historicalDocuments).toHaveLength(1);
    expect(result?.historicalDocuments[0]).toMatchObject({ documentId: original.id, revisionId: corrected.document.revisionId, version: 2,
      agreedMinor: 330000, previouslyPaidMinor: 130000, remainingAtRevisionMinor: 200000,
      historicalAsOf: "2026-10-02", currentAllocatedRemainingMinor: null, allocationState: "not_allocated" });
    expect(result?.historicalDocuments[0].lines.map(line => [line.agreementId, line.planId, line.planItemId, line.clinicalCaseId]))
      .toEqual(corrected.document.lines.map(line => [line.agreementId, line.planId, line.planItemId, line.caseId]));
    expect(new Set(result?.historicalDocuments[0].lines.map(line => line.clinicalCaseId)).size).toBe(3);
    expect(result?.references.flatMap(reference => reference.historicalAgreements)).toHaveLength(3);
    for (const reference of result!.references) {
      expect(reference.historicalAgreements[0]).toMatchObject({ documentId: original.id,
        previouslyPaidMinor: null, remainingAtRegistrationMinor: null, currentAgreementRemainingMinor: null });
      expect(reference.packageCoverage.state).toBe("unspecified");
    }
    expect(result?.accountPositions.YER).toMatchObject({ billedMinor: 0, collectedMinor: 20000, openingMinor: 200000, dueMinor: 180000 });
    expect(result?.documents).toEqual([]);
    expect(await moneyFootprint()).toEqual(beforeCurrentRead);
    expect(await q(`SELECT previously_paid_minor,remaining_minor FROM legacy_treatment_agreements
      WHERE document_id=$1 ORDER BY document_line`, [original.id])).toEqual(Array(3).fill({ previously_paid_minor: null, remaining_minor: null }));

    // A stale correction never makes the read path fall back to the original agreement/revision.
    await expect(documents.correctHistoricalDocument(original.patientId, original.id,
      { ...correction, idempotencyKey: `historical-reference-stale-${serial}` }, session)).rejects.toMatchObject({ code: "stale" });
    expect((await listTreatmentFinancialReferences(original.patientId))?.historicalDocuments[0].version).toBe(2);
    expect(await moneyFootprint()).toEqual(beforeCurrentRead);

    // The real revision guard refuses malformed membership, with no trigger disable/bypass.
    await expect(q(`INSERT INTO legacy_treatment_document_revisions
      (document_id,version,total_minor,discount_minor,discount_reason,previously_paid_minor,remaining_minor,historical_as_of,
       lines,reason,opening_history_id,idempotency_key,request_hash,created_by)
      SELECT document_id,version+1,total_minor,discount_minor,discount_reason,previously_paid_minor,remaining_minor,historical_as_of,
        jsonb_set(lines,'{0,agreementId}','2147483647'::jsonb),'Synthetic invalid membership',opening_history_id,$2,request_hash,created_by
      FROM legacy_treatment_document_revisions WHERE document_id=$1 AND version=2`,
    [original.id, `historical-reference-invalid-${serial}`])).rejects.toThrow(/lineage/);
    expect((await listTreatmentFinancialReferences(original.patientId))?.historicalDocuments[0].version).toBe(2);
    expect(await moneyFootprint()).toEqual(beforeCurrentRead);
    // A note-only document correction legitimately has no new opening history row.
    const [currentView] = await documents.listHistoricalDocuments(original.patientId);
    const openingBefore = await q("SELECT to_jsonb(b) AS facts FROM patient_opening_balances b WHERE patient_id=$1", [original.patientId]);
    const noPrincipalChange = await documents.correctHistoricalDocument(original.patientId, original.id, {
      idempotencyKey: `historical-reference-note-${serial}`, expectedVersion: 2, expectedSourceHash: currentView.sourceHash,
      prices: corrected.document.lines.map(line => String(line.unitPriceMinor)), discount: String(corrected.document.discountMinor),
      discountReason: corrected.document.discountReason, previouslyPaidAmount: String(corrected.document.previouslyPaidMinor),
      historicalAsOf: corrected.document.historicalAsOf, note: "Synthetic revised documentary note",
      reason: "Synthetic note-only correction", repaymentTerms: terms(currentView.openingRemainingMinor),
      repaymentRemainingMinor: currentView.openingRemainingMinor, repaymentVersion: currentView.scheduleVersion,
    }, session);
    expect(noPrincipalChange.document).toMatchObject({ version: 3, remainingMinor: 200000, historicalAsOf: "2026-10-02" });
    const history = await q<{ version: number; opening_history_id: number | null }>(
      "SELECT version,opening_history_id FROM legacy_treatment_document_revisions WHERE document_id=$1 ORDER BY version", [original.id]);
    expect(history.at(-1)).toEqual({ version: 3, opening_history_id: null });
    expect(history.slice(0, -1).some(revision => revision.opening_history_id !== null)).toBe(true);
    expect(await q("SELECT to_jsonb(b) AS facts FROM patient_opening_balances b WHERE patient_id=$1", [original.patientId])).toEqual(openingBefore);
    // Shared schedule provenance comes from the same document's earlier revision, not a fabricated per-line opening.
    await expectHistoricalOrthoReference(noPrincipalChange.document, orthoCaseId, true);
    const beforeNoteRead = await moneyFootprint();
    expect((await listTreatmentFinancialReferences(original.patientId))?.historicalDocuments[0]).toMatchObject({ version: 3,
      agreedMinor: 330000, previouslyPaidMinor: 130000, remainingAtRevisionMinor: 200000 });
    expect(await moneyFootprint()).toEqual(beforeNoteRead);
    const otherPatient = await patient();
    expect((await listTreatmentFinancialReferences(otherPatient))?.historicalDocuments).toEqual([]);
  });

  it("keeps historical Ortho coverage independent of an installment schedule and excludes endodontic siblings", async () => {
    const document = await createDocument(false);
    const orthoCaseId = await createMatchingOrthoCase(document.patientId);
    await expectHistoricalOrthoReference(document, orthoCaseId, false);
  });

  it("fails closed on a document with no current revision, without converting absent totals to zero", async () => {
    const patientId = await patient();
    // An incomplete synthetic source is legal as an unsealed header; no schema or immutable rows are altered.
    await q(`INSERT INTO legacy_treatment_documents(patient_id,currency,line_count,intent,idempotency_key,request_hash,created_by,created_role)
      VALUES($1,'YER',1,'{}'::jsonb,$2,$3,$4,'admin')`, [patientId, `historical-reference-missing-${serial}`, "0".repeat(64), session.username]);
    const before = await moneyFootprint();
    await expect(listTreatmentFinancialReferences(patientId)).rejects.toThrow(/revision needs review/);
    expect(await moneyFootprint()).toEqual(before);
  });
});
