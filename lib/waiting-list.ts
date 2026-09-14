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

/** حدُّ الصباح والمساء — الظهر. وهو تصنيفُ عرضٍ لا قاعدةُ سعة. */
export const NOON_MINUTES = 12 * 60;

export interface WaitingEntryInput {
  patientId: number;
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
export function matchesSlot(entry: WaitingEntry, slot: FreedSlot): boolean {
  if (!OPEN_STATUSES.includes(entry.status)) return false;

  if (entry.earliestDate && slot.date < entry.earliestDate) return false;
  if (entry.latestDate && slot.date > entry.latestDate) return false;

  if (entry.preferredPeriod !== "any") {
    const period = periodOf(slot.time);
    /* وقتٌ غير مقروء لا يُقصي أحدًا: العطب في الوقت لا في المريض. */
    if (period !== null && period !== entry.preferredPeriod) return false;
  }

  /* الطبيب المطلوب: إن طلبه المريض وكان المكان عند غيره فلا يصلح. والمكانُ بلا
     طبيبٍ محدَّد يصلح للجميع — الاستقبال تسنده حين تحجز. */
  if (entry.doctorId && slot.doctorId && entry.doctorId !== slot.doctorId) return false;

  /* الخدمة: الاختلاف لا يمنع بذاته — الاستقبال قد تُحوّل المكان. لكن المدّة
     تمنع: مكانٌ ثلاثين دقيقة لا يسع زراعةً تحتاج تسعين. */
  const needed = entry.durationMinutes ?? null;
  if (needed !== null && needed > slot.durationMinutes) return false;

  return true;
}

/**
 * ترتيبُ المرشَّحين لمكانٍ شاغر.
 *
 * الإلحاح أولًا، ثم **أقدمهم انتظارًا** — لا أحدثهم. والترتيب بأحدث من سجّل
 * يعني أنّ من انتظر شهرًا لا يُنادى أبدًا، وهو ما يجعل القائمة تُهجَر.
 */
export function rankCandidates(entries: WaitingEntry[], slot: FreedSlot): WaitingEntry[] {
  return entries
    .filter((entry) => matchesSlot(entry, slot))
    .sort((a, b) => {
      /* من نودي ولم يُحسم أمره يبقى مرشَّحًا — قد يكون لم يردّ على الهاتف،
         وإسقاطُه يعني أنّ مريضًا اتُّصل به مرةً يخرج من القائمة بلا قرار. لكنه
         يأتي **بعد** من لم يُنادَ بعد، فلا تُعيد الاستقبال الاتصال بمن كلّمته
         للتوّ بينما ينتظر غيرُه مكالمته الأولى. والشاشة تُظهر أنه نودي. */
      const byOffered = Number(a.status === "offered") - Number(b.status === "offered");
      if (byOffered !== 0) return byOffered;
      const byUrgency = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
      if (byUrgency !== 0) return byUrgency;
      const byAge = a.createdAt.localeCompare(b.createdAt);
      if (byAge !== 0) return byAge;
      /* ترتيبٌ حاسمٌ أخيرًا: صفّان في اللحظة نفسها يجب ألّا يتبادلا المواقع
         بين استعلامين، فتقرأ الاستقبال قائمتين مختلفتين للحال نفسه. */
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
