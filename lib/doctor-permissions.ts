/**
 * الصلاحيات ونسب الأطباء — القواعد والتعريفات.
 *
 * المبدأ الحاكم:
 * Doctor = Own Cases Only by Default. Financial Access = Denied by Default.
 * Any additional visibility must be explicitly granted by Admin.
 *
 * لا ثوابت في الكود — كل صلاحية ونسبة ونظام احتساب يُدار ويُضبط بالكامل من الإعدادات
 * من قبل المدير العام، وكل تعديل يُسجّل في سجل التدقيق (Audit Log).
 */

export interface DoctorPermissions {
  /** عرض جميع المرضى (افتراضياً: خطأ ❌ — يرى مرضاه وحالاته فقط) */
  canViewAllPatients: boolean;
  /** إضافة مريض جديد */
  canAddPatient: boolean;
  /** تعديل بيانات المريض */
  canEditPatient: boolean;
  /** حذف/أرشفة مريض (افتراضياً: ❌) */
  canDeletePatient: boolean;
  /** عرض خطة العلاج */
  canViewPlans: boolean;
  /** تعديل خطة العلاج */
  canEditPlans: boolean;
  /** عرض الصور والأشعة السنية */
  canViewXrays: boolean;
  /** رفع صور وأشعة سنية جديدة */
  canUploadXrays: boolean;
  /** عرض مواعيد بقية الأطباء (افتراضياً: ❌ — يرى مواعيده فقط) */
  canViewAllAppointments: boolean;

  /* ================== ميزة المالية المخفية (Hidden Finance) ================== */
  /**
   * نطاق الرؤية المالية للطبيب:
   * - "own_commissions_only": يرى مستحقاته وأتعابه الشخصية فقط (الافتراضي والآمن)
   * - "clinic_and_own": يرى إيرادات المركز العامة ومستحقاته
   */
  financialScope: "own_commissions_only" | "clinic_and_own";
  /** عرض مستحقاتي الشخصية وعمولاتي (افتراضياً: ✅) */
  canViewOwnCommissions: boolean;
  /** عرض إيرادات المركز العامة (افتراضياً: ❌ مخفية) */
  canViewClinicRevenue: boolean;
  /** عرض مالية المركز العامة وإيراداته وصندوقه (افتراضياً: ❌ مخفية) */
  canViewClinicFinance: boolean;
  /** عرض أسعار التكلفة للمواد والمستلزمات وتكاليف المعامل (افتراضياً: ❌ مخفية تماماً) */
  canViewCostPrices: boolean;
  /** عرض المصروفات وبنود الصرف والتشغيل (افتراضياً: ❌ مخفية تماماً) */
  canViewExpenses: boolean;
  /** عرض الأرباح العامة وصافي الدخل ومؤشرات الإدارة (افتراضياً: ❌ مخفية تماماً) */
  canViewClinicProfits: boolean;
  /** عرض الصندوق والورديات (افتراضياً: ❌) */
  canViewCashDrawer: boolean;
  /** عرض حسابات وعمولات الأطباء الآخرين (افتراضياً: ❌) */
  canViewOtherDoctorsAccounts: boolean;
  /** عرض تقارير الإدارة التنفيذية والمالية (افتراضياً: ❌) */
  canViewAdminReports: boolean;
  /** عرض أسعار الخدمات الرسمية (افتراضياً: ❌) */
  canViewServicePrices: boolean;
  /** عرض مدفوعات مرضاي على الفواتير (افتراضياً: ❌) */
  canViewPatientPayments: boolean;
  /** تعديل النسب والعمولات (للمدير فقط) */
  canManageRates: boolean;
  /** إدارة المستخدمين والصلاحيات (للمدير فقط) */
  canManageUsers: boolean;
}

