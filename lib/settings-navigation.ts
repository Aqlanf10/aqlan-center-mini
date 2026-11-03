import {
  CATEGORY_LABEL,
  normalizeArabic,
  visibleCategories,
  type SettingCategory,
} from "./settings-definitions";
import { roleCan } from "./settings-permissions";
import { isAdmin } from "./roles";
import type { StaffCapability } from "./staff-capability-catalogue";

/**
 * الهيكل المؤسسي الموحّد لإعدادات المركز — ثمانية نطاقات مؤسسية واضحة
 * تجمع فئات مفاتيح الإعدادات المركزية مع الشاشات المتخصصة المسموح بها فعليًا
 * لجلسة المستخدم الحالية (دون إظهار روابط محجوبة أو شاشات خارج عقد الهوية الموحّدة).
 */

export type SettingsDomainId =
  | "identity_print"
  | "staff_permissions"
  | "hours_appointments_reception"
  | "clinical_services_rx"
  | "finance_currency_commissions"
  | "labs_inventory_procurement"
  | "messaging_integrations"
  | "security_audit_backup";

export type LegacySettingsLinkGate =
  | "none"
  | "admin"
  | "history"
  | "clinic"
  | "services_catalog";

export interface SettingsViewerContext {
  readonly canonical: boolean;
  readonly role: string | null | undefined;
  readonly isOwner?: boolean;
  readonly capabilities?: readonly string[];
}

export interface SettingsSpecializedLink {
  readonly href: string;
  readonly label: string;
  readonly description: string;
  readonly keywords?: readonly string[];
  readonly legacyGate: LegacySettingsLinkGate;
  /**
   * يُملأ فقط حين تكون الشاشة مسجّلة ومثبتة في `CANONICAL_PAGES`
   * (`lib/canonical-navigation.ts`) بكامل مسارها UI -> HTTP -> DB.
   */
  readonly canonicalAnyOf?: readonly StaffCapability[];
}

export interface SettingsDomainDefinition {
  readonly id: SettingsDomainId;
  readonly title: string;
  readonly subtitle: string;
  /** الفئات الأولية التابعة لهذا النطاق (كل فئة مرئية تنتمي لنطاق أولي واحد بالضبط). */
  readonly categories: readonly SettingCategory[];
  /** فئات مرتبطة مرجعيًا بالنطاق لسهولة القفز السريع دون تكرار أزرار القائمة الجانبية. */
  readonly relatedCategories?: readonly SettingCategory[];
  readonly links: readonly SettingsSpecializedLink[];
}

