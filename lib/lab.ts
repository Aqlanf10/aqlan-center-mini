import { addDays } from "./schedule";

/**
 * أعمال المختبر (التراكيب) — المنطق الخالص.
 *
 * ثالث المشاكل التي ذكرها المالك بنصّها: «تراكم التراكيب». وهي مشكلة مختلفة عن
 * الزحمة والمواعيد: لا أحد يشتكي منها في الصالة، بل تظهر يوم يجلس المريض على الكرسي
 * ليركّب تاجه فيُكتشف أنه لم يصل من المختبر — وقد قُطع له وعدٌ بيوم.
 *
 * لذلك المقياس هنا واحد: **تاريخ الاستحقاق**. عملٌ بلا تاريخ يُنتظر إلى ما لا نهاية،
 * ولا يعرف أحد أنه تأخّر إلا حين يسأل المريض. والقائمة تُرتَّب بالأكثر تأخّرًا لا
 * بالأحدث، لأن المتأخر سبعة أيام هو من يجب أن يُتصَل بشأنه اليوم.
 */

/**
 * `needed`: عملٌ يتطلبه الإجراء المنفَّذ (تاج قُطعت حشوته وأُخذت طبعته) لكنه لم
 * يُرسل للمختبر بعد — تولّده الرحلة تلقائيًا عند توقيع الزيارة (§١٩)، ويُرسله من
 * يتعامل مع المختبر من لوحة الأعمال. لا يُحسَب متأخرًا ولا «عند المختبر»:
 * لم يخرج من العيادة أصلًا.
 */
export type LabOrderStatus = "needed" | "sent" | "received" | "delivered" | "cancelled";

/** الاسم الذي يُكتب في طلبٍ تلقائيّ لم يُختر له مختبر بعد. */
export const PENDING_LAB_NAME = "لم يُحدَّد بعد";

export interface LabOrder {
  id: number;
  patientId: number;
  patientName: string;
  patientPhone: string | null;
  labName: string;
  labPhone: string | null;
  workType: string;
  details: string | null;
  sentDate: string;   // YYYY-MM-DD
  dueDate: string;    // YYYY-MM-DD
  status: LabOrderStatus;
  receivedAt: string | null;
  deliveredAt: string | null;
  note: string | null;
  /** زيارة مصدر الطلب إن تولّد من إجراء (§١٩) — يُفتح منها السياق كاملًا. */
  visitId: number | null;
  /** سنّ الإجراء الذي ولّد الطلب. */
  toothCode: number | null;
  /** auto: تولّد من توقيع زيارة؛ manual: أُنشئ من شاشة. */
  source: "auto" | "manual";
}

export const LAB_STATUS_LABEL: Record<LabOrderStatus, string> = {
  needed: "لم يُرسل بعد",
  sent: "عند المختبر",
  received: "وصل العيادة",
  delivered: "رُكّب للمريض",
  cancelled: "ملغى",
};

/** أنواع العمل الأكثر تكرارًا — تُختصر الكتابة وتوحّد التسمية فيصحّ البحث لاحقًا. */
export const WORK_TYPES = [
  "تاج",
  "جسر",
  "طقم كامل",
  "طقم جزئي",
  "جهاز تقويم متحرك",
  "ريتينر",
  "حافظ مسافة",
  "قشرة (فينير)",
  "وجه (ونير) مؤقت",
];

/** المهلة الافتراضية حتى يُنجز المختبر. تُعدَّل في النموذج لكل عمل. */
export const DEFAULT_LAB_DAYS = 7;

export function defaultDueDate(sentDate: string): string {
  return addDays(sentDate, DEFAULT_LAB_DAYS);
}

/** العمل الذي ما زال في ذمّة المختبر. المستلَم والمركَّب والملغى خرجوا من الانتظار. */
export function isOutstanding(order: LabOrder): boolean {
  return order.status === "sent";
}

/**
 * كم يومًا تأخّر العمل عن موعده.
 *
 * صفر يعني في موعده أو لم يحن بعد — لا رقمًا سالبًا: «متأخر ‎-3 أيام» جملة لا تعني
 * شيئًا لمن يقرؤها بسرعة بين مريضين.
 */
