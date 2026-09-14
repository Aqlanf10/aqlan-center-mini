import { describe, expect, it } from "vitest";
import type { Appointment } from "@/lib/schedule";
import {
  judgeFullCapacity, shiftsCapacityMinutes, usableShifts, withinAnyShift,
  type CapacityVerdict, type FullCapacityInput, type ProviderBlockWindow, type Shift,
} from "@/lib/capacity";

/**
 * المحرّك الكامل (المرحلة ٤ب) — هذه الفحوص كلّها فحوصُ دوالٍّ صرفة: تصف ما يقوله
 * المحرّك، والفرضُ يبقى في الخادم داخل قفل اليوم. فلا يُفهم من خضرة هذا الملف أنّ
 * الحجز المتزامن صار آمنًا — يُفهم منه أنّ الحكم المعروض على الاستقبال صادق.
 */

const DATE = "2026-10-05";

/** يومُ المركز الحقيقي: وردية صباح، ثمّ إغلاقٌ ظهرًا، ثمّ وردية مساء. */
const SHIFTS: readonly Shift[] = [
  { start: "09:00", end: "13:00" },
  { start: "16:00", end: "21:00" },
] as const;

const MORNING_ONLY: readonly Shift[] = [{ start: "09:00", end: "13:00" }] as const;

/** موعدٌ قائم في اليوم — بلقطته هو: مدّته وفواصله وكرسيّه وطبيبه. */
const appt = (over: Partial<Appointment> = {}): Appointment => ({
  id: 1,
  patientId: 1,
  patientName: "مريض",
  patientPhone: null,
  scheduledDate: DATE,
  scheduledTime: "10:00",
  durationMinutes: 30,
  note: null,
  status: "booked",
  doctorId: null,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  chairNo: null,
  ...over,
});

type ServiceNeeds = FullCapacityInput["service"];

/** متطلّبات الخدمة المطلوبة — كلُّ فحصٍ يغيّر متطلّبًا واحدًا ليقرأ كفكرةٍ واحدة. */
const service = (over: Partial<ServiceNeeds> = {}): ServiceNeeds => ({
  requiresProvider: false,
  requiresChair: true,
  allowsConcurrentProviderWork: false,
  consumesEmergencyReserve: false,
  isActive: true,
  nameAr: "كشف واستشارة",
  ...over,
});

const judge = (over: Partial<FullCapacityInput> = {}): CapacityVerdict =>
  judgeFullCapacity({
    appointments: [],
    date: DATE,
    time: "10:00",
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    chairs: 2,
    shifts: SHIFTS,
    nearCapacityPercent: 80,
    service: service(),
    ...over,
  });

const ARABIC = /[؀-ۿ]/;

/**
 * الورديات — الإغلاق الظهريّ وقتٌ مغلقٌ لا فجوةٌ في الجدول.
 *
 * المركز يفتح صباحًا ثمّ يُغلق ثمّ يفتح مساءً. وإن قرأ المحرّك اليوم كقطعةٍ واحدة
 * من ٩:٠٠ إلى ٢١:٠٠ فسيَعِد الاستقبالُ مريضًا بموعد ١٢:٤٥ يمتدّ إلى ١٣:١٥ — فيصل
 * الرجل وقد أُقفل الباب وذهب الطبيب. ومقابل ذلك: إعدادُ ورديةٍ مكتوبٌ خطأً في
 * الشاشة لا يجوز أن يُطفئ الحجز كلَّه في يوم عمل.
 */
