import { describe, expect, it } from "vitest";
import { readPriceBatch } from "../lib/servicePricing";
import { provisionalFills, provisionalPriceOf } from "../lib/provisionalPrices";
import { parseAmount } from "../lib/money";

const parse = (input: string) => parseAmount(input, "YER");
const nameOf = (id: number) => id === 1 ? "حشوة" : id === 2 ? "تاج" : null;

describe("تسعير الدفعة — كلُّها أو لا شيء", () => {
  const entry = (id: number, price: string) => ({ id, price });

  it("دفعةٌ سليمة تُقبل كاملةً", () => {
    const batch = readPriceBatch([entry(1, "25000"), entry(2, "60000")], parse, nameOf);
    expect(batch.ok).toBe(true);
    if (batch.ok) {
      // اليمنيّ بلا كسورٍ صغرى: ٢٥٠٠٠ ريال = ٢٥٠٠٠ بالوحدة الصغرى.
      expect(batch.prices).toEqual([
        { id: 1, priceMinor: 25_000 },
        { id: 2, priceMinor: 60_000 },
      ]);
    }
  });

  it("سعرٌ غير صالح يردّ الدفعة كلَّها باسم صاحبه", () => {
    const batch = readPriceBatch([entry(1, "25000"), entry(2, "فقط")], parse, nameOf);
    expect(batch.ok).toBe(false);
    if (!batch.ok) expect(batch.message).toContain("تاج");
  });

  it("صفرٌ ليس سعرًا: خدمةٌ بصفرٍ تُفوتر بلا مقابل ولا يُعرف أمجّانيةٌ هي أم منسيّة", () => {
    const batch = readPriceBatch([entry(1, "0")], parse, nameOf);
    expect(batch.ok).toBe(false);
    if (!batch.ok) expect(batch.message).toContain("أكبر من صفر");
  });

  it("خدمةٌ مرّتين بسعرين: أيُّهما يُحفظ؟ فتُردّ ولا يُخمَّن", () => {
    const batch = readPriceBatch([entry(1, "1000"), entry(1, "2000")], parse, nameOf);
    expect(batch.ok).toBe(false);
    if (!batch.ok) expect(batch.message).toContain("مكرّرة");
  });

  it("دفعةٌ فارغة أو أطول من الحدّ تُردّ قبل أن تبدأ", () => {
    expect(readPriceBatch([], parse, nameOf).ok).toBe(false);
    expect(readPriceBatch(
      Array.from({ length: 501 }, (_, index) => entry(index + 1, "1")),
      parse, nameOf,
    ).ok).toBe(false);
  });
});

describe("الأسعار التخمينية — موسومة، وما سُعّر لا يُمسّ", () => {
  it("غير المسعّر النشط يُملأ، والمسعّر والمعطّل وبلا فئةٍ لا يُمسّان", () => {
    const fills = provisionalFills([
      { id: 1, category: "filling", priceConfigured: false, isActive: true },
      { id: 2, category: "crown", priceConfigured: true, isActive: true },
      { id: 3, category: "rct", priceConfigured: false, isActive: false },
      { id: 4, category: null, priceConfigured: false, isActive: true },
    ]);
    expect(fills).toEqual([{ id: 1, priceMinor: 12_000 }]);
  });

  it("فئةٌ من دليلنا تُقدَّر بسعرها التخميني بالوحدة الصغرى للريال (بلا كسور)", () => {
    expect(provisionalPriceOf("unknown_category")).toBeNull();
    expect(provisionalPriceOf(null)).toBeNull();
    // filling = 12000 ريال يمني = 12000 بالوحدة الصغرى (اليمنيّ بلا كسور).
    expect(provisionalPriceOf("filling")).toBe(12_000);
  });
});
