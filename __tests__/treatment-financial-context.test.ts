import { describe, expect, it } from "vitest";
import { projectTreatmentFinancialReferences, type TreatmentFinancialSnapshot } from "../lib/treatment-financial-context";
import { invoiceRequestFingerprint } from "../lib/invoice-clinical-linkage";
import { isTreatmentFinancialContext } from "../lib/treatment-financial-context-validation";

function snapshot(): TreatmentFinancialSnapshot {
  return {
    patientId: 10,
    plans: [{ id: 1, patientId: 10, currency: "YER", totalMinor: 300000, status: "active", billingMode: "per_procedure", hasInstallments: false }],
    items: [{ patientId: 10, planId: 1, planItemId: 2, clinicalCaseId: 5, orthoCaseId: 6,
      origin: "plan", originInvoiceId: null, billedInvoiceId: null, billingStatus: "unbilled",
      financialReviewRequired: false, hasInvoiceLineage: false, hasLegacyLineage: false, legacyCoverageState: "none" }],
    invoices: [], lines: [], receipts: [], legacyAgreements: [], openings: [],
  };
}
function invoiced(): TreatmentFinancialSnapshot {
  const data = snapshot();
  data.items[0] = { ...data.items[0], origin: "invoice", originInvoiceId: 3, billedInvoiceId: 3, billingStatus: "billed", hasInvoiceLineage: true };
  data.invoices.push({ id: 3, patientId: 10, planId: null, invoiceNumber: "I-3", currency: "YER", totalMinor: 300000, discountMinor: 30000, status: "open" });
  data.lines.push({ id: 7, invoiceId: 3, planItemId: 2, sourceType: "plan_item", sourceId: 2, totalMinor: 300000 });
  data.receipts.push({ id: 4, patientId: 10, invoiceId: 3, planId: null, openingCurrency: null, reversalOfId: null,
    currency: "YER", amountMinor: 30000, baseAmountMinor: 30000, exchangeRate: 1, kind: "payment" });
  return data;
}

