import { describe, expect, it } from "vitest";
import {
  AR_ACCOUNT, BANK_ACCOUNT, CASH_ACCOUNT, CURRENCY_CLEARING_ACCOUNT,
  isBalanced, paymentEntry, sideTotal,
} from "../lib/accounting";
import { accountLedger, accountingPeriod } from "../lib/accounting-reports";

const base = {
  receiptNumber: "SYNTHETIC-ZERO-BASE", date: "2026-08-01", patientName: "Synthetic",
  currency: "SAR" as const, amountMinor: 1,
  settlementCurrency: "YER" as const, settlementMinor: 0, kind: "payment" as const,
};

describe("positive native receipts with zero stored base", () => {
  for (const currency of ["SAR", "USD"] as const) {
    for (const method of ["cash", "transfer"] as const) {
      for (const kind of ["payment", "refund"] as const) {
        it(`retains ${currency} ${method} ${kind} without a fabricated YER leg`, () => {
          const entry = paymentEntry({ ...base, currency, method, kind })!;
          const account = method === "cash" ? CASH_ACCOUNT[currency] : BANK_ACCOUNT[currency];
          expect(entry.lines).toEqual([
            { accountCode: account, currency, amountMinor: 1, side: kind === "payment" ? "debit" : "credit" },
            { accountCode: CURRENCY_CLEARING_ACCOUNT, currency, amountMinor: 1, side: kind === "payment" ? "credit" : "debit" },
          ]);
          expect(entry.source).toBe(kind);
          expect(isBalanced(entry)).toBe(true);
          expect(entry.lines.some(line => line.accountCode === AR_ACCOUNT || line.currency === "YER")).toBe(false);
          const report = accountingPeriod([entry], base.date, base.date);
          expect(accountLedger(report, account, currency)).toMatchObject({
            closingBalanceMinor: kind === "payment" ? 1 : -1,
            rows: [{ reference: base.receiptNumber, source: kind, currency }],
          });
          for (const code of ["YER", "SAR", "USD"] as const) {
            expect(sideTotal(entry, "debit", code)).toBe(sideTotal(entry, "credit", code));
          }
        });
      }
    }
  }

  it("preserves same-currency settlement semantics and refuses zero, negative or invalid new native-only cases", () => {
    expect(paymentEntry({ ...base, settlementCurrency: "SAR" })).toBeNull();
    for (const amountMinor of [0, -1, NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(paymentEntry({ ...base, amountMinor })).toBeNull();
    }
    expect(paymentEntry({ ...base, settlementMinor: -1 })).toBeNull();
    const same = paymentEntry({ ...base, settlementCurrency: "SAR", settlementMinor: 1 })!;
    expect(same.lines).toEqual([
      { accountCode: CASH_ACCOUNT.SAR, currency: "SAR", amountMinor: 1, side: "debit" },
      { accountCode: AR_ACCOUNT, currency: "SAR", amountMinor: 1, side: "credit" },
    ]);
    expect(isBalanced(same)).toBe(true);
  });

  it("keeps a fully refunded original balanced in both native and stored-base currencies", () => {
    const inputs = [
      { ...base, amountMinor: 3, settlementMinor: 2 },
      { ...base, kind: "refund" as const, settlementMinor: 1 },
      { ...base, kind: "refund" as const, settlementMinor: 0 },
      { ...base, kind: "refund" as const, settlementMinor: 1 },
    ];
    const entries = inputs.map(input => paymentEntry(input)!);
    expect(entries.every(isBalanced)).toBe(true);
    const report = accountingPeriod(entries, base.date, base.date);
    expect(report.entryCount).toBe(4);
    expect(report.cumulativeBalances.every(balance => balance.balanceMinor === 0)).toBe(true);
    expect(accountLedger(report, CASH_ACCOUNT.SAR, "SAR")).toMatchObject({
      periodDebitMinor: 3, periodCreditMinor: 3, closingBalanceMinor: 0,
    });
  });
});