export const DEFAULT_DOCTOR_PERMISSIONS: DoctorPermissions = {
  canViewAllPatients: false,
  canAddPatient: true,
  canEditPatient: true,
  canDeletePatient: false,
  canViewPlans: true,
  canEditPlans: true,
  canViewXrays: true,
  canUploadXrays: true,
  canViewAllAppointments: false,

  // ميزة المالية المخفية — مستحقاته الشخصية فقط، وإخفاء أسعار التكلفة والمصروفات والأرباح العامة وإيرادات المركز
  financialScope: "own_commissions_only",
  canViewOwnCommissions: true,
  canViewClinicRevenue: false,
  canViewClinicFinance: false,
  canViewCostPrices: false,
  canViewExpenses: false,
  canViewClinicProfits: false,
  canViewCashDrawer: false,
  canViewOtherDoctorsAccounts: false,
  canViewAdminReports: false,
  canViewServicePrices: false,
  canViewPatientPayments: false,
  canManageRates: false,
  canManageUsers: false,
};

export const ADMIN_PERMISSIONS: DoctorPermissions = {
  canViewAllPatients: true,
  canAddPatient: true,
  canEditPatient: true,
  canDeletePatient: true,
  canViewPlans: true,
  canEditPlans: true,
  canViewXrays: true,
  canUploadXrays: true,
  canViewAllAppointments: true,

  financialScope: "clinic_and_own",
  canViewOwnCommissions: true,
  canViewClinicRevenue: true,
  canViewClinicFinance: true,
  canViewCostPrices: true,
  canViewExpenses: true,
  canViewClinicProfits: true,
  canViewCashDrawer: true,
  canViewOtherDoctorsAccounts: true,
  canViewAdminReports: true,
  canViewServicePrices: true,
  canViewPatientPayments: true,
  canManageRates: true,
  canManageUsers: true,
};

export const RECEPTION_PERMISSIONS: DoctorPermissions = {
  canViewAllPatients: true,
  canAddPatient: true,
  canEditPatient: true,
  canDeletePatient: false,
  canViewPlans: true,
  canEditPlans: false,
  canViewXrays: true,
  canUploadXrays: true,
  canViewAllAppointments: true,

  financialScope: "own_commissions_only",
  canViewOwnCommissions: false,
  canViewClinicRevenue: false,
  canViewClinicFinance: false,
  canViewCostPrices: false,
  canViewExpenses: false,
  canViewClinicProfits: false,
  canViewCashDrawer: true,
  canViewOtherDoctorsAccounts: false,
  canViewAdminReports: false,
  canViewServicePrices: true,
  canViewPatientPayments: true,
  canManageRates: false,
  canManageUsers: false,
};

export type CommissionCalculationMode = "percentage" | "by_category" | "fixed";

export interface CustomDoctorServiceRate {
  id: string;
  serviceId?: number;
  serviceName: string;
  percent: number;
  category?: string;
  note?: string;
}

export interface RateHistoryEntry {
  id: string;
  effectiveDate: string;
  calculationMode: CommissionCalculationMode;
  defaultPercent: number;
  categoryRates: Record<string, number>;
  customServiceRates?: CustomDoctorServiceRate[];
  serviceRates?: Record<string, number>;
  fixedAmountPerVisitMinor: number;
  deductLabCost: boolean;
  deductMaterialCost: boolean;
  basis: "collected_cash" | "invoiced";
  updatedAt: string;
  updatedBy: string;
  note?: string;
}

