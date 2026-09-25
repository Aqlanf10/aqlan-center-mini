/**
 * (Reports R3) قوالب المركز الجاهزة — عروضٌ شائعة يفتحها الطاقم بنقرة.
 *
 * القالب رابطُ فلاتر وعرضٍ فقط: لا يحمل بيانات ولا صلاحيات. يُعرض لكل دورٍ ما
 * يملك صلاحيته على تقريره (canAccessUnifiedReport)، وفتحه يمرّ بمسار التقارير
 * نفسه الذي يفرض الصلاحية خادميًّا — فالقالب لا يتجاوزها أبدًا.
 */

import { canAccessUnifiedReport, type UnifiedReportId } from "./report-access";
import type { ReportSectionId } from "./saved-reports";

export interface ReportTemplate {
  key: string;
  name: string;
  reportId: UnifiedReportId;
  sectionId: ReportSectionId;
  queryString: string;
}

export const REPORT_TEMPLATES: readonly ReportTemplate[] = [
  {
    key: "today-visits",
    name: "مرضى اليوم",
    reportId: "visits",
    sectionId: "operational",
    queryString: "report=visits&preset=today&sort=arrivedTime:asc",
  },
  {
    key: "week-appointments-by-status",
    name: "مواعيد الأسبوع حسب الحالة (ومنها عدم الحضور)",
    reportId: "appointments",
    sectionId: "operational",
    queryString: "report=appointments&preset=this_week&group=statusLabel",
  },
  {
    key: "month-new-patients",
    name: "مرضى جدد هذا الشهر",
    reportId: "patients",
    sectionId: "operational",
    queryString: "report=patients&preset=this_month",
  },
  {
    key: "lab-overdue",
    name: "متأخرات المختبر",
    reportId: "lab",
    sectionId: "clinical",
    queryString: "report=lab&preset=this_year&sort=daysLate:desc",
  },
  {
    key: "doctors-productivity",
    name: "إنتاجية الأطباء هذا الشهر",
    reportId: "doctor",
    sectionId: "doctors",
    queryString: "report=doctor&preset=this_month",
  },
  {
    key: "outstanding-debt",
    name: "المديونية القائمة",
    reportId: "debt",
    sectionId: "receivables",
    queryString: "report=debt&preset=this_month&debtMode=outstanding",
  },
];

export function templatesForRole(role: string | null | undefined): ReportTemplate[] {
  return REPORT_TEMPLATES.filter((template) => canAccessUnifiedReport(role, template.reportId));
}
