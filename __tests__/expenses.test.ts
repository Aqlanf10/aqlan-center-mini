import { describe, expect, it } from "vitest";
import {
  categoryForParty,
  expectedInBox,
  expenseTotals,
  isExpenseCategory,
  type ExpenseLike,
} from "../lib/expenses";

function expense(over: Partial<ExpenseLike>): ExpenseLike {
  return { category: "other", amountMinor: 10000, currency: "YER", baseAmountMinor: 10000, ...over };
}

describe("إجماليات المصروف", () => {
  it("تجمع بالتصنيف وبالعملة معًا", () => {
    const totals = expenseTotals([
      expense({ category: "lab", baseAmountMinor: 50000, amountMinor: 50000 }),
      expense({ category: "lab", baseAmountMinor: 20000, amountMinor: 20000 }),
      expense({ category: "materials", currency: "USD", amountMinor: 5000, baseAmountMinor: 26500 }),
    ]);
    expect(totals.byCategory.lab).toBe(70000);
    expect(totals.byCategory.materials).toBe(26500);
    expect(totals.byCurrency).toEqual({ YER: 70000, SAR: 0, USD: 5000 });
    expect(totals.baseTotalMinor).toBe(96500);
    expect(totals.count).toBe(3);
  });
});

describe("المتوقَّع في الصندوق", () => {
  it("يطرح المصروف — وإهماله يجعل كل إغلاق يبدو ناقصًا", () => {
    const expected = expectedInBox(
      { YER: 50000, SAR: 0, USD: 2000 },
      { YER: 100000, SAR: 20000, USD: 10000 },
      { YER: 30000, SAR: 0, USD: 0 },
    );
    expect(expected.YER).toBe(120000);
    expect(expected.SAR).toBe(20000);
    expect(expected.USD).toBe(12000);
  });
});

describe("التصنيف المقترح للجهة", () => {
  it("يقترح ما يناسب نوعها", () => {
    expect(categoryForParty("lab")).toBe("lab");
    expect(categoryForParty("doctor")).toBe("commission");
    expect(categoryForParty("supplier")).toBe("supplier");
  });

  it("يقبل مفاتيح بنود المصروفات القياسية والمخصصة ويرفض الصيغ الفاسدة", () => {
    /* النموذج مفتوح الآن: بنود المصروفات سجلاتٌ في القاعدة (expense_categories)
     * لا قائمة مغلقة في الكود — فالتحقق صيغةٌ (حروف وأرقام وشرطات) لا قائمة. */
    expect(isExpenseCategory("lab")).toBe(true);
    expect(isExpenseCategory("electricity")).toBe(true);
    expect(isExpenseCategory("cat_lx2k9f")).toBe(true);
    expect(isExpenseCategory("marketing")).toBe(true);
    expect(isExpenseCategory("")).toBe(false);
    expect(isExpenseCategory("   ")).toBe(false);
    expect(isExpenseCategory("فيه مسافات")).toBe(false);
    expect(isExpenseCategory("x")).toBe(false);
    expect(isExpenseCategory(null)).toBe(false);
  });
});
