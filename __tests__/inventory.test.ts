import { describe, expect, it } from "vitest";
import {
  batchRemaining, deriveBalance, expiryState, isMovementKind, signedQty,
  stockStatus, validateMovement,
  type BatchLike,
} from "../lib/inventory";

/**
 * دستور المخزون مختبرٌ هنا بندًا بندًا:
 *
 * ١) الرصيد اشتقاقٌ رياضي من الحركات — لا حقل رصيد.
 * ٢) لا صرف يتجاوز الرصيد، ولا تسوية بلا سبب مكتوب.
 * ٣) الصرف يستهلك الدفعات بالأقرب صلاحيةً (FEFO)، ومجموع البقايا زائد
 *    التسويات يساوي الرصيد المشتق بالضبط.
 */

describe("الاشتقاق الرياضي للرصيد", () => {
  it("أثر الحركات الموقع: إدخال يزيد وصرف ينقص وتسوية كما وُقّعت", () => {
    expect(signedQty("in", 10)).toBe(10);
    expect(signedQty("out", 10)).toBe(-10);
    expect(signedQty("adjust", -3)).toBe(-3);
    expect(signedQty("adjust", 5)).toBe(5);
    // الصرف الموجب دائمًا داخليًا حتى لو وصل سالبًا من طبقةٍ أعلى — لا انقلاب إشارة.
    expect(signedQty("out", -4)).toBe(-4);
  });

  it("الرصيد مجموع الحركات الموقَّع — لا حقلًا يُعدَّل", () => {
    const movements = [
      { kind: "in" as const, qty: 50 },
      { kind: "out" as const, qty: 12 },
      { kind: "out" as const, qty: 8 },
      { kind: "adjust" as const, qty: -2 }, // تلف موثَّق
      { kind: "in" as const, qty: 20 },
    ];
    expect(deriveBalance(movements)).toBe(48);
    expect(deriveBalance([])).toBe(0);
  });

  it("رمز حركة غريب يُرفض قبل أن يلمس القاعدة", () => {
    expect(isMovementKind("in")).toBe(true);
    expect(isMovementKind("transfer")).toBe(false);
    expect(isMovementKind(42)).toBe(false);
  });
});

describe("فحص الحركة: الصرف لا يتجاوز والتسوية بلا سبب مرفوضة", () => {
  it("الصرف داخل الرصيد يمر وتجاوزه يُرفض برسالة تذكر الرقّمين", () => {
    expect(validateMovement("out", 30, null, 50).ok).toBe(true);
    const rejected = validateMovement("out", 60, null, 50);
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain("50");
    expect(rejected.message).toContain("60");
  });

  it("التسوية الصفرية لا معنى لها، وبلا سبب باب خلفي مرفوض", () => {
    expect(validateMovement("adjust", 0, "نقص", 10).ok).toBe(false);
    expect(validateMovement("adjust", -3, null, 10).ok).toBe(false);
    expect(validateMovement("adjust", -3, "   ", 10).ok).toBe(false);
    expect(validateMovement("adjust", -3, "تلفٌ بالانتهاء", 10).ok).toBe(true);
    expect(validateMovement("adjust", 4, "تصحيح إحصاء", 10).ok).toBe(true);
  });

  it("الإدخال بكمية صفرية أو سالبة يُرفض", () => {
    expect(validateMovement("in", 0, null, 0).ok).toBe(false);
    expect(validateMovement("in", -5, null, 0).ok).toBe(false);
    expect(validateMovement("in", 5, null, 0).ok).toBe(true);
  });
});

