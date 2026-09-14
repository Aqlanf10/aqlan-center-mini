import { describe, expect, it } from "vitest";
import {
  MAX_WAIT_DURATION,
  MIN_WAIT_DURATION,
  NOON_MINUTES,
  OPEN_STATUSES,
  PERIODS,
  PERIOD_LABEL,
  URGENCIES,
  URGENCY_LABEL,
  WAITING_STATUS_LABEL,
  describeWindow,
  isExpired,
  matchesSlot,
  periodOf,
  rankCandidates,
  validateWaitingEntry,
  type FreedSlot,
  type PreferredPeriod,
  type WaitingEntry,
  type WaitingStatus,
  type WaitingUrgency,
} from "@/lib/waiting-list";

/* حرفٌ عربيّ واحد يكفي للحكم بأن الرسالة كُتبت للاستقبال لا للمطوّر. */
const ARABIC = /[؀-ۿ]/;

/** منتظِرٌ في الصفّ — كلُّ فحصٍ يغيّر قيدًا واحدًا ليُقرأ كفكرةٍ واحدة. */
const entry = (over: Partial<WaitingEntry> = {}): WaitingEntry => ({
  id: 1,
  patientId: 7,
  serviceId: null,
  doctorId: null,
  earliestDate: null,
  latestDate: null,
  preferredPeriod: "any",
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
  createdAt: "2026-09-01T09:00:00.000Z",
  createdBy: null,
  ...over,
});

/** مكانٌ شغر بإلغاءٍ مفاجئ — اليوم والوقت والمدّة ومن يخدمه. */
const slot = (over: Partial<FreedSlot> = {}): FreedSlot => ({
  date: "2026-10-05",
  time: "10:00",
  durationMinutes: 30,
  serviceId: null,
  doctorId: null,
  ...over,
});

/**
 * هوية المنتظِر ودرجة إلحاحه — سطرٌ بلا مريضٍ معروف لا يُنادى أحدٌ من أجله.
 *
 * صفُّ الانتظار يُكتب على عجلٍ والهاتف في اليد الأخرى، فتُحفظ الخانة قبل اختيار
 * المريض من القائمة. سطرٌ بمعرّفٍ صفرٍ أو كسريّ يبقى في القائمة أبدًا: تراه
 * الاستقبال حين يشغر مكان، ثم لا تجد له اسمًا ولا رقم هاتفٍ تتّصل به، فتتخطّاه.
 * ودرجة إلحاحٍ لا يعرفها النظام تُسقط صاحبها إلى ذيل الترتيب صامتةً — فألمٌ حادّ
 * يُنادى بعد فحصٍ دوريّ.
 */
describe("هوية المنتظِر ودرجة إلحاحه", () => {
  it("معرّف مريضٍ صفرٌ أو سالبٌ أو كسريّ مرفوض", () => {
    expect(validateWaitingEntry(entry({ patientId: 0 }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ patientId: -3 }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ patientId: 1.5 }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ patientId: Number.NaN }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ patientId: 7 }))).toBeNull();
  });

  it("ودرجة إلحاحٍ غير معروفة مرفوضة", () => {
    expect(validateWaitingEntry(entry({ urgency: "critical" as WaitingUrgency }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ urgency: "" as WaitingUrgency }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ urgency: "URGENT" as WaitingUrgency }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ urgency: "urgent" }))).toBeNull();
  });

  it("وفترةٌ مفضّلة غير معروفة مرفوضة", () => {
    expect(validateWaitingEntry(entry({
      preferredPeriod: "afternoon" as PreferredPeriod,
    }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ preferredPeriod: "" as PreferredPeriod }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ preferredPeriod: "morning" }))).toBeNull();
  });
});

/**
 * مدى الانتظار — القيد الذي يقرّر متى يُنادى صاحبه، وأخطرُه ما يُقصيه إلى الأبد.
 *
 * المريض يقول «أيّ يومٍ بعد عودتي من صنعاء» أو «قبل السفر يوم ١٢»، فتكتب
 * الاستقبال التاريخين في خانتين متجاورتين. وتبديلهما سهوًا لا يُنتج خطأً ظاهرًا:
 * السطر يُحفظ ويظهر في القائمة، لكنه لا يطابق يومًا واحدًا مهما شغر من أماكن.
 * فيبقى صاحبه ينتظر مكالمةً لن تأتي، والمركز يظنّ أنه في الصفّ.
 */
