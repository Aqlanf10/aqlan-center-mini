import { describe, expect, it } from "vitest";
import {
  configuredShiftCount, describeMatch, explainMatch, isoWeekday, matchesSlot,
  normalizeWeekdays, rankCandidates, shiftOfTime,
  type ContactEvent, type FreedSlot, type MatchContext, type WaitingEntry,
} from "@/lib/waiting-list";

/**
 * تصحيحاتُ المرحلة ٥ — كلُّ فحصٍ هنا يقابل عطبًا وجده المالك في المراجعة.
 *
 * وهي مكتوبةٌ بالصيغة التي تُفشِل الشيفرةَ القديمة: لو أُعيد أيٌّ من العيوب
 * سقط فحصُه بعينه، لا فحصٌ عامٌّ يصعب ردُّه إلى سببه.
 */

const SHIFTS = [
  { start: "09:00", end: "13:00" },
  { start: "16:00", end: "21:00" },
];

const context = (over: Partial<MatchContext> = {}): MatchContext => ({
  shifts: SHIFTS,
  clinicToday: "2026-03-10", // ثلاثاء
  ...over,
});

const entry = (over: Partial<WaitingEntry> = {}): WaitingEntry => ({
  id: 1,
  patientId: 7,
  serviceId: null,
  doctorId: null,
  earliestDate: null,
  latestDate: null,
  preferredPeriod: "any",
  preferredShift: "any",
  preferredDays: [],
  sameDayAvailable: true,
  urgency: "normal",
  durationMinutes: null,
  note: null,
  status: "waiting",
  offeredAt: null,
  offeredBy: null,
  appointmentId: null,
  resolvedAt: null,
  resolvedBy: null,
  resolutionReason: null,
  createdAt: "2026-03-01T08:00:00.000Z",
  createdBy: "الاستقبال",
  ...over,
});

const slot = (over: Partial<FreedSlot> = {}): FreedSlot => ({
  date: "2026-03-12", // خميس
  time: "10:00",
  durationMinutes: 30,
  serviceId: null,
  doctorId: null,
  ...over,
});

const event = (over: Partial<ContactEvent> = {}): ContactEvent => ({
  id: "1",
  waitingListId: 1,
  contactedAt: "2026-03-09T10:00:00.000Z",
  contactedBy: "الاستقبال",
  contactedByRole: "reception",
  channel: "phone",
  outcome: "no_answer",
  note: null,
  slotDate: null,
  slotTime: null,
  appointmentId: null,
  ...over,
});

describe("ترقيم أيام الأسبوع", () => {
  it("يعطي ترقيم ISO — الاثنين ١ والأحد ٧", () => {
    expect(isoWeekday("2026-03-09")).toBe(1); // اثنين
    expect(isoWeekday("2026-03-15")).toBe(7); // أحد
  });

  it("تاريخٌ غير مقروء يعيد null ولا يُسقط فرضًا", () => {
    expect(isoWeekday("ليس تاريخًا")).toBeNull();
  });

  /* إسقاطُ القيمة الخاطئة صامتةً يحفظ تفضيلًا غير الذي كتبه الموظّف، ثم يُنادى
     المريض في يومٍ لا يأتي فيه ولا أحد يعرف لماذا. */
  it("قيمةٌ خارج ١..٧ تُرفض كلُّها ولا تُسقَط وحدها", () => {
    expect(normalizeWeekdays([1, 9])).toBeNull();
    expect(normalizeWeekdays([1, 3, 3])).toEqual([1, 3]);
    expect(normalizeWeekdays([])).toEqual([]);
    expect(normalizeWeekdays("الاثنين")).toBeNull();
  });
});

describe("الأيام المفضّلة تُحترم", () => {
  it("مريضٌ يقبل الاثنين والأربعاء لا يُرشَّح لمكانٍ يوم الخميس", () => {
    expect(matchesSlot(entry({ preferredDays: [1, 3] }), slot(), context())).toBe(false);
  });

  it("والمكانُ في يومٍ مفضّل يُرشَّح", () => {
    expect(
      matchesSlot(entry({ preferredDays: [4] }), slot({ date: "2026-03-12" }), context()),
    ).toBe(true);
  });

  it("بلا تحديدٍ يصلح أيُّ يوم", () => {
    expect(matchesSlot(entry({ preferredDays: [] }), slot(), context())).toBe(true);
  });
});

