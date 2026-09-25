import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { drawerBreakdown, drawerDifference, hasDifference, isCashMethod } from "../lib/shift-close";
import { SHIFT_CLOSE_SQL } from "../lib/shift-close-schema";
import { BANK_ACCOUNT, CASH_ACCOUNT, paymentEntry } from "../lib/accounting";

/** (P1-3) القاعدة الواحدة للدرج، وقيد التحويل في البنك، ومسارا المخطط. */
const Z = { YER: 0, SAR: 0, USD: 0 };

describe("drawerBreakdown — النقد وحده في الدرج", () => {
  it("التحويل خارج المتوقَّع، والمردود النقدي والصرف يُطرحان", () => {
    const result = drawerBreakdown(
      { ...Z, YER: 1_000 },
      [
        { kind: "payment", currency: "YER", amountMinor: 10_000, method: "cash" },
        { kind: "payment", currency: "YER", amountMinor: 5_000, method: "transfer" },
        { kind: "refund", currency: "YER", amountMinor: 500, method: "cash" },
        { kind: "payment", currency: "SAR", amountMinor: 3_000, method: null },
      ],
      [{ currency: "YER", amountMinor: 2_000 }],
    );
    expect(result.expected).toEqual({ YER: 8_500, SAR: 3_000, USD: 0 });
    expect(result.nonCashIn.YER).toBe(5_000);
    expect(result.cashRefunds.YER).toBe(500);
  });

  it("الطريقة الغائبة (بيانات قديمة) = نقد", () => {
    expect(isCashMethod(null)).toBe(true);
    expect(isCashMethod("")).toBe(true);
    expect(isCashMethod("transfer")).toBe(false);
  });

  it("الفرق = المعدود − المتوقَّع، وسالبه عجز", () => {
    const difference = drawerDifference({ ...Z, YER: 9_000 }, { ...Z, YER: 8_500 });
    expect(difference.YER).toBe(-500);
    expect(hasDifference(difference)).toBe(true);
    expect(hasDifference(Z)).toBe(false);
  });
});

describe("قيد الدفعة — النقد للصندوق والتحويل للبنك", () => {
  it("التحويل يُقيَّد في حساب البنك، والنقد في الصندوق", () => {
    const transfer = paymentEntry({
      receiptNumber: "R-1", date: "2026-09-24", patientName: "س", currency: "YER",
      baseAmountMinor: 5_000, kind: "payment", method: "transfer",
    })!;
    expect(transfer.lines.find((line) => line.side === "debit")!.accountCode).toBe(BANK_ACCOUNT.YER);
    const cash = paymentEntry({
      receiptNumber: "R-2", date: "2026-09-24", patientName: "س", currency: "YER",
      baseAmountMinor: 5_000, kind: "payment",
    })!;
    expect(cash.lines.find((line) => line.side === "debit")!.accountCode).toBe(CASH_ACCOUNT.YER);
  });
});

describe("مسارا المخطط لا يفترقان (0014)", () => {
  it("جسد migrations/0014 = SHIFT_CLOSE_SQL حرفيًّا", () => {
    const migration = readFileSync("migrations/0014_shift_close_expected_difference.sql", "utf8");
    const lines = migration.split("\n");
    let index = 0;
    while (index < lines.length && (lines[index].startsWith("--") || lines[index].trim() === "")) index += 1;
    expect(`${lines.slice(index).join("\n").replace(/\n+$/, "")}\n`).toBe(SHIFT_CLOSE_SQL);
  });
});
