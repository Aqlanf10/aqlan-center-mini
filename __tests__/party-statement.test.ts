import { describe, expect, it } from "vitest";
import { partyStatementTotals } from "@/lib/party-statement";

/** ملخّص كشف حساب جهة — كل عملةٍ بسطرها، والإبطال يصافي نفسه. */
describe("partyStatementTotals", () => {
  it("لا يمزج العملات: فاتورة بالسعودي وسند بالريال سطران منفصلان", () => {
    const totals = partyStatementTotals(
      [
        { amountMinor: 50_000, currency: "YER", settledMinor: 20_000, remainingMinor: 30_000 },
        { amountMinor: 10_000, currency: "SAR", settledMinor: 0, remainingMinor: 10_000 },
      ],
      [{ amountMinor: 20_000, currency: "YER", payableId: 1 }],
    );
    expect(totals).toEqual([
      { currency: "YER", owedMinor: 50_000, settledMinor: 20_000, remainingMinor: 30_000, paidMinor: 20_000, unlinkedPaidMinor: 0 },
      { currency: "SAR", owedMinor: 10_000, settledMinor: 0, remainingMinor: 10_000, paidMinor: 0, unlinkedPaidMinor: 0 },
    ]);
  });

  it("سند الإبطال السالب يصافي أصله، والدفعة غير المربوطة تُفرد", () => {
    const totals = partyStatementTotals(
      [{ amountMinor: 5_000, currency: "USD", settledMinor: 0, remainingMinor: 5_000 }],
      [
        { amountMinor: 5_000, currency: "USD", payableId: 7 },
        { amountMinor: -5_000, currency: "USD", payableId: 7 },
        { amountMinor: 1_500, currency: "USD", payableId: null },
      ],
    );
    expect(totals).toEqual([
      { currency: "USD", owedMinor: 5_000, settledMinor: 0, remainingMinor: 5_000, paidMinor: 1_500, unlinkedPaidMinor: 1_500 },
    ]);
  });

  it("العملة التي لا حركة فيها لا تظهر، وترتيب العملات ثابت", () => {
    expect(partyStatementTotals([], [])).toEqual([]);
    const totals = partyStatementTotals(
      [{ amountMinor: 100, currency: "USD", settledMinor: 0, remainingMinor: 100 }],
      [{ amountMinor: 300, currency: "YER", payableId: null }],
    );
    expect(totals.map((row) => row.currency)).toEqual(["YER", "USD"]);
  });
});