describe("إتاحة اليوم نفسه", () => {
  it("من لا يقبل اليوم نفسه لا يُرشَّح لمكانٍ اليوم", () => {
    expect(
      matchesSlot(
        entry({ sameDayAvailable: false }),
        slot({ date: "2026-03-10" }),
        context({ clinicToday: "2026-03-10" }),
      ),
    ).toBe(false);
  });

  it("ويبقى مرشَّحًا لمكانٍ في يومٍ آخر", () => {
    expect(
      matchesSlot(
        entry({ sameDayAvailable: false }),
        slot({ date: "2026-03-12" }),
        context({ clinicToday: "2026-03-10" }),
      ),
    ).toBe(true);
  });
});

describe("الورديات من تهيئة المركز لا من الظهر", () => {
  it("يُصنّف الوقت بورديات المركز الفعلية", () => {
    expect(shiftOfTime("10:00", SHIFTS)).toBe("shift1");
    expect(shiftOfTime("17:00", SHIFTS)).toBe("shift2");
    expect(shiftOfTime("14:00", SHIFTS)).toBeNull(); // بين الورديتين
  });

  /* مركزٌ مسائيّ يبدأ ١٤:٠٠: الساعة ١٥:٠٠ عنده «الوردية الأولى» وليست مساءً،
     وقسمةُ الظهر كانت تعطي المساء دائمًا فتُقصي كلَّ من فضّل الصباح. */
  it("مركزٌ مسائيّ: ١٥:٠٠ ورديةٌ أولى لا «مساء»", () => {
    const evening = [{ start: "14:00", end: "20:00" }];
    expect(shiftOfTime("15:00", evening)).toBe("shift1");
    expect(
      matchesSlot(
        entry({ preferredShift: "shift1" }),
        slot({ time: "15:00" }),
        context({ shifts: evening }),
      ),
    ).toBe(true);
  });

  it("من فضّل الوردية الثانية لا يُرشَّح لمكانٍ في الأولى", () => {
    expect(
      matchesSlot(entry({ preferredShift: "shift2" }), slot({ time: "10:00" }), context()),
    ).toBe(false);
  });

  /* تغييرُ التهيئة ليس سببًا لإسقاط مريض: من فضّل ورديةً ألغاها المركز يبقى. */
  it("تفضيلُ ورديةٍ لم يعد المركز يشغّلها لا يُقصي صاحبه", () => {
    const single = [{ start: "09:00", end: "13:00" }];
    expect(configuredShiftCount(single)).toBe(1);
    expect(
      matchesSlot(
        entry({ preferredShift: "shift2" }),
        slot({ time: "10:00" }),
        context({ shifts: single }),
      ),
    ).toBe(true);
  });

  it("وقتٌ خارج الورديات كلِّها لا يُقصي — الطوارئ تقع خارج الدوام", () => {
    expect(
      matchesSlot(entry({ preferredShift: "shift1" }), slot({ time: "22:30" }), context()),
    ).toBe(true);
  });
});

describe("الخدمة تلزم مطابقةً صريحة", () => {
  /* كان الاختلاف يمرّ ما دامت المدّة تكفي: تُنادى المريضة لموعدٍ لا يُجرى لها
     فيه ما تنتظره، لأنّ الحشوة والخلع «ثلاثون دقيقة» كلاهما. */
  it("منتظِرُ خدمةٍ لا يُرشَّح لمكانِ خدمةٍ أخرى ولو اتّسعت المدّة", () => {
    expect(
      matchesSlot(entry({ serviceId: 4, durationMinutes: 30 }),
        slot({ serviceId: 9, durationMinutes: 60 }), context()),
    ).toBe(false);
  });

  it("والخدمةُ نفسها تُرشَّح", () => {
    expect(
      matchesSlot(entry({ serviceId: 4 }), slot({ serviceId: 4 }), context()),
    ).toBe(true);
  });

  it("مكانٌ لا تُعرف خدمته يمرّ ولا يُدَّعى له تطابق", () => {
    expect(matchesSlot(entry({ serviceId: 4 }), slot({ serviceId: null }), context())).toBe(true);
    expect(
      explainMatch(entry({ serviceId: 4 }), slot({ serviceId: null }), context()).serviceMatch,
    ).toBe("unknown");
  });
});

