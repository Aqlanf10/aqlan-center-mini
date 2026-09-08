/**
 * السياسة المركزية لأدوات الذكاء الاصطناعي (Central AI Tool Policy)
 *
 * القاعدة الدستورية هنا: **الأداة بلا سياسة = رفض** (Missing Policy ⇒ DENY).
 * لا يُقبل بعد اليوم «أداةٌ غير معروفة ⇒ تُعامل كقراءةٍ آمنة»؛ فالمجهول في
 * مسارٍ ينفّذ كتابةً في قاعدة بيانات مركزٍ طبيّ ليس «قراءةً آمنة» بل بابٌ
 * خلفي. وكل اسمٍ بديل (Alias) يرث سياسة الأداة الأساسية كاملةً — بالتسمية
 * الكانونية والأدوار والصلاحيات ونطاق المريض والموارد — فلا يُفتح مسارٌ
 * مرادفٌ يتجاوز ما تمنعه سياسةٌ أخرى.
 *
 * والفصل المالي هنا ثنائي لا واحد: **مسك المال** (سند قبض، صندوق) غير **رؤية
 * مالية المركز** (ربح، دخل، تقارير) — فموظف الاستقبال يمسك المال ولا يرى
 * الربح، والطبيب لا هذا ولا ذاك إلا بمنحٍ صريحة.
 */

import type { Role } from "../roles";
import {
  DEFAULT_DOCTOR_PERMISSIONS,
  RECEPTION_PERMISSIONS,
  type DoctorPermissions,
} from "../doctor-permissions";
import type { AiToolContext } from "./types";

/** صنف الوصول: قراءة، تغيير حالة (يكتب في قاعدة البيانات)، أو دعم قرار سريري (اقتراح لا تنفيذ). */
export type AiToolAccessClass = "readOnly" | "stateChanging" | "clinicalDecisionSupport";

/** نطاق مالي صريح — لا مصطلح «مالي» واحد يخلط المسك بالنظر. */
export type AiFinanceScope =
  | "none"
  | "handle_patient_payment"
  | "view_clinic_finance"
  | "view_own_commission";

/** نطاق المخزون: مشاهدة، صرف (يسمح للطبيب)، إدارة كاملة (توريد وتسوية). */
export type AiInventoryScope = "none" | "view" | "issue_out" | "manage";

/** نطاق سريري: لا شيء، مشاهدة، صياغة/اقتراح، كتابة سريرية. */
export type AiClinicalScope = "none" | "view" | "draft" | "write";

/** أنواع الموارد غير المباشرة التي تُحلّ إلى مريضٍ قبل التفويض (BOLA). */
export type AiResourceKind =
  | "appointment"
  | "prescription"
  | "invoice"
  | "visit"
  | "labOrder"
  | "cephAnalysis"
  | "document"
  | "treatmentPlan";

export interface AiToolPolicy {
  /** الاسم الكانوني — المرجع الوحيد في رموز التأكيد والتدقيق. */
  canonicalName: string;
  /** أسماء بديلة (إنجليزية تاريخية) ترث هذه السياسة كاملةً. */
  aliases: string[];
  category:
    | "patient" | "appointment" | "finance" | "inventory" | "lab"
    | "ortho" | "ceph" | "management" | "system" | "clinical"
    | "forms" | "communication";
  access: AiToolAccessClass;
  /** أدوار الطاقم المسموح لها أصلًا طلب الأداة. */
  allowedRoles: Role[];
  /** صلاحيات صريحة يجب أن تكون true (يُفحص دور المدير دائمًا بالسماح). */
  requiredPermissions: (keyof DoctorPermissions)[];
  /** الأداة تخص مريضًا بعينه: يلزم تثبيت هوية المريض وعزله قبل التنفيذ. */
  patientScoped: boolean;
  /** موارد تُقبل كمعرفات مباشرة وتُحلّ إلى مريض قبل التفويض. */
  resourceKinds?: AiResourceKind[];
  financeScope: AiFinanceScope;
  inventoryScope: AiInventoryScope;
  clinicalScope: AiClinicalScope;
  /** أدوات تغيير الحالة لا تُنفّذ إلا برمز تأكيد موقّع مُستهلَك مرة واحدة. */
  requiresConfirmation: boolean;
}

