import { addDays } from "./schedule";
import type { Currency } from "./money";

/**
 * أعمال المختبرات السنية (Dental Laboratory Management V2) — المنطق الخالص.
 *
 * يعالج إدارة التركيبات والأجهزة التقويمية سريريًا ومتابعة جاهزيتها
 * مع الفصل الصارم بين المسار السريري (الطبيب والطاقم) والتكلفة المحاسبية (المسؤول المالي).
 * مدموجة مع رحلة المريض V2 (§١٩): حالة `needed` للأعمال التي يولّدها توقيع الزيارة
 * تلقائيًا (تاج/جسر/قشرة) قبل إرسالها للمختبر، وزر `source` يميز تلقائي الزيارة من
 * يدوي الشاشة، و`toothCode` سنّ الإجراء الذي ولّد الطلب.
 */

export type LabOrderStatus =
  | "needed"
  | "sent"
  | "in_progress"
  | "received"
  | "delivered"
  | "remake"
  | "cancelled";
export type LabOrderPriority = "normal" | "urgent" | "rush";
export type LabImpressionType = "physical" | "digital_scan" | "alginate" | "silicone" | "other";
export type LabQualityCheckStatus = "pending" | "passed" | "rejected";
export type LabFinancialStatus = "pending_delivery" | "payable_created" | "paid" | "exempt";

export interface LabService {
  id: number;
  name: string;
  code: string | null;
  category: "prostho" | "ortho" | "implant" | "restorative" | "appliance" | "other";
  defaultDays: number;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt?: string;
}

