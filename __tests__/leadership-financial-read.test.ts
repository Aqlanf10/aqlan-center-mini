import { expect, it } from "vitest";
import { decodeLeadershipFinancial, leadershipPeriodRange, validLeadershipRange } from "../lib/leadership-financial";
import { leadershipFinancialFixture } from "./fixtures/leadership-financial";

it("accepts original currency amounts without modifying the source", () => {
  const value = leadershipFinancialFixture(), before = structuredClone(value);
  expect(decodeLeadershipFinancial(value, value.from, value.to)).toBe(value);
  expect(value).toEqual(before);
});
it("refuses missing, malformed, duplicate-currency and wrong-period data without zero fallback", () => {
  const value = leadershipFinancialFixture();
  for (const patch of [
    { from: "2026-06-01" }, { baseCurrency: "UNKNOWN" }, { cashMovements: null },
    { billingByCurrency: [{ ...value.billingByCurrency[0], grossMinor: "130001" }] },
    { cashMovements: [value.cashMovements[0], value.cashMovements[0]] },
    { expensesByCurrency: [{ ...value.expensesByCurrency[0], totalMinor: null }] },
    { operational: { ...value.operational, arrived: undefined } },
    { occupancy: { ...value.occupancy, capacityMinutes: Number.NaN } },
    { receivableByCurrency: [{ currency: "USD", dueMinor: Number.MAX_SAFE_INTEGER + 1 }] },
  ]) expect(decodeLeadershipFinancial({ ...value, ...patch }, value.from, value.to)).toBeNull();
});
it("keeps unavailable optional party balances unknown while accepting recorded credits", () => {
  const value = leadershipFinancialFixture();
  Reflect.deleteProperty(value, "payableByCurrency");
  value.cashMovements[0].netMinor = -10;
  expect(decodeLeadershipFinancial(value, value.from, value.to)).toBe(value);
  expect(value.payableByCurrency).toBeUndefined();
});
it("rejects reversed, impossible and incomplete periods before a read", () => {
  for (const [from, to] of [["", "2026-07-31"], ["2026-02-30", "2026-07-31"], ["2026-08-01", "2026-07-31"]]) {
    expect(validLeadershipRange(from, to)).toBe(false);
  }
});
it("resolves preset month boundaries on the clinic calendar independently of host midnight", () => {
  expect(leadershipPeriodRange("thisMonth", new Date("2026-07-31T22:00:00Z"), "Asia/Aden"))
    .toEqual({ from: "2026-08-01", to: "2026-08-01" });
  expect(leadershipPeriodRange("lastMonth", new Date("2026-07-31T22:00:00Z"), "Asia/Aden"))
    .toEqual({ from: "2026-07-01", to: "2026-07-31" });
});