describe("مدى انتظار المريض", () => {
  it("مدىً مقلوب مرفوض — النهاية قبل البداية لا تطابق يومًا واحدًا", () => {
    /* لو مرّ لصار سطرًا ميّتًا: `matchesSlot` تشترط `date >= earliest` و
       `date <= latest` معًا، وهما لا يجتمعان — فلا مكانَ يصلح له أبدًا. */
    const inverted = entry({ earliestDate: "2026-10-10", latestDate: "2026-10-05" });
    expect(validateWaitingEntry(inverted)).not.toBeNull();
    expect(matchesSlot(inverted, slot({ date: "2026-10-07" }))).toBe(false);
    expect(matchesSlot(inverted, slot({ date: "2026-10-05" }))).toBe(false);
    expect(matchesSlot(inverted, slot({ date: "2026-10-10" }))).toBe(false);
  });

  it("ويومٌ واحدٌ بعينه مقبول — البداية والنهاية متساويتان", () => {
    expect(validateWaitingEntry(entry({
      earliestDate: "2026-10-05", latestDate: "2026-10-05",
    }))).toBeNull();
  });

  it("وغياب التاريخين معًا مقبول — ومعناه «أيّ وقت» لا «لا وقت»", () => {
    expect(validateWaitingEntry(entry({ earliestDate: null, latestDate: null }))).toBeNull();
    expect(validateWaitingEntry(entry({
      earliestDate: undefined, latestDate: undefined,
    }))).toBeNull();
  });

  it("وتاريخٌ مشوّه الشكل مرفوض في الطرفين", () => {
    expect(validateWaitingEntry(entry({ earliestDate: "2026/10/05" }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ earliestDate: "5-10-2026" }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ earliestDate: "غدًا" }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ latestDate: "2026-10-5" }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ latestDate: "20261005" }))).not.toBeNull();
  });
});

/**
 * المدّة المطلوبة — هي ما يمنع دعوة مريض زراعةٍ إلى فتحة عشر دقائق.
 *
 * المنتظِر يُكتب له ما يحتاجه فعلًا؛ فإن قُبلت مدّةٌ صفرية صار يطابق كلَّ فتحةٍ
 * مهما ضاقت، فتُنادى صاحبةُ الزراعة إلى كرسيٍّ يخلو بعد عشر دقائق وتقف ونصف
 * عملها لم يبدأ. وإن قُبلت مدّةٌ خرافية لم يطابق شيئًا فبقي في القائمة أبدًا.
 */
describe("مدّة الانتظار المطلوبة", () => {
  it("أقلّ من الحدّ الأدنى وأكثر من الأعلى مرفوضتان", () => {
    expect(validateWaitingEntry(entry({
      durationMinutes: MIN_WAIT_DURATION - 1,
    }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ durationMinutes: 0 }))).not.toBeNull();
    expect(validateWaitingEntry(entry({ durationMinutes: -30 }))).not.toBeNull();
    expect(validateWaitingEntry(entry({
      durationMinutes: MAX_WAIT_DURATION + 1,
    }))).not.toBeNull();
  });

  it("والحدّان نفسهما مقبولان", () => {
    expect(validateWaitingEntry(entry({ durationMinutes: MIN_WAIT_DURATION }))).toBeNull();
    expect(validateWaitingEntry(entry({ durationMinutes: MAX_WAIT_DURATION }))).toBeNull();
  });

  it("ومدّةٌ غائبة أو null مقبولة — لا كلُّ منتظِرٍ يُعرف كم يحتاج وقت تسجيله", () => {
    expect(validateWaitingEntry(entry({ durationMinutes: null }))).toBeNull();
    expect(validateWaitingEntry(entry({ durationMinutes: undefined }))).toBeNull();
  });
});

/**
 * لغة الرفض — من يقرأ هذه الرسالة موظّفة استقبالٍ تُمسك هاتفًا، لا مطوِّر.
 *
 * رسالةٌ إنجليزية أو خانةٌ حمراء بلا نصّ تعني أنها ستُعيد المحاولة مرّتين ثم
 * تترك السطر غير محفوظ وتقول للمريض «اتّصل بنا غدًا» — وهو بالضبط الضياع الذي
 * بُني الصفّ ليُنهيه. وفي المقابل: مدخلٌ سليمٌ بالكامل يجب أن يمرّ بلا اعتراض،
 * وإلّا تعلّمت الاستقبال أن الشاشة «تتعب» فهجرتها إلى ورقةٍ على الطاولة.
 */
describe("لغة الرفض وقبول المدخل السليم", () => {
  it("كلّ رسالة رفضٍ نصٌّ عربيّ غير فارغ", () => {
    const rejected: Array<[string, Partial<WaitingEntry>]> = [
      ["مريض صفر", { patientId: 0 }],
      ["مريض كسري", { patientId: 2.5 }],
      ["إلحاح مجهول", { urgency: "critical" as WaitingUrgency }],
      ["فترة مجهولة", { preferredPeriod: "afternoon" as PreferredPeriod }],
      ["بداية مشوّهة", { earliestDate: "2026/10/05" }],
      ["نهاية مشوّهة", { latestDate: "غدًا" }],
      ["مدى مقلوب", { earliestDate: "2026-10-10", latestDate: "2026-10-01" }],
      ["مدّة قصيرة", { durationMinutes: MIN_WAIT_DURATION - 1 }],
      ["مدّة طويلة", { durationMinutes: MAX_WAIT_DURATION + 1 }],
    ];
    for (const [label, patch] of rejected) {
      const message = validateWaitingEntry(entry(patch));
      expect(message, label).toBeTypeOf("string");
      expect(message?.trim().length ?? 0, label).toBeGreaterThan(0);
      expect(message ?? "", label).toMatch(ARABIC);
    }
  });

  it("ومدخلٌ سليم بالكامل يعيد null بلا اعتراض", () => {
    expect(validateWaitingEntry(entry())).toBeNull();
    expect(validateWaitingEntry(entry({
      patientId: 42,
      serviceId: 3,
      doctorId: 2,
      earliestDate: "2026-10-01",
      latestDate: "2026-10-20",
      preferredPeriod: "evening",
      urgency: "urgent",
      durationMinutes: 45,
      note: "يفضّل بعد المغرب",
    }))).toBeNull();
  });
});

