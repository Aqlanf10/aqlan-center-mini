/**
 * (HR-1/HR-2) الموارد البشرية والمهام — **المنطق الخالص المشترك**: أنواع ومفردات
 * وصلاحيات وخصوصية وتحقق وعرض. بلا أي استيرادٍ لوحدة قاعدة أو خادم — يُستورد
 * بحرية في مكوّنات العميل وفي الخادم معًا. طبقة القاعدة في `lib/hr.ts`.
 *
 * ملفات الطاقم كيانٌ مستقل عن حسابات الدخول: الحارس والمنسق والسكرتارية لهم ملفٌ
 * بلا حساب، والحساب لا يُنشأ من هنا أبدًا وإنما يُربط اختياريًّا بحسابٍ موجود واحد.
 * المسمى الوظيفي نصٌّ حرّ في الملف لا علاقة له بدور الدخول — «حارس» في الملف لا
 * يمنح دورَ استقبالٍ ولا مساعدٍ سريري، ومسارُ الحماية بقي users.role كما هو.
 *
 * نوع التعاقد ثلاثة: «نسبة» تُقرأ من مصدر عمولات الجهات الحالي (parties و
 * doctor-permissions — لا محرك عمولات جديد هنا ولا تغيير نسبة بسبب ملفٍ)، و«راتب»،
 * و«راتب ونسبة». أي مبلغ راتبٍ يُحفظ بعملته ودوريته وتاريخ سريانه، ولا يخرج في
 * دليل الإسناد (المسند إليه يختار اسمًا ومسمًّى وظيفيًّا — لا مبالغ).
 *
 * المهام: خاصة (ملكٌ لصاحبها وحده — لا يراها المدير نفسه عبر القوائم أو البحث أو
 * العدادات أو الروابط أو التدقيق العام) ومشتركة (الإدارة المخولة تتابعها، والمسؤول
 * يعمل فيها). كل تحديثٍ بجلسةٍ حقيقية يُسجَّل باسم من نفّذه فعلًا — التحديث نيابةً
 * عن موظفٍ بلا حساب يحمل هوية من ضغط الزر.
 *
 * هذه الواجهة هي عقد العرض: شروط الأجر تُسقَط بـ`staffToView(row, false)`، والخصوصية
 * دوال خالصة تُختبر بجدول — والخادم وحده من يستدعيها على الصفوف الفعلية.
 */

import type { SessionPayload } from "./auth";
import { isCurrency } from "./money";

/* ── المفردات المغلقة ─────────────────────────────────────────────────────── */

export const HR_DEPARTMENTS = ["doctors", "assistants", "secretariat", "nursing", "guard", "coordinator", "accounting", "other"] as const;
export type HrDepartment = (typeof HR_DEPARTMENTS)[number];

export const HR_WORK_STATUSES = ["active", "suspended", "ended"] as const;
export type HrWorkStatus = (typeof HR_WORK_STATUSES)[number];

export const HR_CONTRACT_KINDS = ["commission", "salary", "salary_commission"] as const;
export type HrContractKind = (typeof HR_CONTRACT_KINDS)[number];

export const HR_SALARY_PERIODS = ["monthly", "weekly", "daily", "per_shift"] as const;
export type HrSalaryPeriod = (typeof HR_SALARY_PERIODS)[number];

export const TASK_STATUSES = ["planned", "in_progress", "blocked", "completed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_LINK_KINDS = ["patient", "lab_order", "inventory_item"] as const;
export type TaskLinkKind = (typeof TASK_LINK_KINDS)[number];

export const HR_DEPARTMENT_LABEL: Record<HrDepartment, string> = {
  doctors: "الأطباء",
  assistants: "المساعدون",
  secretariat: "السكرتارية",
  nursing: "التمريض",
  guard: "الحارس والخدمة",
  coordinator: "المنسقون",
  accounting: "الحسابات",
  other: "أخرى",
};

export const HR_WORK_STATUS_LABEL: Record<HrWorkStatus, string> = {
  active: "على رأس العمل",
  suspended: "موقوف مؤقتًا",
  ended: "انتهت خدمته",
};

export const HR_CONTRACT_KIND_LABEL: Record<HrContractKind, string> = {
  commission: "نسبة",
  salary: "راتب",
  salary_commission: "راتب ونسبة",
};

export const HR_SALARY_PERIOD_LABEL: Record<HrSalaryPeriod, string> = {
  monthly: "شهري",
  weekly: "أسبوعي",
  daily: "يومي",
  per_shift: "لكل وردية",
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  planned: "مخططة",
  in_progress: "جارية",
  blocked: "متعطلة",
  completed: "مكتملة",
  cancelled: "ملغاة",
};

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "منخفضة",
  normal: "عادية",
  high: "عالية",
  urgent: "عاجلة",
};

