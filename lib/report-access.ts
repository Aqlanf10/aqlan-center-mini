/**
 * سياسة الوصول إلى مركز التقارير.
 *
 * "يلمس المال" لا يعني "يرى دخل المركز": الاستقبال يقبض ويصدر الفواتير كي يعمل
 * يومه، لكن تقارير الإيراد والربحية والعمولات وذمم الموردين رقابة إدارية.
 * لذلك لا نعيد استخدام canHandleMoney هنا.
 */

const RECEPTION_REPORTS = new Set([
  "options",
  "visits",
  "appointments",
  "recall",
  "inventory",
  // كشف مريض واحد جزء من خدمة الحساب والتحصيل اليومية، لا تقرير دخل المركز.
  "patient-statement",
]);

export function canAccessUnifiedReport(
  role: string | null | undefined,
  report: string,
): boolean {
  if (role === "admin") return true;
  if (role === "reception") return RECEPTION_REPORTS.has(report);
  return false;
}

export function reportIsAdminOnly(report: string): boolean {
  return !RECEPTION_REPORTS.has(report);
}
