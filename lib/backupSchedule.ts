/**
 * حساب مواعيد النسخ التلقائي — دوال نقية قابلة للاختبار بلا قرص ولا قاعدة.
 *
 * الجدولة هنا **قرار** لا مُشغِّل: لا setInterval ولا setTimeout في هذا
 * النظام — المجدول السلطاني خارجي (Railway Cron أو غيره) يضرب نقطة
 * `/api/internal/backup/run` بانتظام، وهذه الدوال تقرر: هل حان دور اليوم؟
 * من هنا لا يعتمد التشغيل على متصفحٍ مفتوح ولا على ذاكرة عمليةٍ يعاد
 * تشغيلها — التاريخ المكتمل يُحفظ على القرص الدائم (marker) فلا يُنفَّذ
 * دورُ اليوم مرتين مهما ضرب المجدول.
 */

export interface BackupScheduleDecision {
  scheduleEnabled: boolean;
  scheduleTime: string;
  scheduleTimeZone: string;
}

/** تاريخ اليوم ودقائقه المنقضية داخل منطقة زمنية محددة — بلا اعتماد على ساعة المتصفح. */
export function clinicTodayInZone(
  timeZone: string,
  now: Date = new Date(),
): { date: string; minutesOfDay: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const date = `${value("year")}-${value("month")}-${value("day")}`;
  const hour = Number(value("hour")) % 24; // بعض البيئات ترمز منتصف الليل بـ24
  const minute = Number(value("minute"));
  return { date, minutesOfDay: hour * 60 + minute };
}

/** صلاحية منطقة زمنية — تجربة Intl الفعلية لا قائمة مكتوبة تُنسى. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timeZone.trim() });
    return true;
  } catch {
    return false;
  }
}

/** "HH:MM" → دقائق من منتصف الليل، أو null للصيغة التالفة. */
export function scheduleTimeToMinutes(scheduleTime: string): number | null {
  const match = scheduleTime.trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * هل حان دور نسخة اليوم؟
 *
 * الاستحقاق يبقى مستحقًا بعد موعده (لا يُفوَت إن غاب المجدول ساعةً)، لكنه
 * ينتهي بتسجيل إتمام دور اليوم في marker — فالتكرار لا يعيد التشغيل.
 */
export function isScheduleDueNow(
  decision: BackupScheduleDecision,
  lastCompletedScheduleDate: string | null,
  now: Date = new Date(),
): { due: boolean; today: string; reason: "disabled" | "due" | "already-ran" | "not-due" | "invalid-time" | "invalid-timezone" } {
  if (!decision.scheduleEnabled) return { due: false, today: "", reason: "disabled" };
  if (!isValidTimeZone(decision.scheduleTimeZone)) {
    return { due: false, today: "", reason: "invalid-timezone" };
  }
  const scheduledMinutes = scheduleTimeToMinutes(decision.scheduleTime);
  if (scheduledMinutes === null) return { due: false, today: "", reason: "invalid-time" };

  const { date: today, minutesOfDay } = clinicTodayInZone(decision.scheduleTimeZone, now);
  if (lastCompletedScheduleDate === today) {
    return { due: false, today, reason: "already-ran" };
  }
  if (minutesOfDay < scheduledMinutes) {
    return { due: false, today, reason: "not-due" };
  }
  return { due: true, today, reason: "due" };
}

/** الموعد القادم — ISO بمنطقة العيادة معكوَسًا للعرض، أو null والجدولة موقفة. */
export function nextScheduledRunIso(
  decision: BackupScheduleDecision,
  now: Date = new Date(),
): string | null {
  if (!decision.scheduleEnabled) return null;
  if (!isValidTimeZone(decision.scheduleTimeZone)) return null;
  const scheduledMinutes = scheduleTimeToMinutes(decision.scheduleTime);
  if (scheduledMinutes === null) return null;

  const { date, minutesOfDay } = clinicTodayInZone(decision.scheduleTimeZone, now);
  const dueToday = minutesOfDay < scheduledMinutes && date !== null;
  const target = new Date(now);
  if (!dueToday) target.setUTCDate(target.getUTCDate() + 1);
  // نقطة التقاطع: نفس التاريخ المحلي، وقتُه الموعد المحلي — يُكتب ISO بتوقيت UTC
  // للعرض فقط؛ التشغيل الفعلي يحكمه فحص الاستحقاق لا هذه القيمة.
  const [year, month, day] = dueToday ? date.split("-").map(Number) : clinicTodayInZone(decision.scheduleTimeZone, target).date.split("-").map(Number);
  const hour = Math.floor(scheduledMinutes / 60);
  const minute = scheduledMinutes % 60;
  // ملاحظة: الإزاحة الزمنية للعيادة ثابتة (+03:00 عدن بلا توقيت صيفي) —
  // وللاعتراض العام تُحسب الإزاحة فعليًا من formatter وقت الطلب في المسار.
  const offsetMinutes = zoneOffsetMinutes(decision.scheduleTimeZone, now);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60_000;
  return new Date(asUtc).toISOString();
}

/** إزاحة المنطقة الزمنية عن UTC بالدقائق لحظة معينة (تغطي المناطق ذات الصيفي). */
export function zoneOffsetMinutes(timeZone: string, now: Date = new Date()): number {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
  const name = formatter.formatToParts(now).find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";
  const match = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}