describe("حد الطلب وحالة الصلاحية", () => {
  it("منتهٍ شامل الصفر والسالب، وتحت الحد قبل بلوغه، ومتوفر فوقه", () => {
    expect(stockStatus(0, 5)).toBe("out");
    expect(stockStatus(-3, 5)).toBe("out");
    expect(stockStatus(4, 5)).toBe("low");
    expect(stockStatus(5, 5)).toBe("ok");
    expect(stockStatus(9, 0)).toBe("ok"); // بلا حدّ طلب لا إنذار
  });

  it("الصلاحية: منتهية ثم قريبة خلال ثلاثين يومًا ثم سليمة", () => {
    expect(expiryState("2026-01-01", "2026-01-02")).toBe("expired");
    expect(expiryState("2026-01-31", "2026-01-02")).toBe("soon");
    expect(expiryState("2026-02-02", "2026-01-02")).toBe("ok"); // الحادي والثلاثون خارج المهلة
    expect(expiryState("2026-01-02", "2026-01-02")).toBe("soon"); // يوم الانتهاء نفسه
    expect(expiryState("تاريخ تالف", "2026-01-02")).toBe("ok"); // لا إنذار بكذبة
  });
});

describe("دفعات الصلاحية — FEFO واكتمال المعادلة", () => {
  const batch = (id: number, kind: BatchLike["kind"], qty: number, expiryDate: string | null, createdAt: string): BatchLike =>
    ({ id, kind, qty, expiryDate, createdAt });

  it("الصرف يستهلك الدفعة الأقرب انتهاءً أولًا", () => {
    const result = batchRemaining([
      batch(1, "in", 10, "2026-06-01", "2026-01-01T08:00:00Z"),
      batch(2, "in", 10, "2026-03-01", "2026-01-02T08:00:00Z"), // أقرب صلاحيةً رغم أنه لاحق
      batch(3, "out", 12, null, "2026-01-03T08:00:00Z"),
    ]);
    const [older, newer] = result.batches.sort((a, b) => a.id - b.id);
    expect(newer.remaining).toBe(0);   // دفعة مارس استُهلكت أولًا (12 = 10 + 2)
    expect(older.remaining).toBe(8);   // وبقيت دفعة يونيو
  });

  it("مجموع بقايا الدفعات زائد التسويات يساوي الرصيد المشتق بالضبط", () => {
    const movements = [
      batch(1, "in", 50, "2026-05-01", "2026-01-01T08:00:00Z"),
      batch(2, "in", 30, "2026-08-01", "2026-01-02T08:00:00Z"),
      batch(3, "out", 44, null, "2026-01-03T08:00:00Z"),
      batch(4, "adjust", -2, null, "2026-01-04T08:00:00Z"),
      batch(5, "in", 20, null, "2026-01-05T08:00:00Z"),
    ];
    const result = batchRemaining(movements);
    const batchesTotal = result.batches.reduce((sum, b) => sum + b.remaining, 0);
    expect(batchesTotal + result.adjustTotal).toBe(deriveBalance(movements));
    expect(result.adjustTotal).toBe(-2);
  });

  it("تسوية موجبة قد تجعل الصرف يتجاوز الإدخال — الصافي يُغطّيه فتبقى المعادلة مكتملة", () => {
    const movements = [
      batch(1, "in", 10, null, "2026-01-01T08:00:00Z"),
      batch(2, "adjust", 5, null, "2026-01-02T08:00:00Z"),
      batch(3, "out", 14, null, "2026-01-03T08:00:00Z"),
    ];
    const result = batchRemaining(movements);
    expect(result.batches[0].remaining).toBe(0);
    // الصرف زاد على الإدخال بأربعة فتغطّيها التسوية: صافيها 5−4=1،
    // ومجموع البقايا (0) زائد الصافي يساوي الرصيد المشتق (1) بالضبط.
    expect(result.adjustTotal).toBe(1);
    expect(result.batches.reduce((s, b) => s + b.remaining, 0) + result.adjustTotal)
      .toBe(deriveBalance(movements));
  });

  it("بلا صلاحية تُرتّب الدفعات بالأقدمية زمنيًا", () => {
    const result = batchRemaining([
      batch(2, "in", 5, null, "2026-01-02T08:00:00Z"),
      batch(1, "in", 5, null, "2026-01-01T08:00:00Z"),
      batch(3, "out", 6, null, "2026-01-03T08:00:00Z"),
    ]);
    expect(result.batches.find((b) => b.id === 1)?.remaining).toBe(0);
    expect(result.batches.find((b) => b.id === 2)?.remaining).toBe(4);
  });
});
