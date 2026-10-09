/**
 * (HR-5 / HR-6) المستحقات، مسير الرواتب، وسندات الصرف — **العقد المشترك الخالص**.
 *
 * عزل العملات التام ('YER', 'SAR', 'USD')، وحساب الصافي والمدفوع والمتبقي،
 * والتسميات العربية وقواعد التحقق المشتركة.
 */

import { CURRENCIES, type Currency } from "./money";

export type HrPayrollPeriodStatus = "draft" | "calculated" | "approved" | "closed";
export type HrPayrollRunStatus = "draft" | "approved" | "closed";
export type HrPayrollItemStatus = "accrued" | "partially_paid" | "fully_paid" | "reversed";
export type HrPaymentMethod = "cash" | "bank_transfer" | "cheque";

export const HR_PAYROLL_PERIOD_STATUS_LABEL: Record<HrPayrollPeriodStatus, string> = {
  draft: "مسودة",
  calculated: "محتسب",
  approved: "معتمد",
  closed: "مقفل",
};

export const HR_PAYROLL_RUN_STATUS_LABEL: Record<HrPayrollRunStatus, string> = {
  draft: "مسودة",
  approved: "معتمد ماليًا",
  closed: "مقفل ومرحّل",
};

export const HR_PAYROLL_ITEM_STATUS_LABEL: Record<HrPayrollItemStatus, string> = {
  accrued: "مستحق (غير مسدد)",
  partially_paid: "مسدد جزئيًا",
  fully_paid: "مسدد بالكامل",
  reversed: "معكوس",
};

export const HR_PAYMENT_METHOD_LABEL: Record<HrPaymentMethod, string> = {
  cash: "نقدًا (الصندوق)",
  bank_transfer: "تحويل بنكي",
  cheque: "شيك مصرفي",
};

export interface HrPayrollPeriodView {
  id: number;
  periodKey: string; // "2026-10"
  name: string;
  startDate: string;
  endDate: string;
  status: HrPayrollPeriodStatus;
  closedAt: string | null;
  closedBy: string | null;
  createdBy: string;
  createdAt: string;
  runs?: HrPayrollRunView[];
}

export interface HrPayrollRunView {
  id: number;
  periodId: number;
  periodKey?: string;
  periodName?: string;
  currency: Currency;
  status: HrPayrollRunStatus;
  totalBaseSalaryMinor: number;
  totalAllowancesMinor: number;
  totalCommissionsMinor: number;
  totalAdvancesMinor: number;
  totalDeductionsMinor: number;
  totalNetDueMinor: number;
  totalPaidMinor: number;
  totalRemainingMinor: number;
  approvedBy: string | null;
  approvedAt: string | null;
  createdBy: string;
  createdAt: string;
  itemsCount?: number;
}

export interface HrPayrollItemAllowanceDetail {
  name: string;
  amountMinor: number;
  reason?: string;
}

export interface HrPayrollItemCommissionDetail {
  commissionId?: number;
  source: string;
  periodKey: string;
  amountMinor: number;
  visitCount?: number;
  note?: string;
}

export interface HrPayrollItemDeductionDetail {
  name: string;
  amountMinor: number;
  reason?: string;
}

export interface HrPayrollItemView {
  id: number;
  runId: number;
  staffId: number;
  staffName: string;
  staffJobTitle: string;
  department: string;
  currency: Currency;
  baseSalaryMinor: number;
  allowancesMinor: number;
  allowanceDetails: HrPayrollItemAllowanceDetail[];
  commissionsMinor: number;
  commissionDetails: HrPayrollItemCommissionDetail[];
  advancesMinor: number;
  deductionsMinor: number;
  deductionDetails: HrPayrollItemDeductionDetail[];
  netDueMinor: number;
  paidMinor: number;
  remainingMinor: number;
  status: HrPayrollItemStatus;
  payableId: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  disbursements?: HrPayrollDisbursementView[];
}

export interface HrPayrollDisbursementView {
  id: number;
  itemId: number;
  staffId: number;
  staffName?: string;
  currency: Currency;
  amountMinor: number;
  paymentMethod: HrPaymentMethod;
  referenceNumber: string | null;
  expenseId: number | null;
  disbursedBy: string;
  disbursedAt: string;
  notes: string | null;
  clientRequestId: string | null;
}

export interface HrSettingsPayload {
  payrollCycle?: {
    defaultCurrency: Currency;
    salaryDay: number;
    cutoffDay: number;
  };
  attendancePolicy?: {
    lateGraceMins: number;
    lateDeductionRatePerHour: number;
    overtimeRateMultiplier: number;
  };
  leavePolicy?: {
    annualDefaultDays: number;
    probationMonths: number;
  };
}

/**
 * حساب صافي المستحق لبند في المسير:
 * الراتب الأساسي + البدلات + العمولات - السلف - الخصومات = صافي المستحق.
 */
export function calculateItemNetDue(item: {
  baseSalaryMinor: number;
  allowancesMinor: number;
  commissionsMinor: number;
  advancesMinor: number;
  deductionsMinor: number;
}): number {
  const gross = item.baseSalaryMinor + item.allowancesMinor + item.commissionsMinor;
  const cuts = item.advancesMinor + item.deductionsMinor;
  return Math.max(0, gross - cuts);
}

/**
 * التحقق من عزل العملات المعتمدة:
 */
export function isAllowedHrCurrency(currency: string): currency is Currency {
  return (CURRENCIES as readonly string[]).includes(currency);
}