export const TASK_LINK_KIND_LABEL: Record<TaskLinkKind, string> = {
  patient: "مريض",
  lab_order: "أمر مختبر",
  inventory_item: "بند مخزون",
};

export function isHrDepartment(value: unknown): value is HrDepartment {
  return typeof value === "string" && (HR_DEPARTMENTS as readonly string[]).includes(value);
}
export function isHrWorkStatus(value: unknown): value is HrWorkStatus {
  return typeof value === "string" && (HR_WORK_STATUSES as readonly string[]).includes(value);
}
export function isHrContractKind(value: unknown): value is HrContractKind {
  return typeof value === "string" && (HR_CONTRACT_KINDS as readonly string[]).includes(value);
}
export function isHrSalaryPeriod(value: unknown): value is HrSalaryPeriod {
  return typeof value === "string" && (HR_SALARY_PERIODS as readonly string[]).includes(value);
}
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}
export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);
}
export function isTaskLinkKind(value: unknown): value is TaskLinkKind {
  return typeof value === "string" && (TASK_LINK_KINDS as readonly string[]).includes(value);
}

/* ── الصلاحيات — في الخادم لا في الشاشة ──────────────────────────────────── */

/** إدارة ملفات الطاقم وشروط الأجر: المدير وحده. */
export function canManageStaff(role: string | undefined | null): boolean {
  return role === "admin";
}

/** إسناد المهام ومتابعة الفريق: المدير والاستقبال (الإدارة المخولة). */
export function canAssignTasks(role: string | undefined | null): boolean {
  return role === "admin" || role === "reception";
}

/** استخدام منظومة المهام إطلاقًا: الأدوار غير المقيّدة عند الباب. */
export function canUseTasks(role: string | undefined | null): boolean {
  return role === "admin" || role === "reception" || role === "doctor";
}

/** الأدوار المسموح لها بإنشاء مهمة خاصة لنفسها: كل من يدخل المهام. */
export function canCreatePrivateTask(role: string | undefined | null): boolean {
  return canUseTasks(role);
}

/* ── أنواع الصفوف ────────────────────────────────────────────────────────── */

