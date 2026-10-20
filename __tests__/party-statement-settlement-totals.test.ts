import { describe, expect, it } from "vitest";
import { partyStatementNetMinor, partyStatementTotals, readPartyStatementTotals, type StatementExpenseLike } from "../lib/party-statement";
import { CURRENCIES } from "../lib/money";

describe("native statement settlement totals", () => {
  it.each(CURRENCIES)("uses signed payment allocations in %s without touching invoice remaining", (currency) => {
    const totals = partyStatementTotals(
      [{ currency, amountMinor: 30_000, settledMinor: 10_000, remainingMinor: 20_000 }],
      [{ currency, amountMinor: 20_000, payableId: null, payableExists: false, allocatedPaidMinor: 10_000 }],
      [{ currency, amountMinor: 1_000 }],
    );
    expect(totals).toMatchObject([{ currency, remainingMinor: 20_000, paidMinor: 20_000, unlinkedPaidMinor: 10_000, openingAdvanceMinor: 1_000 }]);
    expect(partyStatementNetMinor(totals[0])).toBe(9_000);
  });

  it("keeps mixed-currency invoice settlements separate from a partially allocated YER payment", () => {
    const totals = partyStatementTotals([
      { currency: "USD", amountMinor: 10_000, settledMinor: 5_000, remainingMinor: 5_000 },
      { currency: "SAR", amountMinor: 2_000, settledMinor: 1_000, remainingMinor: 1_000 },
      { currency: "YER", amountMinor: 5_000, settledMinor: 0, remainingMinor: 5_000 },
    ], [{ currency: "YER", amountMinor: 30_000, payableId: null, payableExists: false, allocatedPaidMinor: 28_150 }]);
    expect(totals.map((row) => [row.currency, row.remainingMinor, row.unlinkedPaidMinor, partyStatementNetMinor(row)])).toEqual([
      ["YER", 5_000, 1_850, 3_150], ["SAR", 1_000, 0, 1_000], ["USD", 5_000, 0, 5_000],
    ]);
  });

  it("fully allocated batches and their signed reversals are never advances", () => {
    const original = { currency: "USD", amountMinor: 20_000, payableId: null, payableExists: false, allocatedPaidMinor: 20_000 } as const;
    expect(partyStatementTotals([], [original])[0].unlinkedPaidMinor).toBe(0);
    const totals = partyStatementTotals(
      [{ currency: "USD", amountMinor: 20_000, settledMinor: 0, remainingMinor: 20_000 }],
      [original, { ...original, amountMinor: -20_000, allocatedPaidMinor: -20_000 }],
    );
    expect(totals[0]).toMatchObject({ paidMinor: 0, unlinkedPaidMinor: 0, remainingMinor: 20_000 });
    expect(partyStatementNetMinor(totals[0])).toBe(20_000);
  });

  it("partially allocated reversal restores both invoice and on-account components", () => {
    const original = { currency: "YER", amountMinor: 20_000, payableId: null, payableExists: false, allocatedPaidMinor: 10_000 } as const;
    const totals = partyStatementTotals(
      [{ currency: "YER", amountMinor: 30_000, settledMinor: 0, remainingMinor: 30_000 }],
      [original, { ...original, amountMinor: -20_000, allocatedPaidMinor: -10_000 }],
    );
    expect(totals[0]).toMatchObject({ paidMinor: 0, unlinkedPaidMinor: 0 });
    expect(partyStatementNetMinor(totals[0])).toBe(30_000);
  });

  it("keeps a payment-only credit in its original currency instead of converting or dropping it", () => {
    const totals = partyStatementTotals([], [{ currency: "SAR", amountMinor: 5_000, payableId: null, payableExists: false, allocatedPaidMinor: 0 }]);
    expect(totals.map((row) => [row.currency, partyStatementNetMinor(row)])).toEqual([["SAR", -5_000]]);
  });

  it("treats dangling historical payable IDs as unlinked without rewriting them", () => {
    const expense = { currency: "YER", amountMinor: 20_000, payableId: 999999, payableExists: false, allocatedPaidMinor: 5_000 } as const;
    const totals = partyStatementTotals([{ currency: "YER", amountMinor: 30_000, remainingMinor: 25_000, settledMinor: 5_000 }], [expense]);
    expect(totals[0].unlinkedPaidMinor).toBe(15_000);
    expect(partyStatementNetMinor(totals[0])).toBe(10_000);
    expect(expense.payableId).toBe(999999);
  });

  it("rejects an unknown source currency before filtering output buckets", () => {
    expect(() => partyStatementTotals([{ currency: "EUR", amountMinor: 100, remainingMinor: 100, settledMinor: 0 }] as never[], [])).toThrow();
    expect(() => partyStatementTotals([], [{ currency: "EUR", amountMinor: 100, payableId: null, payableExists: false, allocatedPaidMinor: 0 }] as never[])).toThrow();
    expect(() => partyStatementTotals([], [], [{ currency: "EUR", amountMinor: 100 }] as never[])).toThrow();
  });

  it("does not hide residual on-account credit when net cash payments cancel", () => {
    const totals = partyStatementTotals([], [
      { currency: "YER", amountMinor: 10_000, payableId: null, payableExists: false, allocatedPaidMinor: 10_000 },
      { currency: "YER", amountMinor: -10_000, payableId: null, payableExists: false, allocatedPaidMinor: 0 },
    ]);
    expect(totals).toMatchObject([{ paidMinor: 0, unlinkedPaidMinor: -10_000 }]);
  });

  it.each([undefined, null, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects unavailable/invalid allocation total %s", (allocatedPaidMinor) => {
    expect(() => partyStatementTotals([], [{ currency: "YER", amountMinor: 20_000, payableId: null, payableExists: false, allocatedPaidMinor } as StatementExpenseLike])).toThrow();
  });
});

describe("statement read boundary", () => {
  const valid = () => partyStatementTotals([], [{ currency: "YER", amountMinor: 100, payableId: null, payableExists: false, allocatedPaidMinor: 0 }]);
  it("admits a verified empty response, zero net and negative native balances", () => {
    expect(readPartyStatementTotals([])).toEqual([]);
    expect(readPartyStatementTotals(valid())).toEqual(valid());
    expect(partyStatementNetMinor(valid()[0])).toBe(-100);
  });
  it.each([undefined, null, {}, [null], [{ currency: "YER" }]])("rejects missing/incomplete totals %#", (value) => {
    expect(() => readPartyStatementTotals(value)).toThrow();
  });
  it("rejects duplicate currencies, unknown currency and unsafe net arithmetic", () => {
    const row = valid()[0];
    expect(() => readPartyStatementTotals([row, row])).toThrow();
    expect(() => readPartyStatementTotals([{ ...row, currency: "EUR" }])).toThrow();
    expect(() => readPartyStatementTotals([{ ...row, remainingMinor: Number.MAX_SAFE_INTEGER, unlinkedPaidMinor: -1 }])).toThrow();
    expect(() => partyStatementNetMinor({ remainingMinor: Number.MAX_SAFE_INTEGER, unlinkedPaidMinor: -2, openingAdvanceMinor: Number.MAX_SAFE_INTEGER })).toThrow();
  });
});
