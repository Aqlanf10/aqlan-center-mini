/**
 * سجلّ تعريفات الإعدادات — النموذج المقيَّد بالأنواع.
 *
 * الجدول `settings` يخزّن نصوصًا، أمّا هذا الملف فهو المصدر الوحيد لمعنى المفتاح:
 * نوعه، فئته، صلاحية تغييره، أثره، وحساسيته. الواجهة تقرأ هذا السجل ولا تنشئ
 * قائمةً ثانية قد تنزلق عنه.
 */
import { CLINIC_ZONE_FALLBACK } from "./clinicZone";
import { SETTING_DEFAULTS, type SettingKey } from "./settings";

export type SettingType =
  | "BOOLEAN"
  | "INTEGER"
  | "DECIMAL"
  | "STRING"
  | "ENUM"
  | "TIME"
  | "DATE"
  | "DURATION_MINUTES"
  | "DURATION_DAYS"
  | "DURATION_WEEKS"
  | "LIST"
  | "JSON"
  | "TEMPLATE";

export type SettingCategory =
  | "general"
  | "hours"
  | "scheduling"
  | "visit_types"
  | "capacity"
  | "patient_workflow"
  | "clinical"
  | "ortho"
  | "finance"
  | "reception"
  | "messaging"
  | "complaints"
  | "daily_closing"
  | "reports"
  | "staff"
  | "branding"
  | "backup"
  | "integrations"
  | "feature_flags"
  | "system";

export const CATEGORY_LABEL: Record<SettingCategory, string> = {
  general: "عام",
  hours: "ساعات العمل والورديات",
  scheduling: "الجدولة",
  visit_types: "أنواع الزيارات",
  capacity: "الطاقة الاستيعابية",
  patient_workflow: "رحلة المريض",
  clinical: "السريري",
  ortho: "التقويم",
  finance: "المالية",
  reception: "الاستقبال",
  messaging: "الرسائل",
  complaints: "الشكاوى",
  daily_closing: "إقفال اليوم",
  reports: "التقارير والمؤشّرات",
  staff: "الطاقم والصلاحيات",
  branding: "الطباعة والهوية",
  backup: "النسخ الاحتياطي",
  integrations: "التكاملات",
  feature_flags: "أعلام المزايا",
  system: "معلومات النظام",
};

export type SettingPermission =
  | "settings.manage"
  | "settings.manage_finance"
  | "settings.manage_permissions"
  | "settings.manage_integrations"
  | "settings.manage_backup";

export type SettingSensitivity = "normal" | "secret";
export type SettingScope = "system" | "clinic";

export interface SettingDefinition {
  key: SettingKey;
  category: SettingCategory;
  label: string;
  description?: string;
  type: SettingType;
  defaultValue: string;
  min?: number;
  max?: number;
  options?: readonly string[];
  unit?: string;
  help?: string;
  impact?: string;
  order: number;
  scope: SettingScope;
  sensitivity: SettingSensitivity;
  permission: SettingPermission;
  systemLocked?: boolean;
  requiresReason?: boolean;
}