export interface DoctorCommissionConfig {
  /** طريقة احتساب الطبيب: نسبة عامة / نسب حسب التخصص والخدمة / مبلغ ثابت */
  calculationMode: CommissionCalculationMode;
  /** النسبة المئوية الافتراضية (مثلاً 30%) */
  defaultPercent: number;
  /** نسب مخصصة حسب أقسام وتصنيفات الخدمات السنية */
  categoryRates: Record<string, number>;
  /** نسب خاصة لخدمات وإجراءات معينة (مثل التقويم أو الزراعة) بدلاً من النسبة العامة */
  customServiceRates?: CustomDoctorServiceRate[];
  /** فهرس سريع للنسب المخصصة حسب اسم الخدمة أو رقمها */
  serviceRates?: Record<string, number>;
  /** مبلغ ثابت مقطوع لكل زيارة أو إجراء (بالوحدات الصغرى) */
  fixedAmountPerVisitMinor: number;
  /** خصم تكلفة المعمل من أساس الاحتساب */
  deductLabCost: boolean;
  /** خصم تكلفة المواد والمستهلكات السنية المحددة للخدمة */
  deductMaterialCost: boolean;
  /** أساس الاستحقاق: التحصيل الفعلي من المريض أم المفوتر */
  basis: "collected_cash" | "invoiced";
  /** تاريخ بدء سريان النسبة الجديدة (YYYY-MM-DD) */
  effectiveDate: string;
  /** سجل تعديل النسب وتاريخها — لضمان بقاء الحسابات السابقة صحيحة */
  rateHistory: RateHistoryEntry[];
}

export const DENTAL_SERVICE_CATEGORIES: { key: string; label: string; defaultPercent: number }[] = [
  { key: "ortho", label: "تقويم الأسنان", defaultPercent: 35 },
  { key: "implant", label: "زراعة الأسنان", defaultPercent: 30 },
  { key: "prostho", label: "التركيبات والاستعاضة", defaultPercent: 25 },
  { key: "endo", label: "علاج الجذور والعصب", defaultPercent: 30 },
  { key: "surgery", label: "جراحة الفم والخلع", defaultPercent: 30 },
  { key: "restorative", label: "الحشوات والترميم", defaultPercent: 25 },
  { key: "preventive", label: "التنظيف والوقاية", defaultPercent: 25 },
  { key: "pediatric", label: "طب أسنان الأطفال", defaultPercent: 30 },
  { key: "general", label: "كشف واستشارات عامة", defaultPercent: 25 },
];

export const PRESET_SPECIALTIES = [
  "استشاري جراحة وزراعة وتقويم الأسنان",
  "أخصائي تقويم الأسنان والفكين",
  "أخصائي زراعة وجراحة الأسنان",
  "أخصائي علاج الجذور والعصب",
  "أخصائي تركيبات واستعاضة سنية",
  "أخصائي جراحة الفم والوجه والفكين",
  "أخصائي طب أسنان الأطفال",
  "طبيب أسنان عام وجراحة الفم",
];

export const PRESET_BRANCHES = [
  "الفرع الرئيسي",
  "فرع حدة",
  "فرع السبعين",
  "فرع الأصبحي",
  "فرع تعز",
];

export const DEFAULT_DOCTOR_COMMISSION_CONFIG: DoctorCommissionConfig = {
  calculationMode: "percentage",
  defaultPercent: 30,
  categoryRates: {
    ortho: 35,
    implant: 30,
    prostho: 25,
    endo: 30,
    surgery: 30,
    restorative: 25,
    preventive: 25,
    pediatric: 30,
    general: 25,
  },
  customServiceRates: [],
  serviceRates: {},
  fixedAmountPerVisitMinor: 0,
  deductLabCost: true,
  deductMaterialCost: false,
  basis: "collected_cash",
  effectiveDate: new Date().toISOString().slice(0, 10),
  rateHistory: [],
};

/**
 * يقرأ الصلاحيات ويدمجها بأمان مع القيم الافتراضية.
 */