/**
 * تصنيف الصباح والمساء — عليه يقوم وعدُ «سأنتظر مكانًا مساءً فقط».
 *
 * مريضٌ يعمل صباحًا يقول صراحةً إنه لا يستطيع المجيء قبل الرابعة. فإن صنّف
 * النظام العاشرة صباحًا «مساءً» نُودي إلى مكانٍ لا يقدر عليه، فاعتذر — وضاعت
 * المكالمة والفتحة معًا، وتعلّمت الاستقبال أن المرشَّحين «غير دقيقين» فتجاهلتهم.
 */
describe("تصنيف الصباح والمساء", () => {
  it("ما قبل الظهر صباحٌ والظهر نفسه فما بعده مساء", () => {
    expect(periodOf("00:00")).toBe("morning");
    expect(periodOf("09:30")).toBe("morning");
    expect(periodOf("11:59")).toBe("morning");
    /* الحدّ نفسه: ١٢:٠٠ مساءٌ لا صباح — يُثبَّت صراحةً لأنه موضع الخلاف. */
    expect(periodOf("12:00")).toBe("evening");
    expect(periodOf("16:00")).toBe("evening");
    expect(periodOf("23:59")).toBe("evening");
    expect(NOON_MINUTES).toBe(720);
  });

  it("ووقتٌ مشوّه يعيد null بدل أن يخمّن", () => {
    expect(periodOf("")).toBeNull();
    expect(periodOf("   ")).toBeNull();
    expect(periodOf("abc")).toBeNull();
    expect(periodOf("10:5")).toBeNull();
    expect(periodOf("24:00")).toBeNull();
    expect(periodOf("10:75")).toBeNull();
  });
});

/**
 * حالة المنتظِر — القائمة تُنادي من ينتظر، لا من انتهى أمره.
 *
 * من حُجز له موعدٌ بالفعل ثم نودي ثانيةً لمكانٍ شاغر يسمع مكالمةً لا يفهمها،
 * ومن ألغى انتظاره بنفسه ثم نودي يظنّ المركز لا يقرأ ما يكتب. والأسوأ عمليًّا:
 * كلُّ اسمٍ ميّت في قائمة المرشَّحين يدفع الاستقبال إلى الاتّصال بثلاثة قبل أن
 * تصل إلى من يهمّه الأمر — وفتحةُ الإلغاء لا تحتمل ثلاث مكالمات.
 */
describe("حالة المنتظِر وترشيحه", () => {
  it("المحجوز والملغى والمنتهي لا يُرشَّحون لمكانٍ شاغر", () => {
    expect(matchesSlot(entry({ status: "booked" }), slot())).toBe(false);
    expect(matchesSlot(entry({ status: "cancelled" }), slot())).toBe(false);
    expect(matchesSlot(entry({ status: "expired" }), slot())).toBe(false);
  });

  it("والمنتظِر والمُنادى وحدهما يُرشَّحان", () => {
    expect(matchesSlot(entry({ status: "waiting" }), slot())).toBe(true);
    expect(matchesSlot(entry({ status: "offered" }), slot())).toBe(true);
    expect([...OPEN_STATUSES].sort()).toEqual(["offered", "waiting"]);
  });
});

/**
 * مدى التاريخ أمام المكان الشاغر — القيد الغائب يعني «أيّ يوم» لا «لا يوم».
 *
 * أكثر من يُسجَّل في الصفّ لا يشترط تاريخًا أصلًا: «متى ما توفّر». فلو عُومل
 * غيابُ التاريخ حاجزًا لصارت القائمة مليئةً بمن لا يُرشَّح أبدًا — تكبر كلَّ
 * أسبوع ولا تُخرج مرشَّحًا واحدًا، فتُهجر ويعود المكان الشاغر يضيع كما كان.
 */