/* ─── تعريف السياسات ─────────────────────────────────────────────────────────
 * كل أداة مسجلة في AI_TOOL_DEFINITIONS يجب أن يكون لها مدخل هنا؛ وما لم
 * يجد مدخلًا يُرفض في executeAiTool قبل أي استدعاء.
 * ───────────────────────────────────────────────────────────────────────────── */

const READ_ALL_ROLES: Role[] = ["admin", "reception", "doctor"];

export const AI_TOOL_POLICIES: Record<string, AiToolPolicy> = {
  /* المالية — الرؤية والمسك مفصولان */
  generate_internal_report: {
    canonicalName: "generate_internal_report", aliases: [], category: "finance",
    access: "readOnly", allowedRoles: ["admin", "doctor"],
    requiredPermissions: ["canViewClinicFinance"], patientScoped: false,
    financeScope: "view_clinic_finance", inventoryScope: "none", clinicalScope: "none",
    requiresConfirmation: false,
  },
  get_today_collections: {
    canonicalName: "get_today_collections", aliases: [], category: "finance",
    access: "readOnly", allowedRoles: ["admin", "doctor"],
    requiredPermissions: ["canViewClinicFinance"], patientScoped: false,
    financeScope: "view_clinic_finance", inventoryScope: "none", clinicalScope: "none",
    requiresConfirmation: false,
  },
  get_patient_receivables: {
    canonicalName: "get_patient_receivables", aliases: [], category: "finance",
    access: "readOnly", allowedRoles: ["admin", "doctor"],
    requiredPermissions: ["canViewClinicFinance"], patientScoped: false,
    financeScope: "view_clinic_finance", inventoryScope: "none", clinicalScope: "none",
    requiresConfirmation: false,
  },
  get_debt_aging: {
    canonicalName: "get_debt_aging", aliases: [], category: "finance",
    access: "readOnly", allowedRoles: ["admin", "doctor"],
    requiredPermissions: ["canViewClinicFinance"], patientScoped: false,
    financeScope: "view_clinic_finance", inventoryScope: "none", clinicalScope: "none",
    requiresConfirmation: false,
  },
  get_doctor_commission: {
    canonicalName: "get_doctor_commission", aliases: [], category: "finance",
    access: "readOnly", allowedRoles: ["admin", "doctor"], requiredPermissions: [],
    patientScoped: false, financeScope: "view_own_commission",
    inventoryScope: "none", clinicalScope: "none",
    requiresConfirmation: false,
  },

  /* المرضى */
  search_patient: {
    canonicalName: "search_patient", aliases: [], category: "patient",
    access: "readOnly", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: false, financeScope: "none", inventoryScope: "none",
    clinicalScope: "view", requiresConfirmation: false,
  },
  get_patient_summary: {
    canonicalName: "get_patient_summary", aliases: [], category: "patient",
    access: "readOnly", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: true, financeScope: "none", inventoryScope: "none",
    clinicalScope: "view", requiresConfirmation: false,
  },

  /* المواعيد */
  get_today_appointments: {
    canonicalName: "get_today_appointments", aliases: [], category: "appointment",
    access: "readOnly", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: false, financeScope: "none", inventoryScope: "none",
    clinicalScope: "view", requiresConfirmation: false,
  },

  /* الأورثو والسيفالو */
  get_ortho_followups: {
    canonicalName: "get_ortho_followups", aliases: ["get_ortho_followups_due"], category: "ortho",
    access: "readOnly", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: false, financeScope: "none", inventoryScope: "none",
    clinicalScope: "view", requiresConfirmation: false,
  },
  get_cephalometric_summary: {
    canonicalName: "get_cephalometric_summary", aliases: [], category: "ceph",
    access: "readOnly", allowedRoles: READ_ALL_ROLES,
    requiredPermissions: ["canViewXrays"], patientScoped: true,
    financeScope: "none", inventoryScope: "none", clinicalScope: "view",
    requiresConfirmation: false,
  },

  /* المخزون والمعمل */
  get_inventory_summary: {
    canonicalName: "get_inventory_summary", aliases: [], category: "inventory",
    access: "readOnly", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: false, financeScope: "none", inventoryScope: "view",
    clinicalScope: "none", requiresConfirmation: false,
  },
  get_lab_cases: {
    canonicalName: "get_lab_cases", aliases: [], category: "lab",
    access: "readOnly", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: false, financeScope: "none", inventoryScope: "none",
    clinicalScope: "view", requiresConfirmation: false,
  },

  /* الإدارة والدليل */
  get_doctors: {
    canonicalName: "get_doctors", aliases: [], category: "management",
    access: "readOnly", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: false, financeScope: "none", inventoryScope: "none",
    clinicalScope: "none", requiresConfirmation: false,
  },
  get_service_prices: {
    canonicalName: "get_service_prices", aliases: ["get_services"], category: "management",
    access: "readOnly", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: false, financeScope: "none", inventoryScope: "none",
    clinicalScope: "none", requiresConfirmation: false,
  },
  get_clinic_statistics: {
    canonicalName: "get_clinic_statistics", aliases: [], category: "management",
    access: "readOnly", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: false, financeScope: "none", inventoryScope: "none",
    clinicalScope: "none", requiresConfirmation: false,
  },
  get_system_guide: {
    canonicalName: "get_system_guide", aliases: ["get_system_feature_guide"], category: "system",
    access: "readOnly", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: false, financeScope: "none", inventoryScope: "none",
    clinicalScope: "none", requiresConfirmation: false,
  },
  get_service_pricing: {
    canonicalName: "get_service_pricing", aliases: ["dental_prices", "service_prices", "price_list"], category: "management",
    access: "readOnly", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: false, financeScope: "none", inventoryScope: "none",
    clinicalScope: "none", requiresConfirmation: false,
  },

  /* أدوات تغيير الحالة — كلها برمز تأكيد */
  create_patient: {
    canonicalName: "create_patient", aliases: ["add_patient", "new_patient", "register_patient"], category: "patient",
    access: "stateChanging", allowedRoles: READ_ALL_ROLES,
    requiredPermissions: ["canAddPatient"], patientScoped: false,
    financeScope: "none", inventoryScope: "none", clinicalScope: "none",
    requiresConfirmation: true,
  },
  book_appointment: {
    canonicalName: "book_appointment", aliases: ["schedule_appointment", "new_appointment"], category: "appointment",
    access: "stateChanging", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: true, resourceKinds: ["appointment"],
    financeScope: "none", inventoryScope: "none", clinicalScope: "none",
    requiresConfirmation: true,
  },
  update_appointment_status: {
    canonicalName: "update_appointment_status", aliases: ["cancel_appointment", "arrive_patient"], category: "appointment",
    access: "stateChanging", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: true, resourceKinds: ["appointment"],
    financeScope: "none", inventoryScope: "none", clinicalScope: "none",
    requiresConfirmation: true,
  },
  record_patient_payment: {
    canonicalName: "record_patient_payment", aliases: ["record_payment", "receive_payment", "record_receipt"], category: "finance",
    access: "stateChanging", allowedRoles: ["admin", "reception"], requiredPermissions: [],
    patientScoped: true, resourceKinds: ["invoice"],
    financeScope: "handle_patient_payment", inventoryScope: "none", clinicalScope: "none",
    requiresConfirmation: true,
  },
  add_patient_medical_alert: {
    canonicalName: "add_patient_medical_alert", aliases: ["set_medical_alert"], category: "patient",
    access: "stateChanging", allowedRoles: READ_ALL_ROLES, requiredPermissions: ["canEditPatient"],
    patientScoped: true, financeScope: "none", inventoryScope: "none",
    clinicalScope: "write", requiresConfirmation: true,
  },
  create_lab_order: {
    canonicalName: "create_lab_order", aliases: ["new_lab_order", "send_to_lab"], category: "lab",
    access: "stateChanging", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: true, financeScope: "none", inventoryScope: "none",
    clinicalScope: "view", requiresConfirmation: true,
  },
  record_inventory_movement: {
    canonicalName: "record_inventory_movement", aliases: ["stock_movement"], category: "inventory",
    access: "stateChanging", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: false, financeScope: "none",
    inventoryScope: "issue_out", clinicalScope: "none",
    requiresConfirmation: true,
  },

  /* اتصال وتواصل — قراءة لكنها تخص مريضًا (PII) */
  generate_whatsapp_reminder: {
    canonicalName: "generate_whatsapp_reminder", aliases: ["send_whatsapp", "whatsapp_reminder"], category: "communication",
    access: "readOnly", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: true, financeScope: "none", inventoryScope: "none",
    clinicalScope: "none", requiresConfirmation: false,
  },

  /* دعم قرار سريري — اقتراح لا تنفيذ */
  recommend_prescription: {
    canonicalName: "recommend_prescription", aliases: ["prescription_safety", "check_prescription", "suggest_drugs"], category: "clinical",
    access: "clinicalDecisionSupport", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: true, financeScope: "none", inventoryScope: "none",
    clinicalScope: "draft", requiresConfirmation: false,
  },
  generate_post_op_care: {
    canonicalName: "generate_post_op_care", aliases: ["post_op_care", "post_op_instructions"], category: "clinical",
    access: "clinicalDecisionSupport", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: true, financeScope: "none", inventoryScope: "none",
    clinicalScope: "draft", requiresConfirmation: false,
  },

  /* صياغة النماذج — دعم قرار يقرأ بيانات مريض */
  draft_consent_form: {
    canonicalName: "draft_consent_form", aliases: ["consent_form", "informed_consent", "draft_consent", "fill_consent"], category: "forms",
    access: "clinicalDecisionSupport", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: true, financeScope: "none", inventoryScope: "none",
    clinicalScope: "draft", requiresConfirmation: false,
  },
  draft_treatment_plan_form: {
    canonicalName: "draft_treatment_plan_form", aliases: ["treatment_plan_form", "installment_plan_form", "draft_plan"], category: "forms",
    access: "clinicalDecisionSupport", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: true, resourceKinds: ["treatmentPlan"],
    financeScope: "none", inventoryScope: "none", clinicalScope: "draft",
    requiresConfirmation: false,
  },
  draft_lab_order_form: {
    canonicalName: "draft_lab_order_form", aliases: ["lab_order_form", "draft_lab"], category: "forms",
    access: "clinicalDecisionSupport", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: true, resourceKinds: ["labOrder"],
    financeScope: "none", inventoryScope: "none", clinicalScope: "draft",
    requiresConfirmation: false,
  },
  draft_patient_intake_form: {
    canonicalName: "draft_patient_intake_form", aliases: ["patient_intake", "intake_form"], category: "forms",
    access: "clinicalDecisionSupport", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: true, financeScope: "none", inventoryScope: "none",
    clinicalScope: "draft", requiresConfirmation: false,
  },
  draft_medical_report_form: {
    canonicalName: "draft_medical_report_form", aliases: ["medical_report", "medical_report_form", "clinical_report"], category: "forms",
    access: "clinicalDecisionSupport", allowedRoles: READ_ALL_ROLES, requiredPermissions: [],
    patientScoped: true, financeScope: "none", inventoryScope: "none",
    clinicalScope: "draft", requiresConfirmation: false,
  },
};

