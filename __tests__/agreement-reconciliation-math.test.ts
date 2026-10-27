import { describe, expect, it } from "vitest";
import { reconcileAgreementAmounts } from "../lib/agreement-reconciliation";
describe("agreement reconciliation never bills paid twice", () => {
  it("adds unbilled principal, not unpaid balance", () => {
    expect(reconcileAgreementAmounts({ agreedMinor: 180000, billedPrincipalMinor: 12000, paidMinor: 9000, duePrincipalMinor: 20000 })).toEqual({ agreedMinor: 180000, billedPrincipalMinor: 12000, unbilledPrincipalMinor: 168000, paidMinor: 9000, remainingMinor: 171000, dueNowMinor: 11000 });
  });
  it("records adoption without a zero invoice when already fully billed", () => {
    expect(reconcileAgreementAmounts({ agreedMinor: 180000, billedPrincipalMinor: 180000, paidMinor: 12000, duePrincipalMinor: 180000 }).unbilledPrincipalMinor).toBe(0);
  });
  it.each([{ agreedMinor: 100, billedPrincipalMinor: 101, paidMinor: 0, duePrincipalMinor: 100 }, { agreedMinor: 100, billedPrincipalMinor: 90, paidMinor: 91, duePrincipalMinor: 100 }, { agreedMinor: Number.MAX_SAFE_INTEGER+1, billedPrincipalMinor: 0, paidMinor: 0, duePrincipalMinor: 0 }, { agreedMinor: 100, billedPrincipalMinor: 10, paidMinor: -1, duePrincipalMinor: 100 }])("refuses inconsistent or unsafe sources", input => {
    expect(() => reconcileAgreementAmounts(input)).toThrow();
  });
});
