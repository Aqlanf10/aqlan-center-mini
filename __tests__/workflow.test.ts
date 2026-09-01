import { describe, expect, it } from "vitest";
import {
  BILLING_RULE_LABEL,
  DEFAULT_SESSION_COUNT,
  filterTimeline,
  itemStatusFromSessions,
  labWorkForCategory,
  needsLabOrder,
  nextOpenSession,
  nextStep,
  normalizeSessionCount,
  plannedVisitTitle,
  priceForSession,
  sessionAmounts,
  sessionPriceNote,
  sortTimeline,
  suggestVisitMinutes,
  timelineGroupOf,
  treatmentFinancialSeparation,
  TIMELINE_GROUP_LABEL,
  TIMELINE_KIND_LABEL,
  type SessionStatus,
  type TimelineEvent,
  type TimelineGroup,
  type TimelineKind,
} from "../lib/workflow";

/**
 * رحلة المريض V2 — المنطق الخالص.
 *
 * هذه ليست تفاصيل تجميلية: قاعدة الفوترة تحدد **متى يصبح مال المريض مستحقًا**،
 * وفصل «باقي العلاج» عن «المديونية» يحدد **من يظهر في قائمة المتأخرين** — وخطأ
 * واحدًا فيهما يجعل رقمًا يُجادَل عليه أو يُطالَب به من لا عليه شيء.
 */