describe("ورديات المركز والفترة المغلقة بينها", () => {
  it("الوردية المقلوبة والوقت الفاسد يُهمَلان ولا يُعطّلان الحجز", () => {
    const usable = usableShifts([
      { start: "09:00", end: "13:00" },
      { start: "16:00", end: "15:00" },   // مقلوبة
      { start: "18:00", end: "18:00" },   // صفريّة
      { start: "لا وقت", end: "20:00" },  // فاسدة
      { start: "25:00", end: "26:00" },   // ساعةٌ لا وجود لها
    ]);
    expect(usable).toEqual([{ start: 540, end: 780 }]);
  });

  it("والورديات تُرتَّب ببدايتها مهما جاءت في الإعدادات", () => {
    const usable = usableShifts([
      { start: "16:00", end: "21:00" },
      { start: "09:00", end: "13:00" },
    ]);
    expect(usable.map((shift) => shift.start)).toEqual([540, 960]);
  });

  it("وبلا ورديةٍ صالحة يُسمح بكل وقت — إعدادٌ ناقص لا يوقف يوم عمل", () => {
    /* الانفتاح عند العطب مقصود: لو أُغلق الحجز كلُّه لأنّ أحدهم أخطأ في حقل وقت،
       لتوقّف الاستقبال عن العمل بسبب حرفٍ في الإعدادات. فالمحرّك يصمت ولا يمنع. */
    const midnightWindow = { start: 3 * 60, end: 4 * 60 };
    expect(withinAnyShift(midnightWindow, [])).toBe(true);
    expect(withinAnyShift(midnightWindow, [{ start: "22:00", end: "16:00" }])).toBe(true);
  });

  it("موعدٌ كاملٌ داخل وردية الصباح ليس خارج الدوام", () => {
    const verdict = judge({ time: "10:00", durationMinutes: 30 });
    expect(verdict.outsideHours).toBe(false);
    expect(verdict.state).toBe("AVAILABLE");
  });

  it("وموعدٌ يبدأ قبل الإغلاق وينتهي بعده يُوسم خارج الورديات ولو بدا طرفاه داخل اليوم", () => {
    /* ١٢:٤٥ داخل الصباح، و١٣:١٥ «داخل يوم المركز» بالنظر السطحيّ — لكنه واقعٌ في
       الإغلاق. هذا هو فخّ الورديتين، وهو الفرق بين المحرّك القديم وهذا. */
    const across = judge({ time: "12:45", durationMinutes: 30 });
    expect(across.outsideHours).toBe(true);
    expect(across.state).toBe("NEAR_CAPACITY");
    expect(across.reasons.join(" ")).toContain("خارج ورديات المركز");

    const inside = judge({ time: "12:00", durationMinutes: 30 });
    expect(inside.outsideHours).toBe(false);
  });

  it("وموعدٌ داخل وردية المساء سليمٌ كصباحه", () => {
    const verdict = judge({ time: "16:30", durationMinutes: 30 });
    expect(verdict.outsideHours).toBe(false);
    expect(verdict.state).toBe("AVAILABLE");
  });

  it("والفاصل قبل الموعد جزءٌ من نافذته: ٩:٠٠ بنصف ساعة تجهيزٍ يبدأ قبل الفتح", () => {
    /* التجهيز يسبق جلوس المريض. فموعد ٩:٠٠ بفاصلٍ قبله نصف ساعة يعني مساعدةً
       تفتح الغرفة ٨:٣٠ والباب مقفل. يُوسم ولا يُخفى. */
    const early = judge({ time: "09:00", durationMinutes: 30, bufferBeforeMinutes: 30 });
    expect(early.outsideHours).toBe(true);
    expect(early.state).toBe("NEAR_CAPACITY");

    const flush = judge({ time: "09:00", durationMinutes: 30, bufferBeforeMinutes: 0 });
    expect(flush.outsideHours).toBe(false);
  });
});

/**
 * احتياطي الطوارئ — قرار المالك أنّ الافتراضيّ صفر.
 *
 * الاحتياطي دقائقُ تُترك في كل وردية لمريض الألم الحاد الذي يأتي بلا موعد. وهو
 * نافعٌ حين يطلبه المالك، وضارٌّ حين يُفرض عليه: نشرُ المرحلة ٤ب يجب ألّا يُقلّص
 * طاقة اليوم في الخفاء فيرى الاستقبال «اقتربت السعة» في يومٍ نصفه فارغ، فيَردّ
 * مرضى كان لهم مكان.
 */
