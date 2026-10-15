import { describe, expect, it } from "vitest";
import { resolvePayTerms, type ContractInput, type ProfileInput } from "../lib/hr-pay-terms";
import { payrollBlockerLabel, payrollReviewContractIds } from "../lib/hr-payroll-review";

const profile: ProfileInput = { kind: "salary", salaryMinor: 100000, currency: "YER", salaryPeriod: "monthly", effectiveOn: "2026-01-01", hireDate: "2026-01-01", endDate: null };
const contract = (patch: Partial<ContractInput> = {}): ContractInput => ({ id: 1, parentContractId: null, contractNumber: "TEST-1", versionNumber: 1, status: "approved", startDate: "2026-01-01", endDate: null, kind: "salary", salaryMinor: 100000, currency: "YER", salaryPeriod: "monthly", commissionRatePercent: null, doctorPartyId: null, ...patch });
const period = { start: "2026-08-01", end: "2026-08-31" };

describe("wage source review without an invented financial policy", () => {
  it("blocks overlapping independent agreements even when their amounts match", () => {
    const result = resolvePayTerms(profile, [contract(), contract({ id: 2, versionNumber: 9 })], period);
    expect(result.blockers).toContain("contract_priority_unresolved");
    expect(result.snapshot.reviewContractIds).toEqual([1, 2]);
  });
  it("keeps legitimate addenda in one lineage and does not mistake a future root for an overlap", () => {
    const result = resolvePayTerms(profile, [contract(), contract({ id: 2, parentContractId: 1, versionNumber: 2 }), contract({ id: 3, startDate: "2099-01-01" })], period);
    expect(result.blockers).toEqual([]);
    expect(result.contract?.id).toBe(2);
  });
  it.each([999, 2])("blocks missing or cyclic parent identity %s", parentContractId => {
    expect(resolvePayTerms(profile, [contract({ id: 2, parentContractId })], period).blockers).toContain("contract_priority_unresolved");
  });
  it("does not fall back to the current profile after contract coverage ended", () => {
    const result = resolvePayTerms(profile, [contract({ endDate: "2026-07-31" })], period);
    expect(result.blockers).toContain("contract_coverage_unresolved");
    expect(payrollReviewContractIds(result.snapshot)).toEqual([1]);
  });
  it("retains documented profile-only pay when no preceding agreement exists", () => {
    expect(resolvePayTerms(profile, [], period).blockers).toEqual([]);
    expect(resolvePayTerms(profile, [contract({ startDate: "2099-01-01" })], period).blockers).toEqual([]);
  });
  it("shows Arabic review instructions and a safe unknown-code fallback", () => {
    for (const code of ["contract_lifecycle_unresolved", "terms_changed_in_period", "contract_priority_unresolved", "contract_coverage_unresolved", "unexpected_database_detail"]) {
      expect(payrollBlockerLabel(code)).toMatch(/[\u0600-\u06ff]/);
      expect(payrollBlockerLabel(code)).not.toContain(code);
    }
    expect(payrollReviewContractIds({ contractId: 17 })).toEqual([17]);
    expect(payrollReviewContractIds({ reviewContractIds: [3, 3, "4", -1, 0, null, "../users"] })).toEqual([3]);
  });
});
