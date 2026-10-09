import { describe, expect, it } from "vitest";
import { hasUnresolvedClinicalFinance, hasVerifiedClinicalCoverage, plannedItemBlock, visitSignatureBlock, type SignatureEvidence } from "../components/invoice-clinical-readiness";

const evidence = (): SignatureEvidence => ({
  procedures: [{ id: 9, planItemId: 5 }],
  outstanding: [{ planItemId: 5, origin: "invoice", financialReviewRequired: false, clinicalConsentRecorded: true }],
  sessionPricing: [{ procedureId: 9, planItemId: 5, financialReviewRequired: false, clinicalConsentRecorded: true }],
});

describe("invoice clinical draft versus signature boundary", () => {
  it("keeps the unresolved warning explicit that truthful draft care can be recorded", () => {
    expect(plannedItemBlock({ planItemId: 5, financialReviewRequired: true })).toContain("يمكن توثيق العمل كمسودة");
    expect(plannedItemBlock({ planItemId: 5, origin: "invoice", financialReviewRequired: false,
      clinicalConsentRecorded: false })).toContain("قبل التوقيع");
  });
  it("does not treat known invoice provenance as clinical consent", () => {
    const read = evidence();
    read.outstanding[0].clinicalConsentRecorded = false;
    expect(visitSignatureBlock(read)).toContain("الموافقة السريرية");
  });
  it("blocks signature on financial review even when the original outstanding item is still prepaid", () => {
    const read = evidence();
    read.sessionPricing[0].financialReviewRequired = true;
    expect(visitSignatureBlock(read)).toContain("نسبة العمل أو تغطيته المالية تحتاج مراجعة");
  });
  it("preserves the existing consent gate for ordinary linked plan sessions", () => {
    const read = evidence();
    read.outstanding[0].origin = "clinical";
    read.sessionPricing[0].clinicalConsentRecorded = false;
    expect(visitSignatureBlock(read)).toContain("الموافقة السريرية لبنود الخطة");
  });
  it("does not block an unrelated draft because another unexecuted item requires review", () => {
    const read = evidence();
    read.outstanding.push({ planItemId: 99, origin: "invoice", financialReviewRequired: true });
    expect(visitSignatureBlock(read)).toBeNull();
  });
  it("requires explicit current financial evidence for invoice-origin work without denying legacy ordinary items", () => {
    const read = evidence();
    delete read.outstanding[0].financialReviewRequired;
    expect(visitSignatureBlock(read)).toContain("تعذّر التحقق");
    read.outstanding[0] = { planItemId: 5 };
    expect(visitSignatureBlock(read)).toBeNull();
  });
});

it("does not infer signature permission from missing or unrelated pricing evidence", () => {
  const read = evidence();
  for (const rows of [[], [{}], [{ procedureId: 99, planItemId: 5, financialReviewRequired: false, clinicalConsentRecorded: true }],
    [...read.sessionPricing, ...read.sessionPricing]]) {
    expect(visitSignatureBlock({ ...read, outstanding: [], sessionPricing: rows })).toContain("غير مكتملة");
  }
});
it("review and unknown invoice evidence override legacy included/prepaid flags", () => {
  for (const item of [
    { planItemId: 5, financialReviewRequired: true, includedByAgreement: true },
    { planItemId: 5, billingStatus: "needs_financial_review", prebilled: true },
    { planItemId: 5, origin: "invoice", includedByAgreement: true },
  ]) {
    expect(hasUnresolvedClinicalFinance(item)).toBe(true);
    expect(hasVerifiedClinicalCoverage(item)).toBe(false);
  }
  expect(hasVerifiedClinicalCoverage({ planItemId: 5, financialReviewRequired: false, prebilled: true })).toBe(true);
});