describe("احتياطي الطوارئ — لا يُنقص شيئًا ما لم يطلبه المالك", () => {
  it("الاحتياطي صفرًا: الطاقة هي دقائق الورديات × الكراسي بلا نقصان", () => {
    /* ٢٤٠ + ٣٠٠ = ٥٤٠ دقيقة، بكرسيين = ١٠٨٠. أيّ رقمٍ أقلّ يعني أنّ النشر قضم
       طاقة اليوم بلا أن يطلب أحد. */
    expect(shiftsCapacityMinutes(SHIFTS, 2, 0)).toBe(1080);
    expect(shiftsCapacityMinutes(MORNING_ONLY, 1, 0)).toBe(240);
  });

  it("واحتياطي ٣٠ في ورديةٍ واحدة ينقص ٣٠ بالضبط", () => {
    expect(shiftsCapacityMinutes(MORNING_ONLY, 2, 0)).toBe(480);
    expect(shiftsCapacityMinutes(MORNING_ONLY, 2, 30)).toBe(450);
  });

  it("واحتياطي ٣٠ في ورديتين ينقص ٦٠ — لكل وردية لا لليوم", () => {
    const free = shiftsCapacityMinutes(SHIFTS, 2, 0);
    const reserved = shiftsCapacityMinutes(SHIFTS, 2, 30);
    expect(free - reserved).toBe(60);
    expect(reserved).toBe(1020);
  });

  it("والاحتياطي لا يهبط بوردية تحت الصفر ولا يقضم أختها", () => {
    const shifts: Shift[] = [{ start: "09:00", end: "09:20" }, { start: "16:00", end: "21:00" }];
    // ٢٠ − ٣٠ تُقصّ عند الصفر لا إلى −١٠، فيبقى المساء ٣٠٠ − ٣٠ = ٢٧٠.
    expect(shiftsCapacityMinutes(shifts, 1, 30)).toBe(270);
    expect(shiftsCapacityMinutes(shifts, 1, 10_000)).toBe(0);
  });

  it("والإعداد يغيّر الحكم فعلًا: حجزٌ يمرّ بلا احتياطي ويسقط باحتياطٍ كبير", () => {
    const base = { shifts: MORNING_ONLY, chairs: 1, time: "09:00", durationMinutes: 60 };
    const free = judge({ ...base, emergencyReserveMinutesPerShift: 0 });
    const reserved = judge({ ...base, emergencyReserveMinutesPerShift: 200 });
    expect(free.state).toBe("AVAILABLE");
    expect(free.dayPercent).toBe(25);
    expect(reserved.state).toBe("OVER_CAPACITY");
    expect(reserved.message).toContain("طاقة اليوم");
  });

  it("وخدمةٌ من حقّها أكل الاحتياطي تتجاهله فتُحسب على الطاقة الكاملة", () => {
    const verdict = judge({
      shifts: MORNING_ONLY, chairs: 1, time: "09:00", durationMinutes: 60,
      emergencyReserveMinutesPerShift: 200,
      service: service({ consumesEmergencyReserve: true, nameAr: "طوارئ وألم حاد" }),
    });
    expect(verdict.state).toBe("AVAILABLE");
    expect(verdict.dayPercent).toBe(25);
  });
});

/**
 * الطبيب — لا يُوعَد مريضان بالرجل نفسه في الدقيقة نفسها.
 *
 * حجزان متزامنان على طبيبٍ واحد ينتهيان في الواقع بمريضٍ ينتظر في الممرّ نصف
 * ساعة وهو يظنّ أنّ له موعدًا. وفي المقابل: خدمةٌ لا تحتاج طبيبًا أصلًا (أشعة،
 * تسليم) يجب ألّا تُحجب بانشغال طبيب، وإلّا ضاق اليوم بلا سبب.
 */
