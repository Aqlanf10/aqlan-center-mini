import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENTS_SEPARATOR,
  averageWaitMinutes,
  clockTimeInZone,
  compactTime12,
  DEFAULT_ANNOUNCEMENTS,
  DEFAULT_TAGLINE,
  formatAnnouncements,
  maskName,
  orthoSessionsToday,
  parseAnnouncements,
  positionPhrase,
  waitingRoomQueue,
} from "../lib/waiting-room";
import type { Visit } from "../lib/flow";
import type { Appointment } from "../lib/schedule";

const NOW = new Date("2026-08-24T10:00:00.000Z");
const TZ = "Asia/Aden";

function visit(over: Partial<Visit> & { id: number }): Visit {
  return {
    patientId: null,
    patientName: `مريض ${over.id}`,
    patientPhone: null,
    note: null,
    status: "waiting",
    chair: null,
    arrivedAt: NOW.toISOString(),
    seatedAt: null,
    calledAt: null,
    finishedAt: null,
    appointmentId: null,
    ...over,
  };
}

function appointment(over: Partial<Appointment> & { id: number }): Appointment {
  return {
    patientId: over.id * 100,
    patientName: `موعد ${over.id}`,
    patientPhone: null,
    scheduledDate: "2026-08-24",
    scheduledTime: "10:00",
    durationMinutes: 30,
    appointmentType: null,
    note: null,
    status: "booked",
    reminderSentAt: null,
    ...over,
  };
}

describe("قناع الخصوصية", () => {
  it("يعرض الاسم الأول وأول حرف من العائلة افتراضيًا", () => {
    expect(maskName("أحمد محمد الشرعبي", "first_initial")).toBe("أحمد ش.");
  });

  it("يكتفي بالاسم الأول في وضع الاختصار الأقصى", () => {
    expect(maskName("أحمد محمد الشرعبي", "first_only")).toBe("أحمد");
  });

  it("لا يكسر الاسم المفرد بلا حرف ثانٍ", () => {
    // مريضٌ كُتب باسم واحد في السجل — «سالم م.» من أين «م»؟
    expect(maskName("سالم", "first_initial")).toBe("سالم");
  });

  it("يتعامل مع الفراغات الزائدة التي تصل من الإدخال", () => {
    expect(maskName("  أحمد   محمد  ", "first_initial")).toBe("أحمد م.");
  });
});

describe("عبارة الدور بالعربية الصحيحة", () => {
  it("يقول الدور القادم لمن لا أحد أمامه", () => {
    expect(positionPhrase(0)).toBe("الدور القادم");
  });

  it("يثنّي كما تتكلم العربية لا كما تعدّ الآلة", () => {
    expect(positionPhrase(1)).toBe("أمامك مريض واحد");
    expect(positionPhrase(2)).toBe("أمامك مريضان");
    expect(positionPhrase(3)).toBe("أمامك 3 مرضى");
    expect(positionPhrase(10)).toBe("أمامك 10 مرضى");
  });

  it("يعود للمفرد بعد العشرة بمثنا الصيغة", () => {
    expect(positionPhrase(11)).toBe("أمامك 11 مريضًا");
    expect(positionPhrase(14)).toBe("أمامك 14 مريضًا");
    // المئة واثنا عشر: المنزلة الأخيرة هي الحاكمة لا الرقم الكلي.
    expect(positionPhrase(112)).toBe("أمامك 112 مريضًا");
  });
});

describe("صيغة الوقت", () => {
  it("يحوّل وقت الموعد إلى 12 ساعة بمؤشر صباح/مساء", () => {
    expect(compactTime12("10:45")).toBe("10:45 ص");
    expect(compactTime12("14:30")).toBe("2:30 م");
    expect(compactTime12("12:00")).toBe("12:00 م");
    expect(compactTime12("00:15")).toBe("12:15 ص");
  });

  it("يقرأ وقت الوصول بتوقيت العيادة لا بتوقيت الخادم", () => {
    // 07:55 UTC = 10:55 بتوقيت اليمن (UTC+3).
    expect(clockTimeInZone("2026-08-24T07:55:00.000Z", TZ)).toBe("10:55");
    expect(compactTime12(clockTimeInZone("2026-08-24T07:55:00.000Z", TZ))).toBe("10:55 ص");
  });

  it("يعيد نصًّا فارغًا لطابع تالف بدل أن ينهار", () => {
    expect(clockTimeInZone("ليس تاريخًا", TZ)).toBe("");
  });
});