export function daysLate(order: LabOrder, today: string): number {
  if (!isOutstanding(order)) return 0;
  const due = Date.parse(`${order.dueDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;
  return Math.max(0, Math.round((now - due) / 86_400_000));
}

export function isOverdue(order: LabOrder, today: string): boolean {
  return daysLate(order, today) > 0;
}

/** يستحق اليوم: لم يتأخر بعد، لكن الوعد ينتهي اليوم — والاتصال اليوم يمنع تأخر الغد. */
export function isDueToday(order: LabOrder, today: string): boolean {
  return isOutstanding(order) && order.dueDate === today;
}

export type LabFilter = "late" | "pending" | "outstanding" | "received" | "all";

export const LAB_FILTER_LABEL: Record<LabFilter, string> = {
  late: "متأخرة",
  pending: "لم تُرسل",
  outstanding: "عند المختبر",
  received: "وصلت ولم تُركّب",
  all: "الكل",
};

export function filterOrders(orders: LabOrder[], filter: LabFilter, today: string): LabOrder[] {
  switch (filter) {
    case "late": return orders.filter((order) => isOverdue(order, today));
    case "pending": return orders.filter((order) => order.status === "needed");
    case "outstanding": return orders.filter(isOutstanding);
    case "received": return orders.filter((order) => order.status === "received");
    default: return orders;
  }
}

/**
 * الترتيب الذي يجعل القائمة صالحة للعمل: الأكثر تأخّرًا أولًا.
 *
 * الترتيب بتاريخ الإرسال — وهو الترتيب الطبيعي في قاعدة البيانات — يضع عملًا أُرسل
 * أمس ومهلته شهر فوق عملٍ تأخّر أسبوعًا. والقائمة التي لا يكون أعلاها أهمّها تُقرأ
 * مرة ثم تُهجَر.
 */
export function sortByUrgency(orders: LabOrder[], today: string): LabOrder[] {
  return [...orders].sort((a, b) => {
    const late = daysLate(b, today) - daysLate(a, today);
    if (late !== 0) return late;
    return a.dueDate.localeCompare(b.dueDate);
  });
}

export interface LabSummary {
  outstanding: number;
  late: number;
  dueToday: number;
  waitingFitting: number;
}

export function labSummary(orders: LabOrder[], today: string): LabSummary {
  return {
    outstanding: orders.filter(isOutstanding).length,
    late: orders.filter((order) => isOverdue(order, today)).length,
    dueToday: orders.filter((order) => isDueToday(order, today)).length,
    waitingFitting: orders.filter((order) => order.status === "received").length,
  };
}

/**
 * رسالة المتابعة للمختبر.
 *
 * تُذكر بالاسم والعمل والتاريخ لا بـ«وين شغلنا؟»: المختبر يخدم عيادات كثيرة، ورسالة
 * بلا تفاصيل تُجاب بسؤال آخر فتضيع مكالمة ثانية. ونبرتها متابعة لا مخاصمة — المختبر
 * شريك يُحتاج غدًا أيضًا.
 */
export function labFollowUpText(order: LabOrder, today: string, clinicName: string): string {
  const late = daysLate(order, today);
  const lines = [
    `السلام عليكم،`,
    ``,
    `متابعة عمل من ${clinicName}:`,
    `المريض: ${order.patientName}`,
    `العمل: ${order.workType}${order.details ? ` — ${order.details}` : ""}`,
    `أُرسل: ${order.sentDate} · الموعد المتفق: ${order.dueDate}`,
  ];
  lines.push(
    late > 0
      ? `مضى على الموعد ${late} ${late === 1 ? "يوم" : "أيام"}. نرجو إفادتنا بموعد التسليم — المريض بانتظاره.`
      : `نرجو تأكيد الجاهزية في موعدها.`,
  );
  return lines.join("\n");
}

/** إبلاغ المريض أن عمله وصل — الرسالة التي تُنهي «ما في اهتمام ولا تواصل». */
export function patientReadyText(order: LabOrder, clinicName: string, clinicPhone: string): string {
  return [
    `السلام عليكم ${order.patientName}،`,
    ``,
    `${order.workType} الخاص بكم وصل إلى ${clinicName} وجاهز للتركيب.`,
    `تفضّلوا بالتواصل معنا لتحديد موعد يناسبكم.`,
    ``,
    `للتواصل: ${clinicPhone}`,
  ].join("\n");
}