export interface LabPricingRule {
  id: number;
  partyId: number;
  partyName?: string;
  labServiceId: number;
  serviceName?: string;
  costMinor: number;
  costCurrency: Currency;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null; // YYYY-MM-DD or null
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface LabOrderTrackingEvent {
  id: number;
  labOrderId: number;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  notes: string | null;
  actor: string;
  actorRole: string | null;
  createdAt: string;
}

/**
 * البيانات السريرية لأمر المختبر (يتاح للأطباء والتمريض وموظفي الاستقبال) — بلا أي ذكر للتكلفة المالية.
 */
export interface LabOrderClinicalDTO {
  id: number;
  patientId: number;
  patientName: string;
  patientNumber: string | null;
  patientPhone: string | null;
  labName: string;
  labPhone: string | null;
  partyId: number | null;
  labServiceId: number | null;
  serviceName?: string | null;
  workType: string;
  details: string | null;
  toothNumbers: string | null;
  shade: string | null;
  stumpShade: string | null;
  priority: LabOrderPriority;
  impressionType: LabImpressionType;
  sentDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  status: LabOrderStatus;
  receivedAt: string | null;
  deliveredAt: string | null;
  doctorId: number | null;
  doctorName?: string | null;
  visitId: number | null;
  /** سنّ الإجراء الذي ولّد الطلب (V2 §١٩) — طلب الزيارة له سنّه. */
  toothCode?: number | null;
  /** auto: تولّد من توقيع زيارة؛ manual: أُنشئ من شاشة (V2 §١٩). */
  source?: "auto" | "manual" | null;
  qualityCheck: LabQualityCheckStatus;
  qualityNotes: string | null;
  remakeOriginalId: number | null;
  remakeReason: string | null;
  technicianName: string | null;
  note: string | null;
  createdAt: string;
  events?: LabOrderTrackingEvent[];
}

/**
 * البيانات المالية لأمر المختبر (مخصصة للمدير المالي والمسؤولين ذوي الصلاحيات المالية فقط).
 */
export interface LabOrderFinancialDTO extends LabOrderClinicalDTO {
  costMinor: number | null;
  costCurrency: Currency | null;
  baseAmountMinor: number | null;
  exchangeRate: number;
  financialStatus: LabFinancialStatus;
  payableId: number | null;
  pricingRuleId?: number | null;
}

export interface LabOrder extends LabOrderClinicalDTO {
  costMinor?: number | null;
  costCurrency?: Currency | null;
  baseAmountMinor?: number | null;
  exchangeRate?: number | null;
  financialStatus?: LabFinancialStatus;
  payableId?: number | null;
}

/** الاسم الذي يُكتب في طلبٍ تلقائيّ لم يُختر له مختبر بعد (V2 §١٩). */
export const PENDING_LAB_NAME = "لم يُحدَّد بعد";

export const LAB_STATUS_LABEL: Record<LabOrderStatus, string> = {
  needed: "لم يُرسل بعد",
  sent: "عند المختبر",
  in_progress: "قيد التصنيع",
  received: "وصل العيادة",
  delivered: "رُكّب للمريض",
  remake: "إعادة تصنيع (Remake)",
  cancelled: "ملغى",
};

export const LAB_PRIORITY_LABEL: Record<LabOrderPriority, { label: string; bg: string; text: string }> = {
  normal: { label: "عادي", bg: "bg-slate-100", text: "text-slate-700" },
  urgent: { label: "عاجل", bg: "bg-amber-100", text: "text-amber-800" },
  rush: { label: "طارئ جداً (Rush)", bg: "bg-red-100", text: "text-red-800" },
};

export const LAB_IMPRESSION_LABEL: Record<LabImpressionType, string> = {
  physical: "طبعة تقليدية (فيزيائية)",
  digital_scan: "مسح ضوئي رقمي (Digital Scan)",
  alginate: "طبعة ألجينات (Alginate)",
  silicone: "طبعة مطاطية (Addition Silicone)",
  other: "أخرى",
};

export const LAB_QUALITY_LABEL: Record<LabQualityCheckStatus, { label: string; color: string }> = {
  pending: { label: "بانتظار الفحص", color: "text-amber-600" },
  passed: { label: "مطابق ومقبول ✓", color: "text-emerald-700" },
  rejected: { label: "مرفوض (يحتاج تعديل/إعادة)", color: "text-red-700" },
};

/** ألوان وظلال VITA الكلاسيكية والمتقدمة */
export const VITA_CLASSICAL_SHADES = [
  "A1", "A2", "A3", "A3.5", "A4",
  "B1", "B2", "B3", "B4",
  "C1", "C2", "C3", "C4",
  "D2", "D3", "D4",
];

export const VITA_BLEACH_SHADES = ["OM1", "OM2", "OM3", "BL1", "BL2", "BL3", "BL4"];

export const VITA_3D_MASTER_SHADES = [
  "1M1", "1M2", "2L1.5", "2L2.5", "2M1", "2M2", "2M3", "2R1.5", "2R2.5",
  "3L1.5", "3L2.5", "3M1", "3M2", "3M3", "3R1.5", "3R2.5",
  "4L1.5", "4L2.5", "4M1", "4M2", "4M3", "4R1.5", "4R2.5",
  "5M1", "5M2", "5M3",
];

export const STUMP_SHADES_ND = ["ND1", "ND2", "ND3", "ND4", "ND5", "ND6", "ND7", "ND8", "ND9"];

/** أرقام الأسنان الدائمة بنظام FDI العالمي */
export const ADULT_FDI_TEETH = {
  upperRight: [18, 17, 16, 15, 14, 13, 12, 11],
  upperLeft: [21, 22, 23, 24, 25, 26, 27, 28],
  lowerLeft: [31, 32, 33, 34, 35, 36, 37, 38],
  lowerRight: [48, 47, 46, 45, 44, 43, 42, 41],
};

/** أنواع العمل الأكثر تكرارًا — للتوافق والخيارات السريعة */
export const WORK_TYPES = [
  "تاج زيركون كامل (Full Zirconia)",
  "تاج إيماكس (E.max Crown)",
  "عدسة فينير (Veneer)",
  "تاج بورسلين ميتال (PFM)",
  "جسر زيركون (Zirconia Bridge)",
  "طقم أسنان كامل (Full Denture)",
  "طقم أسنان جزئي كاست (Cast Partial)",
  "حافظ مسافة (Space Maintainer)",
  "جهاز تقويم متحرك (Removable Appliance)",
  "واقي أسنان ليلي (Night Guard)",
  "تاج مؤقت (Temporary Crown)",
  "صب وتجهيز قالب دراسة (Study Model)",
  "أخرى (مخصص)",
];

/** خدمات المعمل الافتراضية للبذر الأولي */
export const DEFAULT_LAB_SERVICES: {
  name: string;
  code: string;
  category: "prostho" | "ortho" | "implant" | "restorative" | "appliance" | "other";
  defaultDays: number;
  sortOrder: number;
}[] = [
  { name: "تاج زيركون كامل (Full Zirconia Crown)", code: "CRW_ZIRC", category: "prostho", defaultDays: 5, sortOrder: 10 },
  { name: "تاج إيماكس تجميلي (E.max Crown)", code: "CRW_EMAX", category: "prostho", defaultDays: 5, sortOrder: 20 },
  { name: "عدسة فينير إيماكس (E.max Veneer)", code: "VNR_EMAX", category: "prostho", defaultDays: 6, sortOrder: 30 },
  { name: "تاج بورسلين ميتال (PFM Crown)", code: "CRW_PFM", category: "prostho", defaultDays: 5, sortOrder: 40 },
  { name: "جسر زيركون (Zirconia Bridge / Unit)", code: "BRG_ZIRC", category: "prostho", defaultDays: 6, sortOrder: 50 },
  { name: "تاج زراعة مخصص (Custom Implant Crown)", code: "CRW_IMP", category: "implant", defaultDays: 7, sortOrder: 60 },
  { name: "طقم أسنان كامل أكريليك (Full Denture)", code: "DNT_FULL", category: "prostho", defaultDays: 8, sortOrder: 70 },
  { name: "طقم أسنان جزئي كاست معدني (Cast Partial)", code: "DNT_CAST", category: "prostho", defaultDays: 9, sortOrder: 80 },
  { name: "جهاز مثبت تقويم هولي (Hawley Retainer)", code: "RET_HAW", category: "ortho", defaultDays: 4, sortOrder: 90 },
  { name: "قالب تقويم شفاف متحرك (Clear Retainer / Essix)", code: "RET_CLR", category: "ortho", defaultDays: 3, sortOrder: 100 },
  { name: "واقي ليلي صلب / مرن (Night Guard)", code: "GRD_NGT", category: "appliance", defaultDays: 4, sortOrder: 110 },
  { name: "حافظ مسافة أحادي / ثنائي (Space Maintainer)", code: "SPC_MNT", category: "ortho", defaultDays: 4, sortOrder: 120 },
  { name: "تاج مؤقت أكريليك / PMMA (Temp Crown)", code: "CRW_TMP", category: "prostho", defaultDays: 2, sortOrder: 130 },
  { name: "صب وتجهيز قالب دراسة وتشخيص (Study Model)", code: "MOD_STD", category: "other", defaultDays: 2, sortOrder: 140 },
];

/** المهلة الافتراضية حتى يُنجز المختبر */
export const DEFAULT_LAB_DAYS = 7;

export function defaultDueDate(sentDate: string, days = DEFAULT_LAB_DAYS): string {
  return addDays(sentDate, days);
}

/** العمل الذي ما زال في ذمّة المختبر. المستلَم والمركَّب والملغى خرجوا من الانتظار */
export function isOutstanding(order: LabOrder | LabOrderClinicalDTO): boolean {
  return order.status === "sent" || order.status === "in_progress" || order.status === "remake";
}

/**
 * كم يومًا تأخّر العمل عن موعده.
 * صفر يعني في موعده أو لم يحن بعد — لا رقمًا سالبًا.
 */
export function daysLate(order: LabOrder | LabOrderClinicalDTO, today: string): number {
  if (!isOutstanding(order)) return 0;
  const due = Date.parse(`${order.dueDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;
  return Math.max(0, Math.round((now - due) / 86_400_000));
}

export function isOverdue(order: LabOrder | LabOrderClinicalDTO, today: string): boolean {
  return daysLate(order, today) > 0;
}

export function isDueToday(order: LabOrder | LabOrderClinicalDTO, today: string): boolean {
  return isOutstanding(order) && order.dueDate === today;
}

export type LabFilter = "late" | "pending" | "outstanding" | "received" | "remake" | "delivered" | "all";

export const LAB_FILTER_LABEL: Record<LabFilter, string> = {
  late: "متأخرة",
  pending: "لم تُرسل بعد",
  outstanding: "عند المختبر",
  received: "وصلت العيادة (جاهزة)",
  remake: "إعادات (Remakes)",
  delivered: "المكتملة والمسلّمة",
  all: "الكل",
};

export function filterOrders<T extends LabOrder | LabOrderClinicalDTO>(
  orders: T[],
  filter: LabFilter,
  today: string,
): T[] {
  switch (filter) {
    case "late":
      return orders.filter((order) => isOverdue(order, today));
    /* pending (V2 §١٩): أعمال ولّدها توقيع الزيارة ولم تُرسل للمختبر بعد. */
    case "pending":
      return orders.filter((order) => order.status === "needed");
    case "outstanding":
      return orders.filter(isOutstanding);
    case "received":
      return orders.filter((order) => order.status === "received");
    case "remake":
      return orders.filter((order) => order.status === "remake");
    case "delivered":
      return orders.filter((order) => order.status === "delivered");
    default:
      return orders;
  }
}

/** الترتيب الذي يجعل القائمة صالحة للعمل: الأكثر تأخّرًا أولًا */
export function sortByUrgency<T extends LabOrder | LabOrderClinicalDTO>(orders: T[], today: string): T[] {
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
  remakes?: number;
  deliveredTotal?: number;
}

export function labSummary(orders: (LabOrder | LabOrderClinicalDTO)[], today: string): LabSummary {
  return {
    outstanding: orders.filter(isOutstanding).length,
    late: orders.filter((order) => isOverdue(order, today)).length,
    dueToday: orders.filter((order) => isDueToday(order, today)).length,
    waitingFitting: orders.filter((order) => order.status === "received").length,
  };
}

export function labSummaryV2(orders: (LabOrder | LabOrderClinicalDTO)[], today: string): Required<LabSummary> {
  return {
    outstanding: orders.filter(isOutstanding).length,
    late: orders.filter((order) => isOverdue(order, today)).length,
    dueToday: orders.filter((order) => isDueToday(order, today)).length,
    waitingFitting: orders.filter((order) => order.status === "received").length,
    remakes: orders.filter((order) => order.status === "remake").length,
    deliveredTotal: orders.filter((order) => order.status === "delivered").length,
  };
}

/**
 * رسالة المتابعة والاستعجال للمختبر عبر واتساب — تركيز سريري وتاريخ استحقاق بلا أي معلومات مالية.
 */
export function labFollowUpText(order: LabOrderClinicalDTO | LabOrder, today: string, clinicName: string): string {
  const late = daysLate(order, today);
  const toothInfo = order.toothNumbers ? ` [الأسنان: ${order.toothNumbers}]` : "";
  const shadeInfo = order.shade ? ` [اللون: ${order.shade}]` : "";
  const lines = [
    `السلام عليكم،`,
    ``,
    `متابعة عمل من ${clinicName}:`,
    `المريض: ${order.patientName}`,
    `العمل: ${order.workType}${order.details ? ` — ${order.details}` : ""}${toothInfo}${shadeInfo}`,
    `أُرسل: ${order.sentDate} · الموعد المتفق: ${order.dueDate}`,
  ];

  if (order.priority === "urgent" || order.priority === "rush") {
    lines.push(`درجة الأهمية: ${LAB_PRIORITY_LABEL[order.priority].label}`);
  }

  lines.push(
    late > 0
      ? `مضى على الموعد ${late} ${late === 1 ? "يوم" : "أيام"}. نرجو إفادتنا بموعد التسليم — المريض بانتظاره.`
      : `نرجو تأكيد الجاهزية في موعدها.`,
  );
  return lines.join("\n");
}

/** إبلاغ المريض أن عمله وصل إلى العيادة وجاهز للتركيب */
export function patientReadyText(
  order: LabOrderClinicalDTO | LabOrder,
  clinicName: string,
  clinicPhone: string,
): string {
  return [
    `السلام عليكم ${order.patientName}،`,
    ``,
    `يسرنا إبلاغكم بأن ${order.workType} الخاص بكم قد وصل إلى ${clinicName} وجاهز للتركيب.`,
    `تفضّلوا بالتواصل معنا لحجز وتأكيد الموعد المناسب لكم.`,
    ``,
    `للتواصل والحجز: ${clinicPhone}`,
  ].join("\n");
}

/**
 * إنشاء نص طلب العمل المخبري السريري (Lab Prescription Sheet) الموجه للمعمل.
 * خالٍ تماماً وبشكل صارم من أي مبالغ أو أسعار أو تكاليف.
 */
export function formatLabPrescriptionText(
  order: LabOrderClinicalDTO | LabOrder,
  clinicName: string,
  clinicPhone?: string,
): string {
  const parts = [
    `══════════════════════════════════════`,
    `      طلب عمل مخبري سني (LAB PRESCRIPTION)      `,
    `          ${clinicName}          `,
    `══════════════════════════════════════`,
    `رقم الطلب: #${order.id}`,
    `التاريخ: ${order.sentDate}`,
    `موعد التسليم المطلوب: ${order.dueDate}`,
    `درجة الاستعجال: ${LAB_PRIORITY_LABEL[order.priority || "normal"].label}`,
    `──────────────────────────────────────`,
    `بيانات المريض:`,
    `• الاسم: ${order.patientName}`,
    `• رقم الملف: ${order.patientNumber || "—"}`,
    `• الطبيب المعالج: ${order.doctorName || "عيادة المركز"}`,
    `• المختبر: ${order.labName}`,
    `──────────────────────────────────────`,
    `المواصفات السريرية والسنية:`,
    `• نوع التركيبة / العمل: ${order.workType}`,
    `• رقم السن / الأسنان: ${order.toothNumbers || "—"}`,
    `• لون السن (Shade): ${order.shade || "—"}`,
    `• لون الجذع المحضر (Stump Shade): ${order.stumpShade || "—"}`,
    `• نوع الطبعة: ${LAB_IMPRESSION_LABEL[order.impressionType || "physical"]}`,
    order.details ? `• التفاصيل والتعليمات: ${order.details}` : "",
    order.note ? `• ملاحظات إضافية للفني: ${order.note}` : "",
    `──────────────────────────────────────`,
    `ملاحظة: هذا المستند سريري وتقني ولا يحتوي على أي بيانات مالية.`,
    clinicPhone ? `هاتف العيادة: ${clinicPhone}` : "",
    `══════════════════════════════════════`,
  ];
  return parts.filter(Boolean).join("\n");
}