describe("تفسيرُ الترشيح", () => {
  it("يجمع الحقائق التي جعلت الاسم يظهر", () => {
    const facts = explainMatch(
      entry({ serviceId: 4, doctorId: 3, preferredDays: [4], preferredShift: "shift1" }),
      slot({ serviceId: 4, doctorId: 3 }),
      context(),
    );
    expect(facts.serviceMatch).toBe("exact");
    expect(facts.dayMatch).toBe(true);
    expect(facts.shiftMatch).toBe(true);
    expect(facts.providerMatch).toBe(true);
    expect(facts.waitingDays).toBe(9);
  });

  it("والوصفُ عربيٌّ يقرأه الاستقبال", () => {
    const text = describeMatch(explainMatch(
      entry({ serviceId: 4 }), slot({ serviceId: 4 }), context(),
    ));
    expect(text).toContain("نفس الخدمة");
    expect(text).toContain("ينتظر منذ");
  });
});

describe("الترتيب يعي سجلَّ الاتصال", () => {
  const history = new Map<number, ContactEvent[]>();
  const historyOf = (one: WaitingEntry) => history.get(one.id) ?? [];

  it("من رفض هذا الوقت بعينه يخرج من هذه الفرصة ويبقى في القائمة", () => {
    history.clear();
    history.set(1, [event({
      outcome: "declined_slot", slotDate: "2026-03-12", slotTime: "10:00",
    })]);
    const one = entry({ id: 1 });
    const two = entry({ id: 2, createdAt: "2026-03-05T08:00:00.000Z" });

    const here = rankCandidates([one, two], slot(), context(), historyOf);
    expect(here.map((candidate) => candidate.id)).toEqual([2]);

    /* الفرصةُ الأخرى تعيده — رفضُ موعدٍ ليس انسحابًا من القائمة. */
    const elsewhere = rankCandidates(
      [one, two], slot({ time: "11:30" }), context(), historyOf,
    );
    expect(elsewhere.map((candidate) => candidate.id)).toContain(1);
  });

  it("من لم يُكلَّم لهذه الفرصة يسبق من كُلّم — فلا تُعاود الاستقبال الاسم نفسه", () => {
    history.clear();
    history.set(1, [event({ slotDate: "2026-03-12", slotTime: "10:00" })]);
    const called = entry({ id: 1, createdAt: "2026-01-01T08:00:00.000Z" });
    const fresh = entry({ id: 2, createdAt: "2026-03-05T08:00:00.000Z" });

    const ranked = rankCandidates([called, fresh], slot(), context(), historyOf);
    expect(ranked.map((candidate) => candidate.id)).toEqual([2, 1]);
  });

  it("وأقدمُ انتظارًا أولًا عند تساوي ما سواه", () => {
    history.clear();
    const older = entry({ id: 5, createdAt: "2026-01-02T08:00:00.000Z" });
    const newer = entry({ id: 6, createdAt: "2026-03-05T08:00:00.000Z" });
    const ranked = rankCandidates([newer, older], slot(), context(), historyOf);
    expect(ranked.map((candidate) => candidate.id)).toEqual([5, 6]);
  });

  it("والمطابقةُ الصريحة للخدمة تسبق المكانَ مجهولَ الخدمة", () => {
    history.clear();
    const exact = entry({ id: 8, serviceId: 4, createdAt: "2026-03-06T08:00:00.000Z" });
    const generic = entry({ id: 9, serviceId: null, createdAt: "2026-03-06T08:00:00.000Z" });
    const ranked = rankCandidates([generic, exact], slot({ serviceId: 4 }), context(), historyOf);
    expect(ranked.map((candidate) => candidate.id)).toEqual([8, 9]);
  });
});