describe("مدى التاريخ أمام المكان الشاغر", () => {
  it("مكانٌ قبل تاريخ البداية لا يصلح، وفي اليوم نفسه يصلح", () => {
    const waiting = entry({ earliestDate: "2026-10-05" });
    expect(matchesSlot(waiting, slot({ date: "2026-10-04" }))).toBe(false);
    expect(matchesSlot(waiting, slot({ date: "2026-10-05" }))).toBe(true);
    expect(matchesSlot(waiting, slot({ date: "2026-10-30" }))).toBe(true);
  });

  it("ومكانٌ بعد تاريخ النهاية لا يصلح، وفي اليوم نفسه يصلح", () => {
    const waiting = entry({ latestDate: "2026-10-05" });
    expect(matchesSlot(waiting, slot({ date: "2026-10-06" }))).toBe(false);
    expect(matchesSlot(waiting, slot({ date: "2026-10-05" }))).toBe(true);
    expect(matchesSlot(waiting, slot({ date: "2026-09-01" }))).toBe(true);
  });

  it("وقيدٌ غائب يعني أيّ يوم — ومن لم يشترط تاريخًا يطابق كلّ مكان", () => {
    const anyDay = entry({ earliestDate: null, latestDate: null });
    expect(matchesSlot(anyDay, slot({ date: "2020-01-01" }))).toBe(true);
    expect(matchesSlot(anyDay, slot({ date: "2026-10-05" }))).toBe(true);
    expect(matchesSlot(anyDay, slot({ date: "2099-12-31" }))).toBe(true);
    /* وطرفٌ واحدٌ غائب يقيّد من جهته وحدها لا من الجهتين. */
    expect(matchesSlot(entry({ earliestDate: "2026-10-05" }), slot({
      date: "2030-01-01",
    }))).toBe(true);
    expect(matchesSlot(entry({ latestDate: "2026-10-05" }), slot({
      date: "2000-01-01",
    }))).toBe(true);
  });
});

/**
 * الفترة المفضّلة — وعدٌ قطعه المركز للمريض حين سجّله، ويُقاس بالمكالمة.
 *
 * كلُّ ترشيحٍ خاطئ هو مكالمةٌ تنتهي باعتذار. وثلاث مكالماتٍ كهذه تكفي لتترك
 * الاستقبال شاشة المرشَّحين وتعود إلى دفترٍ جانبيّ — فتموت الميزة كلُّها لا
 * لأنها لا تعمل، بل لأنها أضاعت وقتًا في أضيق لحظات اليوم.
 */
describe("الفترة المفضّلة", () => {
  it("«أيّ وقت» يقبل الصباح والمساء معًا", () => {
    const anyTime = entry({ preferredPeriod: "any" });
    expect(matchesSlot(anyTime, slot({ time: "09:00" }))).toBe(true);
    expect(matchesSlot(anyTime, slot({ time: "18:30" }))).toBe(true);
  });

  it("ومن فضّل الصباح لا يصلح له مساء، ويصلح له صباح", () => {
    const morning = entry({ preferredPeriod: "morning" });
    expect(matchesSlot(morning, slot({ time: "17:00" }))).toBe(false);
    expect(matchesSlot(morning, slot({ time: "12:00" }))).toBe(false);
    expect(matchesSlot(morning, slot({ time: "09:30" }))).toBe(true);
  });

  it("ومن فضّل المساء لا يصلح له صباح، ويصلح له مساء", () => {
    const evening = entry({ preferredPeriod: "evening" });
    expect(matchesSlot(evening, slot({ time: "10:00" }))).toBe(false);
    expect(matchesSlot(evening, slot({ time: "12:00" }))).toBe(true);
    expect(matchesSlot(evening, slot({ time: "19:00" }))).toBe(true);
  });

  it("ووقتٌ غير مقروء لا يُقصي المريض — العطب في الوقت لا فيه", () => {
    /* إسقاطُ المرشَّحين عند وقتٍ مشوّه يعني أن سطرًا واحدًا فاسدًا في بيانات
       المكان يُفرغ قائمة المرشَّحين كلَّها، فتظنّ الاستقبال أن لا أحد ينتظر. */
    expect(matchesSlot(entry({ preferredPeriod: "morning" }), slot({ time: "" }))).toBe(true);
    expect(matchesSlot(entry({ preferredPeriod: "morning" }), slot({ time: "بعد الظهر" })))
      .toBe(true);
    expect(matchesSlot(entry({ preferredPeriod: "evening" }), slot({ time: "25:00" }))).toBe(true);
  });
});

/**
 * الطبيب المطلوب — «أنا مريض الدكتور عقلان» شرطٌ حقيقيّ في مركزٍ فيه أكثر من طبيب.
 *
 * مريض تقويمٍ في منتصف خطّة علاجٍ لا يصلح له كرسيُّ طبيبٍ آخر شغر فجأة، وترشيحه
 * يُنتج مكالمةً محرجة. وفي المقابل: مكانٌ شغر ولم يُسند بعدُ إلى طبيب ليس سببًا
 * لإقصاء أحد — الاستقبال هي من تُسنده حين تحجز، والقائمة تقترح ولا تحجز.
 */
