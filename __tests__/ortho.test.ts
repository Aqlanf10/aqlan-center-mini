import { describe, expect, it } from "vitest";
import {
  canComplete,
  caseProgress,
  daysBetween,
  findWire,
  isElasticClass,
  isOverdueForAdjustment,
  nextAdjustmentDate,
  nextWire,
  usesArchwires,
  wiresFor,
  suggestCephPhase,
  CEPH_DIAGNOSTIC_STAGES,
} from "../lib/ortho";

describe("الأسلاك", () => {
  it("التسلسل يمشي من الأمرن إلى الأصلب", () => {
    const wires = wiresFor("022");
    expect(wires[0].code).toBe("012 NiTi");
    expect(wires[0].round).toBe(true);
    // آخر السلسلة مستطيل — والمستدير لا يتحكّم في ميل الجذور.
    expect(wires[wires.length - 1].round).toBe(false);
    // الفولاذي لا يسبق المرن.
    const firstSteel = wires.findIndex((wire) => wire.material === "SS");
    const lastNiTi = wires.map((wire) => wire.material).lastIndexOf("NiTi");
    expect(firstSteel).toBeGreaterThan(0);
    expect(firstSteel).toBeGreaterThan(wires.findIndex((wire) => wire.material === "NiTi"));
    expect(lastNiTi).toBeLessThan(wires.length);
  });

  it("يقترح التالي، ويقف عند آخر السلسلة", () => {
    expect(nextWire("022", null)?.code).toBe("012 NiTi");
    expect(nextWire("022", "014 NiTi")?.code).toBe("016 NiTi");
    const wires = wiresFor("022");
    expect(nextWire("022", wires[wires.length - 1].code)).toBeNull();
  });

  it("سلكٌ خارج التسلسل لا يُقترح له تالٍ — القرار للطبيب", () => {
    expect(nextWire("022", "سلك خاص")).toBeNull();
    expect(findWire("022", "سلك خاص")).toBeNull();
    expect(findWire("022", "019×025 SS")?.material).toBe("SS");
  });

  it("الشقّان مختلفان", () => {
    expect(wiresFor("018").some((wire) => wire.code === "019×025 SS")).toBe(false);
    expect(wiresFor("022").some((wire) => wire.code === "019×025 SS")).toBe(true);
  });

  it("الأسلاك للثابت وحده", () => {
    expect(usesArchwires("fixed_metal")).toBe(true);
    expect(usesArchwires("fixed_ceramic")).toBe(true);
    expect(usesArchwires("aligners")).toBe(false);
    expect(usesArchwires("removable")).toBe(false);
  });
});

describe("التقدّم", () => {
  it("يحسب ما مضى وما بقي", () => {
    const progress = caseProgress({
      startDate: "2026-01-01", plannedMonths: 18, adjustments: 6,
      lastAdjustmentDate: "2026-06-01", today: "2026-07-01",
    });
    expect(progress.monthsElapsed).toBeCloseTo(6, 0);
    expect(progress.monthsRemaining).toBeCloseTo(12, 0);
    expect(progress.overdue).toBe(false);
    expect(progress.daysSinceLast).toBe(30);
  });

  it("يعلّم تجاوز المدة بلا أن يعتبره خطأ", () => {
    const progress = caseProgress({
      startDate: "2024-01-01", plannedMonths: 18, adjustments: 20,
      lastAdjustmentDate: null, today: "2026-07-01",
    });
    expect(progress.overdue).toBe(true);
    expect(progress.monthsRemaining).toBe(0);
    expect(progress.percent).toBe(100);
    expect(progress.daysSinceLast).toBeNull();
  });

  it("فرق الأيام بلا انزياح منطقة زمنية", () => {
    expect(daysBetween("2026-08-28", "2026-08-29")).toBe(1);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetween("2026-03-01", "2026-02-28")).toBe(-1);
  });
});