export function parseDoctorPermissions(raw: unknown, role = "doctor"): DoctorPermissions {
  if (role === "admin") return { ...ADMIN_PERMISSIONS };
  if (role === "reception") return { ...RECEPTION_PERMISSIONS };

  const base = { ...DEFAULT_DOCTOR_PERMISSIONS };
  if (!raw) return base;

  let parsed: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return base;
    }
  } else if (typeof raw === "object") {
    parsed = raw as Record<string, unknown>;
  }

  if (parsed.financialScope === "own_commissions_only" || parsed.financialScope === "clinic_and_own") {
    base.financialScope = parsed.financialScope;
  } else if (parsed.canViewClinicRevenue || parsed.canViewClinicFinance) {
    base.financialScope = "clinic_and_own";
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (key === "financialScope") continue;
    if (typeof value === "boolean" && key in base) {
      (base as Record<string, unknown>)[key] = value;
    }
  }

  // مزامنة حالة المالية المخفية مع الصلاحيات الفرعية
  if (base.financialScope === "own_commissions_only") {
    // بالوضع المخفي، تبقى إيرادات المركز وأسعار التكلفة والمصروفات والأرباح العامة محجوبة إلا إذا فُعّلت صراحة
    if (parsed.canViewClinicRevenue === undefined) base.canViewClinicRevenue = false;
    if (parsed.canViewClinicFinance === undefined) base.canViewClinicFinance = false;
    if (parsed.canViewCostPrices === undefined) base.canViewCostPrices = false;
    if (parsed.canViewExpenses === undefined) base.canViewExpenses = false;
    if (parsed.canViewClinicProfits === undefined) base.canViewClinicProfits = false;
  }

  return base;
}

/**
 * فحص ما إذا كان الطبيب يخضع لسياسة 'المالية المخفية' (مستحقاته الشخصية فقط).
 */
export function isDoctorFinancialHidden(permissions?: DoctorPermissions | null, role = "doctor"): boolean {
  if (role === "admin") return false;
  if (!permissions) return true;
  return permissions.financialScope === "own_commissions_only" && !permissions.canViewClinicRevenue && !permissions.canViewClinicFinance;
}

/**
 * فحص إمكانية رؤية الطبيب لإيرادات المركز العامة.
 */
export function canDoctorViewClinicRevenue(permissions?: DoctorPermissions | null, role = "doctor"): boolean {
  if (role === "admin") return true;
  if (!permissions) return false;
  return Boolean(permissions.canViewClinicRevenue || permissions.canViewClinicFinance);
}

/**
 * فحص إمكانية رؤية الطبيب لأسعار التكلفة وتكاليف المواد والمعامل (افتراضياً: ❌ مخفية تماماً).
 */
export function canDoctorViewCostPrices(permissions?: DoctorPermissions | null, role = "doctor"): boolean {
  if (role === "admin") return true;
  if (!permissions) return false;
  return Boolean(permissions.canViewCostPrices);
}

/**
 * فحص إمكانية رؤية الطبيب للمصروفات وبنود الصرف والتشغيل (افتراضياً: ❌ مخفية تماماً).
 */
export function canDoctorViewExpenses(permissions?: DoctorPermissions | null, role = "doctor"): boolean {
  if (role === "admin") return true;
  if (!permissions) return false;
  return Boolean(permissions.canViewExpenses);
}

/**
 * فحص إمكانية رؤية الطبيب للأرباح العامة وصافي الدخل ومؤشرات الإدارة (افتراضياً: ❌ مخفية تماماً).
 */
export function canDoctorViewClinicProfits(permissions?: DoctorPermissions | null, role = "doctor"): boolean {
  if (role === "admin") return true;
  if (!permissions) return false;
  return Boolean(permissions.canViewClinicProfits || permissions.canViewAdminReports);
}

/**
 * يقرأ إعدادات ونسب الطبيب ويدمجها مع القيم الافتراضية.
 */
