import { describe, expect, it } from "vitest";
import { legacyCheckoutDueNow } from "../lib/checkout-legacy-due";
const monthly = { cadence: "monthly" as const, installmentMinor: 200, remainingMinor: 500, overdueMinor: 0, paidTodayMinor: 0, firstDueDate: "2026-12-01", today: "2026-10-20" };
describe("legacy scheduled due, distinct from optional suggestion", () => {
  it("keeps verified future and already-covered monthly dues at zero", () => {
    expect(legacyCheckoutDueNow(monthly)).toBe(0);
    expect(legacyCheckoutDueNow({ ...monthly, firstDueDate: monthly.today, remainingMinor: 300, paidTodayMinor: 200 })).toBe(0);
  });
  it("includes today's monthly due without subtracting receipts a second time", () => {
    expect(legacyCheckoutDueNow({ ...monthly, firstDueDate: monthly.today, overdueMinor: 100, remainingMinor: 400, paidTodayMinor: 100 })).toBe(100);
  });
  it.each([null, "", "2026-02-30", "invalid"])("missing/invalid monthly date %s is review, not future zero", firstDueDate => {
    expect(legacyCheckoutDueNow({ ...monthly, firstDueDate })).toBeNull();
  });
  it("does not infer due with an invalid today or inconsistent future progress", () => {
    expect(legacyCheckoutDueNow({ ...monthly, today: "2026-02-30" })).toBeNull();
    expect(legacyCheckoutDueNow({ ...monthly, overdueMinor: 100 })).toBeNull();
  });
  it("subtracts today's per-visit settlement before capping the final installment", () => {
    expect(legacyCheckoutDueNow({ ...monthly, cadence: "per_visit", firstDueDate: null, remainingMinor: 100, paidTodayMinor: 100 })).toBe(100);
  });
  it("rejects unsafe amounts and does not interpret a refund as additional scheduled principal", () => {
    expect(legacyCheckoutDueNow({ ...monthly, remainingMinor: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(legacyCheckoutDueNow({ ...monthly, cadence: "per_visit", firstDueDate: null, paidTodayMinor: -100 })).toBe(200);
  });
});
