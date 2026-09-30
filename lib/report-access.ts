/**
 * سياسة الوصول إلى مركز التقارير.
 *
 * "يلمس المال" لا يعني "يرى دخل المركز": الاستقبال يقبض ويصدر الفواتير كي يعمل
 * يومه، لكن تقارير الإيراد والربحية والعمولات وذمم الموردين رقابة إدارية.
 * لذلك لا نعيد استخدام canHandleMoney هنا.
 */

export const UNIFIED_REPORT_IDS = [
  "daily",
  "monthly",
  "annual",
  "collections",
  "services",
  "patients",
  "debt",
  "aging",
  "specialty",
  "doctor",
  "doctor-commission",
  "visits",
  "appointments",
  "recall",
  "inventory",
  "treatment-plans",
  "lab",
  "suppliers",
  "patient-statement",
  // (BILL-1) كشفٌ للقراءة فقط: جلسات خطط أقساطٍ فُوترت فوق أقساطها قبل الإصلاح.
  "plan-double-billing",
  // (CASE-1) كشفٌ للقراءة فقط: شدّات تقويم مكررة لـ(حالة، زيارة) — للمدير وحده (سريري).
  "ortho-duplicate-adjustments",
  // (Slice 7) سير العمل الجديد: تفصيل العمولات (مالي)، الإحالات الداخلية (تشغيلي)، جريان الكرسي (رقابي).
  "commission-detail",
  "internal-referrals",
  "chair-flow",
  // (Reports R4) ذكاء العيادة.
  "practice-overview",
  "provider-utilization",
  "chair-utilization",
  "appointment-performance",
  "plan-intelligence",
  "unscheduled-treatment",
  "lab-intelligence",
  "new-patient-intelligence",
  "recall-intelligence",
  "practice-trends",
] as const;

export type UnifiedReportId = typeof UNIFIED_REPORT_IDS[number];

const KNOWN_REPORTS = new Set<string>(["options", ...UNIFIED_REPORT_IDS]);

const RECEPTION_REPORTS = new Set<string>([
  "options",
  "visits",
  "appointments",
  "recall",
  "inventory",
  // كشف مريض واحد جزء من خدمة الحساب والتحصيل اليومية، لا تقرير دخل المركز.
  "patient-statement",
  // (Reports R4) تشغيلية بلا دخلٍ للمركز: أداء المواعيد، الكراسي، المتابعة، علاجٌ ينتظر الجدولة.
  "appointment-performance",
  "chair-utilization",
  "recall-intelligence",
  "unscheduled-treatment",
  // (Slice 7) الاستقبال يحجز الإحالات — فيرى ما ينتظر الحجز (بلا مال).
  "internal-referrals",
]);

/**
 * (P2-1) المحاسب: التقارير المالية — الإيراد والتحصيل والذمم والموردين والعمولات
 * والمختبر بتكلفته — لا التشغيلية ولا السريرية (المواعيد والزيارات والتقويم والخطط).
 */
const ACCOUNTANT_REPORTS = new Set<string>([
  "options",
  "daily",
  "monthly",
  "annual",
  "collections",
  "services",
  "debt",
  "aging",
  "specialty",
  "doctor",
  "doctor-commission",
  // (Slice 7) تفصيل العمولات سطرًا سطرًا — من المحرّك نفسه.
  "commission-detail",
  "lab",
  "suppliers",
  "patient-statement",
  "plan-double-billing",
]);

export function isKnownUnifiedReport(report: string): report is UnifiedReportId | "options" {
  return KNOWN_REPORTS.has(report);
}

/**
 * تقارير العمولات تتبع صلاحية `viewCommissions` نفسها التي تحرس شاشة العمولات وكشفها المطبوع —
 * محاسبٌ أُغلقت عنه العمولات لا يصل إليها من مركز التقارير أيضًا.
 */
const COMMISSION_REPORTS = new Set<string>(["doctor-commission", "commission-detail"]);

export function canAccessUnifiedReport(
  role: string | null | undefined,
  report: string,
  /** صلاحيات المحاسب الدقيقة من الجلسة (`financeAccess`) — بلا قيمة: الافتراضي الكامل للدور. */
  access?: { viewCommissions?: boolean } | null,
): boolean {
  if (!isKnownUnifiedReport(report)) return false;
  if (role === "admin") return true;
  if (role === "reception") return RECEPTION_REPORTS.has(report);
  if (role === "accountant") {
    if (COMMISSION_REPORTS.has(report) && access?.viewCommissions === false) return false;
    return ACCOUNTANT_REPORTS.has(report);
  }
  return false;
}

export function reportIsAdminOnly(report: string): boolean {
  return isKnownUnifiedReport(report) && !RECEPTION_REPORTS.has(report);
}

/** (P2-1) هل يظهر التقرير لهذا الدور في شاشة التقارير؟ — نفس قاعدة الخادم. */
export function reportVisibleToRole(
  role: string | null | undefined,
  report: string,
  access?: { viewCommissions?: boolean } | null,
): boolean {
  return canAccessUnifiedReport(role, report, access);
}
