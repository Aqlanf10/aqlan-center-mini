/**
 * (HR-3 / HR-4) العقود، جداول العمل، الحضور والانصراف، والإجازات — **العقد المشترك الخالص**.
 *
 * أنواع، مفردات، صلاحيات، تسميات عربية، وتحقق — بلا استيراد لـ pg أو node:fs
 * ليجوز استيراده من مكونات العميل (Next.js Client Components) والخادم معًا.
 */

import type { HrDepartment } from "./hr-shared";

/* ── ١. العقود والقوالب ──────────────────────────────────────────────────── */

export type HrContractTemplateKind =
  | "doctor_percentage"
  | "doctor_salary"
  | "doctor_hybrid"
  | "support_staff";

export type HrContractStatus =
  | "draft"
  | "under_review"
  | "approved"
  | "active"
  | "expired"
  | "terminated";

export const HR_CONTRACT_TEMPLATE_LABEL: Record<HrContractTemplateKind, string> = {
  doctor_percentage: "طبيب بالعمولة (نسبة)",
  doctor_salary: "طبيب براتب ثابت",
  doctor_hybrid: "طبيب بنظام مختلط (راتب ونسبة)",
  support_staff: "موظف مساند (استقبال، سكرتارية، حراسة، تمريض، تنسيق، حسابات)",
};

export const HR_CONTRACT_STATUS_LABEL: Record<HrContractStatus, string> = {
  draft: "مسودة",
  under_review: "قيد المراجعة",
  approved: "معتمد إداريًا",
  active: "سارٍ",
  expired: "منتهٍ",
  terminated: "مُنهى",
};

export interface HrContractTermsPayload {
  jobDescription?: string;
  workingHoursSummary?: string;
  allowances?: Array<{ name: string; amountMinor: number; currency: string; period: string }>;
  clauses?: string[];
  commissionNotes?: string;
  confidentialityClause?: boolean;
  administrativeDisclaimer?: string;
}

