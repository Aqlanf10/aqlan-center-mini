import { describe, expect, it } from "vitest";
import { costNow, costStates, issuedCostMinor } from "../lib/inventoryCost";
import { signedQty, type MovementKind } from "../lib/inventory";

const movement = (
  kind: MovementKind, qty: number,
  unitCostMinor?: number | null, isReturn?: boolean,
) => ({ kind, qty, unitCostMinor, isReturn });

describe("المتوسط المرجّح (WAC) — تكلفةٌ مشتقّة كالرصيد", () => {
  it("شراءٌ بثمنٍ معلوم يحدّد المتوسط، والصرف يُقيَّم بما قبله", () => {
    const states = costStates([
      movement("in", 10, 1000),
      movement("out", 4),
    ]);
    expect(states[0]).toMatchObject({ qty: 10, valueMinor: 10_000, unitCostMinor: 1000 });
    expect(states[1]).toMatchObject({ qty: 6, valueMinor: 6_000, unitCostMinor: 1000 });
  });

  it("شراءٌ بثمنٍ آخر يحرّك المتوسّط لا يستبدله", () => {
    const state = costNow([
      movement("in", 10, 1000),
      movement("in", 10, 2000),
    ]);
    expect(state.qty).toBe(20);
    expect(state.valueMinor).toBe(30_000);
    expect(state.unitCostMinor).toBe(1500);
  });

  it("شراءٌ بعد الصرف لا يغيّر تكلفة ما صُرف قبلَه", () => {
    const total = issuedCostMinor(
      [movement("in", 10, 1000), movement("out", 4), movement("in", 10, 5000)],
      (index) => index === 1,
    );
    // الأربعة صُرفت بمتوسّط ١٠٠٠ قبل أن يدخل الثمن الغالي.
    expect(total).toBe(4000);
  });

  it("الردّ يعيد بالمتوسّط القائم — لا يُحرّكه كأنّه شراء", () => {
    const state = costNow([
      movement("in", 10, 1000),
      movement("out", 4),
      movement("in", 2, undefined, true),
    ]);
    expect(state.qty).toBe(8);
    // ٦ × ١٠٠٠ + ٢ × ١٠٠٠ (المتوسط القائم) = ٨٠٠٠ — الردّ لم يُدخل ثمنًا جديدًا.
    expect(state.valueMinor).toBe(8000);
    expect(state.unitCostMinor).toBe(1000);
  });

  it("رفٌّ بلا ثمنٍ قيمتُه صفر لا سالبة، ولا قسمة على صفر", () => {
    const state = costNow([
      movement("in", 5),
      movement("out", 5),
    ]);
    expect(state.qty).toBe(0);
    expect(state.valueMinor).toBe(0);
    expect(state.unitCostMinor).toBeNull();
  });

  it("صرفٌ فوق الرصيد لا ينزل القيمة تحت الصفر", () => {
    const state = costNow([
      movement("in", 2, 1000),
      movement("out", 5),
    ]);
    expect(state.valueMinor).toBe(0);
  });
});

describe("signedQty — التوقيع موحّد مع محرك المخزون", () => {
  it("الإدخال يزيد والصرف ينقص والتسوية موقَّعة", () => {
    expect(signedQty("in", 3)).toBe(3);
    expect(signedQty("out", 3)).toBe(-3);
    expect(signedQty("adjust", -2)).toBe(-2);
  });
});
