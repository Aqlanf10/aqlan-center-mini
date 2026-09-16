/**
 * قائمة الانتظار — المنطق الخالص.
 *
 * المرحلة ٤ب جعلت المحرّك يرفض الحجز حين يمتلئ اليوم. والرفض صواب، لكنه بلا
 * وجهةٍ يعني مريضًا ضاع: تقول له الاستقبال «لا يوجد مكان» فيُغلق الهاتف، ثم
 * يُلغي مريضٌ آخر موعده بعد ساعتين فيبقى الكرسي فارغًا ولا أحد يعرف من يُنادى.
 *
 * فهذه الوحدة هي الجانب الآخر من الحارس: **من رُدّ يُكتب، ومن أُفرج له مكانٌ
 * يُنادى**. وهي ليست طابور صالة الانتظار — ذاك من حضر، وهذه من لم يجد موعدًا.
 *
 * والقاعدة المُلزمة: **تقترح ولا تحجز**. موعدٌ يُفرض على مريضٍ لم يؤكّد هو وعدٌ
 * لا يستطيع المركز الوفاء به؛ والسابقة في `booking.ts` نفسها — المريض يطلب
 * ولا يحجز. فالمخرَج هنا مرشَّحون تُنادِيهم الاستقبال، لا حجوزاتٌ تُكتب وحدها.
 */

export type WaitingUrgency = "urgent" | "soon" | "normal";

export const URGENCY_LABEL: Record<WaitingUrgency, string> = {
  urgent: "عاجل",
  soon: "قريب",
  normal: "عادي",
};

/** ترتيبُ الإلحاح — الأصغر أسبق. ألمٌ حادّ لا ينتظر كما ينتظر فحصٌ دوريّ. */
const URGENCY_RANK: Record<WaitingUrgency, number> = { urgent: 0, soon: 1, normal: 2 };

export const URGENCIES = Object.keys(URGENCY_LABEL) as WaitingUrgency[];

export type WaitingStatus = "waiting" | "offered" | "booked" | "cancelled" | "expired";

export const WAITING_STATUS_LABEL: Record<WaitingStatus, string> = {
  waiting: "ينتظر",
  offered: "نودي",
  booked: "حُجز",
  cancelled: "أُلغي",
  expired: "انتهى",
};

/** الحالات التي ما زالت تنتظر مكانًا — وحدها تُرشَّح لمكانٍ شاغر. */
export const OPEN_STATUSES: readonly WaitingStatus[] = ["waiting", "offered"];

export type PreferredPeriod = "morning" | "evening" | "any";

export const PERIOD_LABEL: Record<PreferredPeriod, string> = {
  morning: "صباحًا",
  evening: "مساءً",
  any: "أيّ وقت",
};

export const PERIODS = Object.keys(PERIOD_LABEL) as PreferredPeriod[];

/**
 * الوردية المفضّلة — من ورديات المركز المُهيّأة لا من منتصف النهار.
 *
 * كانت القسمة `قبل ١٢:٠٠ صباحًا / بعدها مساءً` مكتوبةً في هذه الوحدة، مستقلّةً
 * عن الورديات التي هيّأها المالك في المرحلة ٤ب. فمركزٌ يعمل ١٦:٠٠–٢٢:٠٠ كان كلُّ
 * أوقاته «مساءً»، ومركزٌ بورديتين ٠٩–١٣ و١٦–٢١ كانت ١٢:٣٠ عنده «مساءً» وهي خارج
 * الدوام أصلًا. وتقويمان في نظامٍ واحد يفترقان يوم يُعدَّل أحدهما.
 */
export type PreferredShift = "any" | "shift1" | "shift2";

export const SHIFT_LABEL: Record<PreferredShift, string> = {
  any: "أيّ وردية",
  shift1: "الوردية الأولى",
  shift2: "الوردية الثانية",
};

export const SHIFTS = Object.keys(SHIFT_LABEL) as PreferredShift[];

/** ترقيم ISO: ١ الاثنين … ٧ الأحد. رقمٌ ثابتٌ هوية، والاسم العربيّ عرض. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  1: "الاثنين", 2: "الثلاثاء", 3: "الأربعاء", 4: "الخميس",
  5: "الجمعة", 6: "السبت", 7: "الأحد",
};

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as Weekday[];

/** يومُ الأسبوع بترقيم ISO لتاريخٍ بصيغة YYYY-MM-DD. */
export function isoWeekday(dateISO: string): Weekday | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null;
  const parsed = new Date(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  const day = parsed.getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
}

