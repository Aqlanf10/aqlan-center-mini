import type { StaffCapability } from "./staff-capability-catalogue";

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
  // (LEGACY-AUDIT) كشفٌ للقراءة فقط: سندات مدفوعات ما قبل النظام التي قُيّدت داخل ورديات مفتوحة.
  "pre-system-receipts",
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
  "pre-system-receipts",
]);

export function isKnownUnifiedReport(report: string): report is UnifiedReportId | "options" {
  return KNOWN_REPORTS.has(report);
}

/**
 * تقارير العمولات تتبع صلاحية `viewCommissions` نفسها التي تحرس شاشة العمولات وكشفها المطبوع —
 * محاسبٌ أُغلقت عنه العمولات لا يصل إليها من مركز التقارير أيضًا.
 */
const COMMISSION_REPORTS = new Set<string>(["doctor-commission", "commission-detail"]);
const SUPPLIER_REPORTS = new Set<string>(["suppliers"]);
const PATIENT_LEDGER_REPORTS = new Set<string>(["debt", "aging", "collections", "patient-statement"]);
const GENERAL_FINANCIAL_REPORTS = new Set<string>([
  "daily", "monthly", "annual", "services", "specialty", "doctor", "lab", "plan-double-billing", "pre-system-receipts",
]);

export interface ReportFinanceAccessShape {
  viewCommissions?: boolean;
  viewReports?: boolean;
  viewSuppliers?: boolean;
  viewPatientLedger?: boolean;
}

export function canAccessUnifiedReport(
  role: string | null | undefined,
  report: string,
  /** صلاحيات المحاسب الدقيقة من الجلسة (`financeAccess`) — بلا قيمة: الافتراضي الكامل للدور. */
  access?: ReportFinanceAccessShape | null,
): boolean {
  if (!isKnownUnifiedReport(report)) return false;
  if (role === "admin") return true;
  if (role === "reception") return RECEPTION_REPORTS.has(report);
  if (role === "accountant") {
    if (COMMISSION_REPORTS.has(report) && access?.viewCommissions === false) return false;
    if (SUPPLIER_REPORTS.has(report) && access?.viewSuppliers === false) return false;
    if (PATIENT_LEDGER_REPORTS.has(report) && access?.viewPatientLedger === false) return false;
    if (GENERAL_FINANCIAL_REPORTS.has(report) && access?.viewReports === false) return false;
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
  access?: ReportFinanceAccessShape | null,
): boolean {
  return canAccessUnifiedReport(role, report, access);
}

const CLINICAL_ONLY_REPORTS = new Set<string>([
  "treatment-plans",
  "plan-intelligence",
  "ortho-duplicate-adjustments",
  "lab-intelligence",
]);

const MIXED_REVENUE_OPERATIONAL_REPORTS = new Set<string>([
  "practice-overview",
  "practice-trends",
]);

const OPERATIONAL_REPORTS = new Set<string>([
  "patients",
  "visits",
  "appointments",
  "recall",
  "inventory",
  "internal-referrals",
  "chair-flow",
  "provider-utilization",
  "chair-utilization",
  "appointment-performance",
  "unscheduled-treatment",
  "new-patient-intelligence",
  "recall-intelligence",
]);

/** Canonical capability-based access to each unified report (never role-label based). */
export function canCanonicalAccessUnifiedReport(
  report: string,
  granted: (capability: StaffCapability) => boolean,
): boolean {
  if (!isKnownUnifiedReport(report)) return false;
  if (report === "options") {
    return (
      granted("reports.operational.view") ||
      granted("reports.financial.view") ||
      granted("reports.clinical.view")
    );
  }
  if (COMMISSION_REPORTS.has(report)) {
    return granted("reports.financial.view") && granted("finance.commissions.view-all");
  }
  if (SUPPLIER_REPORTS.has(report)) {
    return granted("reports.financial.view") && granted("finance.suppliers.view");
  }
  if (report === "patient-statement") {
    return (
      (granted("reports.financial.view") || granted("reports.operational.view")) &&
      granted("finance.patient-ledger.view")
    );
  }
  if (PATIENT_LEDGER_REPORTS.has(report)) {
    return granted("reports.financial.view") && granted("finance.patient-ledger.view");
  }
  if (GENERAL_FINANCIAL_REPORTS.has(report)) {
    return granted("reports.financial.view");
  }
  if (CLINICAL_ONLY_REPORTS.has(report)) {
    return granted("reports.clinical.view");
  }
  if (MIXED_REVENUE_OPERATIONAL_REPORTS.has(report)) {
    return granted("reports.financial.view") && granted("reports.operational.view");
  }
  if (OPERATIONAL_REPORTS.has(report)) {
    return granted("reports.operational.view");
  }
  return false;
}