describe("انشغال الطبيب وحجوزاته", () => {
  const noChair = service({ requiresProvider: true, requiresChair: false });
  const block = (over: Partial<ProviderBlockWindow> = {}): ProviderBlockWindow => ({
    startMinutes: 600, endMinutes: 660, reason: "اجتماع إداري", ...over,
  });

  it("خدمةٌ لا تحتاج طبيبًا لا يُسأل عن انشغاله أصلًا", () => {
    const verdict = judge({
      service: service({ requiresProvider: false, requiresChair: false }),
      providerId: 7,
      appointments: [appt({ id: 2, doctorId: 7, scheduledTime: "10:00", durationMinutes: 60 })],
      providerBlocks: [block()],
    });
    expect(verdict.state).toBe("AVAILABLE");
    expect(verdict.reasons).toEqual([]);
  });

  it("والطبيب نفسه في وقتٍ متداخل تجاوزٌ بسببٍ يذكره", () => {
    const verdict = judge({
      service: noChair, providerId: 7,
      appointments: [appt({ id: 2, doctorId: 7, scheduledTime: "10:15", durationMinutes: 30 })],
    });
    expect(verdict.state).toBe("OVER_CAPACITY");
    expect(verdict.reasons.join(" ")).toContain("الطبيب لديه موعدٌ آخر");
  });

  it("وطبيبٌ آخر في الوقت نفسه ليس تزاحمًا", () => {
    const verdict = judge({
      service: noChair, providerId: 7,
      appointments: [appt({ id: 2, doctorId: 9, scheduledTime: "10:15", durationMinutes: 30 })],
    });
    expect(verdict.state).toBe("AVAILABLE");
  });

  it("وخدمةٌ تسمح بعمل الطبيب على أكثر من مريض تمرّ بالتداخل", () => {
    const verdict = judge({
      service: service({
        requiresProvider: true, requiresChair: false, allowsConcurrentProviderWork: true,
      }),
      providerId: 7,
      appointments: [appt({ id: 2, doctorId: 7, scheduledTime: "10:15", durationMinutes: 30 })],
    });
    expect(verdict.state).toBe("AVAILABLE");
  });

  it("وحجبُ الطبيب في نافذةٍ يمنع الحجز ويُظهر سبب الحجب نصًّا", () => {
    const verdict = judge({
      service: noChair, providerId: 7, time: "10:30",
      providerBlocks: [block({ reason: "إجازة نصف يوم" })],
    });
    expect(verdict.state).toBe("OVER_CAPACITY");
    expect(verdict.message).toContain("إجازة نصف يوم");
  });

  it("وخدمةٌ تشترط طبيبًا بلا طبيبٍ مختار لا تُفحص — لا أحدَ ليتزاحم معه", () => {
    /* الحارس هو `providerId` لا `requiresProvider`: بلا معرِّفِ طبيبٍ لا مقارنةَ
       ممكنة، فيمرّ الحكم ولو كان الطبيب محجوبًا اليوم كلَّه. واشتراطُ اختيار
       الطبيب أصلًا ليس عمل هذا المحرّك — يقع قبله في نموذج الحجز. */
    const verdict = judge({
      service: noChair, providerId: null,
      appointments: [appt({ id: 2, doctorId: null, durationMinutes: 60 })],
      providerBlocks: [{ startMinutes: 0, endMinutes: 1440, reason: "إجازة سنوية" }],
    });
    expect(verdict.state).toBe("AVAILABLE");
    expect(verdict.reasons).toEqual([]);
  });

  it("وحجبٌ ينتهي في اللحظة التي يبدأ فيها الموعد لا يمنعه", () => {
    /* نهايةٌ ملامسة ليست تزاحمًا — واعتبارها كذلك يُهدر فتحةً في كل يوم. */
    const verdict = judge({
      service: noChair, providerId: 7, time: "10:00",
      providerBlocks: [block({ startMinutes: 540, endMinutes: 600 })],
    });
    expect(verdict.state).toBe("AVAILABLE");
  });
});

/**
 * الكراسي — الزحمة التي يراها المريض بعينه.
 *
 * الكرسيّ هو المورد الذي ينفد أوّلًا في المركز. وخطأٌ واحدٌ هنا يُنتج غرفة انتظار
 * ممتلئة: كرسيٌّ محجوزٌ مرّتين، أو موعدٌ بلا كرسيٍّ مخصَّص حُسب «بلا كرسي» فأُدخل
 * فوق طاقة المكان.
 */