/**
 * تنقيةُ الأيام المفضّلة — الفراغ يعني «أيّ يوم».
 *
 * ويُردّ `null` على أيّ قيمةٍ خارج ١..٧ بدل تجاهلها بصمت: يومٌ يُهمل بلا خبر
 * يجعل المريض يظنّ أنه حدّد الخميس وهو غير محدَّد.
 */
export function normalizeWeekdays(raw: unknown): Weekday[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: Weekday[] = [];
  for (const value of raw) {
    const day = Number(value);
    if (!Number.isInteger(day) || day < 1 || day > 7) return null;
    if (!out.includes(day as Weekday)) out.push(day as Weekday);
  }
  return out.sort((a, b) => a - b);
}

/** نتيجةُ محاولة اتصال — مفرداتٌ صغيرة تصف ما جرى فعلًا. */
export type ContactOutcome =
  | "accepted" | "declined_slot" | "no_answer" | "busy"
  | "call_back" | "not_available" | "wrong_number" | "no_longer_needed";

export const CONTACT_OUTCOME_LABEL: Record<ContactOutcome, string> = {
  accepted: "قَبِل الموعد",
  declined_slot: "رفض هذا الموعد",
  no_answer: "لم يردّ",
  busy: "مشغول",
  call_back: "يُعاود الاتصال",
  not_available: "غير متاح حاليًّا",
  wrong_number: "رقم خطأ",
  no_longer_needed: "لم يعد يحتاج",
};

export const CONTACT_OUTCOMES = Object.keys(CONTACT_OUTCOME_LABEL) as ContactOutcome[];

export type ContactChannel = "phone" | "whatsapp" | "other";

export const CONTACT_CHANNEL_LABEL: Record<ContactChannel, string> = {
  phone: "هاتف",
  whatsapp: "واتساب",
  other: "أخرى",
};

export const CONTACT_CHANNELS = Object.keys(CONTACT_CHANNEL_LABEL) as ContactChannel[];

/** محاولةُ اتصالٍ واحدة — تُضاف ولا يُكتب فوقها. */
export interface ContactEvent {
  id: string;
  waitingListId: number;
  contactedAt: string;
  contactedBy: string;
  contactedByRole: string | null;
  channel: ContactChannel;
  outcome: ContactOutcome;
  note: string | null;
  slotDate: string | null;
  slotTime: string | null;
  appointmentId: number | null;
}

/** حدُّ الصباح والمساء — الظهر. وهو تصنيفُ عرضٍ لا قاعدةُ سعة. */
export const NOON_MINUTES = 12 * 60;

export interface WaitingEntryInput {
  patientId: number;
  /** أيامٌ مفضّلة بترقيم ISO — الفراغ يعني «أيّ يوم». */
  preferredDays?: Weekday[];
  /** الوردية المفضّلة من ورديات المركز المُهيّأة. */
  preferredShift?: PreferredShift;
  /** هل يقبل مكانًا **اليوم** — بتوقيت المركز لا بتوقيت المتصفّح. */
  sameDayAvailable?: boolean;
  serviceId?: number | null;
  doctorId?: number | null;
  earliestDate?: string | null;
  latestDate?: string | null;
  preferredPeriod: PreferredPeriod;
  urgency: WaitingUrgency;
  durationMinutes?: number | null;
  note?: string | null;
}

export interface WaitingEntry extends WaitingEntryInput {
  id: number;
  status: WaitingStatus;
  offeredAt: string | null;
  offeredBy: string | null;
  appointmentId: number | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionReason: string | null;
  createdAt: string;
  createdBy: string | null;
  /** ختمُ مطالبةِ التحويل إلى موعد — يمنع حاجزَين على الصفّ نفسه. */
  bookingClaimAt?: string | null;
  /* ملخَّصُ الاتصال — مشتقٌّ من أحداثه، والأحداثُ هي المرجع. */
  contactAttempts?: number;
  lastOutcome?: ContactOutcome | null;
  lastContactAt?: string | null;
  /** علامةُ مراجعةٍ حين يضبط المالك مدّة بقاء. لا حذف. */
  isStale?: boolean;
  /** يُملأ للعرض — لا يُخزَّن في صفّ الانتظار. */
  patientName?: string;
  patientPhone?: string | null;
  serviceName?: string | null;
  doctorName?: string | null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * تاريخٌ موجودٌ في التقويم لا مجرّدُ شكلٍ صحيح.
 *
 * النمط يفحص الشكل ولا يعرف أنّ فبراير ٢٨ يومًا. و«2026-02-30» يمرّ منه، ثم لا
 * يطابق يومًا واحدًا في الوجود — فيبقى المريض في القائمة أبدًا ولا يُنادى. وهو
 * بالضبط العطب الذي يمنعه فحصُ المدى المقلوب، يدخل من باب خطأٍ مطبعيّ واحد.
 */
function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
}

