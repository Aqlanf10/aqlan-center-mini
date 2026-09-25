/**
 * جاهزية أعمال المختبر لموعد المريض — «هل وصلت التركيبة قبل أن يصل هو؟»
 *
 * المشكلة (أولوية المالك: تراكم التراكيب): مريضٌ يُحجز لتركيب تاجه، يأتي ويجلس
 * في الصالة، ثم يُكتشف أن العمل ما زال عند المختبر — زيارةٌ ضائعة، وكرسيٌّ محجوز
 * بلا عمل، ومريضٌ غاضب. والمعلومة كانت في النظام: أمر المختبر مفتوح بتاريخ
 * استحقاقه. هذا الملف يضعها بجانب الموعد نفسه، فيرى الاستقبال في قائمة الغد
 * من يجب الاتصال بالمختبر لأجله أو تأجيل موعده — قبل أن يأتي.
 *
 * دالة خالصة: التصنيف والنص هنا، والقاعدة والشاشة تستهلكانه.
 */

/** الحالات التي لم يكتمل فيها العمل بعد، ومعها «وصل العيادة» (جاهز للتركيب). */
export const LAB_READINESS_STATUSES = ["needed", "sent", "in_progress", "remake", "received"] as const;
export type LabReadinessStatus = (typeof LAB_READINESS_STATUSES)[number];

export interface PatientLabWork {
  orderId: number;
  patientId: number;
  workType: string;
  labName: string;
  status: LabReadinessStatus;
  /** YYYY-MM-DD */
  dueDate: string;
}

/**
 * - `ready`: العمل وصل العيادة — جاهز للتركيب في هذا الموعد.
 * - `not_sent`: لم يُرسل للمختبر أصلًا.
 * - `late`: تجاوز تاريخ استحقاقه وما زال عند المختبر.
 * - `after_visit`: تاريخ وصوله المتوقَّع بعد الموعد — لن يكون جاهزًا.
 * - `awaiting`: لم يصل بعد، ومتوقَّع قبل الموعد أو يومه.
 */
export type LabReadinessLevel = "ready" | "not_sent" | "late" | "after_visit" | "awaiting";

export interface LabReadinessItem {
  orderId: number;
  workType: string;
  labName: string;
  level: LabReadinessLevel;
  message: string;
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export function classifyLabWork(work: PatientLabWork, appointmentDate: string, today: string): LabReadinessItem {
  const base = { orderId: work.orderId, workType: work.workType, labName: work.labName };
  if (work.status === "received") {
    return { ...base, level: "ready", message: `${work.workType}: وصلت العيادة — جاهزة للتركيب` };
  }
  if (work.status === "needed") {
    return { ...base, level: "not_sent", message: `${work.workType}: لم تُرسل للمختبر بعد` };
  }
  const lateDays = daysBetween(work.dueDate, today);
  if (lateDays > 0) {
    return {
      ...base, level: "late",
      message: `${work.workType}: متأخرة عند ${work.labName} ${lateDays} يوم — اتصل بالمختبر`,
    };
  }
  if (work.dueDate > appointmentDate) {
    return {
      ...base, level: "after_visit",
      message: `${work.workType}: وصولها المتوقَّع ${work.dueDate} بعد الموعد`,
    };
  }
  return {
    ...base, level: "awaiting",
    message: `${work.workType}: لم تصل بعد — متوقَّعة ${work.dueDate}`,
  };
}

/** أعمال المريض مرتّبةً: غير الجاهز أولًا (الأخطر أولًا)، ثم الجاهز. */
const LEVEL_ORDER: Record<LabReadinessLevel, number> = {
  late: 0, not_sent: 1, after_visit: 2, awaiting: 3, ready: 4,
};

export function labReadinessFor(
  works: readonly PatientLabWork[],
  appointmentDate: string,
  today: string,
): LabReadinessItem[] {
  return works
    .map((work) => classifyLabWork(work, appointmentDate, today))
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.orderId - b.orderId);
}

/** هل في القائمة عملٌ غير جاهز — ما يستحق تنبيه الاستقبال. */
export function hasPendingLabWork(items: readonly LabReadinessItem[] | undefined): boolean {
  return (items ?? []).some((item) => item.level !== "ready");
}