describe("الطبيب المطلوب", () => {
  it("طبيبٌ مطلوبٌ ومكانٌ عند غيره لا يصلح", () => {
    expect(matchesSlot(entry({ doctorId: 3 }), slot({ doctorId: 9 }))).toBe(false);
  });

  it("والطبيب نفسه يصلح", () => {
    expect(matchesSlot(entry({ doctorId: 3 }), slot({ doctorId: 3 }))).toBe(true);
  });

  it("ومن لم يطلب طبيبًا يقبل مكانًا عند أيّ طبيب", () => {
    expect(matchesSlot(entry({ doctorId: null }), slot({ doctorId: 9 }))).toBe(true);
    expect(matchesSlot(entry({ doctorId: undefined }), slot({ doctorId: 9 }))).toBe(true);
  });

  it("ومن طلب طبيبًا يقبل مكانًا بلا طبيبٍ محدَّد — الاستقبال تُسنده", () => {
    expect(matchesSlot(entry({ doctorId: 3 }), slot({ doctorId: null }))).toBe(true);
    expect(matchesSlot(entry({ doctorId: 3 }), slot({ doctorId: undefined }))).toBe(true);
  });
});

/**
 * سعة المكان الشاغر — الفتحة التي لا تتّسع للعمل ليست فتحةً لهذا المريض.
 *
 * إلغاءُ متابعةِ تقويمٍ يُفرج عن عشر دقائق، وإلغاءُ زراعةٍ يُفرج عن تسعين. فإن
 * رُشِّح صاحب التسعين للعشر جاء وجلس ثم قيل له «لن نُكمل اليوم»، وتأخّر من بعده
 * في الصالة — وهي الزحمة نفسها التي بُني المحرّك ليمنعها، تدخل من الباب الخلفيّ.
 */
describe("سعة المكان الشاغر", () => {
  it("من يحتاج تسعين دقيقة لا يصلح له مكانٌ ثلاثون", () => {
    expect(matchesSlot(entry({ durationMinutes: 90 }), slot({ durationMinutes: 30 }))).toBe(false);
    expect(matchesSlot(entry({ durationMinutes: 31 }), slot({ durationMinutes: 30 }))).toBe(false);
  });

  it("والمساواة تسع — ثلاثون في ثلاثين، وما دونها أوسع", () => {
    expect(matchesSlot(entry({ durationMinutes: 30 }), slot({ durationMinutes: 30 }))).toBe(true);
    expect(matchesSlot(entry({ durationMinutes: 20 }), slot({ durationMinutes: 30 }))).toBe(true);
    expect(matchesSlot(entry({ durationMinutes: 90 }), slot({ durationMinutes: 90 }))).toBe(true);
  });

  it("ومن لم يحدّد مدّةً يقبل أيّ مكانٍ مهما ضاق", () => {
    expect(matchesSlot(entry({ durationMinutes: null }), slot({ durationMinutes: 5 }))).toBe(true);
    expect(matchesSlot(entry({ durationMinutes: undefined }), slot({
      durationMinutes: 5,
    }))).toBe(true);
  });
});

/**
 * ترتيب المرشَّحين — هو القائمة التي تقرأ منها الاستقبال الأسماء بالترتيب.
 *
 * والفتحة لا تحتمل إلا مكالمتين أو ثلاثًا، فأوّل ثلاثة أسماءٍ هم الميزة كلُّها.
 * ترتيبٌ يبدأ بالأحدث تسجيلًا يعني أن من انتظر شهرًا لا يُنادى أبدًا، لأن كلَّ
 * يومٍ يأتي من يسبقه إلى الصدارة — فيتراكم القدامى في الذيل ويهجرون المركز
 * صامتين، وهو بالضبط كيف تموت قوائم الانتظار في العيادات.
 */
