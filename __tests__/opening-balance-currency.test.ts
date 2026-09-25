import { describe, expect, it } from "vitest";
import { openingByCurrencyOf, patientBalancesByCurrency, toCurrencyPaymentLikes } from "../lib/money";

/**
 * (P1-5b) Owner decision: an old-system balance stays in its currency — SAR stays SAR,
 * USD stays USD. The opening balance is a bucket per currency, and a payment can
 * target it explicitly.
 */

describe("opening balance per currency", () => {
  it("places each opening in its own bucket; a bare number stays the base (legacy shape)", () => {
    expect(openingByCurrencyOf(5000)).toEqual({ YER: 5000, SAR: 0, USD: 0 });
    const balances = patientBalancesByCurrency([], [], { YER: 1000, SAR: 79300 });
    expect(balances.YER).toMatchObject({ openingMinor: 1000, dueMinor: 1000 });
    expect(balances.SAR).toMatchObject({ openingMinor: 79300, dueMinor: 79300 });
    expect(balances.USD.dueMinor).toBe(0);
  });

  it("a SAR payment targeting the SAR opening settles the SAR bucket only — never the base", () => {
    const payments = toCurrencyPaymentLikes(1, [{
      amountMinor: 50000, currency: "SAR", exchangeRate: 425, baseAmountMinor: 212500,
      kind: "payment", invoiceId: null, planId: null, openingCurrency: "SAR",
    }], new Map(), new Map());
    const balances = patientBalancesByCurrency([], payments, { YER: 1000, SAR: 79300 });
    expect(balances.SAR.dueMinor).toBe(29300);
    expect(balances.YER.dueMinor).toBe(1000);
  });
});