describe("read-only treatment financial references", () => {
  it("keeps exact clinical identities without treating plan value/progress as debt", () => {
    const result = projectTreatmentFinancialReferences(snapshot());
    expect(result.references[0]).toMatchObject({ patientId: 10, planId: 1, planItemId: 2, clinicalCaseId: 5, orthoCaseId: 6,
      invoiceIds: [], clinicalPlanValue: { amountMinor: 300000, isDebt: false } });
    expect(result.accountPositions.YER.dueMinor).toBe(0);
    expect(result.references[0].packageCoverage.state).toBe("unspecified");
  });
  it("separates discounted document net, line gross, direct receipts and canonical account due", () => {
    const result = projectTreatmentFinancialReferences(invoiced());
    expect(result.documents[0]).toMatchObject({ netMinor: 270000, directlyLinkedSettledMinor: 30000, allocatedRemainingMinor: null });
    expect(result.references[0].invoiceLines[0]).toMatchObject({ invoiceLineId: 7, grossMinor: 300000, sourceType: "plan_item", sourceId: 2 });
    expect(result.accountPositions.YER.dueMinor).toBe(240000);
    expect(result.references[0].unresolvedReasons).toContain("item_settlement_allocation_unavailable");
  });
  it("does not copy a shared invoice total/receipt into each item or sum documents twice", () => {
    const data = invoiced();
    data.items.push({ ...data.items[0], planItemId: 8, clinicalCaseId: 9, orthoCaseId: null });
    data.lines.push({ ...data.lines[0], id: 11, planItemId: 8, sourceId: 8, totalMinor: 100000 });
    data.lines[0].totalMinor = 200000;
    const result = projectTreatmentFinancialReferences(data);
    expect(result.documents).toHaveLength(1);
    expect(result.references.map((reference) => reference.invoiceIds)).toEqual([[3], [3]]);
    expect(result.accountPositions.YER.dueMinor).toBe(240000);
  });
  it("keeps cancelled original/correction receipts and does not fabricate replacement debt", () => {
    const data = invoiced();
    data.invoices[0].status = "cancelled";
    data.invoices.push({ ...data.invoices[0], id: 12, invoiceNumber: "I-12", status: "paid", totalMinor: 30000, discountMinor: 0 });
    data.lines.push({ ...data.lines[0], id: 13, invoiceId: 12, sourceType: "correction", sourceId: 7, totalMinor: 30000 });
    data.items[0].billedInvoiceId = 12;
    const result = projectTreatmentFinancialReferences(data);
    expect(result.references[0].invoiceIds).toEqual([3, 12]);
    expect(result.documents[0]).toMatchObject({ status: "cancelled", netMinor: 0, directlyLinkedSettledMinor: 30000 });
    expect(result.documents[1]).toMatchObject({ status: "paid", directlyLinkedSettledMinor: 0, allocatedRemainingMinor: null });
    expect(result.accountPositions.YER.dueMinor).toBe(0);
  });
  it("keeps the 300000/120000/180000 snapshot and current 150000 opening at distinct scopes", () => {
    const data = snapshot();
    data.items[0] = { ...data.items[0], hasLegacyLineage: true, legacyCoverageState: "verified", origin: "legacy" };
    data.legacyAgreements.push({ id: 20, patientId: 10, planItemId: 2, clinicalCaseId: 5, currency: "YER",
      agreedMinor: 300000, previouslyPaidMinor: 120000, remainingAtRegistrationMinor: 180000,
      historicalAsOf: "2026-10-01", openingHistoryId: 21, openingEffect: "created", status: "live" });
    data.openings.push({ currency: "YER", openingMinor: 180000, settledMinor: 30000, remainingMinor: 150000 });
    data.receipts.push({ id: 22, patientId: 10, invoiceId: null, planId: null, openingCurrency: "YER", reversalOfId: null,
      currency: "YER", amountMinor: 30000, baseAmountMinor: 30000, exchangeRate: 1, kind: "payment" });
    const result = projectTreatmentFinancialReferences(data);
    expect(result.references[0].historicalAgreements[0]).toMatchObject({ agreedMinor: 300000, previouslyPaidMinor: 120000,
      remainingAtRegistrationMinor: 180000, currentAgreementRemainingMinor: null });
    expect(result.openingPositions[0]).toMatchObject({ remainingMinor: 150000, scope: "patient_currency" });
    expect(result.accountPositions.YER).toMatchObject({ billedMinor: 0, openingMinor: 180000, dueMinor: 150000 });
    expect(result.documents).toHaveLength(0);
  });
  it("never allocates a shared opening receipt by equal shares, agreement amount or order", () => {
    const data = snapshot();
    data.items.push({ ...data.items[0], planItemId: 8 });
    data.legacyAgreements = [2, 8].map((planItemId, index) => ({ id: 20 + index, patientId: 10, planItemId, clinicalCaseId: 5,
      currency: "YER", agreedMinor: 300000, previouslyPaidMinor: 120000, remainingAtRegistrationMinor: 180000,
      historicalAsOf: "2026-10-01", openingHistoryId: 30 + index, openingEffect: "increased", status: "live" }));
    data.openings.push({ currency: "YER", openingMinor: 360000, settledMinor: 30000, remainingMinor: 330000 });
    const result = projectTreatmentFinancialReferences(data);
    expect(result.openingPositions[0].agreementIds).toEqual([20, 21]);
    expect(result.references.every((reference) => reference.historicalAgreements[0].currentAgreementRemainingMinor === null)).toBe(true);
  });
  it("a fully historically paid agreement creates no invoice or opening obligation", () => {
    const data = snapshot();
    data.legacyAgreements.push({ id: 20, patientId: 10, planItemId: 2, clinicalCaseId: 5, currency: "YER",
      agreedMinor: 300000, previouslyPaidMinor: 300000, remainingAtRegistrationMinor: 0,
      historicalAsOf: "2026-10-01", openingHistoryId: null, openingEffect: "none", status: "live" });
    const result = projectTreatmentFinancialReferences(data);
    expect(result.accountPositions.YER.dueMinor).toBe(0);
    expect(result.openingPositions).toEqual([]);
    expect(result.documents).toEqual([]);
  });
  it("retains original receipt currency and recorded settlement without combining currency buckets", () => {
    const data = invoiced();
    data.receipts[0] = { ...data.receipts[0], currency: "SAR", amountMinor: 10000, baseAmountMinor: 30000, exchangeRate: 3 };
    const result = projectTreatmentFinancialReferences(data);
    expect(result.documents[0].settlements[0]).toMatchObject({ originalCurrency: "SAR", originalAmountMinor: 10000,
      settlementCurrency: "YER", settlementMinor: 30000 });
    expect(result.accountPositions.SAR.dueMinor).toBe(0);
    expect(result.accountPositions.YER.dueMinor).toBe(240000);
  });
  it("fails closed on unsupported foreign settlement and wrong-patient evidence", () => {
    const data = invoiced();
    data.invoices[0].currency = "USD";
    data.receipts[0].currency = "SAR";
    expect(() => projectTreatmentFinancialReferences(data)).toThrow();
    const foreign = snapshot();
    foreign.items[0].patientId = 99;
    expect(() => projectTreatmentFinancialReferences(foreign)).toThrow("Cross-patient");
  });
  it("keeps installment invoices at plan level and keeps legacy/invoice collection guards visible", () => {
    const data = invoiced();
    data.plans[0].billingMode = "installments";
    data.plans[0].hasInstallments = true;
    data.invoices.push({ ...data.invoices[0], id: 15, planId: 1, invoiceNumber: "I-15" });
    const result = projectTreatmentFinancialReferences(data);
    expect(result.references[0].installment).toEqual({ mode: "historical_invoice_on_collection",
      planId: 1, planDocumentIds: [15], collectionRequiresFinancialReview: true });
    expect(result.references[0].invoiceIds).toEqual([3]);
  });
  it("does not infer installment coverage from mode text without a schedule and fences all siblings", () => {
    const data = invoiced();
    data.plans[0].billingMode = "installments";
    data.items.push({ ...data.items[0], planItemId: 8, billedInvoiceId: null, originInvoiceId: null, hasInvoiceLineage: false });
    const result = projectTreatmentFinancialReferences(data);
    expect(result.references[1].installment).toMatchObject({ mode: "unconfigured_installment_plan", collectionRequiresFinancialReview: true });
    expect(result.references[1].unresolvedReasons).toContain("installment_schedule_missing");
    expect(result.references[1].invoiceIds).toEqual([]);
  });
});