describe("ترتيب المرشَّحين لمكانٍ شاغر", () => {
  it("من لا يصلح له المكان لا يظهر في القائمة أصلًا", () => {
    const pool = [
      entry({ id: 1, status: "booked" }),
      entry({ id: 2, preferredPeriod: "evening" }),
      entry({ id: 3, durationMinutes: 90 }),
      entry({ id: 4, doctorId: 8 }),
      entry({ id: 5, latestDate: "2026-09-01" }),
      entry({ id: 6 }),
    ];
    const ranked = rankCandidates(pool, slot({ time: "10:00", durationMinutes: 30, doctorId: 2 }));
    expect(ranked.map((candidate) => candidate.id)).toEqual([6]);
  });

  it("والعاجل قبل القريب قبل العادي", () => {
    const pool = [
      entry({ id: 1, urgency: "normal" }),
      entry({ id: 2, urgency: "urgent" }),
      entry({ id: 3, urgency: "soon" }),
    ];
    expect(rankCandidates(pool, slot()).map((candidate) => candidate.urgency))
      .toEqual(["urgent", "soon", "normal"]);
  });

  it("وفي درجة الإلحاح نفسها: أقدمهم انتظارًا أوّلًا", () => {
    const pool = [
      entry({ id: 1, createdAt: "2026-09-10T08:00:00.000Z" }),
      entry({ id: 2, createdAt: "2026-08-01T08:00:00.000Z" }),
      entry({ id: 3, createdAt: "2026-09-01T08:00:00.000Z" }),
    ];
    expect(rankCandidates(pool, slot()).map((candidate) => candidate.id)).toEqual([2, 3, 1]);
  });

  it("والإلحاح يسبق القِدَم — عاجلٌ سجّل اليوم قبل عاديٍّ انتظر شهرًا", () => {
    const pool = [
      entry({ id: 1, urgency: "normal", createdAt: "2026-08-01T08:00:00.000Z" }),
      entry({ id: 2, urgency: "urgent", createdAt: "2026-09-13T08:00:00.000Z" }),
    ];
    expect(rankCandidates(pool, slot()).map((candidate) => candidate.id)).toEqual([2, 1]);
  });

  it("والتساوي التامّ يُحسم بالمعرّف — القائمة نفسها في كلّ استعلام", () => {
    /* صفّان سُجّلا في اللحظة نفسها يجب ألّا يتبادلا موقعيهما بين استعلامين،
       وإلّا قرأت الاستقبال قائمتين مختلفتين للحال نفسه فشكّت في الاثنتين. */
    const born = "2026-09-01T08:00:00.000Z";
    const ids = [4, 1, 3, 2, 5];
    const first = rankCandidates(ids.map((id) => entry({ id, createdAt: born })), slot());
    const second = rankCandidates(
      [...ids].reverse().map((id) => entry({ id, createdAt: born })), slot(),
    );
    expect(first.map((candidate) => candidate.id)).toEqual([1, 2, 3, 4, 5]);
    expect(second.map((candidate) => candidate.id)).toEqual(first.map((c) => c.id));
  });

  it("ولا مرشَّح يعني قائمةً فارغة، والمُدخَل لا يُمسّ", () => {
    const pool = [
      entry({ id: 1, urgency: "normal", preferredPeriod: "morning" }),
      entry({ id: 2, urgency: "urgent", preferredPeriod: "morning" }),
      entry({ id: 3, urgency: "soon", preferredPeriod: "morning" }),
    ];
    const snapshot = pool.map((candidate) => candidate.id);
    expect(rankCandidates(pool, slot({ time: "17:00" }))).toEqual([]);
    expect(rankCandidates([], slot())).toEqual([]);
    rankCandidates(pool, slot());
    expect(pool.map((candidate) => candidate.id)).toEqual(snapshot);
  });
});

/**
 * انتهاء صلاحية الانتظار — إسقاطُ اسمٍ من القائمة قرارُ مالكٍ لا سلوكُ نظام.
 *
 * المريض الذي يُحذف اسمه بعد أسبوعين لا يعرف أنه حُذف؛ يظلّ ينتظر مكالمةً سقطت
 * من النظام صامتةً، ثم يتّصل بعد شهرٍ فيُقال له «لست في القائمة». فالافتراضيّ
 * صفرٌ — أي بلا انتهاء — حتى يقرّر المالك مدّةً بنفسه؛ والمحجوز أو الملغى لا
 * يُعدّ منتهيًا أصلًا فلا يظهر في تقرير «منتهون» ويُربك من يراجعه.
 */
describe("انتهاء صلاحية الانتظار", () => {
  it("صفرٌ يعني بلا انتهاء — ولو مضت سنةٌ ونصف", () => {
    expect(isExpired(entry({ createdAt: "2025-01-01T08:00:00.000Z" }), "2026-09-14", 0))
      .toBe(false);
    /* وقيمةٌ سالبة تُعامَل صفرًا — لا انتهاءَ بأثرٍ رجعيّ. */
    expect(isExpired(entry({ createdAt: "2025-01-01T08:00:00.000Z" }), "2026-09-14", -5))
      .toBe(false);
  });

  it("وبأربعة عشر يومًا: من مضى عليه عشرون منتهٍ ومن مضى عليه عشرة لا", () => {
    const born = entry({ createdAt: "2026-09-01T09:00:00.000Z" });
    expect(isExpired(born, "2026-09-21", 14)).toBe(true);
    expect(isExpired(born, "2026-09-11", 14)).toBe(false);
  });

  it("وفي اليوم الرابع عشر بالضبط لم ينتهِ بعد — الانتهاء بتجاوز المدّة لا ببلوغها", () => {
    /* سلوكٌ مُثبَّت كما هو في الشيفرة: الشرط `> days` لا `>= days`. فمن سُجّل
       يوم ١ ينتهي فجر اليوم الخامس عشر لا الرابع عشر — ويومٌ إضافيّ في صالح
       المريض أسلمُ من إسقاطه قبل انقضاء المدّة التي وُعد بها. */
    const born = entry({ createdAt: "2026-09-01T09:00:00.000Z" });
    expect(isExpired(born, "2026-09-15", 14)).toBe(false);
    expect(isExpired(born, "2026-09-16", 14)).toBe(true);
  });

  it("ومن حُجز أو أُلغي أو انتهى لا يُعدّ منتهيًا مهما طال", () => {
    const ancient = "2020-01-01T08:00:00.000Z";
    expect(isExpired(entry({ createdAt: ancient, status: "booked" }), "2026-09-14", 14))
      .toBe(false);
    expect(isExpired(entry({ createdAt: ancient, status: "cancelled" }), "2026-09-14", 14))
      .toBe(false);
    expect(isExpired(entry({ createdAt: ancient, status: "expired" }), "2026-09-14", 14))
      .toBe(false);
    expect(isExpired(entry({ createdAt: ancient, status: "waiting" }), "2026-09-14", 14))
      .toBe(true);
    expect(isExpired(entry({ createdAt: ancient, status: "offered" }), "2026-09-14", 14))
      .toBe(true);
  });
});

