/**
 * مركز متابعة التقويم — تصنيف الحالات إلى قوائم العمل.
 *
 * مالك المركز وصف اليوم الذي يريده: قائمة يومية للاستقبال تقسم مرضى التقويم إلى
 * «اليوم، غدًا، هذا الأسبوع، بدون موعد قادم، تجاوزوا موعدهم، لم يحضروا، منذ ٤/٦/٨
 * أسابيع، وحالات التثبيت». هذه الوحدة هي التصنيف نفسه — منطقٌ خالص بلا قاعدةٍ
 * ولا شبكة، يُختبر بالكلمة ويُعاد استخدامه أينما احتاج.
 *
 * والحالة قد تظهر في قائمتين معًا ولا حرج: مريضٌ لم يحضر آخر موعد له **و** مضى
 * على شدّته ستة أسابيع هو مصدر قلقٍ من بابين — فليظهر في البابين، فالاستقبال
 * تصل إليه من أي قائمة فتحت.
 */

import { daysBetween } from "./ortho";
import { nextAdjustmentDate } from "./ortho";

export type FollowupBucket =
  | "today"          // موعد الشدّة اليوم
  | "tomorrow"       // غدًا
  | "this_week"      // خلال ٧ أيام
  | "upcoming"       // موعدٌ قادم بعد أسبوع أو أكثر
  | "no_appointment" // بدون موعد قادم — قائمة الاستقبال اليومية
  | "overdue"        // تجاوزوا موعدهم — موعدٌ محجوزٌ ماضٍ ولم يُنفَّذ
  | "no_show"        // لم يحضروا آخر موعدٍ لهم
  | "lapsed_4"       // منذ ٤ أسابيع بلا شدّة
  | "lapsed_6"       // منذ ٦ أسابيع
  | "lapsed_8"       // منذ ٨ أسابيع أو أكثر
  | "retention";     // حالات التثبيت

export const BUCKET_LABEL: Record<FollowupBucket, string> = {
  today: "اليوم",
  tomorrow: "غدًا",
  this_week: "هذا الأسبوع",
  upcoming: "مواعيد قادمة",
  no_appointment: "بدون موعد قادم",
  overdue: "تجاوزوا موعدهم",
  no_show: "لم يحضروا",
  lapsed_4: "منذ ٤ أسابيع",
  lapsed_6: "منذ ٦ أسابيع",
  lapsed_8: "منذ ٨ أسابيع+",
  retention: "حالات التثبيت",
};

export const BUCKET_ORDER: FollowupBucket[] = [
  "today", "tomorrow", "this_week", "no_appointment", "overdue", "no_show",
  "lapsed_4", "lapsed_6", "lapsed_8", "retention", "upcoming",
];

/** لون القائمة على الشاشة — الحِدّة تُترجم إلى لونٍ واحد لا إلى نصٍّ طويل. */
export const BUCKET_TONE: Record<FollowupBucket, "red" | "amber" | "navy" | "slate" | "emerald"> = {
  today: "navy",
  tomorrow: "navy",
  this_week: "navy",
  upcoming: "slate",
  no_appointment: "amber",
  overdue: "red",
  no_show: "red",
  lapsed_4: "amber",
  lapsed_6: "red",
  lapsed_8: "red",
  retention: "emerald",
};

/** الحالات الجارية وحدها تُتابع — المغلقة خرجت من الدورة. */
export type FollowupCaseStatus = "active" | "retention";

export interface NextAppointmentInfo {
  id: number;
  /** تاريخ الموعد بتوقيت العيادة. */
  date: string;
  time: string;
  status: string;
}

export interface FollowupCase {
  caseId: number;
  patientId: number;
  patientName: string;
  patientPhone: string | null;
  status: FollowupCaseStatus;
  phase: string;
  startDate: string;
  /** تاريخ آخر شدّة — وقد لا توجد شدّة بعد لحالةٍ فُتحت حديثًا. */
  lastAdjustmentDate: string | null;
  nextWeeks: number;
  upperWire: string | null;
  lowerWire: string | null;
  /** أقرب موعدٍ محجوز (booked) لهذا المريض — ماضٍ أو مستقبل. */
  nextAppointment: NextAppointmentInfo | null;
  /** هل آخر موعدٍ له كان غيابًا no_show؟ */
  lastWasNoShow: boolean;
}

