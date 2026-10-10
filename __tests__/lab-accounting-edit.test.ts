import { describe, expect, it } from "vitest";
import { isLabAccountingRate, labAccountingMoneyEdit, labAccountingPreviewBase } from "../lib/lab-accounting-edit";
import type { Currency } from "../lib/money";

// Pure monetary intent/preview checks supplement, rather than replace, the real
// component callbacks and actual API route boundary in the companion suites.
const stored = { costMinor: 2500, costCurrency: "USD" as const };

describe("lab accounting edit intent", () => {
  it("omits money when untouched even if a legacy order has no priced amount", () => {
    expect(labAccountingMoneyEdit(stored, "25", "USD", "YER", false)).toEqual({ kind: "unchanged" });
    expect(labAccountingMoneyEdit({ costMinor: null, costCurrency: null }, "", "YER", "YER", false))
      .toEqual({ kind: "unchanged" });
  });

  it.each(["25", "25.00", "025.000", "٢٥"])("equivalent original %s restores unchanged intent", (text) => {
    expect(labAccountingMoneyEdit(stored, text, "USD", "YER", true)).toEqual({ kind: "unchanged" });
  });

  it.each([
    ["30", "USD", 3000], ["30.25", "SAR", 3025], ["17500", "YER", 17500],
    ["35184372088832.1953125", "SAR", 3518437208883220],
  ] as const)("explicit %s %s sends its selected-currency minor amount", (text, currency, costMinor) => {
    expect(labAccountingMoneyEdit(stored, text, currency, "YER", true))
      .toEqual({ kind: "edited", costMinor, currency });
  });

  it("returning to the displayed extreme saved value preserves the original minor snapshot", () => {
    expect(labAccountingMoneyEdit({ costMinor: 3518437208883220, costCurrency: "SAR" },
      "35184372088832.2", "SAR", "YER", true)).toEqual({ kind: "unchanged" });
  });

  it.each(["", " ", "0", "-1", "n/a", "900719925474099200"])("known-cost invalid edit %s cannot become removal or unchanged", (text) => {
    expect(labAccountingMoneyEdit(stored, text, "USD", "YER", true).kind).toBe("invalid");
  });

  it.each(["n/a", "-1", "900719925474099200"])("null legacy cost does not make invalid nonblank %s an equivalent amount", (text) => {
    expect(labAccountingMoneyEdit({ costMinor: null, costCurrency: "USD" }, text, "USD", "YER", true).kind)
      .toBe("invalid");
  });

  it("untouched-equivalent blank legacy state remains nonmonetary after a revert", () => {
    expect(labAccountingMoneyEdit({ costMinor: null, costCurrency: "USD" }, "", "USD", "YER", true))
      .toEqual({ kind: "unchanged" });
  });
});

describe("lab accounting quote admission matches stored precision", () => {
  it.each([1, 531.125, 600.123456, 0.000001, 1_000_000])("admits finite storable positive rate %s", (rate) => {
    expect(isLabAccountingRate(rate)).toBe(true);
  });
  it.each([null, undefined, "600", 0, -1, NaN, Infinity, 1_000_001, 600.0000004])("rejects invalid rate %s", (rate) => {
    expect(isLabAccountingRate(rate)).toBe(false);
  });
  it.each([
    [3000, "USD", 600, 18000], [3025, "SAR", 150, 4538], [17500, "YER", 1, 17500],
  ] as const)("converts %s %s minor units only with the supplied current rate", (minor, currency, rate, expected) => {
    expect(labAccountingPreviewBase(minor, currency as Currency, "YER", rate)).toBe(expected);
  });
  it("does not show an unsafe base equivalent", () => {
    expect(labAccountingPreviewBase(Number.MAX_SAFE_INTEGER, "USD", "YER", 1_000_000)).toBeNull();
    expect(labAccountingPreviewBase(3000, "USD", "YER", 600.0000004)).toBeNull();
  });
});