describe("إشغال الكراسي", () => {
  it("خدمةٌ بلا كرسي لا تملأ الكراسي أبدًا", () => {
    const verdict = judge({
      chairs: 1,
      service: service({ requiresChair: false, nameAr: "استلام تقرير أشعة" }),
      appointments: [
        appt({ id: 2, scheduledTime: "10:00", durationMinutes: 30 }),
        appt({ id: 3, scheduledTime: "10:00", durationMinutes: 30 }),
      ],
    });
    expect(verdict.occupiedChairs).toBe(0);
    expect(verdict.state).toBe("AVAILABLE");
  });

  it("وكرسيٌّ بعينه محجوزٌ مرّتين تجاوزٌ يسمّي رقم الكرسي", () => {
    const verdict = judge({
      chairs: 3, chairNo: 2, time: "10:15",
      appointments: [appt({ id: 2, chairNo: 2, scheduledTime: "10:00", durationMinutes: 30 })],
    });
    expect(verdict.state).toBe("OVER_CAPACITY");
    expect(verdict.message).toContain("الكرسي رقم 2");
  });

  it("والوقت نفسه على كرسيٍّ آخر مسموح", () => {
    const verdict = judge({
      chairs: 3, chairNo: 1, time: "10:15",
      appointments: [appt({ id: 2, chairNo: 2, scheduledTime: "10:00", durationMinutes: 30 })],
    });
    expect(verdict.state).toBe("AVAILABLE");
    expect(verdict.occupiedChairs).toBe(1);
  });

  it("والكرسي غير المخصَّص يستهلك طاقةً عامة — «غير مخصَّص» لا تعني «بلا كرسي»", () => {
    /* `chairNo: null` تعني «لم يُخصَّص بعد»، والمريض سيجلس على كرسيٍّ لا محالة.
       فلو مرّت هذه، دخل موعدان على كرسيٍّ واحد لأنّ أحدًا لم يكتب رقمًا. */
    const verdict = judge({
      chairs: 1, chairNo: null,
      appointments: [appt({ id: 2, chairNo: null, scheduledTime: "10:00", durationMinutes: 30 })],
    });
    expect(verdict.occupiedChairs).toBe(1);
    expect(verdict.state).toBe("OVER_CAPACITY");
    expect(verdict.message).toContain("الكراسي ممتلئة");
  });

  it("وآخر كرسيٍّ متاح تحذيرٌ لا منع", () => {
    const verdict = judge({
      chairs: 2,
      appointments: [appt({ id: 2, scheduledTime: "10:00", durationMinutes: 30 })],
    });
    expect(verdict.occupiedChairs).toBe(1);
    expect(verdict.state).toBe("NEAR_CAPACITY");
    expect(verdict.reasons.join(" ")).toContain("آخر كرسيٍّ");
  });
});

/**
 * الفواصل — التعقيم والتجهيز وقتٌ محجوز لا هواء.
 *
 * الكرسيّ بعد الخلع لا يستقبل التالي في الثانية نفسها: يُنظَّف ويُجهَّز. وإن لم
 * يُحسب الفاصل، امتلأ الجدول ورقًا وتأخّر واقعًا فتراكم مرضى المساء. والأهمّ:
 * موعدٌ قديم يُحكم بلقطته هو، لا بإعداد الخدمة كما صار اليوم — وإلّا تغيّر ماضي
 * الجدول كلّما عدّل المالك رقمًا في شاشة الخدمات.
 */
