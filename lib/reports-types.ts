/**
 * أنواع التقارير والتسميات — نقسمها عن محرك التقارير عمدًا.
 *
 * هذا الملف **لا يستورد شيئًا من الخادم** (لا pg ولا db.ts): تستورده شاشة العميل
 * لأنواعها وتسمياتها فحسب، ولو كان في lib/reports.ts لجُلب postgres إلى حزمة
 * المتصفح معه — عيبٌ لا يظهر إلا في حجم الحزمة وكسر البناء.
 */

import type { Currency } from "./money";

// ─── الفترات ─────────────────────────────────────────────────────────────────

export type PeriodPreset =
  | "today" | "yesterday" | "this_week" | "this_month" | "prev_month"
  | "this_quarter" | "this_year" | "prev_year" | "custom";

export const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: "today", label: "اليوم" },
  { value: "yesterday", label: "أمس" },
  { value: "this_week", label: "هذا الأسبوع" },
  { value: "this_month", label: "هذا الشهر" },
  { value: "prev_month", label: "الشهر السابق" },
  { value: "this_quarter", label: "هذا الربع" },
  { value: "this_year", label: "هذه السنة" },
  { value: "prev_year", label: "السنة السابقة" },
  { value: "custom", label: "فترة مخصصة" },
];

// ─── أنماط المديونية ─────────────────────────────────────────────────────────

export type DebtMode = "outstanding" | "accrued" | "collected" | "movement";

export const DEBT_MODES: { value: DebtMode; label: string; hint: string }[] = [
  {
    value: "outstanding",
    label: "الرصيد المستحق في نهاية الفترة",
    hint: "كم كان على المرضى بتاريخ نهاية الفترة — يشمل كل ما تراكم قبلها",
  },
  {
    value: "accrued",
    label: "مديونية نشأت خلال الفترة",
    hint: "الديون الناتجة عن خدمات تمت خلال الفترة (فواتير الفترة ناقص دفعاتها)",
  },
  {
    value: "collected",
    label: "تحصيل المديونيات خلال الفترة",
    hint: "ما حُصِّل فعليًا خلال الفترة من أرصدة سابقة وأخرى جديدة",
  },
  {
    value: "movement",
    label: "حركة المديونية كاملة",
    hint: "رصيد أول الفترة + ديون جديدة − تحصيل + تسويات = رصيد آخرها",
  },
];

export type PatientStatusFilter = "all" | "active" | "completed" | "stopped";
export const PATIENT_STATUS_FILTERS: { value: PatientStatusFilter; label: string }[] = [
  { value: "all", label: "كل المرضى" },
  { value: "active", label: "نشط" },
  { value: "completed", label: "منتهي" },
  { value: "stopped", label: "متوقف" },
];

export type DebtStatusFilter = "all" | "indebted" | "settled" | "overdue";
export const DEBT_STATUS_FILTERS: { value: DebtStatusFilter; label: string }[] = [
  { value: "all", label: "الجميع" },
  { value: "indebted", label: "عليه مديونية" },
  { value: "settled", label: "مسدّد" },
  { value: "overdue", label: "متأخر (٣٠+ يومًا)" },
];

export type CurrencyFilter = "all" | Currency;

export type CompareMode = "none" | "prev_period" | "prev_year";

// ─── الفلاتر الموحدة ─────────────────────────────────────────────────────────

export interface ReportFilters {
  preset: PeriodPreset;
  from: string;
  to: string;
  /** التخصص = تصنيف الخدمة (ortho/implant/crown…). */
  specialty: string | null;
  /** الطبيب = جهة من نوع doctor. */
  doctorId: number | null;
  patientId: number | null;
  serviceId: number | null;
  /** فلتر العملة: للتحصيل يصفّي دفعات العملة نفسها. */
  currency: CurrencyFilter;
  patientStatus: PatientStatusFilter;
  debtStatus: DebtStatusFilter;
  debtMode: DebtMode;
  compare: CompareMode;
  method: string | null;
  receivedBy: string | null;
}

// ─── شكل النتائج الموحد ──────────────────────────────────────────────────────

export type KpiTone = "calm" | "good" | "warn" | "bad" | "info";

export interface KpiItem {
  key: string;
  label: string;
  /** قيمة مالية بالوحدة الصغرى — يُعرض مع رمز العملة. */
  minor?: number;
  /** قيمة عدديّة. */
  count?: number;
  /** نص جاهز (تاريخ، اسم شهر…). */
  text?: string;
  currency?: Currency;
  tone?: KpiTone;
  hint?: string;
}

export type ColumnType = "money" | "count" | "text" | "date" | "percent" | "link";

export interface ReportColumn {
  key: string;
  label: string;
  type?: ColumnType;
  /** مفتاح صف المريض داخل الصف — يجعل الخلية قابلة للنقر (Drill-down). */
  patientKey?: string;
  hint?: string;
}

export type ReportRow = Record<string, string | number | null>;

export interface ComparisonEntry {
  label: string;
  currentMinor: number;
  previousMinor: number;
  changePercent: number | null;
}

export interface ReportResult {
  report: string;
  title: string;
  subtitle?: string;
  periodLabel: string;
  from: string;
  to: string;
  baseCurrency: Currency;
  kpis: KpiItem[];
  columns?: ReportColumn[];
  rows?: ReportRow[];
  /** مقارنة اختيارية (شهري). */
  comparison?: { title: string; entries: ComparisonEntry[] };
  /** صفوف شهرية (سنوي / حركة المديونية). */
  monthly?: { columns: ReportColumn[]; rows: ReportRow[]; barKey?: string };
  /** أشرطة بيانية بسيطة (سنوي). */
  bars?: { label: string; minor: number }[];
  /** ملاحظات تفسيرية تظهر أسفل التقرير. */
  notes?: string[];
  /** أزرار أفعال إضافية (روابط). */
  actions?: { label: string; href: string }[];
  /** تفاصيل الفلاتر المطبَّقة — تظهر في الطباعة. */
  filtersLabel: string;
}

// ─── خيارات الفلاتر ─────────────────────────────────────────────────────────

export interface ReportOptions {
  doctors: { id: number; name: string }[];
  specialties: { value: string; label: string }[];
  services: { id: number; name: string }[];
  methods: { value: string; label: string }[];
  receivers: string[];
  baseCurrency: Currency;
  clinicName: string;
}

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: "نقدًا",
  transfer: "حوالة",
};

export const PATIENT_STATUS_LABEL: Record<string, string> = {
  active: "نشط",
  completed: "منتهي",
  stopped: "متوقف",
  unknown: "غير مصنف",
};

// ─── تسميات الأعمدة الشائعة ──────────────────────────────────────────────────

export const COMMON_COLUMNS = {
  patient: { key: "patientName", label: "المريض", type: "link" as ColumnType, patientKey: "patientId" },
  doctor: { key: "doctorName", label: "الطبيب" },
  specialty: { key: "specialtyLabel", label: "التخصص" },
} as const;
