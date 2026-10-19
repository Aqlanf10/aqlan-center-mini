import { describe, expect, it } from "vitest";
import { expenseEntry, isBalanced } from "../lib/accounting";

describe("voucher settlement liability accounts", () => {
  const input = {
    voucherNumber: "PV-SYNTHETIC", date: "2026-10-01", payeeName: "Synthetic staff",
    category: "salary", currency: "YER" as const, amountMinor: 100, settlesPayable: true,
    payableAccountCode: "2101",
    settlements: [
      { paidMinor: 40, payableCurrency: "YER" as const, settledMinor: 40, payableAccountCode: "2107" },
      { paidMinor: 50, payableCurrency: "YER" as const, settledMinor: 50, payableAccountCode: "2106" },
    ],
  };

  it("uses each payable's account and keeps the unallocated advance on the party account", () => {
    const entry = expenseEntry(input)!;
    expect(entry.lines).toEqual([
      { accountCode: "2107", currency: "YER", amountMinor: 40, side: "debit" },
      { accountCode: "2106", currency: "YER", amountMinor: 50, side: "debit" },
      { accountCode: "2101", currency: "YER", amountMinor: 10, side: "debit" },
      { accountCode: "1101", currency: "YER", amountMinor: 100, side: "credit" },
    ]);
    expect(isBalanced(entry)).toBe(true);
  });

  it("mirrors each account and the remainder on reversal", () => {
    const original = expenseEntry(input)!;
    const reversal = expenseEntry({ ...input, amountMinor: -100, settlements: input.settlements.map(piece => ({
      ...piece, paidMinor: -piece.paidMinor, settledMinor: -piece.settledMinor,
    })) })!;
    expect(reversal.lines).toEqual(original.lines.map(line => ({ ...line, side: line.side === "debit" ? "credit" : "debit" })));
    expect(isBalanced(reversal)).toBe(true);
  });

  it("uses the target account in its recorded currency with balanced clearing legs", () => {
    const entry = expenseEntry({ ...input, settlements: [
      { paidMinor: 80, payableCurrency: "USD", settledMinor: 25, payableAccountCode: "2107" },
    ] })!;
    expect(entry.lines).toContainEqual({ accountCode: "2107", currency: "USD", amountMinor: 25, side: "debit" });
    expect(entry.lines).toContainEqual({ accountCode: "2101", currency: "YER", amountMinor: 20, side: "debit" });
    expect(entry.lines.filter(line => line.accountCode === "1901")).toHaveLength(2);
    expect(isBalanced(entry)).toBe(true);
  });

  it("preserves the existing fallback for callers without piece accounts", () => {
    const entry = expenseEntry({ ...input, settlements: [{ paidMinor: 100, payableCurrency: "YER", settledMinor: 100 }] })!;
    expect(entry.lines[0]).toEqual({ accountCode: "2101", currency: "YER", amountMinor: 100, side: "debit" });
  });
});
