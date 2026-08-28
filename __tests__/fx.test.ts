import { describe, expect, it } from "vitest";
import {
  effectiveRate,
  foreignCurrencies,
  isWorthPosting,
  revaluePosition,
} from "../lib/fx";
import {
  CASH_ACCOUNT,
  FX_ACCOUNT,
  balanceSheet,
  incomeStatement,
  isBalanced,
  revaluationEntry,
  trialBalance,
} from "../lib/accounting";

describe("إعادة تقييم العملات", () => {
  it("لا يُقيّم العملة الأساسية بنفسها", () => {
    expect(foreignCurrencies("YER")).toEqual(["SAR", "USD"]);
    expect(foreignCurrencies("USD")).toEqual(["YER", "SAR"]);
  });

  it("يحسب ربح ارتفاع السعر على النقد المحتفظ به", () => {
    // مئة دولار دخلت الدفاتر بـ545 وسعر اليوم 600: الفرق ربحٌ حقيقي بلا ريال جديد.
    const position = revaluePosition({
      currency: "USD", base: "YER", heldMinor: 10_000,
      bookValueMinor: 54_500, rate: 600,
    });
    expect(position.revaluedMinor).toBe(60_000);
    expect(position.differenceMinor).toBe(5_500);
    expect(position.impliedRate).toBe(545);
  });

  it("يحسب خسارة انخفاض السعر", () => {
    const position = revaluePosition({
      currency: "SAR", base: "YER", heldMinor: 100_000,
      bookValueMinor: 145_000, rate: 140,
    });
    expect(position.revaluedMinor).toBe(140_000);
    expect(position.differenceMinor).toBe(-5_000);
  });

  it("لا سعر ضمنيًا بلا رصيد — ولا قسمة على صفر", () => {
    const position = revaluePosition({
      currency: "USD", base: "YER", heldMinor: 0, bookValueMinor: 0, rate: 600,
    });
    expect(position.impliedRate).toBeNull();
    expect(position.differenceMinor).toBe(0);
  });

  it("السعر الفعلي وزني لا حسابي", () => {
    // ألف دولار بـ500 وعشرة بـ600: الوسط الحسابي 550 والفعلي ~500.
    const rate = effectiveRate(
      [
        { amountMinor: 100_000, baseAmountMinor: 500_000 },
        { amountMinor: 1_000, baseAmountMinor: 6_000 },
      ],
      "USD", "YER", 545,
    );
    expect(Math.round(rate)).toBe(501);
  });

  it("يرجع السعر الاحتياطي حين لا تمرّ العملة أصلًا", () => {
    expect(effectiveRate([], "USD", "YER", 545)).toBe(545);
  });

  it("لا يرحّل فرقًا لا يستحق قيدًا", () => {
    expect(isWorthPosting(0)).toBe(false);
    expect(isWorthPosting(1)).toBe(true);
    expect(isWorthPosting(-1)).toBe(true);
  });

  it("قيد الربح يزيد الصندوق ويقيّد الفرق في قائمة الدخل", () => {
    const entry = revaluationEntry({ date: "2026-08-27", currency: "USD", differenceMinor: 5_500 });
    expect(entry).not.toBeNull();
    expect(isBalanced(entry!)).toBe(true);
    expect(entry!.lines).toContainEqual({
      accountCode: CASH_ACCOUNT.USD, amountMinor: 5_500, side: "debit",
    });
    expect(entry!.lines).toContainEqual({
      accountCode: FX_ACCOUNT, amountMinor: 5_500, side: "credit",
    });

    const balances = trialBalance([entry!]);
    // الفرق يدخل قائمة الدخل لا حقوق الملكية — والربح يُنقص مصروف الفروقات.
    expect(incomeStatement(balances).totalExpensesMinor).toBe(-5_500);
    expect(balanceSheet(balances).differenceMinor).toBe(0);
  });

  it("قيد الخسارة يعكس الطرفين", () => {
    const entry = revaluationEntry({ date: "2026-08-27", currency: "SAR", differenceMinor: -5_000 });
    expect(entry!.lines).toContainEqual({
      accountCode: FX_ACCOUNT, amountMinor: 5_000, side: "debit",
    });
    expect(entry!.lines).toContainEqual({
      accountCode: CASH_ACCOUNT.SAR, amountMinor: 5_000, side: "credit",
    });
    expect(isBalanced(entry!)).toBe(true);
  });

  it("لا قيد بلا فرق", () => {
    expect(revaluationEntry({ date: "2026-08-27", currency: "USD", differenceMinor: 0 })).toBeNull();
  });

  it("ترحيلٌ ثانٍ لا يُضاعف: الفرق بعده صفر", () => {
    // بعد الترحيل صارت القيمة الدفترية 60,000 — فإعادة الحساب بالسعر نفسه لا تعطي فرقًا.
    const after = revaluePosition({
      currency: "USD", base: "YER", heldMinor: 10_000,
      bookValueMinor: 60_000, rate: 600,
    });
    expect(after.differenceMinor).toBe(0);
    expect(isWorthPosting(after.differenceMinor)).toBe(false);
  });
});
