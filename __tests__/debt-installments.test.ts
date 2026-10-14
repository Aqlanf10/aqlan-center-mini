import { describe, expect, it } from "vitest";
import { debtInstallmentProgress, validateDebtRepaymentTerms } from "../lib/debt-installments";

describe("schedule of existing remaining debt", () => {
  const installments = [{ dueDate: "2026-10-12", amountMinor: 20000, kind: "down_payment" as const }, { dueDate: "2026-11-12", amountMinor: 40000, kind: "installment" as const }];
  it("schedules remaining debt, with the proposed down payment included once", () => {
    expect(validateDebtRepaymentTerms({ mode: "installments", installments },60000).ok).toBe(true);
    expect(validateDebtRepaymentTerms({ mode: "installments", installments },100000).ok).toBe(false);
    expect(validateDebtRepaymentTerms({ mode: "full", installments: [] },60000).ok).toBe(true);
  });
  it("rejects zero/fractional amounts, invalid dates, bad sums and out-of-order dates", () => {
    for(const change of [{amountMinor:0},{amountMinor:0.5},{dueDate:"2026-02-30"},{amountMinor:20001},{dueDate:"2027-10-12"}]) {
      expect(validateDebtRepaymentTerms({ mode: "installments", installments: [{...installments[0],...change},installments[1]] },60000).ok).toBe(false);
    }
  });
  it("does not count collections before revision twice or treat a scheduled down payment as a receipt", () => {
    const initial = debtInstallmentProgress({ principalMinor:60000,currentRemainingMinor:60000,netSettledSinceRevisionMinor:0,installments,today:"2026-10-13" });
    expect(initial.settledSinceRevisionMinor).toBe(0); expect(initial.overdueMinor).toBe(20000);
    const paid = debtInstallmentProgress({ principalMinor:60000,currentRemainingMinor:35000,netSettledSinceRevisionMinor:25000,installments,today:"2026-10-13" });
    expect(paid.rows.map(row => row.remainingMinor)).toEqual([0,35000]);
    expect(paid.settledSinceRevisionMinor).toBe(25000);
  });
  it("exposes newly reopened debt for an explicit revision without rewriting the schedule", () => {
    const progress = debtInstallmentProgress({ principalMinor:60000,currentRemainingMinor:70000,netSettledSinceRevisionMinor:-10000,installments,today:"2026-10-12" });
    expect(progress.unallocatedMinor).toBe(10000);expect(progress.rows.map(row => row.remainingMinor)).toEqual([20000,40000]);
  });
  it("does not describe a downward debt correction as collection", () => {
    const progress = debtInstallmentProgress({ principalMinor:60000,currentRemainingMinor:50000,netSettledSinceRevisionMinor:0,installments,today:"2026-10-12" });
    expect(progress.settledSinceRevisionMinor).toBe(0);
    expect(progress.requiresRevision).toBe(true);
    expect(progress.rows.map(row => row.remainingMinor)).toEqual([20000,40000]);
  });
});
