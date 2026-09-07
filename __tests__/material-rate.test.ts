import { describe, expect, it } from "vitest";
import { FULL_RATE_BP, materialCost, parseRateBp, ratePercentText } from "../lib/materialRate";

describe("نسب إهلاك المواد — نقاط أساس كالمال", () => {
  it("النسبة تُقرأ بأشكال الكتابة كلها", () => {
    expect(parseRateBp("7.5")).toBe(750);
    expect(parseRateBp("7٫5")).toBe(750);
    // الفاصلة الإنجليزية فاصلُ آلافٍ لا عشريّ — كالمال في محركنا.
    expect(parseRateBp("7,5")).toBe(7500);
    expect(parseRateBp(" 7.5% ")).toBe(750);
    expect(parseRateBp(7.5)).toBe(750);
    expect(parseRateBp("0")).toBe(0);
  });

  it("فوق المئة مرفوضة: ٧٥٠ حيث أراد أحدهم ٧٫٥ يأكل العمولة كلَّها", () => {
    expect(parseRateBp("750")).toBeNull();
    expect(parseRateBp("-1")).toBeNull();
    expect(parseRateBp("")).toBeNull();
    expect(parseRateBp(null)).toBeNull();
    expect(FULL_RATE_BP).toBe(10_000);
  });

  it("نصُّ النسبة كما يُعرض — بلا أصفارٍ ذيلية", () => {
    expect(ratePercentText(750)).toBe("7.5");
    expect(ratePercentText(1000)).toBe("10");
    expect(ratePercentText(0)).toBe("0");
  });

  it("التكلفة على المحصَّل موزَّعة على التخصصات، وما بلا نسبةٍ يُقال لا يُقدَّر بصفر", () => {
    const covered = new Map<string | null, number>([
      ["rct", 1_000_000],
      ["filling", 500_000],
      [null, 200_000],
    ]);
    const rates = new Map<string, number>([["rct", 750], ["filling", 1000]]);
    const result = materialCost(covered, rates);
    // rct: 7.5% من مليون = 75000؛ filling: 10% من 500000 = 50000.
    expect(result.costMinor).toBe(125_000);
    expect(result.unratedCoveredMinor).toBe(200_000);
  });

  it("تخصّصٌ بلا نسبةٍ محدَّدة لا يُخصم منه شيء", () => {
    const result = materialCost(new Map([["crown", 900_000]]), new Map());
    expect(result.costMinor).toBe(0);
    expect(result.unratedCoveredMinor).toBe(900_000);
  });
});