/** خريطة الاسم البديل → الاسم الكانوني (تُشتق من السياسات لا تُكتب يدويًا كي لا تنحرف). */
export const AI_TOOL_ALIAS_TO_CANONICAL: Record<string, string> = Object.create(null);
for (const policy of Object.values(AI_TOOL_POLICIES)) {
  AI_TOOL_ALIAS_TO_CANONICAL[policy.canonicalName] = policy.canonicalName;
  for (const alias of policy.aliases) {
    if (AI_TOOL_ALIAS_TO_CANONICAL[alias] && AI_TOOL_ALIAS_TO_CANONICAL[alias] !== policy.canonicalName) {
      throw new Error(`سياسة أدوات AI: الاسم البديل «${alias}» مستخدم لأداتين مختلفتين.`);
    }
    AI_TOOL_ALIAS_TO_CANONICAL[alias] = policy.canonicalName;
  }
}

/**
 * حلّ الاسم (الكانوني أو البديل) إلى سياسته — والمرادف يرث سياسة الأساسية كاملةً.
 * ما لا سياسة له يعيد null، والمُنفِّذ يرفضه: المجهول ليس «قراءةً آمنة».
 */
export function resolveToolPolicy(name: string): AiToolPolicy | null {
  if (typeof name !== "string" || name.length === 0 || name.length > 100) return null;
  const canonical = AI_TOOL_ALIAS_TO_CANONICAL[name];
  return canonical ? AI_TOOL_POLICIES[canonical] ?? null : null;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

function roleOf(context: AiToolContext): Role | undefined {
  return context.role ?? context.userRole;
}

function permissionGranted(context: AiToolContext, permission: keyof DoctorPermissions): boolean {
  const role = roleOf(context);
  if (role === "admin") return true;
  /* القيمة الصريحة أولًا؛ وغيابُ كائن الصلاحيات كله لا يعني المنع الكلي بل
     يعود إلى افتراضات الدور نفسها كما يفعل باقي النظام عند قراءة المستخدم. */
  const value = context.permissions?.[permission];
  if (typeof value === "boolean") return value;
  if (role === "doctor") return DEFAULT_DOCTOR_PERMISSIONS[permission] === true;
  if (role === "reception") return RECEPTION_PERMISSIONS[permission] === true;
  return false;
}

/**
 * التفويض المركزي للسياسة: الدور، الصلاحيات الصريحة، النطاق المالي، والمخزوني.
 * تُطبَّق قبل أي استدعاء للأداة — في executeAiTool وفي مسار التأكيد معًا.
 */
export function authorizeToolPolicy(policy: AiToolPolicy, context: AiToolContext): PolicyDecision {
  const role = roleOf(context);
  if (!role) return { allowed: false, reason: "لا دور معروف في الجلسة — الرفض الافتراضي." };
  if (!policy.allowedRoles.includes(role)) {
    return { allowed: false, reason: "دورك غير مصرح له بطلب هذا الإجراء عبر المساعد." };
  }
  for (const permission of policy.requiredPermissions) {
    if (!permissionGranted(context, permission)) {
      return { allowed: false, reason: "الصلاحية الصريحة المطلوبة لهذا الإجراء غير ممنوحة لحسابك — غير مصرح." };
    }
  }
  switch (policy.financeScope) {
    case "handle_patient_payment":
      if (role !== "admin" && role !== "reception") {
        return { allowed: false, reason: "مسك المال وسندات القبض للمدير والاستقبال حصرًا." };
      }
      break;
    case "view_clinic_finance":
      if (role !== "admin" && context.permissions?.canViewClinicFinance !== true) {
        return { allowed: false, reason: "الاطلاع على مالية المركز يتطلب صلاحية رؤية مالية صريحة." };
      }
      break;
    case "view_own_commission":
      if (role !== "admin" && role !== "doctor") {
        return { allowed: false, reason: "العمولات للطبيب (عمولته) والمدير." };
      }
      break;
    default:
      break;
  }
  switch (policy.inventoryScope) {
    case "manage":
      if (role !== "admin" && role !== "reception") {
        return { allowed: false, reason: "إدارة المخزون والتسويات للمدير والاستقبال." };
      }
      break;
    default:
      break;
  }
  if (policy.clinicalScope === "write" && role === "reception" && policy.canonicalName === "add_patient_medical_alert") {
    /* التنبيه الطبي عند التسجيل يُدخله الاستقبال عادةً (حساسية يصرّح بها المريض عند
       الفتح) — يبقى الطبيب معزولًا بالملكية، والاستقبال مفتوحًا له كالنظام الأصلي. */
  }
  return { allowed: true, reason: "" };
}