export const SETTINGS_DOMAINS: readonly SettingsDomainDefinition[] = Object.freeze([
  {
    id: "identity_print",
    title: "الهوية والطباعة والترقيم",
    subtitle: "بيانات المركز الرسمية، ترويسة التقارير والسندات، صورة شاشة الدخول، وبادئات وأرقام الملفات.",
    categories: ["general", "branding"],
    relatedCategories: ["finance"],
    links: [
      {
        href: "/settings/patient-numbering",
        label: "ترقيم ملفات المرضى الجدد",
        description: "ضبط الحد الأدنى التزايدي لأرقام الملفات الجديدة (P-xxxxx) دون المساس بالملفات القائمة.",
        keywords: ["ترقيم", "ملف", "مريض", "عداد", "numbering"],
        legacyGate: "admin",
      },
    ],
  },
  {
    id: "staff_permissions",
    title: "المستخدمون والأدوار والصلاحيات وربط الأطباء",
    subtitle: "حسابات الطاقم، مصفوفة الصلاحيات ونطاقات السجلات، وربط كل طبيب بجهته المهنية.",
    categories: ["staff"],
    links: [
      {
        href: "/staff-access",
        label: "صلاحيات الطاقم والهوية الموحّدة",
        description: "إدارة حسابات الموظفين ومنح الصلاحيات الدقيقة وربط الأطباء بمراجعة وتدقيق.",
        keywords: ["طاقم", "صلاحيات", "أطباء", "ربط", "هوية", "staff"],
        legacyGate: "none",
        canonicalAnyOf: ["staff.view"],
      },
      {
        href: "/settings/users",
        label: "المستخدمون والصلاحيات وربط الأطباء",
        description: "إدارة حسابات الطاقم، الأدوار، ربط الأطباء، وإعدادات نسبهم الفردية.",
        keywords: ["مستخدمون", "حسابات", "أدوار", "أطباء", "صلاحيات", "users"],
        legacyGate: "admin",
      },
    ],
  },
  {
    id: "hours_appointments_reception",
    title: "الدوام والمواعيد والاستقبال",
    subtitle: "ورديات العمل، الطاقة الاستيعابية، قواعد الحجز، شاشة الصالة، ومتابعة واستدعاء المرضى.",
    categories: ["hours", "scheduling", "capacity", "reception", "patient_workflow"],
    links: [
      {
        href: "/settings/appointment-services",
        label: "خدمات المواعيد وأنواع الزيارات",
        description: "كتالوج أنواع المواعيد ومددها وفواصلها الزمنية المغذّية لمحرّك السعة.",
        keywords: ["مواعيد", "زيارات", "مدة", "سعة", "appointment"],
        legacyGate: "clinic",
      },
    ],
  },
  {
    id: "clinical_services_rx",
    title: "الخدمات السريرية والوصفات",
    subtitle: "دليل الإجراءات السنية وأسعارها، قوالب الخطط العلاجية، العبارات السريرية، وحدود المرفقات.",
    categories: ["clinical"],
    links: [
      {
        href: "/finance/services",
        label: "دليل الخدمات السنية وتسعيرها",
        description: "قائمة الإجراءات المعتمدة في المركز وأسعارها الافتراضية بالعملات.",
        keywords: ["خدمات", "أسعار", "تسعير", "إجراءات", "حشوات", "تقويم", "services"],
        legacyGate: "services_catalog",
      },
      {
        href: "/settings/plan-templates",
        label: "قوالب الخطط حسب التخصص",
        description: "تخصيص خطوات وجلسات وقواعد فوترة الخطط العلاجية الجاهزة.",
        keywords: ["قوالب", "خطط", "تخصص", "جلسات", "templates"],
        legacyGate: "clinic",
      },
      {
        href: "/settings/service-materials",
        label: "ربط الخدمات بالمستهلكات",
        description: "تحديد المواد المستهلكة تلقائيًا عند توقيع كل خدمة سريرية.",
        keywords: ["مستهلكات", "مواد", "خدمة", "خصم", "materials"],
        legacyGate: "clinic",
      },
    ],
  },
  {
    id: "finance_currency_commissions",
    title: "المالية والعملات والعمولات",
    subtitle: "أسعار الصرف، قفل الدفاتر، حدود الخصم، بنود المصروفات، ونسب إهلاك وعمولات الأطباء.",
    categories: ["finance"],
    links: [
      {
        href: "/settings/finance-expenses",
        label: "بنود وميزانيات المصروفات",
        description: "تصنيفات سندات الصرف والحدود الشهرية الاسترشادية للمصروفات.",
        keywords: ["مصروفات", "بنود", "ميزانية", "صرف", "expenses"],
        legacyGate: "clinic",
      },
      {
        href: "/settings/material-rates",
        label: "نسب إهلاك المواد للعمولات",
        description: "نسب خصم تكلفة المواد المعتمدة لكل تخصص عند احتساب صافي عمولة الطبيب.",
        keywords: ["إهلاك", "عمولة", "نسب", "تخصص", "material rates"],
        legacyGate: "clinic",
      },
      {
        href: "/finance/commissions",
        label: "كشوف وتسويات عمولات الأطباء",
        description: "مراجعة مستحقات الأطباء المحققة وصرفها وفق السياسة المالية المعتمدة.",
        keywords: ["عمولات", "أطباء", "مستحقات", "تسوية", "commissions"],
        legacyGate: "admin",
      },
    ],
  },
  {
    id: "labs_inventory_procurement",
    title: "المختبرات والمخزون والمشتريات",
    subtitle: "المعامل المتعاقدة وخدماتها وتسعيرها، وتهيئة أصناف ومواقع المخزون وحدود اعتماد الشراء.",
    categories: [],
    relatedCategories: ["scheduling", "branding", "clinical"],
    links: [
      {
        href: "/settings/laboratories",
        label: "المختبرات المتعاقدة",
        description: "دليل معامل الأسنان، عملات التعامل، ومدد التسليم الافتراضية.",
        keywords: ["مختبر", "معمل", "تركيبات", "laboratories"],
        legacyGate: "clinic",
      },
      {
        href: "/settings/lab-services",
        label: "دليل خدمات المختبر",
        description: "تعريف الأعمال المعملية ونطاق الأسنان لكل عمل (تاج، جسر، طقم، جهاز تقويم).",
        keywords: ["خدمات المختبر", "أعمال معملية", "تيجان", "جسور", "lab services"],
        legacyGate: "clinic",
      },
      {
        href: "/settings/lab-pricing",
        label: "تسعير المختبر",
        description: "قوائم أسعار الأعمال المعملية المعتمدة لكل مختبر متعاقد.",
        keywords: ["تسعير المختبر", "أسعار المعمل", "تكلفة المعمل", "lab pricing"],
        legacyGate: "clinic",
      },
      {
        href: "/inventory/procurement/setup",
        label: "تهيئة المواد والمواقع والمشتريات",
        description: "تعريف المواد ووحدات العبوات ومواقع التخزين وحدود اعتماد طلبات الشراء.",
        keywords: ["مخزون", "مشتريات", "مواقع", "مواد", "عبوات", "inventory", "procurement"],
        legacyGate: "admin",
        canonicalAnyOf: ["inventory.references.view"],
      },
    ],
  },
  {
    id: "messaging_integrations",
    title: "التواصل والتكاملات والواجهات العامة",
    subtitle: "قنوات واتساب والرسائل النصية والبريد، التذكير الآلي، مزوّدو الذكاء الاصطناعي، وبوابة المريض والحجز العام.",
    categories: ["messaging", "feature_flags"],
    links: [
      {
        href: "/settings/messaging",
        label: "قنوات الرسائل: واتساب، الرسائل النصية، البريد",
        description: "إعداد أرقام وعناوين ومفاتيح القنوات الخارجية وفحص الاتصال الفعلي.",
        keywords: ["واتساب", "رسائل", "بريد", "قنوات", "whatsapp", "sms", "email"],
        legacyGate: "admin",
      },
      {
        href: "/settings/ai",
        label: "مزوّدو الذكاء الاصطناعي",
        description: "إعداد مزوّدي الذكاء الاصطناعي الإداري ومفاتيحهم وأولوياتهم.",
        keywords: ["ذكاء", "اصطناعي", "مزود", "ai"],
        legacyGate: "admin",
      },
    ],
  },
  {
    id: "security_audit_backup",
    title: "الأمان والتدقيق والنسخ والاستعادة",
    subtitle: "جاهزية التشغيل، النسخ الاحتياطي المتحقق منه واختبار الاستعادة، التصدير والاستيراد، وسجلا التغييرات والتدقيق.",
    categories: ["backup"],
    links: [
      {
        href: "/settings/readiness",
        label: "جاهزية الإطلاق والتشغيل",
        description: "فحص حيّ لصحة الإعدادات والنسخ الاحتياطي وسجل التدقيق قبل وأثناء التشغيل.",
        keywords: ["جاهزية", "إطلاق", "فحص", "readiness"],
        legacyGate: "admin",
      },
      {
        href: "/settings/backup",
        label: "إدارة النسخ والاستعادة",
        description: "أرشيف النسخ المتحققة على القرص الدائم وتشغيل اختبار الاستعادة المعزول (Restore Drill).",
        keywords: ["نسخ", "استعادة", "قرص دائم", "restore", "backup"],
        legacyGate: "admin",
      },
      {
        href: "/settings/export",
        label: "النسخ والتصدير",
        description: "تنزيل النسخة الموحّدة (قاعدة البيانات والأشعة) وجداول CSV للمراجعة البشرية.",
        keywords: ["تصدير", "تنزيل", "csv", "export"],
        legacyGate: "admin",
      },
      {
        href: "/settings/import",
        label: "استيراد مرضى المركز القديم",
        description: "استيراد ملفات Excel/CSV بثلاث خطوات مع كشف التكرار ومعاينة كل سطر قبل الحفظ.",
        keywords: ["استيراد", "إكسل", "مرضى قدامى", "import", "xlsx"],
        legacyGate: "admin",
      },
      {
        href: "/settings/history",
        label: "سجل تغييرات الإعدادات",
        description: "تتبّع كل تعديل على الإعدادات بقبل/بعد والفاعل والسبب مع إمكانية استعادة القيمة السابقة.",
        keywords: ["سجل", "تغييرات", "تاريخ", "استعادة قيمة", "history"],
        legacyGate: "history",
      },
      {
        href: "/settings/audit",
        label: "سجل التدقيق العام",
        description: "مراجعة العمليات المالية والسريرية والإدارية الحساسة بالتاريخ والفاعل.",
        keywords: ["تدقيق", "رقابة", "حركات حساسة", "audit"],
        legacyGate: "admin",
      },
      {
        href: "/settings/reset",
        label: "إعادة الضبط (مسح البيانات التجريبية)",
        description: "مسح محروس للبيانات التجريبية بعد أخذ نسخة احتياطية متحققة وبكلمة مرور المدير.",
        keywords: ["إعادة ضبط", "مسح", "تجريبية", "reset"],
        legacyGate: "admin",
      },
    ],
  },
]);

