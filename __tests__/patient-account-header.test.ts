import { describe, expect, it } from "vitest";
import { readPatientAccountHeader } from "../lib/patient-account-header";

const financial = () => ({ balanceMinor: 999999, byCurrency: {
  YER: { balanceMinor: 0, agreementRemainingMinor: 900000, remainingTreatmentMinor: 800000 },
  SAR: { balanceMinor: 2300, openingMinor: 5000, invoicedMinor: 6000, paidMinor: 8700 },
  USD: { balanceMinor: -500 },
} });

describe("canonical patient account header projection", () => {
  it("copies signed currency ledger balances without adding work, agreements, or opening twice", () => {
    const input = financial(), before = JSON.stringify(input);
    expect(readPatientAccountHeader(input, true)).toEqual([
      { currency: "YER", balanceMinor: 0 }, { currency: "SAR", balanceMinor: 2300 }, { currency: "USD", balanceMinor: -500 },
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each([null, undefined, {}, { balanceMinor: 0 }, { byCurrency: {} },
    { byCurrency: { YER: { balanceMinor: 0 } } },
  ])("does not manufacture missing currency balances: %j", value => {
    expect(readPatientAccountHeader(value, true)).toBeNull();
  });
  it.each(["0", null, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid minor units: %s", balanceMinor => {
    const input = financial();
    expect(readPatientAccountHeader({ ...input, byCurrency: { ...input.byCurrency, USD: { balanceMinor } } }, true)).toBeNull();
  });
  it("hides valid data without server financial capability and rejects unknown currencies", () => {
    expect(readPatientAccountHeader(financial(), false)).toBeNull();
    expect(readPatientAccountHeader({ byCurrency: { ...financial().byCurrency, EUR: { balanceMinor: 0 } } }, true)).toBeNull();
  });
});
