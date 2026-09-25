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

describe("statement screens show every currency bucket (portal, dossier)", () => {
  it("a SAR-only debt is an active SAR card — not a settled YER account", async () => {
    const { activeBalanceCurrencies } = await import("../lib/money");
    const balances = patientBalancesByCurrency([], [], { SAR: 1000 });
    expect(activeBalanceCurrencies(balances, "YER")).toEqual(["SAR"]);
    expect(activeBalanceCurrencies(patientBalancesByCurrency([], []), "YER")).toEqual(["YER"]);
  });

  it("the dossier's ledger total keeps a SAR opening and its SAR payment in the SAR bucket", async () => {
    const { ledgerBalancesByCurrency } = await import("../lib/db");
    const balances = ledgerBalancesByCurrency(7, {
      invoices: [],
      payments: [{
        amountMinor: 400, currency: "SAR", exchangeRate: 425, baseAmountMinor: 170000,
        kind: "payment", invoiceId: null, planId: null, openingCurrency: "SAR",
      }],
      openings: [{ currency: "SAR", amountMinor: 1000 }],
    } as never, new Map());
    expect(balances.SAR.dueMinor).toBe(600);
    expect(balances.YER.dueMinor).toBe(0);
  });
});
