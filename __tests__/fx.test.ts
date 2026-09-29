import { describe, expect, it } from "vitest";
import { foreignCurrencies, translatePosition } from "../lib/fx";
import * as accounting from "../lib/accounting";

/**
 * (TD-REG-028) العملات الأجنبية في دفترٍ بعملاته الأصلية: لا «إعادة تقييم» تُرحَّل — عرض ترجمةٍ
 * للعلم بسعرٍ مذكور، ولا سعر يُخترع حين يغيب.
 */
describe("ترجمة العملات الأجنبية — للعلم، لا ترحيل", () => {
  it("لا يُترجم العملة الأساسية إلى نفسها", () => {
    expect(foreignCurrencies("YER")).toEqual(["SAR", "USD"]);
    expect(foreignCurrencies("USD")).toEqual(["YER", "SAR"]);
  });

  it("يترجم ما نملكه بسعر الإعدادات المذكور — والنقد يبقى بعملته", () => {
    const position = translatePosition({ currency: "USD", base: "YER", cashMinor: 10_000, clearingMinor: -2_000, rate: 545 });
    // 100.00 $ × 545 = 54,500 ر.ي — للعلم.
    expect(position).toEqual({
      currency: "USD", cashMinor: 10_000, clearingMinor: -2_000, rate: 545,
      translatedCashMinor: 54_500, translatedClearingMinor: -10_900,
    });
  });

  it("لا سعر مضبوط ⇒ لا ترجمة (null) — لا صفر ولا تخمين", () => {
    for (const rate of [null, 0, -1, Number.NaN]) {
      const position = translatePosition({ currency: "SAR", base: "YER", cashMinor: 5_000, clearingMinor: 0, rate });
      expect(position.rate).toBeNull();
      expect(position.translatedCashMinor).toBeNull();
      expect(position.cashMinor).toBe(5_000);
    }
  });

  it("لا مُنشئ لقيد «إعادة تقييم» في الدفتر الأصلي — الترحيل متوقف بقرارٍ موثَّق", () => {
    expect("revaluationEntry" in accounting).toBe(false);
  });
});