describe("فواصل التجهيز قبل الموعد وبعده", () => {
  it("موعدان لا يتلامسان بأوقاتهما لكن فاصليهما يتداخلان: تزاحم", () => {
    const verdict = judge({
      chairs: 1, time: "10:30", durationMinutes: 30,
      bufferBeforeMinutes: 15, bufferAfterMinutes: 0,
      appointments: [appt({
        id: 2, scheduledTime: "10:00", durationMinutes: 30, bufferAfterMinutes: 15,
      })],
    });
    expect(verdict.state).toBe("OVER_CAPACITY");
    expect(verdict.message).toContain("الكراسي ممتلئة");
  });

  it("والفواصل تُحسب في نسبة امتلاء اليوم لا تُطرح منها", () => {
    const bare = judge({ chairs: 1, durationMinutes: 60 });
    const buffered = judge({
      chairs: 1, durationMinutes: 60, bufferBeforeMinutes: 15, bufferAfterMinutes: 15,
    });
    expect(bare.dayPercent).toBe(11);      // ٦٠ من ٥٤٠
    expect(buffered.dayPercent).toBe(17);  // ٩٠ من ٥٤٠
    expect(buffered.dayPercent).toBeGreaterThan(bare.dayPercent);
  });

  it("والموعد القائم يُحكم بفواصله المخزَّنة لا بفواصل خدمة اليوم", () => {
    /* الطلب الوارد فواصله صفر. فإن حُكم القديمُ بفواصل الوارد، انكمشت نافذته
       واختفى التزاحم — وهذا بالضبط ما يجعل جدول الأمس يتغيّر حين يعدّل المالك
       إعداد الخدمة اليوم. */
    const withStoredBuffer = judge({
      chairs: 1, time: "10:00", durationMinutes: 30,
      bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
      appointments: [appt({
        id: 2, scheduledTime: "09:00", durationMinutes: 30, bufferAfterMinutes: 60,
      })],
    });
    expect(withStoredBuffer.state).toBe("OVER_CAPACITY");
    expect(withStoredBuffer.occupiedChairs).toBe(1);

    const withoutStoredBuffer = judge({
      chairs: 1, time: "10:00", durationMinutes: 30,
      bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
      appointments: [appt({
        id: 2, scheduledTime: "09:00", durationMinutes: 30, bufferAfterMinutes: 0,
      })],
    });
    expect(withoutStoredBuffer.state).toBe("AVAILABLE");
    expect(withoutStoredBuffer.occupiedChairs).toBe(0);
  });
});

/**
 * طاقة اليوم والحدود — «اقترب» قبل الوعد أنفع من «امتلأ» بعده.
 *
 * موعدٌ في ساعةٍ فارغة من يومٍ ممتلئ يمرّ من فحص اللحظة ويسقط في فحص اليوم؛
 * وكلاهما ازدحامٌ يشعر به المريض. وخدمةٌ أوقفها المالك يجب ألّا تُحجز اليوم
 * بحجّة أنها كانت تُحجز أمس، وحدّ المرضى الجدد إن وُضع فهو وعدٌ للطبيب بيومٍ
 * يمكن إنجازه.
 */