describe("explicit selections are bound into the idempotency fingerprint", () => {
  const input = { patientId: 10, currency: "YER", discountMinor: 0,
    items: [{ serviceId: 1, description: "RCT", quantity: 1, unitPriceMinor: 1000, doctorId: 2 }] };
  it("preserves old fingerprints when no identity is selected", () => {
    expect(invoiceRequestFingerprint(input)).toBe(JSON.stringify([10, "YER", 0, null,
      [[1, "RCT", 1, 1000, 2, null, null, null, null, null, null]]]));
    expect(invoiceRequestFingerprint({ ...input, existingPlanId: null })).toBe(invoiceRequestFingerprint(input));
  });
  it("cannot replay an explicit operation after switching plan or item", () => {
    const selected = { ...input, existingPlanId: 7, items: [{ ...input.items[0], planItemId: 8 }] };
    expect(invoiceRequestFingerprint(selected)).not.toBe(invoiceRequestFingerprint({ ...selected, existingPlanId: 9 }));
    expect(invoiceRequestFingerprint(selected)).not.toBe(invoiceRequestFingerprint({ ...selected, items: [{ ...selected.items[0], planItemId: 9 }] }));
  });
});

describe("financial context response decoder", () => {
  it("accepts canonical projected responses with all nested monetary/identity fields", () => {
    expect(isTreatmentFinancialContext(projectTreatmentFinancialReferences(snapshot()), 10)).toBe(true);
    expect(isTreatmentFinancialContext(projectTreatmentFinancialReferences(invoiced()), 10)).toBe(true);
  });
  it("rejects another patient even when every collection has the expected shape", () => {
    const result = projectTreatmentFinancialReferences(invoiced());
    expect(isTreatmentFinancialContext(result, 11)).toBe(false);
    expect(isTreatmentFinancialContext({ ...result, references: [{ ...result.references[0], patientId: 11 }] }, 10)).toBe(false);
  });
  it("rejects malformed nested balances, receipts, currency, source identities and fake allocations", () => {
    const result = projectTreatmentFinancialReferences(invoiced());
    const invalid = [
      { ...result, accountPositions: { ...result.accountPositions, YER: { ...result.accountPositions.YER, dueMinor: "240000" } } },
      { ...result, documents: [{ ...result.documents[0], netMinor: Number.NaN }] },
      { ...result, documents: [{ ...result.documents[0], currency: "INVALID" }] },
      { ...result, documents: [{ ...result.documents[0], status: ["open"] }] },
      { ...result, documents: [{ ...result.documents[0], settlements: [{ ...result.documents[0].settlements[0], originalAmountMinor: Number.MAX_SAFE_INTEGER + 1 }] }] },
      { ...result, references: [{ ...result.references[0], planItemId: 0 }] },
      { ...result, references: [{ ...result.references[0], planId: 900 }] },
      { ...result, references: [{ ...result.references[0], invoiceLines: [{ ...result.references[0].invoiceLines[0], planItemId: 900, sourceId: 900 }] }] },
      { ...result, documents: [{ ...result.documents[0], allocatedRemainingMinor: 240000 }] },
      { ...result, openingPositions: [{ currency: "YER", openingMinor: 10, settledMinor: 0, remainingMinor: 10, scope: "agreement", agreementIds: [20], allocationState: "not_allocated" }] },
    ];
    for (const malformed of invalid) expect(isTreatmentFinancialContext(malformed, 10)).toBe(false);
  });
  it("keeps unresolved missing invoice IDs explicit instead of accepting silent omissions", () => {
    const result = projectTreatmentFinancialReferences(invoiced());
    const reference = { ...result.references[0], invoiceIds: [3, 999] };
    expect(isTreatmentFinancialContext({ ...result, references: [reference] }, 10)).toBe(false);
    expect(isTreatmentFinancialContext({ ...result, references: [{
      ...reference, unresolvedReasons: [...reference.unresolvedReasons, "invoice_reference_missing"],
    }] }, 10)).toBe(true);
  });
});