/**
 * وصف المدى للعرض — السطر الذي تقرؤه الاستقبال قبل أن تضغط زرّ الاتّصال.
 *
 * «٢٠٢٦-١٠-٠١ / ٢٠٢٦-١٠-٠١» سطرٌ يُقرأ مرّتين قبل أن يُفهم أنه يومٌ واحد،
 * وخانتان فارغتان تُقرآن «لا يوجد قيد» أو «ناقص البيانات» بحسب من ينظر. وفي
 * لحظةٍ بين مريضين لا يُعاد قراءة سطرٍ غامض — يُتخطّى إلى الذي يليه.
 */
describe("وصف مدى الانتظار للعرض", () => {
  it("التاريخان المختلفان: من … إلى …", () => {
    expect(describeWindow(entry({ earliestDate: "2026-10-01", latestDate: "2026-10-09" })))
      .toBe("من 2026-10-01 إلى 2026-10-09");
  });

  it("واليوم الواحد يُكتب يومًا لا مدىً", () => {
    expect(describeWindow(entry({ earliestDate: "2026-10-05", latestDate: "2026-10-05" })))
      .toBe("يوم 2026-10-05");
  });

  it("والبداية وحدها «فصاعدًا»، والنهاية وحدها «حتى»", () => {
    expect(describeWindow(entry({ earliestDate: "2026-10-01", latestDate: null })))
      .toBe("من 2026-10-01 فصاعدًا");
    expect(describeWindow(entry({ earliestDate: null, latestDate: "2026-10-09" })))
      .toBe("حتى 2026-10-09");
  });

  it("ولا قيدَ أصلًا: أيّ وقت", () => {
    expect(describeWindow(entry({ earliestDate: null, latestDate: null }))).toBe("أيّ وقت");
    expect(describeWindow(entry({ earliestDate: undefined, latestDate: undefined })))
      .toBe("أيّ وقت");
  });

  it("وكلّ وصفٍ نصٌّ عربيّ غير فارغ", () => {
    const windows: Array<Partial<WaitingEntry>> = [
      { earliestDate: "2026-10-01", latestDate: "2026-10-09" },
      { earliestDate: "2026-10-05", latestDate: "2026-10-05" },
      { earliestDate: "2026-10-01", latestDate: null },
      { earliestDate: null, latestDate: "2026-10-09" },
      { earliestDate: null, latestDate: null },
    ];
    for (const window of windows) {
      const text = describeWindow(entry(window));
      expect(text.trim().length, JSON.stringify(window)).toBeGreaterThan(0);
      expect(text, JSON.stringify(window)).toMatch(ARABIC);
    }
  });
});

/**
 * التسميات العربية — مفتاحٌ لاتينيّ يظهر في شاشةٍ عربية يوقف العمل لا يُشوّهه فقط.
 *
 * حالةٌ بلا تسمية تظهر «offered» أو فراغًا في عمودٍ تُصفّي به الاستقبال القائمة،
 * فلا تعرف من نُودي ومن لم يُنادَ بعد — فتُعيد الاتّصال بمن اتّصلت به قبل ساعة.
 * والقوائم تنمو بالحالات والدرجات، فالحارس لازمٌ لا زينة.
 */
describe("تسميات القائمة العربية", () => {
  it("لكلّ درجة إلحاحٍ تسميةٌ عربية غير فارغة", () => {
    expect(URGENCIES.length).toBeGreaterThan(0);
    for (const urgency of URGENCIES) {
      const label = URGENCY_LABEL[urgency];
      expect(label, urgency).toBeTypeOf("string");
      expect(label.trim().length, urgency).toBeGreaterThan(0);
      expect(label, urgency).toMatch(ARABIC);
    }
    expect([...URGENCIES].sort()).toEqual(Object.keys(URGENCY_LABEL).sort());
  });

  it("ولكلّ فترةٍ مفضّلة تسميةٌ عربية غير فارغة", () => {
    expect(PERIODS.length).toBeGreaterThan(0);
    for (const period of PERIODS) {
      const label = PERIOD_LABEL[period];
      expect(label, period).toBeTypeOf("string");
      expect(label.trim().length, period).toBeGreaterThan(0);
      expect(label, period).toMatch(ARABIC);
    }
    expect([...PERIODS].sort()).toEqual(Object.keys(PERIOD_LABEL).sort());
  });

  it("ولكلّ حالةٍ في الصفّ تسميةٌ عربية غير فارغة", () => {
    const statuses = Object.keys(WAITING_STATUS_LABEL) as WaitingStatus[];
    expect(statuses).toEqual(
      expect.arrayContaining(["waiting", "offered", "booked", "cancelled", "expired"]),
    );
    for (const status of statuses) {
      const label = WAITING_STATUS_LABEL[status];
      expect(label, status).toBeTypeOf("string");
      expect(label.trim().length, status).toBeGreaterThan(0);
      expect(label, status).toMatch(ARABIC);
    }
    for (const open of OPEN_STATUSES) {
      expect(statuses, open).toContain(open);
    }
  });
});