describe("جدول القادمين", () => {
  it("يُقدم الواصلين بترتيب وصولهم ثم مواعيد اليوم بترتيب وقتها", () => {
    const rows = waitingRoomQueue({
      visits: [
        visit({ id: 2, patientName: "سارة علي", arrivedAt: "2026-08-24T07:20:00.000Z" }),
        visit({ id: 1, patientName: "أحمد محمد", arrivedAt: "2026-08-24T07:10:00.000Z" }),
      ],
      appointments: [
        appointment({ id: 11, patientName: "علي محمد", scheduledTime: "09:45" }),
        appointment({ id: 12, patientName: "محمد أحمد", scheduledTime: "09:15" }),
      ],
      privacy: "first_initial",
      timeZone: TZ,
    });
    expect(rows.map((row) => row.name)).toEqual(["أحمد م.", "سارة ع.", "محمد أ.", "علي م."]);
    expect(rows[0]!.position).toBe("الدور القادم");
    expect(rows[1]!.position).toBe("أمامك مريض واحد");
    expect(rows[2]!.position).toBeNull();
    expect(rows[2]!.status).toBe("upcoming");
    expect(rows[0]!.status).toBe("arrived");
  });

  it("يعرض وقت الموعد الأصلي للواصل من حجز لا ساعة وصوله", () => {
    const rows = waitingRoomQueue({
      visits: [
        visit({ id: 1, patientName: "أحمد محمد", arrivedAt: "2026-08-24T07:40:00.000Z", appointmentId: 5 }),
      ],
      appointments: [appointment({ id: 5, patientName: "أحمد محمد", scheduledTime: "10:15" })],
      privacy: "first_initial",
      timeZone: TZ,
    });
    // وصل متأخرًا عن موعده، والشاشة تعرض موعده — فالمريض الذي بعده لا يظن أن
    // دوره جاء قبل موعد أسبق منه.
    expect(rows[0]!.timeText).toBe("10:15 ص");
  });

  it("لا يعرض المنادى عليهم ولا الجالسين ولا المنتهين", () => {
    const rows = waitingRoomQueue({
      visits: [
        visit({ id: 1, status: "waiting" }),
        visit({ id: 2, status: "called", chair: 1, calledAt: "2026-08-24T09:00:00.000Z" }),
        visit({ id: 3, status: "in_chair", chair: 1, seatedAt: "2026-08-24T09:02:00.000Z" }),
        visit({ id: 4, status: "done", finishedAt: "2026-08-24T08:00:00.000Z" }),
      ],
      appointments: [],
      privacy: "first_only",
      timeZone: TZ,
    });
    expect(rows).toHaveLength(1);
  });

  it("يحترم سقف الصفوف — التلفاز لا يعرض يومًا كاملًا", () => {
    const rows = waitingRoomQueue({
      visits: [1, 2, 3, 4, 5, 6, 7].map((id) => visit({ id, arrivedAt: `2026-08-24T0${id}:00:00.000Z` })),
      appointments: [1, 2, 3, 4].map((id) => appointment({ id, scheduledTime: `1${id % 10}:00` })),
      privacy: "first_only",
      timeZone: TZ,
    });
    expect(rows).toHaveLength(8);
    expect(rows.filter((row) => row.status === "arrived")).toHaveLength(6);
  });

  it("لا يخرج من الجدول هاتف ولا ملاحظة ولا مُعرّف — الشاشة عامة", () => {
    const rows = waitingRoomQueue({
      visits: [visit({ id: 1, patientName: "أحمد محمد", patientPhone: "777123456" })],
      appointments: [],
      privacy: "first_initial",
      timeZone: TZ,
    });
    expect(JSON.stringify(rows)).not.toContain("777123456");
    expect(JSON.stringify(rows)).not.toContain("محمد");
  });
});

