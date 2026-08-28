import { describe, expect, it } from "vitest";

import {
  computeBalances,
  EMPTY_BALANCES,
  formatMoney,
  fromMinorUnits,
  hasOutstandingBalance,
  toMinorUnits,
} from "@/lib/money";

describe("minor units conversion", () => {
  it("converts numeric strings without float drift", () => {
    expect(toMinorUnits("1234.50")).toBe(123450);
    expect(toMinorUnits("0.1")).toBe(10);
    expect(toMinorUnits("999999999999.99")).toBe(99999999999999);
  });

  it("converts numbers", () => {
    expect(toMinorUnits(1234.5)).toBe(123450);
  });

  it("returns NaN for garbage", () => {
    expect(toMinorUnits("abc")).toBeNaN();
    expect(toMinorUnits(Number.NaN)).toBeNaN();
  });

  it("round-trips through fromMinorUnits", () => {
    expect(fromMinorUnits(123450)).toBe("1234.50");
    expect(fromMinorUnits(-500)).toBe("-5.00");
    expect(fromMinorUnits(5)).toBe("0.05");
  });
});

describe("computeBalances", () => {
  it("never mixes currencies", () => {
    const balances = computeBalances(
      [
        { amount: "100000.00", currency: "YER" },
        { amount: "500.00", currency: "SAR" },
        { amount: "100.00", currency: "USD" },
      ],
      [
        { amount: "40000.00", currency: "YER" },
        { amount: "50.00", currency: "USD" },
      ]
    );
    expect(balances).toEqual({ YER: 6000000, SAR: 50000, USD: 5000 });
  });

  it("starts from an all-zero ledger", () => {
    expect(EMPTY_BALANCES).toEqual({ YER: 0, SAR: 0, USD: 0 });
    expect(computeBalances([], [])).toEqual(EMPTY_BALANCES);
  });

  it("ignores unparseable amounts defensively", () => {
    const balances = computeBalances(
      [{ amount: "oops", currency: "YER" }],
      []
    );
    expect(balances.YER).toBe(0);
  });

  it("supports negative balances (overpayment)", () => {
    const balances = computeBalances(
      [{ amount: "100.00", currency: "USD" }],
      [{ amount: "150.00", currency: "USD" }]
    );
    expect(balances.USD).toBe(-5000);
  });
});

describe("hasOutstandingBalance", () => {
  it("flags any positive balance", () => {
    expect(hasOutstandingBalance({ YER: 1, SAR: 0, USD: 0 })).toBe(true);
    expect(hasOutstandingBalance({ YER: 0, SAR: 0, USD: 0 })).toBe(false);
    expect(hasOutstandingBalance({ YER: -100, SAR: 0, USD: 0 })).toBe(false);
  });
});

describe("formatMoney", () => {
  it("formats with currency code and two decimals", () => {
    expect(formatMoney(1250000, "YER", "en")).toBe("12,500.00 YER");
    expect(formatMoney(-500, "SAR", "en")).toBe("-5.00 SAR");
  });

  it("uses Latin digits in Arabic for staff readability", () => {
    expect(formatMoney(1250000, "YER", "ar")).toBe("12,500.00 YER");
  });
});