describe("قواعد الفوترة — مبالغ الجلسات", () => {
  it("عند البدء: كامل المبلغ في الجلسة الأولى ثم صفر", () => {
    expect(sessionAmounts("on_start", 30000, 3)).toEqual([30000, 0, 0]);
  });

  it("عند الإكمال: صفر حتى الجلسة الأخيرة ثم كامل المبلغ", () => {
    expect(sessionAmounts("on_completion", 30000, 3)).toEqual([0, 0, 30000]);
  });

  it("لكل جلسة: توزيع متساوٍ لا يُضيع وحدة صغرى", () => {
    expect(sessionAmounts("per_session", 30000, 3)).toEqual([10000, 10000, 10000]);
    // 100 على 3 جلسات: 33 + 33 + 34 — الفرق على الأخيرة (لحظة الإكمال).
    expect(sessionAmounts("per_session", 100, 3)).toEqual([33, 33, 34]);
  });

  it("مجموع الجلسات يساوي إجمالي البند دائمًا — وإلا صار الاتفاق رقمًا ثالثًا", () => {
    for (const rule of ["on_start", "on_completion", "per_session"] as const) {
      for (const count of [1, 2, 3, 5, 7]) {
        const total = rule === "per_session" ? 100001 : 50000;
        expect(sessionAmounts(rule, total, count).reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it("الجلسة الزائدة عن العدّد تعود صفرًا — حماية من جلسةٍ خامسة لعصبٍ ثلاث جلسات", () => {
    expect(priceForSession("per_session", 30000, 3, 4)).toBe(0);
    expect(priceForSession("per_session", 30000, 3, 0)).toBe(0);
  });

  it("بندٌ بجلسةٍ واحدة: كل القواعد تُسعَّره كاملًا في جلسته", () => {
    expect(priceForSession("on_start", 25000, 1, 1)).toBe(25000);
    expect(priceForSession("on_completion", 25000, 1, 1)).toBe(25000);
    expect(priceForSession("per_session", 25000, 1, 1)).toBe(25000);
  });
});

describe("شرح السعر — الصفر بلا تفسير يبدو خطأً فيُكتب فوقه", () => {
  it("جلسة البدء تُفسَّر بأن البند يُفوتر كاملًا", () => {
    expect(sessionPriceNote("on_start", 1, 3)).toContain("كاملًا عند بدئه");
  });

  it("جلسة العمل الوسيطة تُفسَّر بأنها بلا فوترة جديدة", () => {
    const note = sessionPriceNote("on_completion", 2, 3);
    expect(note).toContain("جلسة 2 من 3");
    expect(note).toContain("بلا فوترة");
  });
});

describe("حالات البند من جلساته", () => {
  const sessions = (statuses: SessionStatus[]) => statuses.map((status) => ({ sequence: 1, status }));

  it("بلا جلسات منجزة: مخطَّط", () => {
    expect(itemStatusFromSessions(sessions(["planned", "planned"]))).toBe("planned");
  });

  it("بعض الجلسات منجزة: قيد التنفيذ", () => {
    expect(itemStatusFromSessions(sessions(["done", "planned"]))).toBe("in_progress");
  });

  it("كل الجلسات منجزة: مكتمل", () => {
    expect(itemStatusFromSessions(sessions(["done", "done"]))).toBe("done");
  });

  it("المتخطَّاة لا تُحسب حيّة — والملغى يبقى ملغى", () => {
    expect(itemStatusFromSessions(sessions(["done", "skipped"]))).toBe("done");
    expect(itemStatusFromSessions(sessions(["done", "planned"]), true)).toBe("cancelled");
  });

  it("أول جلسة مفتوحة بالترتيب — «ماذا نعمل في الجلسة القادمة؟»", () => {
    const open = nextOpenSession([
      { sequence: 3, status: "planned" },
      { sequence: 1, status: "done" },
      { sequence: 2, status: "planned" },
    ]);
    expect(open?.sequence).toBe(2);
  });
});

describe("أعداد الجلسات — حدود منطقية", () => {
  it("تُطبَّع إلى مجال 1..12", () => {
    expect(normalizeSessionCount(0)).toBe(DEFAULT_SESSION_COUNT);
    expect(normalizeSessionCount(-4)).toBe(1);
    expect(normalizeSessionCount(2.7)).toBe(3);
    expect(normalizeSessionCount(99)).toBe(12);
    expect(normalizeSessionCount("not-a-number")).toBe(1);
  });
});

describe("عنوان الزيارة المخطَّطة", () => {
  it("بندٌ متعدد الجلسات: «RCT 11 — جلسة 2»", () => {
    expect(plannedVisitTitle([
      { serviceName: "RCT", toothCode: 11, sessionIndex: 2, sessionCount: 3 },
    ])).toBe("RCT 11 — جلسة 2");
  });

  it("بندٌ بجلسةٍ واحدة لا يذكر الجلسة", () => {
    expect(plannedVisitTitle([
      { serviceName: "كشف", toothCode: null, sessionIndex: 1, sessionCount: 1 },
    ])).toBe("كشف");
  });

  it("بنودٌ متعددة: الأول + عدّد الباقي", () => {
    expect(plannedVisitTitle([
      { serviceName: "RCT", toothCode: 11, sessionIndex: 2, sessionCount: 3 },
      { serviceName: "حشوة", toothCode: 14, sessionIndex: 1, sessionCount: 1 },
    ])).toBe("RCT 11 — جلسة 2 + 1 أخرى");
  });

  it("الفراغ: متابعة — لا عنوان فارغ", () => {
    expect(plannedVisitTitle([])).toBe("زيارة متابعة");
  });
});

describe("مدة الزيارة المقترحة", () => {
  it("مجموع مدد الجلسات، والفراغ 30 دقيقة", () => {
    expect(suggestVisitMinutes([])).toBe(30);
    expect(suggestVisitMinutes([
      { plannedDuration: 30 }, { plannedDuration: 20 }, { plannedDuration: null },
    ])).toBe(80);
  });
});

describe("فصل العلاج عن المديونية — الأرقام الستة (§٢٤)", () => {
  it("المديونية من الدفتر وحده لا من قيمة الخطة", () => {
    const separation = treatmentFinancialSeparation({
      livePlans: [{ totalMinor: 105000, itemsDoneMinor: 40000 }],
      invoicedMinor: 40000,
      paidMinor: 25000,
      openingMinor: 0,
    });
    // المتفق 105000، أُنجز 40000، بقي علاج 65000 (عملٌ لا دَين).
    expect(separation.agreedMinor).toBe(105000);
    expect(separation.treatmentDoneMinor).toBe(40000);
    expect(separation.remainingTreatmentMinor).toBe(65000);
    // المديونية = فوتر − دفع = 15000 — لا 80000.
    expect(separation.debtMinor).toBe(15000);
  });

  it("من وافق على خطةٍ لم تبدأ ليس مدينًا", () => {
    const separation = treatmentFinancialSeparation({
      livePlans: [{ totalMinor: 1000000, itemsDoneMinor: 0 }],
      invoicedMinor: 0,
      paidMinor: 0,
      openingMinor: 0,
    });
    expect(separation.remainingTreatmentMinor).toBe(1000000);
    expect(separation.debtMinor).toBe(0);
  });

  it("الرصيد الافتتاحي دَينٌ قديم لا إيراد اليوم", () => {
    const separation = treatmentFinancialSeparation({
      livePlans: [],
      invoicedMinor: 0,
      paidMinor: 0,
      openingMinor: 50000,
    });
    expect(separation.debtMinor).toBe(50000);
    expect(separation.remainingTreatmentMinor).toBe(0);
  });
});

describe("محرك «ماذا الآن؟» — الخطوة التالية", () => {
  it("الزيارة القائمة أولًا: مريضٌ على الكرسي الآن", () => {
    const step = nextStep({
      openVisit: { id: 7 },
      todayAppointment: { id: 3 },
      debtMinor: 5000,
      unscheduledPlannedVisit: { id: 9 },
      activePlan: { id: 1 },
    });
    expect(step.kind).toBe("continue_visit");
    expect(step.targetId).toBe(7);
  });

  it("موعد اليوم يسبق التحصيل والجدولة", () => {
    const step = nextStep({
      openVisit: null,
      todayAppointment: { id: 3 },
      debtMinor: 5000,
      unscheduledPlannedVisit: { id: 9 },
      activePlan: { id: 1 },
    });
    expect(step.kind).toBe("start_today_visit");
  });

  it("الدَّين يُقبض قبل حجز الجلسة التالية", () => {
    expect(nextStep({
      openVisit: null, todayAppointment: null,
      debtMinor: 5000, unscheduledPlannedVisit: { id: 9 }, activePlan: { id: 1 },
    }).kind).toBe("collect_payment");
  });

  it("لا دَين: جدولة الجلسة غير المجدولة", () => {
    expect(nextStep({
      openVisit: null, todayAppointment: null,
      debtMinor: 0, unscheduledPlannedVisit: { id: 9 }, activePlan: { id: 1 },
    }).kind).toBe("schedule_next_visit");
  });

  it("من لا يملك رؤية المال (debtMinor = null) لا يُوجَّه للتحصيل", () => {
    expect(nextStep({
      openVisit: null, todayAppointment: null,
      debtMinor: null, unscheduledPlannedVisit: { id: 9 }, activePlan: { id: 1 },
    }).kind).toBe("schedule_next_visit");
  });

  it("لا خطة ولا شيء: إنشاء خطة", () => {
    expect(nextStep({
      openVisit: null, todayAppointment: null,
      debtMinor: 0, unscheduledPlannedVisit: null, activePlan: null,
    }).kind).toBe("create_plan");
  });
});

describe("تسميات القواعد — عربية كاملة", () => {
  it("القواعد الثلاث مسمّاة", () => {
    expect(BILLING_RULE_LABEL.on_start).toBe("عند البدء");
    expect(BILLING_RULE_LABEL.on_completion).toBe("عند الإكمال");
    expect(BILLING_RULE_LABEL.per_session).toBe("لكل جلسة");
  });
});

describe("طلب المختبر من الإجراء (§١٩) — الفئة تحدد العمل", () => {
  it("التاج والجسر والقشرة أعمال مختبر بمعمّى عربي موحّد", () => {
    expect(labWorkForCategory("crown")).toBe("تاج");
    expect(labWorkForCategory("bridge")).toBe("جسر");
    expect(labWorkForCategory("veneer")).toBe("قشرة (فينير)");
  });

  it("ما سواها لا يولّد طلب مختبر — الحشوة والعصب والخلع أعمال كرسي", () => {
    expect(needsLabOrder("filling")).toBe(false);
    expect(needsLabOrder("rct")).toBe(false);
    expect(needsLabOrder("extraction")).toBe(false);
    expect(needsLabOrder(null)).toBe(false);
    // الربط بالفئة لا بالاسم: فئةٌ مجهولة التسنين لا تخترع عملًا للمختبر.
    expect(needsLabOrder("massage")).toBe(false);
  });
});

describe("الخط الزمني الموحَّد (§٢٩-٣٠) — فرز وفلترة", () => {
  const events: TimelineEvent[] = [
    { key: "visit:1", kind: "visit", at: "2026-09-01T10:00:00.000Z", title: "زيارة", detail: null, amountMinor: null, currency: null, href: null },
    { key: "payment:2", kind: "payment", at: "2026-09-01T12:30:00.000Z", title: "دفعة", detail: null, amountMinor: 5000, currency: "YER", href: null },
    { key: "invoice:3", kind: "invoice", at: "2026-08-20T09:00:00.000Z", title: "فاتورة", detail: null, amountMinor: 30000, currency: null, href: null },
    { key: "lab:4", kind: "lab", at: "2026-08-25T08:00:00.000Z", title: "طلب مختبر", detail: null, amountMinor: null, currency: null, href: null },
  ];

  it("الأحدث أولًا — أول سطرٍ في الخط هو آخر ما حدث", () => {
    const sorted = sortTimeline(events);
    expect(sorted[0].key).toBe("payment:2");
    expect(sorted[1].key).toBe("visit:1");
    expect(sorted[sorted.length - 1].key).toBe("invoice:3");
  });

  it("الفرز لا يغيّر المصفوفة الأصلية — الخط يُبنى لا يُقلَب في مكانه", () => {
    const original = [...events];
    sortTimeline(events);
    expect(events).toEqual(original);
  });

  it("فلترة المالي تجيب «تاريخ ماله» من المصدرين معًا", () => {
    const financial = filterTimeline(sortTimeline(events), "financial");
    expect(financial.map((event) => event.kind)).toEqual(["payment", "invoice"]);
  });

  it("فلترة المختبر والأحداث السريرية والكل", () => {
    expect(filterTimeline(events, "lab")).toHaveLength(1);
    expect(filterTimeline(events, "clinical")).toHaveLength(1);
    expect(filterTimeline(events, "all")).toHaveLength(4);
    expect(filterTimeline(events, "files")).toHaveLength(0);
  });

  it("كل نوعٍ يعرف مجموعته — والتسمية موجودة لكل نوع وكل مجموعة", () => {
    for (const kind of Object.keys(TIMELINE_KIND_LABEL) as TimelineKind[]) {
      expect(TIMELINE_KIND_LABEL[kind].length).toBeGreaterThan(0);
      expect(timelineGroupOf(kind)).toBeTruthy();
    }
    for (const group of Object.keys(TIMELINE_GROUP_LABEL) as TimelineGroup[]) {
      expect(TIMELINE_GROUP_LABEL[group].length).toBeGreaterThan(0);
    }
  });
});
