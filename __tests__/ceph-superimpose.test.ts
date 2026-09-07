import { describe, expect, it } from "vitest";
import { referenceLines, superimposeOnSN } from "../lib/cephSuperimpose";
import type { LandmarkMap } from "../lib/ceph";

const points = (overrides: Partial<LandmarkMap> = {}): LandmarkMap => ({
  S: { x: 100, y: 100 },
  N: { x: 300, y: 90 },
  A: { x: 280, y: 220 },
  B: { x: 260, y: 320 },
  Pog: { x: 270, y: 380 },
  Me: { x: 250, y: 400 },
  Go: { x: 120, y: 350 },
  ...overrides,
});

describe("التراكب على SN عند S", () => {
  it("بلا معايرة لا تراكب — المقياس هو الحدّ الحاكم", () => {
    const result = superimposeOnSN(
      { points: points(), mmPerPixel: null },
      { points: points(), mmPerPixel: 0.1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("معايرة");
  });

  it("بلا S أو N في إحدى الصورتين يُقال ما يُفعل", () => {
    const result = superimposeOnSN(
      { points: points({ N: undefined }), mmPerPixel: 0.1 },
      { points: points(), mmPerPixel: 0.1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("S وN");
  });

  it("الصورتان بمقاسين مختلفين: المليمتر وحدة مشتركة فلا تحجيم محوٍ للنموّ", () => {
    // الأحدث بمقياس مضاعف: النقطة نفسها تغطي ضعف المليمترات.
    const base = { points: points(), mmPerPixel: 0.1 };
    const target = { points: points(), mmPerPixel: 0.2 };
    const result = superimposeOnSN(base, target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // S الأحدث يُنقل إلى S الأقدم بالضبط — بالبكسل في فضاء الصورة الأولى.
    expect(result.value.points.S?.x).toBeCloseTo(100, 5);
    expect(result.value.points.S?.y).toBeCloseTo(100, 5);
    // وSN الأحدث بعد التحويل يمرّ من S نحو اتجاه SN الأقدم.
    expect(result.value.points.N?.x).toBeGreaterThan(100);
    // وطول SN بالمليمتر يُقرأ رقمًا في كلٍّ — النموّ لا يُمحى.
    expect(result.value.cranialBaseBefore).toBeCloseTo(Math.hypot(200, -10) * 0.1, 5);
    expect(result.value.cranialBaseAfter).toBeCloseTo(Math.hypot(200, -10) * 0.2, 5);
  });

  it("معاملات النمو تظهر بالفرق بين الطولين", () => {
    const result = superimposeOnSN(
      { points: points(), mmPerPixel: 0.1 },
      { points: points(), mmPerPixel: 0.15 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cranialBaseAfter).toBeGreaterThan(result.value.cranialBaseBefore);
  });
});

describe("referenceLines — خطوطٌ تُرسم من معالم موجودة فقط", () => {
  it("معالمٌ كاملة تُعطي الخطوط القياسية", () => {
    const lines = referenceLines(points());
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(lines.some((line) => line.label.includes("SN"))).toBe(true);
  });

  it("معلمٌ غائب يُسقط خطّه بصمت — لا يُرسم من لا شيء", () => {
    const lines = referenceLines(points({ ANS: undefined, PNS: undefined }));
    expect(lines.some((line) => line.label.includes("ANS-PNS"))).toBe(false);
  });
});
