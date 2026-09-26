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
  "lab",
  "suppliers",
  "patient-statement",
]);

export function isKnownUnifiedReport(report: string): report is UnifiedReportId | "options" {
  return KNOWN_REPORTS.has(report);
}

export function canAccessUnifiedReport(
  role: string | null | undefined,
  report: string,
): boolean {
  if (!isKnownUnifiedReport(report)) return false;
  if (role === "admin") return true;
  if (role === "reception") return RECEPTION_REPORTS.has(report);
  if (role === "accountant") return ACCOUNTANT_REPORTS.has(report);
  return false;
}

export function reportIsAdminOnly(report: string): boolean {
  return isKnownUnifiedReport(report) && !RECEPTION_REPORTS.has(report);
}

/** (P2-1) هل يظهر التقرير لهذا الدور في شاشة التقارير؟ — نفس قاعدة الخادم. */
export function reportVisibleToRole(role: string | null | undefined, report: string): boolean {
  return canAccessUnifiedReport(role, report);
}