describe("موعد الشدّ", () => {
  it("أربعة أسابيع افتراضًا", () => {
    expect(nextAdjustmentDate("2026-08-01")).toBe("2026-08-29");
    expect(nextAdjustmentDate("2026-08-01", 6)).toBe("2026-09-12");
  });

  it("التأخّر يُحسب من آخر شدّ، ومن البداية إن لم يكن هناك شدّ", () => {
    // آخر شدّ ١ أغسطس، فالموعد ٢٩ أغسطس. ومهلةُ أسبوعٍ بعده قبل أن يُعدّ متأخرًا:
    // مريضٌ تأخّر ثلاثة أيام ليس منقطعًا، وتنبيهٌ عليه يجعل القائمة تُتجاهل.
    expect(isOverdueForAdjustment({
      lastAdjustmentDate: "2026-08-01", startDate: "2026-01-01", today: "2026-09-01",
    })).toBe(false);
    expect(isOverdueForAdjustment({
      lastAdjustmentDate: "2026-08-01", startDate: "2026-01-01", today: "2026-09-10",
    })).toBe(true);
    // بلا شدٍّ بعدُ: يُحسب من تاريخ التركيب.
    expect(isOverdueForAdjustment({
      lastAdjustmentDate: null, startDate: "2026-08-25", today: "2026-09-01",
    })).toBe(false);
    expect(isOverdueForAdjustment({
      lastAdjustmentDate: null, startDate: "2026-06-01", today: "2026-09-01",
    })).toBe(true);
  });
});

describe("الإغلاق", () => {
  it("لا إغلاق بلا مثبّت — الارتداد يُضيع النتيجة", () => {
    const blocked = canComplete({ status: "active", retainer: null });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.message).toContain("المثبّت");
  });

  it("و«لم يُسلَّم» قرارٌ صريح يُقبل", () => {
    expect(canComplete({ status: "active", retainer: "none" }).ok).toBe(true);
    expect(canComplete({ status: "retention", retainer: "bonded" }).ok).toBe(true);
  });

  it("ولا إغلاق لمكتملة أو متوقّفة", () => {
    expect(canComplete({ status: "completed", retainer: "hawley" }).ok).toBe(false);
    expect(canComplete({ status: "discontinued", retainer: "hawley" }).ok).toBe(false);
  });

  it("صنف المطاطات قائمة مغلقة", () => {
    expect(isElasticClass("class_ii")).toBe(true);
    expect(isElasticClass("صنف ثانٍ")).toBe(false);
  });
});

describe("السيفالومتري ومراحل التشخيص التقويمي T1-T4", () => {
  it("يقترح T1 قبل العلاج للحالات الجديدة أو بدون شدّات", () => {
    expect(suggestCephPhase(null, 0)).toBe("pretreatment");
    expect(suggestCephPhase("aligning", 0)).toBe("pretreatment");
  });

  it("يقترح T2 أثناء التقدم لمرحلتي التسوية والمرحلة العاملة", () => {
    expect(suggestCephPhase("aligning", 2)).toBe("during");
    expect(suggestCephPhase("working", 5)).toBe("during");
  });

  it("يقترح T3 بعد انتهاء العلاج لمرحلة الإنهاء", () => {
    expect(suggestCephPhase("finishing", 12)).toBe("posttreatment");
  });

  it("يقترح T4 للمتابعة والتثبيت لمرحلة الاستبقاء", () => {
    expect(suggestCephPhase("retention", 16)).toBe("followup");
  });

  it("المراحل الأربعة معرّفة برموزها السريرية T1 إلى T4", () => {
    expect(CEPH_DIAGNOSTIC_STAGES.pretreatment.tCode).toBe("T1");
    expect(CEPH_DIAGNOSTIC_STAGES.during.tCode).toBe("T2");
    expect(CEPH_DIAGNOSTIC_STAGES.posttreatment.tCode).toBe("T3");
    expect(CEPH_DIAGNOSTIC_STAGES.followup.tCode).toBe("T4");
  });
});