export function parseDoctorCommissionConfig(raw: unknown, defaultPercentFallback?: number): DoctorCommissionConfig {
  const base: DoctorCommissionConfig = {
    ...DEFAULT_DOCTOR_COMMISSION_CONFIG,
    defaultPercent: typeof defaultPercentFallback === "number" && defaultPercentFallback > 0
      ? defaultPercentFallback
      : DEFAULT_DOCTOR_COMMISSION_CONFIG.defaultPercent,
    categoryRates: { ...DEFAULT_DOCTOR_COMMISSION_CONFIG.categoryRates },
    customServiceRates: [],
    serviceRates: {},
    rateHistory: [],
  };

  if (!raw) return base;

  let parsed: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return base;
    }
  } else if (typeof raw === "object") {
    parsed = raw as Record<string, unknown>;
  }

  if (parsed.calculationMode === "percentage" || parsed.calculationMode === "by_category" || parsed.calculationMode === "fixed") {
    base.calculationMode = parsed.calculationMode;
  }
  if (typeof parsed.defaultPercent === "number" && Number.isFinite(parsed.defaultPercent) && parsed.defaultPercent >= 0 && parsed.defaultPercent <= 100) {
    base.defaultPercent = parsed.defaultPercent;
  }
  if (parsed.categoryRates && typeof parsed.categoryRates === "object") {
    const custom = parsed.categoryRates as Record<string, unknown>;
    for (const [k, v] of Object.entries(custom)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100) {
        base.categoryRates[k] = v;
      }
    }
  }
  if (Array.isArray(parsed.customServiceRates)) {
    const validCustomRates: CustomDoctorServiceRate[] = [];
    const serviceRatesMap: Record<string, number> = {};

    for (let i = 0; i < parsed.customServiceRates.length; i++) {
      const item = parsed.customServiceRates[i];
      if (item && typeof item === "object") {
        const rawItem = item as Record<string, unknown>;
        const serviceName = typeof rawItem.serviceName === "string" ? rawItem.serviceName.trim() : "";
        const percent = typeof rawItem.percent === "number" && Number.isFinite(rawItem.percent)
          ? Math.max(0, Math.min(100, rawItem.percent))
          : 0;

        if (serviceName) {
          const entry: CustomDoctorServiceRate = {
            id: typeof rawItem.id === "string" && rawItem.id ? rawItem.id : `csr_${Date.now()}_${i}`,
            serviceName,
            percent,
            serviceId: typeof rawItem.serviceId === "number" ? rawItem.serviceId : undefined,
            category: typeof rawItem.category === "string" ? rawItem.category : undefined,
            note: typeof rawItem.note === "string" ? rawItem.note : undefined,
          };
          validCustomRates.push(entry);

          // فهرسة سريعة
          serviceRatesMap[serviceName.toLowerCase()] = percent;
          if (entry.serviceId) {
            serviceRatesMap[String(entry.serviceId)] = percent;
          }
        }
      }
    }
    base.customServiceRates = validCustomRates;
    base.serviceRates = serviceRatesMap;
  } else if (parsed.serviceRates && typeof parsed.serviceRates === "object") {
    const rawMap = parsed.serviceRates as Record<string, unknown>;
    const serviceRatesMap: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawMap)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        serviceRatesMap[k] = Math.max(0, Math.min(100, v));
      }
    }
    base.serviceRates = serviceRatesMap;
  }
  if (typeof parsed.fixedAmountPerVisitMinor === "number" && parsed.fixedAmountPerVisitMinor >= 0) {
    base.fixedAmountPerVisitMinor = parsed.fixedAmountPerVisitMinor;
  }
  if (typeof parsed.deductLabCost === "boolean") {
    base.deductLabCost = parsed.deductLabCost;
  }
  if (typeof parsed.deductMaterialCost === "boolean") {
    base.deductMaterialCost = parsed.deductMaterialCost;
  }
  if (parsed.basis === "collected_cash" || parsed.basis === "invoiced") {
    base.basis = parsed.basis;
  }
  if (typeof parsed.effectiveDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.effectiveDate)) {
    base.effectiveDate = parsed.effectiveDate;
  }
  if (Array.isArray(parsed.rateHistory)) {
    base.rateHistory = parsed.rateHistory as RateHistoryEntry[];
  }

  return base;
}