const def = (d: SettingDefinition): SettingDefinition => d;

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  // ── عام ──────────────────────────────────────────────────────────────────
  def({ key: "clinic.name", category: "general", label: "اسم المركز", type: "STRING",
    defaultValue: SETTING_DEFAULTS["clinic.name"], order: 10, scope: "clinic",
    sensitivity: "normal", permission: "settings.manage",
    impact: "يظهر في كل تقرير وسند ورسالة." }),
  def({ key: "clinic.lead_doctor", category: "general", label: "الطبيب المسؤول", type: "STRING",
    defaultValue: SETTING_DEFAULTS["clinic.lead_doctor"], order: 20, scope: "clinic",
    sensitivity: "normal", permission: "settings.manage" }),
  def({ key: "clinic.lead_doctor_title", category: "general", label: "التخصص", type: "STRING",
    defaultValue: SETTING_DEFAULTS["clinic.lead_doctor_title"], order: 30, scope: "clinic",
    sensitivity: "normal", permission: "settings.manage" }),
  def({ key: "clinic.lead_doctor_credentials", category: "general", label: "المؤهل", type: "STRING",
    defaultValue: SETTING_DEFAULTS["clinic.lead_doctor_credentials"], order: 40, scope: "clinic",
    sensitivity: "normal", permission: "settings.manage",
    help: "يظهر تحت الاسم في تقارير التقويم والسيفالو." }),
  def({ key: "clinic.phone", category: "general", label: "هاتف المركز", type: "STRING",
    defaultValue: SETTING_DEFAULTS["clinic.phone"], order: 50, scope: "clinic",
    sensitivity: "normal", permission: "settings.manage" }),
  def({ key: "clinic.address", category: "general", label: "العنوان", type: "STRING",
    defaultValue: SETTING_DEFAULTS["clinic.address"], order: 60, scope: "clinic",
    sensitivity: "normal", permission: "settings.manage" }),

  // ── ساعات العمل والطاقة ─────────────────────────────────────────────────
  def({ key: "clinic.day_start", category: "hours", label: "بداية الدوام", type: "TIME",
    defaultValue: SETTING_DEFAULTS["clinic.day_start"], order: 10, scope: "clinic",
    sensitivity: "normal", permission: "settings.manage" }),
  def({ key: "clinic.day_end", category: "hours", label: "نهاية الدوام", type: "TIME",
    defaultValue: SETTING_DEFAULTS["clinic.day_end"], order: 20, scope: "clinic",
    sensitivity: "normal", permission: "settings.manage" }),
  def({ key: "clinic.chairs", category: "capacity", label: "عدد الكراسي", type: "INTEGER",
    defaultValue: SETTING_DEFAULTS["clinic.chairs"], min: 1, max: 50, unit: "كرسي",
    order: 10, scope: "clinic", sensitivity: "normal", permission: "settings.manage",
    impact: "يحكم الحجز وقائمة الانتظار وشاشة الصالة." }),

  // ── المالية ──────────────────────────────────────────────────────────────
  def({ key: "finance.base_currency", category: "finance", label: "العملة الأساسية",
    type: "ENUM", options: ["YER", "SAR", "USD"] as const,
    defaultValue: SETTING_DEFAULTS["finance.base_currency"], order: 10, scope: "clinic",
    sensitivity: "normal", permission: "settings.manage_finance", requiresReason: true,
    impact: "كل التقارير تُحسب بها. تغييرها يغيّر عرض كل رصيد." }),
  def({ key: "finance.rate.SAR", category: "finance", label: "سعر الريال السعودي",
    type: "DECIMAL", min: 0, defaultValue: SETTING_DEFAULTS["finance.rate.SAR"],
    order: 20, scope: "clinic", sensitivity: "normal", permission: "settings.manage_finance",
    help: "كم ريالًا يمنيًا يساوي ريالًا سعوديًا اليوم." }),
  def({ key: "finance.rate.USD", category: "finance", label: "سعر الدولار",
    type: "DECIMAL", min: 0, defaultValue: SETTING_DEFAULTS["finance.rate.USD"],
    order: 30, scope: "clinic", sensitivity: "normal", permission: "settings.manage_finance" }),
  def({ key: "finance.locked_before", category: "finance", label: "قفل الدفاتر قبل تاريخ",
    type: "DATE", defaultValue: SETTING_DEFAULTS["finance.locked_before"], order: 40,
    scope: "clinic", sensitivity: "normal", permission: "settings.manage_finance",
    requiresReason: true,
    help: "لا يُقبل قيدٌ قبل هذا التاريخ. اتركه فارغًا لإلغاء القفل." }),
  def({ key: "finance.commission_material_rate", category: "finance",
    label: "خصم إهلاك المواد من العمولة", type: "ENUM", options: ["on", "off"] as const,
    defaultValue: SETTING_DEFAULTS["finance.commission_material_rate"], order: 50,
    scope: "clinic", sensitivity: "normal", permission: "settings.manage_finance",
    requiresReason: true, impact: "يغيّر صافي عمولة كل طبيب في التقارير القادمة." }),

  // ── التشغيل ──────────────────────────────────────────────────────────────
  def({ key: "lab.default_days", category: "scheduling", label: "مهلة المختبر الافتراضية",
    type: "DURATION_DAYS", min: 1, max: 120, unit: "يوم",
    defaultValue: SETTING_DEFAULTS["lab.default_days"], order: 40, scope: "clinic",
    sensitivity: "normal", permission: "settings.manage" }),
  def({ key: "recall.lapse_weeks", category: "patient_workflow",
    label: "مدة اعتبار المريض منقطعًا", type: "DURATION_WEEKS", min: 1, max: 104,
    unit: "أسبوع", defaultValue: SETTING_DEFAULTS["recall.lapse_weeks"], order: 20,
    scope: "clinic", sensitivity: "normal", permission: "settings.manage" }),
  def({ key: "documents.max_megabytes", category: "clinical",
    label: "أقصى حجم لملف الأشعة", type: "INTEGER", min: 1, max: 100, unit: "ميغابايت",
    defaultValue: SETTING_DEFAULTS["documents.max_megabytes"], order: 10, scope: "clinic",
    sensitivity: "normal", permission: "settings.manage" }),
  def({ key: "workflow.doctor_financial_view", category: "staff",
    label: "رؤية الطبيب للمالية", type: "BOOLEAN",
    defaultValue: SETTING_DEFAULTS["workflow.doctor_financial_view"], order: 10,
    scope: "clinic", sensitivity: "normal", permission: "settings.manage_permissions",
    requiresReason: true,
    impact: "يغيّر ما يراه الأطباء من أرقام المرضى الماليّة." }),

  // ── شاشة الصالة ──────────────────────────────────────────────────────────
  def({ key: "display.privacy_mode", category: "reception", label: "خصوصية الاسم على الشاشة",
    type: "ENUM", options: ["first_only", "first_initial"] as const,
    defaultValue: SETTING_DEFAULTS["display.privacy_mode"], order: 40, scope: "clinic",
    sensitivity: "normal", permission: "settings.manage" }),
  def({ key: "display.voice", category: "reception", label: "النداء الصوتي", type: "BOOLEAN",
    defaultValue: SETTING_DEFAULTS["display.voice"], order: 50, scope: "clinic",
    sensitivity: "normal", permission: "settings.manage" }),
  def({ key: "display.delay_notice", category: "reception", label: "رسالة الاعتذار عن التأخير",
    type: "BOOLEAN", defaultValue: SETTING_DEFAULTS["display.delay_notice"], order: 60,
    scope: "clinic", sensitivity: "normal", permission: "settings.manage" }),
  def({ key: "display.show_ortho", category: "reception", label: "عرض جلسات التقويم",
    type: "BOOLEAN", defaultValue: SETTING_DEFAULTS["display.show_ortho"], order: 70,
    scope: "clinic", sensitivity: "normal", permission: "settings.manage" }),
  def({ key: "display.announcements", category: "reception", label: "إعلانات الشاشة (قديم)",
    type: "STRING", defaultValue: SETTING_DEFAULTS["display.announcements"], order: 80,
    scope: "clinic", sensitivity: "normal", permission: "settings.manage", systemLocked: true,
    help: "حقل تاريخي للقراءة فقط؛ الإعلانات تُدار الآن كسجلات مستقلة من مدير الإعلانات." }),
  def({ key: "display.tagline", category: "branding", label: "عبارة الشاشة", type: "STRING",
    defaultValue: SETTING_DEFAULTS["display.tagline"], order: 10, scope: "clinic",
    sensitivity: "normal", permission: "settings.manage" }),

  // ── النسخ الاحتياطي ──────────────────────────────────────────────────────
  def({ key: "backup.enabled", category: "backup", label: "تشغيل نظام النسخ", type: "BOOLEAN",
    defaultValue: SETTING_DEFAULTS["backup.enabled"], order: 10, scope: "system",
    sensitivity: "normal", permission: "settings.manage_backup", requiresReason: true }),
  def({ key: "backup.schedule_enabled", category: "backup", label: "النسخ التلقائي المجدول",
    type: "BOOLEAN", defaultValue: SETTING_DEFAULTS["backup.schedule_enabled"], order: 20,
    scope: "system", sensitivity: "normal", permission: "settings.manage_backup",
    requiresReason: true }),
  def({ key: "backup.schedule_time", category: "backup", label: "وقت النسخ التلقائي",
    type: "TIME", defaultValue: SETTING_DEFAULTS["backup.schedule_time"], order: 30,
    scope: "system", sensitivity: "normal", permission: "settings.manage_backup" }),
  def({ key: "backup.schedule_timezone", category: "backup", label: "المنطقة الزمنية للجدولة",
    type: "STRING", defaultValue: SETTING_DEFAULTS["backup.schedule_timezone"], order: 40,
    scope: "system", sensitivity: "normal", permission: "settings.manage_backup",
    help: `مثال: ${CLINIC_ZONE_FALLBACK}` }),
  def({ key: "backup.retention_daily_count", category: "backup", label: "النسخ اليومية المحفوظة",
    type: "INTEGER", min: 1, max: 365, unit: "نسخة",
    defaultValue: SETTING_DEFAULTS["backup.retention_daily_count"], order: 50, scope: "system",
    sensitivity: "normal", permission: "settings.manage_backup" }),
  def({ key: "backup.retention_weekly_count", category: "backup", label: "النسخ الأسبوعية المحفوظة",
    type: "INTEGER", min: 1, max: 52, unit: "نسخة",
    defaultValue: SETTING_DEFAULTS["backup.retention_weekly_count"], order: 60, scope: "system",
    sensitivity: "normal", permission: "settings.manage_backup" }),
  def({ key: "backup.destination_railway_volume", category: "backup", label: "الوجهة: القرص الدائم",
    type: "BOOLEAN", defaultValue: SETTING_DEFAULTS["backup.destination_railway_volume"],
    order: 70, scope: "system", sensitivity: "normal", permission: "settings.manage_backup",
    requiresReason: true }),
  def({ key: "backup.destination_google_drive", category: "backup", label: "الوجهة: Google Drive",
    type: "BOOLEAN", defaultValue: SETTING_DEFAULTS["backup.destination_google_drive"],
    order: 80, scope: "system", sensitivity: "normal", permission: "settings.manage_backup",
    requiresReason: true, systemLocked: true,
    help: "غير موصولة بعد. تُفتح للتعديل فقط بعد تنفيذ اتصال OAuth؛ لا تُفعَّل وجهة إنتاجية صامتة." }),

  // ── ثوابت تشغيلية لها مستهلكٌ فعلي اليوم ────────────────────────────────
  def({ key: "ops.late_tolerance_minutes", category: "reception",
    label: "حدّ اعتبار المريض متأخّرًا", type: "DURATION_MINUTES", min: 0, max: 240,
    unit: "دقيقة", defaultValue: "15", order: 10, scope: "clinic", sensitivity: "normal",
    permission: "settings.manage",
    description: "بعد هذه المدّة يُعرض الموعد متأخّرًا في فقرة «مُنتظَرون».",
    impact: "رفعه يُخفي تأخّرًا حقيقيًّا عن الاستقبال؛ خفضه يُكثر التنبيه." }),
  def({ key: "ops.wait_warning_minutes", category: "reception",
    label: "تحذير الانتظار", type: "DURATION_MINUTES", min: 1, max: 240, unit: "دقيقة",
    defaultValue: "15", order: 20, scope: "clinic", sensitivity: "normal",
    permission: "settings.manage",
    description: "عندها يصير صفّ المريض أصفر في شاشة اليوم وشاشة الصالة." }),
  def({ key: "ops.wait_critical_minutes", category: "reception",
    label: "انتظار حرج", type: "DURATION_MINUTES", min: 1, max: 480, unit: "دقيقة",
    defaultValue: "30", order: 30, scope: "clinic", sensitivity: "normal",
    permission: "settings.manage",
    description: "عندها يصير الصفّ أحمر. يجب أن يكون أكبر من حدّ التحذير." }),
  def({ key: "ops.follow_up_lookback_days", category: "patient_workflow",
    label: "مدى متابعة المواعيد", type: "DURATION_DAYS", min: 1, max: 365, unit: "يوم",
    defaultValue: "30", order: 10, scope: "clinic", sensitivity: "normal",
    permission: "settings.manage",
    description: "مدى قائمتي «مواعيد مضت ولم تُغلَق» و«لم يحضروا» معًا.",
    impact: "القائمتان تقرآن هذا المفتاح نفسه — فلا يضيع مريضٌ بينهما." }),
  def({ key: "scheduling.max_days_ahead", category: "scheduling",
    label: "أقصى مدى للحجز المسبق", type: "DURATION_DAYS", min: 1, max: 730, unit: "يوم",
    defaultValue: "60", order: 10, scope: "clinic", sensitivity: "normal",
    permission: "settings.manage",
    description: "أبعد يومٍ يقبله الحجز الإلكتروني." }),
  def({ key: "inventory.expiry_soon_days", category: "clinical",
    label: "تنبيه قرب انتهاء الصلاحية", type: "DURATION_DAYS", min: 1, max: 365, unit: "يوم",
    defaultValue: "30", order: 20, scope: "clinic", sensitivity: "normal",
    permission: "settings.manage",
    description: "قبلها بهذه المدّة يُعدّ صنف المخزون «يقارب الانتهاء»." }),
] as const;

const BY_KEY = new Map<string, SettingDefinition>(
  SETTING_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function settingDefinition(key: string): SettingDefinition | null {
  return BY_KEY.get(key) ?? null;
}

export function visibleCategories(): SettingCategory[] {
  const seen = new Set<SettingCategory>();
  for (const definition of SETTING_DEFINITIONS) seen.add(definition.category);
  return (Object.keys(CATEGORY_LABEL) as SettingCategory[]).filter((c) => seen.has(c));
}

export function definitionsInCategory(category: SettingCategory): SettingDefinition[] {
  return SETTING_DEFINITIONS
    .filter((definition) => definition.category === category)
    .sort((a, b) => a.order - b.order);
}

export function searchDefinitions(term: string): SettingDefinition[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return [...SETTING_DEFINITIONS];
  return SETTING_DEFINITIONS.filter((definition) =>
    definition.key.toLowerCase().includes(needle)
    || definition.label.toLowerCase().includes(needle)
    || (definition.description ?? "").toLowerCase().includes(needle)
    || (definition.help ?? "").toLowerCase().includes(needle)
    || CATEGORY_LABEL[definition.category].includes(needle));
}