describe("متوسط الانتظار الفعلي", () => {
  it("يحسب متوسط الفرق بين الوصول والنداء", () => {
    const visits = [
      visit({ id: 1, arrivedAt: "2026-08-24T07:00:00.000Z", calledAt: "2026-08-24T07:10:00.000Z" }),
      visit({ id: 2, arrivedAt: "2026-08-24T08:00:00.000Z", calledAt: "2026-08-24T08:20:00.000Z" }),
    ];
    expect(averageWaitMinutes(visits)).toBe(15);
  });

  it("يعيد null حين لا يوجد قياس — لا صفرًا كاذبًا", () => {
    expect(averageWaitMinutes([visit({ id: 1 })])).toBeNull();
    expect(averageWaitMinutes([])).toBeNull();
  });

  it("يتجاهل الطوابع التالفة ولا يفسد المتوسط", () => {
    const visits = [
      visit({ id: 1, arrivedAt: "2026-08-24T07:00:00.000Z", calledAt: "2026-08-24T07:30:00.000Z" }),
      visit({ id: 2, arrivedAt: "باطل", calledAt: "باطل" }),
    ];
    expect(averageWaitMinutes(visits)).toBe(30);
  });
});

describe("جلسات التقويم اليوم", () => {
  it("يعدّ من نوع المتابعة ومن مرضى الحالات القائمة معًا", () => {
    const summary = orthoSessionsToday(
      [
        appointment({ id: 1, appointmentType: "follow_up", status: "done" }),
        appointment({ id: 2, patientId: 77, status: "arrived" }),
        appointment({ id: 3, patientId: 77, status: "booked" }),
        appointment({ id: 4, appointmentType: "filling", status: "booked" }),
        appointment({ id: 5, appointmentType: "follow_up", status: "cancelled" }),
      ],
      [77],
    );
    expect(summary).toEqual({ total: 3, done: 1, waiting: 1, upcoming: 1 });
  });

  it("يعيد null في يوم بلا جلسات تقويم فتُخفى البطاقة", () => {
    expect(orthoSessionsToday([appointment({ id: 1, appointmentType: "filling" })], [])).toBeNull();
  });

  it("لا يُدخل الملغى ومن لم يحضر في المجموع — أجزاء الشاشة تجمع", () => {
    const summary = orthoSessionsToday(
      [
        appointment({ id: 1, appointmentType: "follow_up", status: "cancelled" }),
        appointment({ id: 2, appointmentType: "follow_up", status: "no_show" }),
      ],
      [],
    );
    expect(summary).toBeNull();
  });
});

describe("الإعلانات المتناوبة", () => {
  it("يقرأ سطرًا لكل إعلان بصيغة العنوان | النص", () => {
    const parsed = parseAnnouncements(
      `تذكير | يرجى إبلاغ الاستقبال بأي تغيير في رقم الهاتف.\nخدمات المركز | تقويم • زراعة • تجميل`,
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ title: "تذكير", body: "يرجى إبلاغ الاستقبال بأي تغيير في رقم الهاتف." });
  });

  it("يعود للافتراضي حين يكون الإعداد فارغًا — الشاشة لا تبقى بلا نصوص", () => {
    expect(parseAnnouncements("")).toEqual(DEFAULT_ANNOUNCEMENTS);
    expect(parseAnnouncements(null)).toEqual(DEFAULT_ANNOUNCEMENTS);
  });

  it("يتخطى السطر التالف ولا يُسقط بقية الإعلانات", () => {
    const parsed = parseAnnouncements(
      `سطر بلا فاصل صحيح\nعنوان | نص سليم\n   \n| نص بلا عنوان`,
    );
    expect(parsed).toEqual([{ title: "عنوان", body: "نص سليم" }]);
  });

  it("الفاصل الأول فقط هو الفاصل — النص قد يحتوي |", () => {
    const parsed = parseAnnouncements("خدمات | تقويم | زراعة");
    expect(parsed).toEqual([{ title: "خدمات", body: "تقويم | زراعة" }]);
  });

  it("التدوير الصياغة ينتج نصًّا يقرؤه التحقق — الدائرتان متناقختان", () => {
    const text = formatAnnouncements(DEFAULT_ANNOUNCEMENTS);
    expect(parseAnnouncements(text)).toEqual(DEFAULT_ANNOUNCEMENTS);
    expect(text).toContain(ANNOUNCEMENTS_SEPARATOR);
  });
});

describe("الشعار الافتراضي", () => {
  it("له وجه واحد يُعرض حين يُترك الإعداد فارغًا", () => {
    expect(DEFAULT_TAGLINE).toBe("ابتسامتك تستحق أفضل عناية");
  });
});
