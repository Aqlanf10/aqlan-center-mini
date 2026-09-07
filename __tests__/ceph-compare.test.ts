import { describe, expect, it } from "vitest";
import {
  CHANGE_LABEL, NOISE_FLOOR, chronologicalOrder, compareAnalyses, comparable,
  comparisonSummary, directionOf, type ComparableMeasurement,
} from "../lib/cephCompare";

const measurement = (
  code: string, value: number, mean: number | null,
): ComparableMeasurement => ({ code, name: `قياس ${code}`, unit: "°", value, mean });

describe("المقارنة السيفالومترية — الحكم بالاقتراب من المعيار", () => {
  it("الاقتراب من المعيار تحسّنٌ مهما كان اتجاه الرقم", () => {
    // SNA فوق المعيار تنزل نحوه: تحسّن. والفرق موجب الاتجاه معاكس.
    expect(directionOf(6, 2, -4)).toBe("improved");
    // SNA تحت المعيار تنزل مبتعدة: تراجع — والاتجاه نفسه.
    expect(directionOf(-2, -6, -4)).toBe("worsened");
  });

  it("عبور المتوسط ب الجهتين ليس ثباتًا: الحكم بالمقدار المطلق", () => {
    // +2 ثم −2: عبرت المتوسط بالمقدار نفسه — فرق المسافة صفر → ثبات.
    expect(directionOf(2, -2, -4)).toBe("steady");
  });

  it("ما دون أرضية الضجيج (٠٫٥°) لا يُسمّى تغيّرًا", () => {
    expect(directionOf(3, 3.2, 0.2)).toBe("steady");
    expect(NOISE_FLOOR).toBe(0.5);
  });

  it("بلا معيار لا يُحكم: يُعرض الفرق ويُقال «بلا معيار»", () => {
    expect(directionOf(null, 2, 5)).toBe("ungraded");
    expect(CHANGE_LABEL.ungraded.ar).toContain("بلا معيار");
  });
});

describe("compareAnalyses — لا يُقارَن إلا ما قيس في الاثنتين", () => {
  it("القياس في واحدةٍ وحده يُقال اسمه ولا يُعرض فرقًا", () => {
    const comparison = compareAnalyses(
      [measurement("ANB", 5, 2), measurement("FMA", 30, 25)],
      [measurement("ANB", 3, 2)],
    );
    expect(comparison.measurements).toHaveLength(1);
    expect(comparison.onlyBefore).toEqual(["FMA"]);
    expect(comparison.onlyAfter).toEqual([]);
    expect(comparison.measurements[0]).toMatchObject({ key: "ANB", before: 5, after: 3, delta: -2 });
    expect(comparison.improved).toBe(1);
  });

  it("لا قياس مشترك — جملة الخلاصة تقولها صريحة", () => {
    const comparison = compareAnalyses([measurement("A", 1, 1)], [measurement("B", 2, 1)]);
    expect(comparison.measurements).toHaveLength(0);
    expect(comparisonSummary(comparison).ar).toContain("لا قياسَ مشتركًا");
  });
});

describe("comparable — من نتائج المحرك", () => {
  it("قيمةٌ غير رقمية تُسقط لا تُفسد المقارنة", () => {
    expect(comparable({
      code: "X", ar: "س", en: "X", unit: "mm", value: null,
      display: "—", mean: 5, tol: 2, status: null, severityStars: "",
      interpretationAr: "", interpretationEn: "", group: "sagittal", schools: [],
      source: "test",
    })).toBeNull();
  });
});

describe("chronologicalOrder — ترتيبٌ حاسم لا يتبع من نادى", () => {
  const study = (id: number, takenOn: string | null, createdAt: string) => ({ id, takenOn, createdAt });

  it("الأقدم «قبل» والأحدث «بعد» — ولو نُادِي بالعكس", () => {
    const [before, after] = chronologicalOrder(
      study(2, "2026-09-01", "2026-09-02T10:00:00Z"),
      study(1, "2025-01-01", "2025-01-01T08:00:00Z"),
    );
    expect(before.id).toBe(1);
    expect(after.id).toBe(2);
  });

  it("تاريخ التصوير يتساوى فيُحسم بوقت الإنشاء — لا بترتيب النداء", () => {
    const [before, after] = chronologicalOrder(
      study(9, "2026-01-01", "2026-01-02T09:00:00Z"),
      study(4, "2026-01-01", "2026-01-01T08:00:00Z"),
    );
    expect(before.id).toBe(4);
    expect(after.id).toBe(9);
  });

  it("غائب تاريخ التصوير فيُستخدم تاريخ الإنشاء", () => {
    const [before] = chronologicalOrder(
      study(1, null, "2026-05-05T00:00:00Z"),
      study(2, "2026-06-06", "2026-06-06T00:00:00Z"),
    );
    expect(before.id).toBe(1);
  });
});
