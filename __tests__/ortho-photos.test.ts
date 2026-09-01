import { describe, expect, it } from "vitest";
import {
  FULL_SET_VIEWS, PHOTO_VIEWS, buildComparison, fullPhotoSetCheck, isPhotoStage,
  isPhotoView, suggestPhotoStage, type PhotoView, type StagePhoto,
} from "../lib/ortho-photos";

describe("أدوار الصور ووجهاتها", () => {
  it("المجموعة الكاملة ثماني الوجوه، والقائمة مغلقة", () => {
    expect(FULL_SET_VIEWS).toHaveLength(8);
    expect(new Set(FULL_SET_VIEWS).size).toBe(8);
    for (const view of FULL_SET_VIEWS) expect(isPhotoView(view)).toBe(true);
    expect(isPhotoView("selfie")).toBe(false);
    expect(isPhotoStage("initial")).toBe(true);
    expect(isPhotoStage("عام")).toBe(false);
  });

  it("أول جلسة توثيقٍ تُقترح بدايةً، والتثبيت يُقترح تثبيتًا، وسواها متابعة", () => {
    expect(suggestPhotoStage({
      date: "2026-09-01", startDate: "2026-09-01", phase: "aligning",
      isFirstSession: true,
    })).toBe("initial");

    expect(suggestPhotoStage({
      date: "2026-09-01", startDate: "2025-01-01", phase: "retention",
      isFirstSession: false,
    })).toBe("retention");

    expect(suggestPhotoStage({
      date: "2026-09-01", startDate: "2025-01-01", phase: "working",
      isFirstSession: false,
    })).toBe("progress");
  });
});

describe("نقاط المجموعة الكاملة", () => {
  const base = {
    sessionDate: "2026-09-01",
    startDate: "2026-09-01",
    lastFullSetDate: null as string | null,
    intervalMonths: 6,
    phase: "aligning" as const,
    capturedViews: [] as PhotoView[],
  };

  it("أول توثيقٍ بلا مجموعةٍ سابقة يطلب المجموعة كاملة", () => {
    const check = fullPhotoSetCheck({
      ...base,
      capturedViews: ["extraoral_frontal"],
    });
    expect(check.required).toBe(true);
    expect(check.missingViews).toHaveLength(7);
  });

  it("فترة الميثاق الماضية تُعيد الطلب — والنقص يُقال بالاسم", () => {
    const check = fullPhotoSetCheck({
      ...base,
      startDate: "2026-01-01",
      lastFullSetDate: "2026-01-01",
      sessionDate: "2026-08-01",
      capturedViews: PHOTO_VIEWS,
    });
    expect(check.required).toBe(true);
    expect(check.missingViews).toHaveLength(0);
    expect(check.reason).toContain("شهرًا");
  });

  it("داخل الفترة ومرحلة التسوية: لا إجبار — التصوير السريع حرّ", () => {
    const check = fullPhotoSetCheck({
      ...base,
      startDate: "2026-08-01",
      lastFullSetDate: "2026-08-01",
      sessionDate: "2026-09-01",
      phase: "aligning",
      capturedViews: [],
    });
    expect(check.required).toBe(false);
    expect(check.reason).toBeNull();
  });

  it("مرحلة الإنهاء والتثبيت تطلبان المجموعة", () => {
    expect(fullPhotoSetCheck({
      ...base,
      startDate: "2026-08-01",
      lastFullSetDate: "2026-08-01",
      sessionDate: "2026-09-01",
      phase: "finishing",
    }).required).toBe(true);
    expect(fullPhotoSetCheck({
      ...base,
      startDate: "2026-08-01",
      lastFullSetDate: "2026-08-01",
      sessionDate: "2026-09-01",
      phase: "retention",
    }).required).toBe(true);
  });
});

describe("مقارنة Before / Progress / After", () => {
  const photo = (id: number, stage: StagePhoto["stage"], view: StagePhoto["view"], takenOn: string): StagePhoto => ({
    id, stage, view, takenOn, uploadedAt: `${takenOn}T10:00:00Z`,
  });

  it("كل دورٍ يُمثَّل بصورةٍ واحدة، والأمامية الداخلية أولى المرشّحين", () => {
    const columns = buildComparison([
      photo(1, "initial", "upper_occlusal", "2026-07-01"),
      photo(2, "initial", "intraoral_frontal", "2026-07-01"),
      photo(3, "progress", "intraoral_right", "2026-09-01"),
      photo(4, "progress", "intraoral_frontal", "2026-09-01"),
      photo(5, "debond", "intraoral_frontal", "2027-07-01"),
    ]);
    const initial = columns.find((column) => column.stage === "initial");
    const progress = columns.find((column) => column.stage === "progress");
    const debond = columns.find((column) => column.stage === "debond");
    const retention = columns.find((column) => column.stage === "retention");

    expect(initial?.featured?.id).toBe(2); // الأمامية الداخلية لا القوام
    expect(progress?.featured?.id).toBe(4);
    expect(debond?.featured?.id).toBe(5);
    expect(retention?.featured).toBeNull(); // الدور الفارغ عمودٌ فارغ لا خطأ
    expect(initial?.count).toBe(2);
  });

  it("بدايةٌ بأكثر من صورةٍ يُمثّلها الأقدم — والمراحل اللاحقة الأحدث", () => {
    const columns = buildComparison([
      photo(10, "initial", "intraoral_frontal", "2026-01-01"),
      photo(11, "initial", "intraoral_frontal", "2026-02-01"),
      photo(12, "progress", "intraoral_frontal", "2026-05-01"),
      photo(13, "progress", "intraoral_frontal", "2026-06-01"),
    ]);
    const initial = columns.find((column) => column.stage === "initial");
    const progress = columns.find((column) => column.stage === "progress");
    expect(initial?.featured?.id).toBe(10); // البداية: الأقدم
    expect(progress?.featured?.id).toBe(13); // التقدّم: الأحدث
  });
});