export const MIN_WAIT_DURATION = 5;
export const MAX_WAIT_DURATION = 480;

/** فحصُ المدخلات — والرسائل عربية لأنّ من يقرؤها موظّفة الاستقبال. */
export function validateWaitingEntry(input: WaitingEntryInput): string | null {
  if (!Number.isInteger(input.patientId) || input.patientId <= 0) {
    return "اختر المريض أولًا.";
  }
  if (!URGENCIES.includes(input.urgency)) return "درجة الإلحاح غير معروفة.";
  if (!PERIODS.includes(input.preferredPeriod)) return "الفترة المفضّلة غير معروفة.";

  const earliest = input.earliestDate ?? null;
  const latest = input.latestDate ?? null;
  if (earliest && !isRealDate(earliest)) return "تاريخ البداية غير صالح.";
  if (latest && !isRealDate(latest)) return "تاريخ النهاية غير صالح.";
  /* مدىً مقلوب ليس تشدّدًا: «من ١٠ إلى ٥» لا يطابق يومًا واحدًا، فيبقى المريض
     في القائمة أبدًا ولا يُنادى — وهو أسوأ من رفضٍ صريح عند الإدخال. */
  if (earliest && latest && latest < earliest) {
    return "تاريخ النهاية يجب أن يكون بعد تاريخ البداية.";
  }

  if (input.durationMinutes != null) {
    const duration = Number(input.durationMinutes);
    /* عددٌ صحيح كـ`validateService`: «١٢٫٥ دقيقة» ليست مدّةً يفهمها أحد، وتركُ
       الوحدتين تختلفان فيما تقبلانه هو أوّل ما يفترقان فيه. */
    if (!Number.isInteger(duration) || duration < MIN_WAIT_DURATION
      || duration > MAX_WAIT_DURATION) {
      return `المدّة يجب أن تكون بين ${MIN_WAIT_DURATION} و${MAX_WAIT_DURATION} دقيقة.`;
    }
  }
  return null;
}

/** مكانٌ شغر — تاريخٌ ووقتٌ ومدّة، ومن يخدمه. */
export interface FreedSlot {
  date: string;
  time: string;
  durationMinutes: number;
  serviceId?: number | null;
  doctorId?: number | null;
}

const toMinutes = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
};

export function periodOf(time: string): PreferredPeriod | null {
  const minutes = toMinutes(time);
  if (minutes === null) return null;
  return minutes < NOON_MINUTES ? "morning" : "evening";
}

/**
 * هل يصلح هذا المكان لهذا المنتظِر؟
 *
 * كلُّ قيدٍ **غائبٍ** يعني «لا يهمّني»، لا «لا يصلح». فمريضٌ لم يحدّد طبيبًا
 * يقبل أيّ طبيب؛ ومن لم يحدّد مدىً يقبل أيّ يوم. وافتراضُ العكس يُبقي القائمة
 * مليئةً بمن لا يُنادَون أبدًا.
 */
/** الورديات المُهيّأة كما يقرؤها محرّك السعة — تُمرَّر ولا تُعاد صياغتها هنا. */
export interface ShiftWindow { start: string; end: string }

/**
 * أيُّ ورديةٍ مُهيّأة يقع فيها هذا الوقت.
 *
 * الترتيب من `usableShifts` في محرّك السعة: الأولى أبكرهما بداية. ووقتٌ خارج
 * الورديات كلِّها يعيد `null` — وهو ليس عطبًا: طوارئُ الأسنان تقع خارج الدوام.
 */