export function settingsLinkAllowed(
  link: SettingsSpecializedLink,
  viewer: SettingsViewerContext,
): boolean {
  if (viewer.canonical) {
    if (!link.canonicalAnyOf) return false;
    if (viewer.isOwner === true) return true;
    const granted = new Set(viewer.capabilities ?? []);
    return link.canonicalAnyOf.some((cap) => granted.has(cap));
  }
  const role = viewer.role ?? null;
  if (!role) return false;
  switch (link.legacyGate) {
    case "none":
      return false;
    case "admin":
      return isAdmin(role);
    case "history":
      return roleCan(role, "settings.view_history");
    case "clinic":
      return role === "admin" || role === "reception" || role === "doctor";
    case "services_catalog":
      return role === "admin" || role === "reception" || role === "doctor" || role === "accountant";
  }
}

export interface ProjectedSettingsDomain {
  readonly id: SettingsDomainId;
  readonly title: string;
  readonly subtitle: string;
  readonly categories: readonly SettingCategory[];
  readonly relatedCategories: readonly SettingCategory[];
  readonly links: readonly SettingsSpecializedLink[];
}

export function projectSettingsDomains(
  viewer: SettingsViewerContext,
  availableCategories: readonly SettingCategory[] = visibleCategories(),
): ProjectedSettingsDomain[] {
  const visibleSet = new Set(availableCategories);
  return SETTINGS_DOMAINS.map((domain) => ({
    id: domain.id,
    title: domain.title,
    subtitle: domain.subtitle,
    categories: domain.categories.filter((category) => visibleSet.has(category)),
    relatedCategories: (domain.relatedCategories ?? []).filter((category) => visibleSet.has(category)),
    links: domain.links.filter((link) => settingsLinkAllowed(link, viewer)),
  }));
}

export function primaryDomainForCategory(category: SettingCategory): SettingsDomainDefinition | null {
  return SETTINGS_DOMAINS.find((domain) => domain.categories.includes(category)) ?? null;
}

export function searchSettingsLinks(
  term: string,
  viewer: SettingsViewerContext,
): Array<{ domain: SettingsDomainDefinition; link: SettingsSpecializedLink }> {
  const needle = normalizeArabic(term);
  if (!needle) return [];
  const matches: Array<{ domain: SettingsDomainDefinition; link: SettingsSpecializedLink }> = [];
  for (const domain of SETTINGS_DOMAINS) {
    for (const link of domain.links) {
      if (!settingsLinkAllowed(link, viewer)) continue;
      const pieces = [
        link.label,
        link.description,
        domain.title,
        ...(domain.categories.map((cat) => CATEGORY_LABEL[cat])),
        ...(link.keywords ?? []),
      ];
      if (pieces.some((piece) => normalizeArabic(piece).includes(needle))) {
        matches.push({ domain, link });
      }
    }
  }
  return matches;
}