export interface HrStaffRow {
  id: number;
  full_name: string;
  job_title: string;
  department: HrDepartment;
  work_status: HrWorkStatus;
  hire_date: string | null;
  end_date: string | null;
  contract_kind: HrContractKind;
  salary_amount_minor: string | number | null;
  salary_currency: string | null;
  salary_period: HrSalaryPeriod | null;
  salary_effective_on: string | null;
  user_id: number | null;
  user_linked_at: Date | string | null;
  phone: string | null;
  note: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

/** شكل ملف الموظف كما يخرج من الخادم — المبالغ اختيارية لأنها للمدير وحده. */
export interface HrStaffView {
  id: number;
  fullName: string;
  jobTitle: string;
  department: HrDepartment;
  workStatus: HrWorkStatus;
  hireDate: string | null;
  endDate: string | null;
  contractKind: HrContractKind;
  /** شروط الأجر — تُملأ للمدير المخوّل وحده، وتُسقَط من كل قائمة اختيار. */
  payTerms: {
    amountMinor: number;
    currency: string;
    period: HrSalaryPeriod;
    effectiveOn: string;
  } | null;
  userId: number | null;
  phone: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrTaskRow {
  id: number;
  title: string;
  description: string;
  is_private: boolean;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: Date | string | null;
  planned_for: Date | string | null;
  owner_user_id: number;
  owner_display_name: string;
  assignee_staff_id: number | null;
  /** لقطة تاريخية لربط الحساب وقت الإسناد — لا تُستعمل في الصلاحية إطلاقًا. */
  assignee_user_id: number | null;
  assignee_label: string;
  completed_at: Date | string | null;
  client_request_id: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface HrTaskView {
  id: number;
  title: string;
  description: string;
  isPrivate: boolean;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  /** تاريخ التخطيط المستقل عن الاستحقاق — حالة «مخطّطة» لا تعوّضه. */
  plannedFor: string | null;
  overdue: boolean;
  /** أيام التأخر عند تجاوز الموعد وحالة المهمة مفتوحة — صفرٌ وإلا. */
  overdueDays: number;
  ownerUserId: number;
  ownerDisplayName: string;
  assigneeStaffId: number | null;
  assigneeUserId: number | null;
  assigneeLabel: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ── الخصوصية والقدرة على التعديل — دوال خالصة تُختبر بجدول ─────────────── */

/**
 * من يرى المهمة؟ الخاصة لصاحبها وحده — المدير ليس استثناءً: ما هو خاصٌّ خاصٌّ.
 * والمشتركة للإدارة المخولة ولصاحبها وللمسؤول.
 *
 * **مسؤولية المهمّف تُحسب عبر الربط الحالي بين حسابه وملف الطاقم فقط** (viewerStaffId
 * يُشتق من hr_staff.user_id لحظة الفحص): `assignee_user_id` المخزَّن على المهمة
 * لقطة تاريخية وقت الإسناد لا تُثبت شيئًا — فكّ الربط أو تغييره أو تعطيل الحساب
 * يسحب الوصول فورًا عبر كل المسارات، وإعادة الربط بحسابٍ آخر تمنحه لمالكه الجديد،
 * دون أي نقلٍ لملكية المهام الخاصة.
 */
export function canSeeTask(
  task: Pick<HrTaskRow, "is_private" | "owner_user_id" | "assignee_staff_id">,
  session: Pick<SessionPayload, "userId" | "role">,
  viewerStaffId: number | null = null,
): boolean {
  if (task.is_private) return task.owner_user_id === session.userId;
  if (canAssignTasks(session.role)) return true;
  if (task.owner_user_id === session.userId) return true;
  return viewerStaffId !== null && task.assignee_staff_id !== null && task.assignee_staff_id === viewerStaffId;
}

/** من يعدّل بيانات المهمة (عنوان/وصف/أولوية/موعد/مسؤول/روابط/تحويل)؟ */
export function canManageTask(
  task: Pick<HrTaskRow, "is_private" | "owner_user_id">,
  session: Pick<SessionPayload, "userId" | "role">,
): boolean {
  if (task.is_private) return task.owner_user_id === session.userId;
  if (canAssignTasks(session.role)) return true;
  return task.owner_user_id === session.userId;
}

/**
 * من يعمل في المهمة (تغيير الحالة/التحقق/التعليق)؟ المسؤول فيها كصاحبها في العمل —
 * **والعمل وحده**: تعديل حقول الإدارة ليس من العمل، ويحرسه canManageTask على حدة.
 */
export function canWorkOnTask(
  task: Pick<HrTaskRow, "is_private" | "owner_user_id" | "assignee_staff_id">,
  session: Pick<SessionPayload, "userId" | "role">,
  viewerStaffId: number | null = null,
): boolean {
  if (canManageTask(task, session)) return true;
  if (task.is_private) return false;
  return viewerStaffId !== null && task.assignee_staff_id !== null && task.assignee_staff_id === viewerStaffId;
}

/**
 * حقول الإدارة التي تتجاوز العمل في المهمة — يتطلب أيًّا منها canManageTask
 * في الخادم على مستوى المسار والحقل، لا في الواجهة: المكلّف يغيّر الحالة
 * ويعلّق ويعمل في القائمة، ولا يعدّل العنوان أو الأولوية أو الموعد ولا
 * يُعيد الإسناد (فإعادة الإسناد تمنح غيره الوصول — قرار إداري لا قرار مكلّف).
 */
export const TASK_MANAGEMENT_FIELDS = [
  "title", "description", "priority", "dueAt", "plannedFor", "assigneeStaffId", "convertToShared",
] as const;

export type TaskManagementField = (typeof TASK_MANAGEMENT_FIELDS)[number];

/** نتيجة تعديل ملف موظف — رفضٌ بسببٍ واضح (400/404/409) أو نجاح بالملف المحدَّث. */
export type StaffUpdateResult =
  | { ok: true; staff: HrStaffView; changed: boolean }
  | { ok: false; error: string; status: number };

/* ── التحقق من المدخلات — خالص وقابل للاختبار ────────────────────────────── */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface PayTermsInput {
  amountMinor: number;
  currency: string;
  period: HrSalaryPeriod;
  effectiveOn: string;
}

/**
 * شروط الأجر تُقبل ثلاثتها معًا أو تُرفض كلها: مبلغٌ بلا عملةٍ ودوريةٍ وتاريخ
 * سريانٍ هو رقمٌ بلا معنى يتعارض يوم الحساب. المبلغ بالوحدات الصغرى للعملة
 * (lib/money.ts: اليمني بوحدةٍ واحدة، والسعودي والدولار بالهللة/السنت)،
 * والعملة إحدى عملات المركز المعتمدة حصرًا (YER/SAR/USD) لا أي رمزٍ من ثلاثة أحرف.
 */
export function validatePayTermsInput(source: Record<string, unknown>): PayTermsInput | null | string {
  const rawAmount = source.salaryAmountMinor;
  const rawCurrency = source.salaryCurrency;
  const rawPeriod = source.salaryPeriod;
  const rawEffective = source.salaryEffectiveOn;
  if (rawAmount === undefined && rawCurrency === undefined && rawPeriod === undefined && rawEffective === undefined) {
    return null; // لا شروط أجرٍ في الطلب
  }
  const amount = Number(rawAmount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 9_000_000_000_000) {
    return "مبلغ الراتب رقمٌ صحيح موجب بالوحدات الصغرى لعملته (اليمني وحدة، والسعودي والدولار هللة/سنت).";
  }
  if (typeof rawCurrency !== "string" || !isCurrency(rawCurrency)) {
    return "عملة الراتب إحدى عملات المركز المعتمدة: YER أو SAR أو USD.";
  }
  if (!isHrSalaryPeriod(rawPeriod)) {
    return "دورية الراتب: شهري أو أسبوعي أو يومي أو لكل وردية.";
  }
  if (typeof rawEffective !== "string" || !DATE_RE.test(rawEffective)) {
    return "تاريخ سريان الراتب بصيغة YYYY-MM-DD.";
  }
  return { amountMinor: amount, currency: rawCurrency, period: rawPeriod, effectiveOn: rawEffective };
}

/** المسمى الوظيفي حرّ لكنه ليس فوضى: نصٌّ معقول بلا أحرف تحكّم. */
export function cleanJobTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (trimmed.length > 80) return null;
  return trimmed;
}

export function cleanOptionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) return undefined;
  return trimmed;
}

export function cleanDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !DATE_RE.test(value)) return undefined;
  return value;
}