export function shiftOfTime(
  time: string, shifts: readonly ShiftWindow[],
): "shift1" | "shift2" | null {
  const minutes = toMinutes(time);
  if (minutes === null) return null;
  const usable = shifts
    .map((shift) => ({ start: toMinutes(shift.start), end: toMinutes(shift.end) }))
    .filter((shift): shift is { start: number; end: number } =>
      shift.start !== null && shift.end !== null && shift.end > shift.start)
    .sort((a, b) => a.start - b.start);
  const index = usable.findIndex(
    (shift) => minutes >= shift.start && minutes < shift.end,
  );
  if (index === 0) return "shift1";
  if (index === 1) return "shift2";
  return null;
}

/** كم ورديةً يشغّلها المركز فعلًا — يحدّد هل «الثانية» تفضيلٌ قابل للتحقّق. */
export function configuredShiftCount(shifts: readonly ShiftWindow[]): number {
  return shifts.filter((shift) => {
    const start = toMinutes(shift.start);
    const end = toMinutes(shift.end);
    return start !== null && end !== null && end > start;
  }).length;
}

/** الحقائق التي بُني عليها الترشيح — تُعرض للمستخدم بدل رقمٍ غامض. */
export interface MatchFacts {
  serviceMatch: "exact" | "unknown" | "none";
  dayMatch: boolean | null;
  shiftMatch: boolean | null;
  providerMatch: boolean | null;
  sameDay: boolean;
  previouslyContacted: boolean;
  waitingDays: number;
}

export interface MatchContext {
  shifts: readonly ShiftWindow[];
  /** «اليوم» بتوقيت المركز — يُمرَّر ولا يُشتقّ من ساعة المتصفّح. */
  clinicToday: string;
}

export function matchesSlot(
  entry: WaitingEntry, slot: FreedSlot, context?: MatchContext,
): boolean {
  if (!OPEN_STATUSES.includes(entry.status)) return false;

  if (entry.earliestDate && slot.date < entry.earliestDate) return false;
  if (entry.latestDate && slot.date > entry.latestDate) return false;

  /* ١) الأيام المفضّلة — الفراغ «أيّ يوم»، والتحديدُ يُقصي ما سواه. */
  const days = entry.preferredDays ?? [];
  if (days.length > 0) {
    const weekday = isoWeekday(slot.date);
    /* تاريخٌ غير مقروء لا يُقصي أحدًا — العطب في التاريخ لا في المريض. */
    if (weekday !== null && !days.includes(weekday)) return false;
  }

  /* ٢) إتاحة اليوم نفسه — «اليوم» بتوقيت المركز يُمرَّر في السياق. */
  if (context && entry.sameDayAvailable === false && slot.date === context.clinicToday) {
    return false;
  }

  /* ٣) الوردية — من ورديات المركز المُهيّأة.
     وتفضيلُ ورديةٍ لا يشغّلها المركز لا يُقصي صاحبه: من فضّل «الثانية» في مركزٍ
     صار يعمل ورديةً واحدة يبقى مرشَّحًا، وإلا سقط من القائمة بسبب تغييرٍ في
     التهيئة لا بسبب رغبته. */
  const wanted = entry.preferredShift ?? "any";
  if (context && wanted !== "any") {
    const available = configuredShiftCount(context.shifts);
    const honourable = wanted === "shift1" ? available >= 1 : available >= 2;
    if (honourable) {
      const actual = shiftOfTime(slot.time, context.shifts);
      /* خارج الورديات كلِّها لا يُقصي — طوارئُ الأسنان تقع خارج الدوام. */
      if (actual !== null && actual !== wanted) return false;
    }
  } else if (!context && entry.preferredPeriod !== "any") {
    /* بلا سياقٍ مُهيّأ يبقى التفضيل القديم عاملًا — توافقٌ مع ما كُتب قبل ٠٠١٠. */
    const period = periodOf(slot.time);
    if (period !== null && period !== entry.preferredPeriod) return false;
  }

  /* ٤) الطبيب: إن طلبه المريض وكان المكان عند غيره فلا يصلح. والمكانُ بلا طبيبٍ
     محدَّد يصلح للجميع — الاستقبال تسنده حين تحجز. */
  if (entry.doctorId && slot.doctorId && entry.doctorId !== slot.doctorId) return false;

  /* ٥) الخدمة — وهذا تصحيحُ المرحلة.
     كان الاختلاف يمرّ ما دامت المدّة تكفي، أي أنّ «ثلاثين دقيقة» تُعامَل كأنها
     إجراءٌ واحد. وحشوةٌ ليست خلعًا ولو تساوت مدّتاهما: تُنادى المريضة لموعدٍ لا
     يُجرى لها فيه ما تنتظره. فالخدمةُ المحدَّدة تلزم مطابقةً صريحة.
     أمّا مكانٌ لا تُعرف خدمته (موعدٌ قديم لا يُحسم إلى خدمةٍ قانونية) فلا يُقصي
     ولا يُدَّعى له تطابق: يمرّ ويُقال في التفسير إنّ الخدمة غير معروفة، ويأتي
     بعد المطابقات الصريحة. */
  if (entry.serviceId && slot.serviceId && entry.serviceId !== slot.serviceId) return false;

  /* ٦) المدّة: مكانٌ ثلاثين دقيقة لا يسع زراعةً تحتاج تسعين. */
  const needed = entry.durationMinutes ?? null;
  if (needed !== null && needed > slot.durationMinutes) return false;

  return true;
}