export interface FollowupRow extends FollowupCase {
  buckets: FollowupBucket[];
  /** التاريخ المستحق للشدّة القادمة بحساب nextWeeks — للعرض في القائمة. */
  dueDate: string;
  daysSinceLast: number | null;
}

/**
 * يصنّف كل حالة إلى قوائمها.
 *
 * حدود الأسبوع مأخوذة من كلام المالك حرفيًّا: أربعة أسابيع دورة الشدّ الطبيعية
 * (فما دونها لا يستحق قائمة)، وستة تعني انقطاعًا حقيقيًّا، وثمانية تعني جهازًا
 * يعمل بلا إشراف شهرين — وهذه أخطر قائمة في الشاشة.
 */
export function classifyFollowups(input: {
  cases: FollowupCase[];
  today: string;
}): FollowupRow[] {
  return input.cases.map((row) => {
    const buckets: FollowupBucket[] = [];
    const since = row.lastAdjustmentDate ?? row.startDate;
    const daysSinceLast = daysBetween(since, input.today);
    const dueDate = nextAdjustmentDate(since, row.nextWeeks);

    const appointment = row.nextAppointment;
    if (appointment) {
      const offset = daysBetween(input.today, appointment.date);
      const stillBooked = appointment.status === "booked" || appointment.status === "arrived";
      if (stillBooked && offset === 0) buckets.push("today");
      else if (stillBooked && offset === 1) buckets.push("tomorrow");
      else if (stillBooked && offset >= 2 && offset <= 7) buckets.push("this_week");
      else if (stillBooked && offset > 7) buckets.push("upcoming");
      else if (stillBooked && offset < 0) buckets.push("overdue");
    } else {
      buckets.push("no_appointment");
    }

    if (row.lastWasNoShow) buckets.push("no_show");

    if (daysSinceLast >= 56) buckets.push("lapsed_8");
    else if (daysSinceLast >= 42) buckets.push("lapsed_6");
    else if (daysSinceLast >= 28) buckets.push("lapsed_4");

    if (row.status === "retention") buckets.push("retention");

    return { ...row, buckets, dueDate, daysSinceLast };
  });
}

/**
 * «مضى ٢٣ يومًا» بلا — العدّ بالأسابيع كما يفكّر أخصائي التقويم.
 * صفرٌ يعني اليوم، والواحد والاثنان بالمثنّى كما تجب العربية.
 */
export function sinceAdjustmentText(days: number | null): string {
  if (days === null) return "بلا شدّات بعد";
  if (days <= 0) return "اليوم";
  const weeks = Math.floor(days / 7);
  if (weeks < 1) return days === 1 ? "قبل يوم" : days === 2 ? "قبل يومين" : `قبل ${days} أيام`;
  if (weeks === 1) return "قبل أسبوع";
  if (weeks === 2) return "قبل أسبوعين";
  return `قبل ${weeks} أسابيع`;
}

/**
 * القوائم مرتّبة بحِدّتها — الاستقبال تفتح الشاشة فترى الأخطر أولًا لا الترتيب
 * الذي صادفه المبرمج. «بدون موعد قادم» تتقدّم على المتأخرات لأنها الأوسع ولا
 * تحتاج حسابًا: غيابُ الموعد نفسه هو الخطر.
 */
export function groupByBucket(rows: FollowupRow[]): Map<FollowupBucket, FollowupRow[]> {
  const groups = new Map<FollowupBucket, FollowupRow[]>();
  for (const bucket of BUCKET_ORDER) groups.set(bucket, []);
  for (const row of rows) {
    for (const bucket of row.buckets) groups.get(bucket)?.push(row);
  }
  // داخل كل قائمة: الأقدم انقطاعًا أولًا — من مضت عليه أشدّ قلقًا يُنادى أولًا.
  for (const [bucket, list] of groups) {
    list.sort((a, b) => {
      const aDate = a.lastAdjustmentDate ?? a.startDate;
      const bDate = b.lastAdjustmentDate ?? b.startDate;
      const byAge = aDate.localeCompare(bDate);
      if (byAge !== 0) return byAge;
      if (bucket === "today" || bucket === "tomorrow" || bucket === "this_week" || bucket === "upcoming" || bucket === "overdue") {
        return (a.nextAppointment?.date ?? "").localeCompare(b.nextAppointment?.date ?? "");
      }
      return a.patientName.localeCompare(b.patientName, "ar");
    });
  }
  return groups;
}