/**
 * التاريخُ المستحيل — عطبٌ يدخل من خطأٍ مطبعيّ واحد.
 *
 * فحصُ المدى المقلوب موجودٌ لأنّ مدىً لا يطابق يومًا يُبقي المريض في القائمة
 * أبدًا بلا نداء. و«٣٠ فبراير» يصنع الأثر نفسه بالضبط: شكلُه سليم، ولا يوجد
 * في التقويم. فمن كتب ٣٠ وهو يريد ٢٠ لا يعرف أنّ مريضه صار صفًّا ميّتًا.
 */
describe("التواريخ المستحيلة تُردّ كما يُردّ المدى المقلوب", () => {
  it("«٣٠ فبراير» يُردّ برسالةٍ عربية لا يُقبل بصمت", () => {
    const problem = validateWaitingEntry(entry({ earliestDate: "2026-02-30" }));
    expect(problem).not.toBeNull();
    expect(problem!).toMatch(ARABIC);
  });

  it("و«الشهر الثالث عشر» كذلك", () => {
    expect(validateWaitingEntry(entry({ latestDate: "2026-13-05" }))).not.toBeNull();
  });

  it("و٢٩ فبراير في سنةٍ كبيسة يُقبل — الحارس يفرّق ولا يُعمَّم", () => {
    /* ٢٠٢٨ كبيسة. حارسٌ يرفض كلّ ما لم يفهمه يمنع حجوزًا صحيحة. */
    expect(validateWaitingEntry(entry({
      earliestDate: "2028-02-29", latestDate: "2028-03-01",
    }))).toBeNull();
  });

  it("و٢٩ فبراير في سنةٍ غير كبيسة يُردّ", () => {
    expect(validateWaitingEntry(entry({ earliestDate: "2026-02-29" }))).not.toBeNull();
  });
});

/**
 * المدّة عددٌ صحيح.
 *
 * «١٢٫٥ دقيقة» ليست مدّةً يفهمها أحد، و`validateService` في كتالوج الخدمات
 * يردّها. وتركُ الوحدتين تختلفان فيما تقبلانه هو أوّل ما يفترقان فيه.
 */
describe("المدّة الكسرية تُردّ", () => {
  it("١٢٫٥ دقيقة تُردّ", () => {
    expect(validateWaitingEntry(entry({ durationMinutes: 12.5 }))).not.toBeNull();
  });

  it("والعدد الصحيح داخل المدى يُقبل", () => {
    expect(validateWaitingEntry(entry({ durationMinutes: 30 }))).toBeNull();
  });
});

/**
 * من نودي ولم يُحسم أمره — لا يُسقَط ولا يُقدَّم.
 *
 * مريضٌ اتُّصل به ولم يردّ يبقى مرشَّحًا: إسقاطُه يعني أنّ مكالمةً واحدةً لم
 * يردّ عليها تُخرجه من القائمة بلا قرارٍ من أحد. لكنه يأتي **بعد** من لم يُنادَ
 * بعد — وإلا عاودت الاستقبال الاتصال بمن كلّمته للتوّ بينما ينتظر غيرُه مكالمته
 * الأولى، فتبدو القائمة كأنها تدور على الاسم نفسه.
 */
describe("ترتيب من نودي بالنسبة لمن ينتظر", () => {
  it("من لم يُنادَ يسبق من نودي — ولو تساويا في الإلحاح والأقدمية", () => {
    const called = entry({
      id: 1, status: "offered", urgency: "normal", createdAt: "2026-01-01T08:00:00.000Z",
    });
    const fresh = entry({
      id: 2, status: "waiting", urgency: "normal", createdAt: "2026-01-01T08:00:00.000Z",
    });
    const ranked = rankCandidates([called, fresh], slot());
    expect(ranked.map((row) => row.id)).toEqual([2, 1]);
  });

  it("ومن نودي يبقى في الترشيح — لا يسقط من القائمة", () => {
    const called = entry({ id: 1, status: "offered" });
    expect(rankCandidates([called], slot()).map((row) => row.id)).toEqual([1]);
  });

  it("والإلحاح يظلّ يسبق داخل كل مجموعة", () => {
    const urgentCalled = entry({ id: 1, status: "offered", urgency: "urgent" });
    const normalCalled = entry({ id: 2, status: "offered", urgency: "normal" });
    const normalFresh = entry({ id: 3, status: "waiting", urgency: "normal" });
    const ranked = rankCandidates([normalCalled, urgentCalled, normalFresh], slot());
    /* من لم يُنادَ أولًا، ثم المنادَون بينهم بالإلحاح. */
    expect(ranked.map((row) => row.id)).toEqual([3, 1, 2]);
  });
});