/* ── عرض الصفوف — سقاطة الحقول المالية قبل مغادرة الخادم ────────────────── */

/** عمود DATE يعود من pg ككائن Date — الوجهة الواجهية نصٌّ YYYY-MM-DD دائمًا. */
function dateToIsoDate(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

export function staffToView(row: HrStaffRow, includePayTerms: boolean): HrStaffView {
  const hasPay =
    includePayTerms &&
    row.salary_amount_minor !== null &&
    row.salary_currency !== null &&
    row.salary_period !== null &&
    row.salary_effective_on !== null;
  return {
    id: row.id,
    fullName: row.full_name,
    jobTitle: row.job_title,
    department: row.department,
    workStatus: row.work_status,
    hireDate: dateToIsoDate(row.hire_date),
    endDate: dateToIsoDate(row.end_date),
    contractKind: row.contract_kind,
    payTerms: hasPay
      ? {
          amountMinor: Number(row.salary_amount_minor),
          currency: row.salary_currency as string,
          period: row.salary_period as HrSalaryPeriod,
          effectiveOn: dateToIsoDate(row.salary_effective_on) as string,
        }
      : null,
    userId: row.user_id,
    phone: row.phone,
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function taskToView(row: HrTaskRow, nowMs: number = Date.now()): HrTaskView {
  const dueMs = row.due_at ? new Date(row.due_at).getTime() : null;
  const open = row.status !== "completed" && row.status !== "cancelled";
  const overdue = dueMs !== null && dueMs < nowMs && open;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    isPrivate: row.is_private,
    status: row.status,
    priority: row.priority,
    dueAt: row.due_at ? new Date(row.due_at).toISOString() : null,
    plannedFor: dateToIsoDate(row.planned_for),
    overdue,
    overdueDays: overdue ? Math.max(0, Math.floor((nowMs - dueMs) / 86_400_000)) : 0,
    ownerUserId: row.owner_user_id,
    ownerDisplayName: row.owner_display_name,
    assigneeStaffId: row.assignee_staff_id,
    assigneeUserId: row.assignee_user_id,
    assigneeLabel: row.assignee_label,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