/**
 * كم يومًا انتظر — بحساب التقويم لا بفارق اللحظات.
 *
 * والتقطيعُ إلى يومٍ كامل مقصود ومطابقٌ لـ`isExpired`: لو حُسب بالساعات لقال
 * العرضُ «ينتظر منذ ٨ أيام» بينما تعدّه مدّةُ البقاء تسعة، فيُعلَّم صفٌّ يقول
 * عن نفسه إنه أحدث ممّا عُومل به — رقمان لواقعةٍ واحدة.
 */
export function waitingDaysOf(createdAt: string, todayISO: string): number {
  const created = new Date(`${createdAt.slice(0, 10)}T00:00:00Z`).getTime();
  const today = new Date(`${todayISO}T00:00:00Z`).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(today)) return 0;
  return Math.max(0, Math.round((today - created) / 86_400_000));
}

/**
 * الحقائق التي جعلت هذا المرشَّح يظهر — لا رقمًا غامضًا.
 *
 * الاستقبال تقرأ «نفس الخدمة · الطبيب المفضّل · ينتظر منذ ١٢ يومًا» فتعرف لماذا
 * هذا الاسم أولًا. وترتيبٌ لا يُفسَّر لا يُوثق به، فتتخطّاه الموظّفة وتتصل بمن
 * تعرفه هي — وتعود القائمة زينةً.
 */
export function explainMatch(
  entry: WaitingEntry, slot: FreedSlot, context: MatchContext,
  history: readonly ContactEvent[] = [],
): MatchFacts {
  const days = entry.preferredDays ?? [];
  const weekday = isoWeekday(slot.date);
  const wanted = entry.preferredShift ?? "any";
  const available = configuredShiftCount(context.shifts);
  const honourable = wanted === "any"
    ? false : (wanted === "shift1" ? available >= 1 : available >= 2);

  const waiting = waitingDaysOf(entry.createdAt, context.clinicToday);

  return {
    serviceMatch: !entry.serviceId
      ? "none"
      : (slot.serviceId
        ? (slot.serviceId === entry.serviceId ? "exact" : "none")
        : "unknown"),
    dayMatch: days.length === 0 ? null : (weekday !== null && days.includes(weekday)),
    shiftMatch: !honourable ? null : shiftOfTime(slot.time, context.shifts) === wanted,
    providerMatch: !entry.doctorId ? null : (!slot.doctorId ? null : true),
    sameDay: slot.date === context.clinicToday,
    previouslyContacted: history.length > 0,
    waitingDays: waiting,
  };
}

/** وصفٌ عربيّ قصيرٌ للحقائق — يُعرض كما هو في اللوحة. */
export function describeMatch(facts: MatchFacts): string {
  const parts: string[] = [];
  if (facts.serviceMatch === "exact") parts.push("نفس الخدمة");
  else if (facts.serviceMatch === "unknown") parts.push("خدمة المكان غير معروفة");
  if (facts.dayMatch === true) parts.push("يومٌ مفضّل");
  if (facts.shiftMatch === true) parts.push("الوردية المفضّلة");
  if (facts.providerMatch === true) parts.push("الطبيب المفضّل");
  if (facts.sameDay) parts.push("اليوم نفسه");
  parts.push(`ينتظر منذ ${facts.waitingDays} يومًا`);
  if (facts.previouslyContacted) parts.push("سبق الاتصال به");
  return parts.join(" · ");
}