export interface HrContractView {
  id: number;
  staffId: number;
  staffName?: string;
  staffDepartment?: HrDepartment;
  contractNumber: string;
  templateKind: HrContractTemplateKind;
  title: string;
  status: HrContractStatus;
  startDate: string;
  endDate: string | null;
  probationEndDate: string | null;
  noticePeriodDays: number;
  termsPayload: HrContractTermsPayload;
  compensationKind: "commission" | "salary" | "salary_commission";
  baseSalaryMinor: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  commissionRatePercent: number | null;
  doctorPartyId: number | null;
  parentContractId: number | null;
  versionNumber: number;
  addendumReason: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  signedAt: string | null;
  signedByStaff: boolean;
  signedByCenter: boolean;
  attachmentRefs: Array<{ id: string; name: string; url?: string; uploadedAt: string }>;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/* ── ٢. جداول الدوام والورديات ───────────────────────────────────────────── */

export type HrScheduleType = "morning" | "evening" | "split" | "variable" | "night";

export const HR_SCHEDULE_TYPE_LABEL: Record<HrScheduleType, string> = {
  morning: "صباحي",
  evening: "مسائي",
  split: "فترتين (منقسم)",
  variable: "متغير",
  night: "ليلي (يعبر منتصف الليل)",
};

export const WEEK_DAYS_AR: Record<number, string> = {
  0: "الأحد",
  1: "الإثنين",
  2: "الثلاثاء",
  3: "الأربعاء",
  4: "الخميس",
  5: "الجمعة",
  6: "السبت",
};

export interface HrWorkScheduleView {
  id: number;
  staffId: number | null;
  staffName?: string | null;
  department: HrDepartment | null;
  name: string;
  scheduleType: HrScheduleType;
  effectiveFrom: string;
  effectiveTo: string | null;
  workingDays: number[];
  shiftStartTime: string;
  shiftEndTime: string;
  secondShiftStart: string | null;
  secondShiftEnd: string | null;
  gracePeriodMins: number;
  expectedDailyHours: number;
  crossesMidnight: boolean;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/* ── ٣. الحضور والانصراف ─────────────────────────────────────────────────── */

export type HrAttendanceStatus =
  | "present"
  | "late"
  | "early_exit"
  | "incomplete"
  | "absent"
  | "on_leave"
  | "holiday"
  | "rest_day";

export const HR_ATTENDANCE_STATUS_LABEL: Record<HrAttendanceStatus, string> = {
  present: "حاضر",
  late: "متأخر",
  early_exit: "خروج مبكر",
  incomplete: "تسجيل ناقص",
  absent: "غياب",
  on_leave: "إجازة معتمدة",
  holiday: "عطلة رسمية",
  rest_day: "راحة أسبوعية",
};

export interface HrAttendanceRecordView {
  id: number;
  staffId: number;
  staffName: string;
  staffJobTitle: string;
  department: HrDepartment;
  scheduleId: number | null;
  attendanceDate: string;
  status: HrAttendanceStatus;
  checkInRaw: string | null;
  checkOutRaw: string | null;
  checkInActual: string | null;
  checkOutActual: string | null;
  workMinutes: number;
  lateMinutes: number;
  earlyExitMinutes: number;
  overtimeMinutes: number;
  overtimeApproved: boolean;
  overtimeApprovedBy: string | null;
  overtimeApprovedAt: string | null;
  isIncomplete: boolean;
  source: "manual" | "imported" | "scheduled";
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HrAttendanceCorrectionView {
  id: number;
  attendanceId: number;
  staffId: number;
  staffName?: string;
  fieldCorrected: "check_in" | "check_out" | "status" | "overtime" | "all";
  oldCheckIn: string | null;
  newCheckIn: string | null;
  oldCheckOut: string | null;
  newCheckOut: string | null;
  oldStatus: string | null;
  newStatus: string | null;
  reason: string;
  requestedBy: string;
  approvedBy: string;
  approvedAt: string;
  createdAt: string;
}

/* ── ٤. الإجازات والأرصدة ────────────────────────────────────────────────── */

export type HrLeaveTypeCode =
  | "annual"
  | "sick"
  | "unpaid"
  | "emergency"
  | "maternity"
  | "paternity"
  | "holiday";

export type HrLeaveRequestStatus = "pending" | "under_review" | "approved" | "rejected" | "cancelled";

export const HR_LEAVE_TYPE_LABEL: Record<HrLeaveTypeCode, string> = {
  annual: "إجازة سنوية",
  sick: "إجازة مرضية",
  unpaid: "إجازة بدون راتب",
  emergency: "إجازة طارئة",
  maternity: "إجازة أمومة",
  paternity: "إجازة أبوة",
  holiday: "عطلة رسمية",
};

export const HR_LEAVE_STATUS_LABEL: Record<HrLeaveRequestStatus, string> = {
  pending: "قيد الانتظار",
  under_review: "قيد المراجعة",
  approved: "مقبولة",
  rejected: "مرفوضة",
  cancelled: "ملغاة",
};

export interface HrLeaveBalanceView {
  id: number;
  staffId: number;
  staffName?: string;
  leaveTypeCode: HrLeaveTypeCode;
  leaveTypeName?: string;
  year: number;
  allocatedDays: number;
  carriedOverDays: number;
  usedDays: number;
  pendingDays: number;
  availableDays: number; // allocated + carriedOver - used - pending
  effectiveFrom: string;
  effectiveTo: string;
  updatedAt: string;
}

export interface HrLeaveRequestView {
  id: number;
  staffId: number;
  staffName: string;
  staffJobTitle: string;
  department: HrDepartment;
  leaveTypeCode: HrLeaveTypeCode;
  leaveTypeName?: string;
  startDate: string;
  endDate: string;
  daysCount: number;
  isPartialDay: boolean;
  partialHours: number | null;
  reason: string;
  status: HrLeaveRequestStatus;
  decisionBy: string | null;
  decisionAt: string | null;
  decisionReason: string | null;
  attachmentRefs: Array<{ id: string; name: string; url?: string }>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/* ── حسابات الدوام وساعات التأخير والورديات ──────────────────────────────── */

export interface ShiftCalculation {
  workMinutes: number;
  lateMinutes: number;
  earlyExitMinutes: number;
  overtimeMinutes: number;
  isIncomplete: boolean;
  status: HrAttendanceStatus;
}

/**
 * احتساب ساعات العمل الدقيقة لوردية (تدعم الورديات التي تعبر منتصف الليل).
 */
export function calculateShiftAttendance(params: {
  checkIn: Date | null;
  checkOut: Date | null;
  scheduledStart: string; // "HH:MM"
  scheduledEnd: string;   // "HH:MM"
  graceMins: number;
  crossesMidnight: boolean;
}): ShiftCalculation {
  if (!params.checkIn || !params.checkOut) {
    return {
      workMinutes: 0,
      lateMinutes: 0,
      earlyExitMinutes: 0,
      overtimeMinutes: 0,
      isIncomplete: Boolean(params.checkIn && !params.checkOut),
      status: params.checkIn && !params.checkOut ? "incomplete" : "absent",
    };
  }

  const [startH, startM] = params.scheduledStart.split(":").map(Number);
  const [endH, endM] = params.scheduledEnd.split(":").map(Number);

  // حساب دقيقة البداية والنهاية من بداية اليوم
  const schedStartMin = startH * 60 + startM;
  let schedEndMin = endH * 60 + endM;
  if (params.crossesMidnight || schedEndMin <= schedStartMin) {
    schedEndMin += 24 * 60; // اليوم التالي
  }

  const inH = params.checkIn.getHours();
  const inM = params.checkIn.getMinutes();
  const actualInMin = inH * 60 + inM;

  let outH = params.checkOut.getHours();
  let outM = params.checkOut.getMinutes();
  let actualOutMin = outH * 60 + outM;

  if (params.crossesMidnight && actualOutMin < actualInMin) {
    actualOutMin += 24 * 60;
  }

  const workMinutes = Math.max(0, actualOutMin - actualInMin);

  // حساب التأخير (مع فترة السماح)
  let lateMinutes = 0;
  if (actualInMin > schedStartMin + params.graceMins) {
    lateMinutes = actualInMin - schedStartMin;
  }

  // حساب الخروج المبكر
  let earlyExitMinutes = 0;
  if (actualOutMin < schedEndMin) {
    earlyExitMinutes = schedEndMin - actualOutMin;
  }

  // حساب الساعات الإضافية (بعد انتهاء الوردية المجدولة)
  let overtimeMinutes = 0;
  if (actualOutMin > schedEndMin) {
    overtimeMinutes = actualOutMin - schedEndMin;
  }

  let status: HrAttendanceStatus = "present";
  if (lateMinutes > 0) {
    status = "late";
  } else if (earlyExitMinutes > 0) {
    status = "early_exit";
  }

  return {
    workMinutes,
    lateMinutes,
    earlyExitMinutes,
    overtimeMinutes,
    isIncomplete: false,
    status,
  };
}