describe("نسبة اليوم والحدود اليومية", () => {
  it("يومٌ عند العتبة أو فوقها ودون التجاوز: اقترابٌ لا منع", () => {
    const verdict = judge({
      chairs: 1, nearCapacityPercent: 80, time: "19:00", durationMinutes: 30,
      appointments: [
        appt({ id: 2, scheduledTime: "09:00", durationMinutes: 240 }),
        appt({ id: 3, scheduledTime: "16:00", durationMinutes: 165 }),
      ],
    });
    expect(verdict.dayPercent).toBe(81);
    expect(verdict.state).toBe("NEAR_CAPACITY");
    expect(verdict.reasons.join(" ")).toContain("اليوم ممتلئ");
  });

  it("والمئة بالضبط اقترابٌ لا تجاوز — الحدّ يُبلَغ ولا يُخترق", () => {
    /* ٢٤٠ دقيقة على كرسيٍّ واحد في وردية الصباح = طاقتها كلّها بالضبط. والفرق
       بين «امتلأ» و«تجاوز» فرقٌ في الحكم: الأوّل يمرّ بتحذير، والثاني يُمنع
       ولا يمرّ إلّا بصلاحيةٍ وسببٍ مكتوب. فخطأُ دقيقةٍ هنا يمنع مريضًا له مكان. */
    const exact = judge({ shifts: MORNING_ONLY, chairs: 1, time: "09:00", durationMinutes: 240 });
    expect(exact.dayPercent).toBe(100);
    expect(exact.state).toBe("NEAR_CAPACITY");

    const beyond = judge({
      shifts: MORNING_ONLY, chairs: 1, time: "09:00", durationMinutes: 240,
      bufferAfterMinutes: 5,
    });
    expect(beyond.dayPercent).toBe(102);
    expect(beyond.state).toBe("OVER_CAPACITY");
  });

  it("وتجاوز المئة منعٌ بسببٍ عربيٍّ يذكر طاقة اليوم", () => {
    const verdict = judge({
      shifts: MORNING_ONLY, chairs: 2, time: "12:00", durationMinutes: 60,
      appointments: [
        appt({ id: 2, scheduledTime: "09:00", durationMinutes: 180 }),
        appt({ id: 3, scheduledTime: "09:00", durationMinutes: 180 }),
        appt({ id: 4, scheduledTime: "12:00", durationMinutes: 90 }),
      ],
    });
    expect(verdict.dayPercent).toBe(106);
    expect(verdict.state).toBe("OVER_CAPACITY");
    expect(verdict.message).toContain("طاقة اليوم");
  });

  it("وخدمةٌ معطَّلة تُمنع فورًا برسالةٍ تسمّيها", () => {
    const verdict = judge({ service: service({ isActive: false, nameAr: "تبييض الأسنان" }) });
    expect(verdict.state).toBe("OVER_CAPACITY");
    expect(verdict.message).toContain("تبييض الأسنان");
    expect(verdict.message).toContain("معطَّلة");
  });

  it("وحدّ المرضى الجدد صفرًا يعني بلا حدّ", () => {
    const verdict = judge({
      isNewPatient: true, newPatientDailyLimit: 0, newPatientsBookedToday: 12,
    });
    expect(verdict.state).toBe("AVAILABLE");
  });

  it("وحدُّ اثنين بعد حجز اثنين يمنع الثالث", () => {
    const verdict = judge({
      isNewPatient: true, newPatientDailyLimit: 2, newPatientsBookedToday: 2,
    });
    expect(verdict.state).toBe("OVER_CAPACITY");
    expect(verdict.message).toContain("حدّ المرضى الجدد");
  });

  it("وموعدٌ يُعاد جدولته لا يزاحم نفسه", () => {
    const existing = [appt({ id: 7, scheduledTime: "10:00", durationMinutes: 60 })];
    expect(judge({ chairs: 1, appointments: existing }).state).toBe("OVER_CAPACITY");
    expect(judge({ chairs: 1, appointments: existing, excludeId: 7 }).state).toBe("AVAILABLE");
  });

  it("وكلُّ منعٍ أو تحذيرٍ يخرج برسالةٍ عربية غير فارغة وأسبابٍ مطابقة لها", () => {
    const cases: { label: string; verdict: CapacityVerdict }[] = [
      {
        label: "خدمة معطَّلة",
        verdict: judge({ service: service({ isActive: false }) }),
      },
      {
        label: "الطبيب مشغول",
        verdict: judge({
          service: service({ requiresProvider: true, requiresChair: false }), providerId: 7,
          appointments: [appt({ id: 2, doctorId: 7, durationMinutes: 60 })],
        }),
      },
      {
        label: "الطبيب محجوب",
        verdict: judge({
          service: service({ requiresProvider: true, requiresChair: false }), providerId: 7,
          providerBlocks: [{ startMinutes: 595, endMinutes: 660, reason: "اجتماع" }],
        }),
      },
      {
        label: "الكرسي محجوز",
        verdict: judge({
          chairs: 3, chairNo: 2,
          appointments: [appt({ id: 2, chairNo: 2, durationMinutes: 60 })],
        }),
      },
      {
        label: "الكراسي ممتلئة",
        verdict: judge({ chairs: 1, appointments: [appt({ id: 2, durationMinutes: 60 })] }),
      },
      {
        label: "حدّ المرضى الجدد",
        verdict: judge({
          isNewPatient: true, newPatientDailyLimit: 1, newPatientsBookedToday: 1,
        }),
      },
      {
        label: "تجاوز طاقة اليوم",
        verdict: judge({
          shifts: MORNING_ONLY, chairs: 1, time: "09:00", durationMinutes: 60,
          emergencyReserveMinutesPerShift: 200,
        }),
      },
      {
        label: "آخر كرسي",
        verdict: judge({ chairs: 2, appointments: [appt({ id: 2, durationMinutes: 60 })] }),
      },
      {
        label: "خارج الورديات",
        verdict: judge({ time: "12:45", durationMinutes: 30 }),
      },
    ];

    for (const { label, verdict } of cases) {
      expect(verdict.state, label).not.toBe("AVAILABLE");
      expect(verdict.message.trim(), label).not.toBe("");
      expect(verdict.message, label).toMatch(ARABIC);
      expect(verdict.reasons.length, label).toBeGreaterThan(0);
      expect(verdict.message, label).toBe(verdict.reasons.join(" "));
      for (const reason of verdict.reasons) expect(reason, label).toMatch(ARABIC);
    }
  });
});

