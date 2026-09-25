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
  return false;
}

export function reportIsAdminOnly(report: string): boolean {
  return isKnownUnifiedReport(report) && !RECEPTION_REPORTS.has(report);
}
