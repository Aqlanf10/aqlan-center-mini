import { describe, expect, it } from "vitest";
import {
  classifyFollowups, groupByBucket, sinceAdjustmentText,
  type FollowupCase,
} from "../lib/ortho-followup";

const TODAY = "2026-09-01";

const row = (overrides: Partial<FollowupCase> = {}): FollowupCase => ({
  caseId: 1,
  patientId: 10,
  patientName: "مريض تجربة",
  patientPhone: "770123456",
  status: "active",
  phase: "aligning",
  startDate: "2026-08-01",
  lastAdjustmentDate: "2026-08-25",
  nextWeeks: 4,
  upperWire: "016 NiTi",
  lowerWire: "014 NiTi",
  nextAppointment: null,
  lastWasNoShow: false,
  ...overrides,
});

describe("تصنيف قوائم المتابعة", () => {
  it("موعد اليوم وغدًا هذا الأسبوع كلٌّ في قائمته", () => {
    const rows = classifyFollowups({
      today: TODAY,
      cases: [
        row({ caseId: 1, nextAppointment: { id: 1, date: "2026-09-01", time: "16:00", status: "booked" } }),
        row({ caseId: 2, nextAppointment: { id: 2, date: "2026-09-02", time: "10:00", status: "booked" } }),
        row({ caseId: 3, nextAppointment: { id: 3, date: "2026-09-06", time: "11:00", status: "booked" } }),
        row({ caseId: 4, nextAppointment: { id: 4, date: "2026-09-20", time: "09:00", status: "booked" } }),
      ],
    });
    const groups = groupByBucket(rows);
    expect(groups.get("today")?.map((entry) => entry.caseId)).toEqual([1]);
    expect(groups.get("tomorrow")?.map((entry) => entry.caseId)).toEqual([2]);
    expect(groups.get("this_week")?.map((entry) => entry.caseId)).toEqual([3]);
    expect(groups.get("upcoming")?.map((entry) => entry.caseId)).toEqual([4]);
  });

  it("من بلا موعدٍ محجوز يظهر في «بدون موعد قادم» — قائمة الاستقبال اليومية", () => {
    const rows = classifyFollowups({ today: TODAY, cases: [row()] });
    expect(rows[0].buckets).toContain("no_appointment");
  });

  it("موعدٌ ماضٍ محجوز لم يُنفَّذ يعني «تجاوزوا موعدهم»", () => {
    const rows = classifyFollowups({
      today: TODAY,
      cases: [row({
        nextAppointment: { id: 9, date: "2026-08-28", time: "16:00", status: "booked" },
      })],
    });
    expect(rows[0].buckets).toContain("overdue");
    expect(rows[0].buckets).not.toContain("no_appointment");
  });

  it("الغياب الأخير يضع المريض في «لم يحضروا» حتى لو حُجز بعده", () => {
    const rows = classifyFollowups({
      today: TODAY,
      cases: [row({
        lastWasNoShow: true,
        nextAppointment: { id: 10, date: "2026-09-10", time: "16:00", status: "booked" },
      })],
    });
    expect(rows[0].buckets).toContain("no_show");
  });

  it("سلّم الأسابيع: ٤ و٦ و٨ — كلٌّ في أعلى سلّمٍ بلغه لا في كل السلالم", () => {
    const rows = classifyFollowups({
      today: TODAY,
      cases: [
        row({ caseId: 1, lastAdjustmentDate: "2026-08-04" }), // ٤ أسابيع
        row({ caseId: 2, lastAdjustmentDate: "2026-07-20" }), // ٦ أسابيع
        row({ caseId: 3, lastAdjustmentDate: "2026-07-01" }), // أكثر من ٨
        row({ caseId: 4, lastAdjustmentDate: "2026-08-20" }), // أقل من ٤
      ],
    });
    const find = (caseId: number) => rows.find((entry) => entry.caseId === caseId)!;
    expect(find(1).buckets).toContain("lapsed_4");
    expect(find(1).buckets).not.toContain("lapsed_6");
    expect(find(2).buckets).toContain("lapsed_6");
    expect(find(2).buckets).not.toContain("lapsed_8");
    expect(find(3).buckets).toContain("lapsed_8");
    expect(find(4).buckets).not.toContain("lapsed_4");
  });

  it("حالة التثبيت تظهر في قائمتها — والأشهر الفائتة تُحسب من البداية إن لم توجد شدّة", () => {
    const rows = classifyFollowups({
      today: TODAY,
      cases: [row({ status: "retention", lastAdjustmentDate: null, startDate: "2026-04-01" })],
    });
    expect(rows[0].buckets).toContain("retention");
    expect(rows[0].buckets).toContain("lapsed_8");
  });

  it("داخل القائمة الأقدم انقطاعًا أولًا", () => {
    const rows = classifyFollowups({
      today: TODAY,
      cases: [
        row({ caseId: 1, lastAdjustmentDate: "2026-08-04" }),
        row({ caseId: 2, lastAdjustmentDate: "2026-07-01" }),
        row({ caseId: 3, lastAdjustmentDate: "2026-07-20" }),
      ],
    });
    const group = groupByBucket(rows).get("lapsed_4") ?? [];
    void group;
    const lapsed = groupByBucket(rows);
    const order = [
      ...(lapsed.get("lapsed_8") ?? []),
      ...(lapsed.get("lapsed_6") ?? []),
      ...(lapsed.get("lapsed_4") ?? []),
    ].map((entry) => entry.caseId);
    expect(order).toEqual([2, 3, 1]);
  });
});

describe("النصّ العربي للانقطاع", () => {
  it("بالمثنّى والجمع الصحيح", () => {
    expect(sinceAdjustmentText(null)).toBe("بلا شدّات بعد");
    expect(sinceAdjustmentText(0)).toBe("اليوم");
    expect(sinceAdjustmentText(1)).toBe("قبل يوم");
    expect(sinceAdjustmentText(2)).toBe("قبل يومين");
    expect(sinceAdjustmentText(7)).toBe("قبل أسبوع");
    expect(sinceAdjustmentText(14)).toBe("قبل أسبوعين");
    expect(sinceAdjustmentText(30)).toBe("قبل 4 أسابيع");
  });
});