/**
 * المدخلات المعطوبة — العطب يُهمَل ولا يُطفئ شبّاك الاستقبال.
 *
 * إعدادات المركز يحرّرها بشرٌ في شاشةٍ وسط يومٍ مزدحم: حقلُ وقتٍ يُترك فارغًا،
 * ورديةٌ تُكتب مقلوبة، موعدٌ حُجز قبل المرحلة ٤ب لا يحمل حقلي الفاصل أصلًا.
 * والقاعدة أنّ خطأً في الإعداد لا يجوز أن يُحوِّل كلَّ نقرةٍ في شاشة الحجز إلى
 * «تجاوز» فيقف الاستقبال ويُردّ المرضى — إلّا في شيءٍ واحد: وقتُ الطلب نفسه إن
 * لم يُقرأ فلا حكمَ فيه، لأنّ حكمًا مبنيًّا على وقتٍ مخمَّن أسوأ من لا حكم.
 */
describe("العطب في المدخلات — انفتاحٌ محسوب لا شلل", () => {
  it("وقتُ الطلب إن لم يُقرأ يُمنع — لا يُخمَّن موعدٌ لمريض", () => {
    for (const time of ["", "   ", "99:99", "بكرة الصبح", "9:5"]) {
      const verdict = judge({ time });
      expect(verdict.state, time).toBe("OVER_CAPACITY");
      expect(verdict.message, time).toBe("وقت غير صالح.");
    }
  });

  it("وبلا ورديةٍ واحدة صالحة لا طاقةَ تُقاس فتبقى النسبة صفرًا ويمرّ الحجز", () => {
    /* انفتاحٌ مقصود لا حسابٌ صحيح: «صفر بالمئة» هنا تعني «لا أعرف» لا «اليوم
       فارغ». وقيمتُه أنّ مركزًا لم تُضبط ورديّاته بعد يظلّ قادرًا على الحجز. */
    const verdict = judge({ shifts: [], chairs: 1, durationMinutes: 480 });
    expect(verdict.dayPercent).toBe(0);
    expect(verdict.outsideHours).toBe(false);
    expect(verdict.state).toBe("AVAILABLE");
  });

  it("والملغى ومن لم يحضر لا يشغلان كرسيًّا ولا يُحسبان في حمل اليوم", () => {
    const verdict = judge({
      chairs: 1,
      appointments: [
        appt({ id: 2, status: "cancelled", durationMinutes: 60 }),
        appt({ id: 3, status: "no_show", durationMinutes: 60 }),
      ],
    });
    expect(verdict.occupiedChairs).toBe(0);
    expect(verdict.state).toBe("AVAILABLE");
  });

  it("ومواعيد يومٍ آخر لا تزاحم هذا اليوم", () => {
    const verdict = judge({
      chairs: 1,
      appointments: [appt({ id: 2, scheduledDate: "2026-10-06", durationMinutes: 240 })],
    });
    expect(verdict.occupiedChairs).toBe(0);
    expect(verdict.state).toBe("AVAILABLE");
  });

  it("وموعدٌ قائم بلا فواصل مخزَّنة يُقرأ صفرًا ولا يسقط من الحساب", () => {
    /* المواعيد المحجوزة قبل المرحلة ٤ب لا تحمل حقلي الفاصل. فلو عوملت
       `undefined` كموعدٍ بلا نافذة، اختفى جدول الأمس من حساب الزحمة اليوم. */
    const legacy: Appointment = {
      id: 2, patientId: 1, patientName: "مريضٌ قديم", patientPhone: null,
      scheduledDate: DATE, scheduledTime: "10:00", durationMinutes: 60,
      note: null, status: "booked",
    };
    const verdict = judge({ chairs: 1, appointments: [legacy] });
    expect(verdict.occupiedChairs).toBe(1);
    expect(verdict.dayPercent).toBe(17);
    expect(verdict.state).toBe("OVER_CAPACITY");
  });
});