/**
 * ترتيبُ المرشَّحين لمكانٍ شاغر — حتميّ ومُفسَّر.
 *
 * الترتيب:
 *   ١) من لم يُتّصل به لهذه الفرصة قبل من اتُّصل به — فلا تُعاود الاستقبال من
 *      كلّمته بينما ينتظر غيرُه مكالمته الأولى.
 *   ٢) الإلحاح: ألمٌ حادّ لا ينتظر كما ينتظر فحصٌ دوريّ.
 *   ٣) مطابقةُ الخدمة الصريحة قبل المكان الذي لا تُعرف خدمته.
 *   ٤) أقدمُهم انتظارًا — لا أحدثهم. والترتيب بالأحدث يعني أنّ من انتظر شهرًا
 *      لا يُنادى أبدًا، وهو ما يجعل القائمة تُهجَر.
 *   ٥) رقمُ الصفّ حاسمًا — فلا تقرأ الاستقبال قائمتين مختلفتين للحال نفسه.
 *
 * ومن **رفض هذا الموعد بعينه** يُستبعد من هذه الفرصة وحدها — لا من القائمة:
 * رفضُ موعدٍ ليس انسحابًا، والمرشَّح يعود لأيّ فرصةٍ أخرى.
 */
export function rankCandidates(
  entries: WaitingEntry[],
  slot: FreedSlot,
  context?: MatchContext,
  historyOf?: (entry: WaitingEntry) => readonly ContactEvent[],
): WaitingEntry[] {
  const history = (entry: WaitingEntry) => historyOf?.(entry) ?? [];

  const declinedThisSlot = (entry: WaitingEntry) =>
    history(entry).some((event) =>
      event.outcome === "declined_slot"
      && event.slotDate === slot.date
      && (event.slotTime ?? "").slice(0, 5) === slot.time.slice(0, 5));

  const contactedFor = (entry: WaitingEntry) =>
    history(entry).some((event) =>
      event.slotDate === slot.date
      && (event.slotTime ?? "").slice(0, 5) === slot.time.slice(0, 5));

  const serviceRank = (entry: WaitingEntry) => {
    if (!entry.serviceId) return 1;
    if (slot.serviceId && slot.serviceId === entry.serviceId) return 0;
    return 2;
  };

  return entries
    .filter((entry) => matchesSlot(entry, slot, context))
    .filter((entry) => !declinedThisSlot(entry))
    .sort((a, b) => {
      const byContacted = Number(contactedFor(a)) - Number(contactedFor(b));
      if (byContacted !== 0) return byContacted;
      const byOffered = Number(a.status === "offered") - Number(b.status === "offered");
      if (byOffered !== 0) return byOffered;
      const byUrgency = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
      if (byUrgency !== 0) return byUrgency;
      const byService = serviceRank(a) - serviceRank(b);
      if (byService !== 0) return byService;
      const byAge = a.createdAt.localeCompare(b.createdAt);
      if (byAge !== 0) return byAge;
      return a.id - b.id;
    });
}

/**
 * هل انتهت صلاحية الانتظار؟
 *
 * `holdDays` صفرٌ يعني **بلا انتهاء** — وهو الافتراضيّ عمدًا: قائمةٌ تُسقط
 * أسماءً وحدها بعد أسبوعين تفعل ذلك صامتةً، والمريض الذي حُذف لا يعرف أنه حُذف.
 * فالمالك هو من يقرّر متى يُسقَط، لا النظام.
 */
export function isExpired(
  entry: Pick<WaitingEntry, "createdAt" | "status">, todayISO: string, holdDays: number,
): boolean {
  if (!OPEN_STATUSES.includes(entry.status)) return false;
  const days = Math.max(0, Math.floor(holdDays));
  if (days === 0) return false;
  const created = new Date(`${entry.createdAt.slice(0, 10)}T00:00:00Z`).getTime();
  const today = new Date(`${todayISO}T00:00:00Z`).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(today)) return false;
  return (today - created) / 86_400_000 > days;
}

/** وصفٌ عربيّ للمدى — يُعرض كما هو في الشاشة والطباعة. */
export function describeWindow(entry: Pick<WaitingEntry, "earliestDate" | "latestDate">): string {
  const { earliestDate: from, latestDate: to } = entry;
  if (!from && !to) return "أيّ وقت";
  if (from && to) return from === to ? `يوم ${from}` : `من ${from} إلى ${to}`;
  return from ? `من ${from} فصاعدًا` : `حتى ${to}`;
}
