import { describe, expect, it } from "vitest";
import { mergeCommissionBalances, type CommissionBalanceLike } from "../lib/commission-balance";

const row = (overrides: Partial<CommissionBalanceLike> = {}): CommissionBalanceLike => ({
  doctorId: 7,
  currency: "YER",
  accruedMinor: 0,
  earnedMinor: 0,
  paidMinor: 0,
  dueMinor: 0,
  materialRateCostMinor: 0,
  unratedCoveredMinor: 0,
  netEarnedMinor: 0,
  materialRateApplied: true,
  ...overrides,
});

describe("ترحيل رصيد عمولة الطبيب", () => {
  it("يحمل مديونية سابقة إلى فترة فيها استحقاق جديد", () => {
    const period = row({ earnedMinor: 50000, netEarnedMinor: 50000, dueMinor: 50000 });
    const cumulative = row({ earnedMinor: 120000, paidMinor: 150000, netEarnedMinor: 120000, dueMinor: -30000 });
    const [merged] = mergeCommissionBalances([period], [cumulative]);
    expect(merged.dueMinor).toBe(50000);
    expect(merged.balanceMinor).toBe(-30000);
  });

  it("يبقي الطبيب المدين ظاهرًا حتى بلا حركة في الفترة الحالية", () => {
    const cumulative = row({ paidMinor: 25000, dueMinor: -25000 });
    const [merged] = mergeCommissionBalances([], [cumulative]);
    expect(merged.earnedMinor).toBe(0);
    expect(merged.paidMinor).toBe(0);
    expect(merged.dueMinor).toBe(0);
    expect(merged.balanceMinor).toBe(-25000);
  });
});
