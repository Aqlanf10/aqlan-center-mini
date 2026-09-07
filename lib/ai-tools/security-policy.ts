/**
 * سجل السياسات الأمنية المركزية لأدوات الذكاء الاصطناعي (AI Tool Security Policy Registry)
 * لمركز الدكتور عقلان الكامل لطب وجراحة وتقويم الأسنان.
 *
 * يطبق متطلبات التحصين الأمني الصارم (P0-FIX):
 * 1. حصر السياسات الأمنية في الأدوات الأساسية (Canonical Tools) ومنع التحديد بناءً على Alias.
 * 2. المبدأ الحاكم: Missing/Unknown Policy => DENY (حظر فوري لا يقبل القراءة أو التجاوز).
 * 3. توريث كافة الخصائص الأمنية للأسماء البديلة (Aliases) بالضرورة من الأداة الأساسية.
 * 4. حماية BOLA (Broken Object Level Authorization) على مستوى كافة المعرفات (appointmentId, invoiceId, etc).
 */

import type { Role } from "../roles";
import type { DoctorPermissions } from "../doctor-permissions";
import type { AiToolContext } from "./types";

export type ToolMutability = "read_only" | "clinical_cds" | "state_changing";

export type CanonicalToolName =
  | "generate_internal_report"
  | "get_today_collections"
  | "get_patient_receivables"
  | "get_debt_aging"
  | "get_doctor_commission"
  | "search_patient"
  | "get_patient_summary"
  | "get_today_appointments"
  | "get_ortho_summary"
  | "get_ortho_followups"
  | "get_ceph_analysis"
  | "get_inventory_summary"
  | "get_lab_cases"
  | "get_service_pricing"
  | "get_service_prices"
  | "get_clinic_statistics"
  | "get_doctors"
  | "get_system_guide"
  | "create_patient"
  | "book_appointment"
  | "update_appointment_status"
  | "record_patient_payment"
  | "add_patient_medical_alert"
  | "create_lab_order"
  | "record_inventory_movement"
  | "generate_whatsapp_reminder"
  | "recommend_prescription"
  | "generate_post_op_care"
  | "draft_consent_form"
  | "draft_treatment_plan_form"
  | "draft_lab_order_form"
  | "draft_patient_intake_form"
  | "draft_medical_report_form";

export interface AiToolSecurityPolicy {
  canonicalName: CanonicalToolName;
  aliases: string[];
  mutability: ToolMutability;
  allowedRoles: Role[];
  requiredPermissions?: (keyof DoctorPermissions | "finance_only" | "inventory_only")[];
  requiresConfirmation: boolean;
  patientScoped: boolean;
  clinicalOnly: boolean;
  resourceType?: "patient" | "appointment" | "invoice" | "lab_order" | "inventory" | "none";
  validateParams?: (params: Record<string, any>) => { valid: boolean; reason?: string };
}

/**
 * خريطة الأسماء المستعارة (Aliases) المعتمدة وربطها بالأداة القانونية (Canonical)
 */
export const ALIAS_TO_CANONICAL_MAP: Record<string, CanonicalToolName> = {
  // 1. العمليات المالية والمقبوضات
  record_payment: "record_patient_payment",
  receive_payment: "record_patient_payment",
  record_receipt: "record_patient_payment",

  // 2. المواعيد والجدولة
  schedule_appointment: "book_appointment",
  new_appointment: "book_appointment",
  cancel_appointment: "update_appointment_status",
  arrive_patient: "update_appointment_status",

  // 3. إدارة المرضى والملفات
  add_patient: "create_patient",
  new_patient: "create_patient",
  register_patient: "create_patient",
  set_medical_alert: "add_patient_medical_alert",
  find_patient: "search_patient",
  patient_info: "get_patient_summary",
  query_patient: "get_patient_summary",

  // 4. المعامل والتركيبات
  new_lab_order: "create_lab_order",
  send_to_lab: "create_lab_order",

  // 5. المخزون والمواد
  stock_movement: "record_inventory_movement",

  // 6. المراسلات والتنبيهات
  send_whatsapp: "generate_whatsapp_reminder",
  whatsapp_reminder: "generate_whatsapp_reminder",

  // 7. الدعم السريري والوصفات
  prescription_safety: "recommend_prescription",
  check_prescription: "recommend_prescription",
  suggest_drugs: "recommend_prescription",
  post_op_care: "generate_post_op_care",
  post_op_instructions: "generate_post_op_care",

  // 8. التقارير والخدمات
  get_ortho_followups_due: "get_ortho_followups",
  get_cephalometric_summary: "get_ceph_analysis",
  get_services: "get_service_prices",
  get_system_feature_guide: "get_system_guide",
  dental_prices: "get_service_pricing",
  service_prices: "get_service_pricing",
  price_list: "get_service_pricing",

  // 9. صياغة الاستمارات
  consent_form: "draft_consent_form",
  informed_consent: "draft_consent_form",
  draft_consent: "draft_consent_form",
  fill_consent: "draft_consent_form",
  treatment_plan_form: "draft_treatment_plan_form",
  installment_plan_form: "draft_treatment_plan_form",
  draft_treatment_plan: "draft_treatment_plan_form",
  draft_plan: "draft_treatment_plan_form",
  lab_order_form: "draft_lab_order_form",
  draft_lab_order: "draft_lab_order_form",
  draft_lab: "draft_lab_order_form",
  patient_intake: "draft_patient_intake_form",
  intake_form: "draft_patient_intake_form",
  medical_report: "draft_medical_report_form",
  medical_report_form: "draft_medical_report_form",
  clinical_report: "draft_medical_report_form",
  draft_medical_report: "draft_medical_report_form",
  medical_certificate: "draft_medical_report_form",
};

/**
 * فك الاسم المستعار أو القانوني إلى الاسم القانوني الموحد للأداة
 */
export function resolveCanonicalToolName(nameOrAlias: string): CanonicalToolName | null {
  if (!nameOrAlias || typeof nameOrAlias !== "string") return null;
  const trimmed = nameOrAlias.trim();

  // فحص مباشر إذا كان الاسم هو بالفعل Canonical
  if (trimmed in AI_SECURITY_POLICIES) {
    return trimmed as CanonicalToolName;
  }

  // فحص خريطة الـ Aliases
  if (trimmed in ALIAS_TO_CANONICAL_MAP) {
    return ALIAS_TO_CANONICAL_MAP[trimmed];
  }

  return null;
}

/**
 * السجل المركزي للسياسات الأمنية (Single Source of Truth)
 * أي أداة مسجلة في النظام يجب أن تمتلك سياسة أمنية صريحة هنا.
 */
export const AI_SECURITY_POLICIES: Record<CanonicalToolName, AiToolSecurityPolicy> = {
  // ─── أدوات العمليات المغيرة للحالة (State-Changing Tools) ─────────────────
  record_patient_payment: {
    canonicalName: "record_patient_payment",
    aliases: ["record_payment", "receive_payment", "record_receipt"],
    mutability: "state_changing",
    allowedRoles: ["admin", "reception"],
    requiredPermissions: ["finance_only"],
    requiresConfirmation: true,
    patientScoped: true,
    clinicalOnly: false,
    resourceType: "invoice",
    validateParams: (params) => {
      const amount = Number(params.amount);
      if (isNaN(amount) || amount <= 0) {
        return { valid: false, reason: "المبلغ المالي يجب أن يكون رقماً موجباً أكبر من الصفر." };
      }
      return { valid: true };
    },
  },

  create_patient: {
    canonicalName: "create_patient",
    aliases: ["add_patient", "new_patient", "register_patient"],
    mutability: "state_changing",
    allowedRoles: ["admin", "reception"],
    requiresConfirmation: true,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "patient",
    validateParams: (params) => {
      const fullName = String(params.fullName || "").trim();
      if (!fullName || fullName.length < 2) {
        return { valid: false, reason: "يرجى تقديم اسم المريض الثلاثي أو الثنائي على الأقل (حرفان فأكثر)." };
      }
      return { valid: true };
    },
  },

  book_appointment: {
    canonicalName: "book_appointment",
    aliases: ["schedule_appointment", "new_appointment"],
    mutability: "state_changing",
    allowedRoles: ["admin", "reception", "doctor"],
    requiresConfirmation: true,
    patientScoped: true,
    clinicalOnly: false,
    resourceType: "appointment",
  },

  update_appointment_status: {
    canonicalName: "update_appointment_status",
    aliases: ["cancel_appointment", "arrive_patient"],
    mutability: "state_changing",
    allowedRoles: ["admin", "reception", "doctor"],
    requiresConfirmation: true,
    patientScoped: true,
    clinicalOnly: false,
    resourceType: "appointment",
    validateParams: (params) => {
      const action = String(params.action || "").trim();
      if (!["arrive", "cancel", "done", "no_show"].includes(action)) {
        return { valid: false, reason: "إجراء الموعد غير معروف. الإجراءات المسموحة: arrive, cancel, done, no_show." };
      }
      return { valid: true };
    },
  },

  add_patient_medical_alert: {
    canonicalName: "add_patient_medical_alert",
    aliases: ["set_medical_alert"],
    mutability: "state_changing",
    allowedRoles: ["admin", "doctor"],
    requiresConfirmation: true,
    patientScoped: true,
    clinicalOnly: true,
    resourceType: "patient",
    validateParams: (params) => {
      const alert = String(params.medicalAlert || "").trim();
      if (!alert) {
        return { valid: false, reason: "يرجى كتابة نص التنبيه الطبي أو الحساسية المطلوب تثبيتها." };
      }
      return { valid: true };
    },
  },

  create_lab_order: {
    canonicalName: "create_lab_order",
    aliases: ["new_lab_order", "send_to_lab"],
    mutability: "state_changing",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: true,
    patientScoped: true,
    clinicalOnly: false,
    resourceType: "lab_order",
  },

  record_inventory_movement: {
    canonicalName: "record_inventory_movement",
    aliases: ["stock_movement"],
    mutability: "state_changing",
    allowedRoles: ["admin", "reception"],
    requiredPermissions: ["inventory_only"],
    requiresConfirmation: true,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "inventory",
    validateParams: (params) => {
      const qty = Number(params.qty);
      if (isNaN(qty) || qty <= 0) {
        return { valid: false, reason: "الكمية في حركة المخزون يجب أن تكون رقماً موجباً أكبر من الصفر." };
      }
      return { valid: true };
    },
  },

  // ─── أدوات دعم القرار السريري (Doctor Clinical Decision Support - CDS) ───
  recommend_prescription: {
    canonicalName: "recommend_prescription",
    aliases: ["prescription_safety", "check_prescription", "suggest_drugs"],
    mutability: "clinical_cds",
    allowedRoles: ["doctor"], // P0-FIX-9: للطبيب المعالج فقط، ومحظورة على الاستقبال
    requiresConfirmation: false,
    patientScoped: true,
    clinicalOnly: true,
    resourceType: "patient",
  },

  generate_post_op_care: {
    canonicalName: "generate_post_op_care",
    aliases: ["post_op_care", "post_op_instructions"],
    mutability: "clinical_cds",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: true,
    clinicalOnly: true,
    resourceType: "patient",
  },

  generate_whatsapp_reminder: {
    canonicalName: "generate_whatsapp_reminder",
    aliases: ["send_whatsapp", "whatsapp_reminder"],
    mutability: "clinical_cds",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: true,
    clinicalOnly: false,
    resourceType: "patient",
  },

  draft_consent_form: {
    canonicalName: "draft_consent_form",
    aliases: ["consent_form", "informed_consent", "draft_consent", "fill_consent"],
    mutability: "clinical_cds",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: true,
    clinicalOnly: true,
    resourceType: "patient",
  },

  draft_treatment_plan_form: {
    canonicalName: "draft_treatment_plan_form",
    aliases: ["treatment_plan_form", "draft_treatment_plan"],
    mutability: "clinical_cds",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: true,
    clinicalOnly: true,
    resourceType: "patient",
  },

  draft_lab_order_form: {
    canonicalName: "draft_lab_order_form",
    aliases: ["lab_order_form", "draft_lab_order"],
    mutability: "clinical_cds",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: true,
    clinicalOnly: true,
    resourceType: "patient",
  },

  draft_patient_intake_form: {
    canonicalName: "draft_patient_intake_form",
    aliases: ["intake_form"],
    mutability: "clinical_cds",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: true,
    clinicalOnly: true,
    resourceType: "patient",
  },

  draft_medical_report_form: {
    canonicalName: "draft_medical_report_form",
    aliases: ["medical_report", "draft_medical_report", "medical_certificate"],
    mutability: "clinical_cds",
    allowedRoles: ["admin", "doctor"],
    requiresConfirmation: false,
    patientScoped: true,
    clinicalOnly: true,
    resourceType: "patient",
  },

  // ─── أدوات الاستعلام المالي والإداري (Read-Only Tools) ─────────────────────
  generate_internal_report: {
    canonicalName: "generate_internal_report",
    aliases: [],
    mutability: "read_only",
    allowedRoles: ["admin"],
    requiredPermissions: ["finance_only"],
    requiresConfirmation: false,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "none",
  },

  get_today_collections: {
    canonicalName: "get_today_collections",
    aliases: [],
    mutability: "read_only",
    allowedRoles: ["admin"],
    requiredPermissions: ["finance_only"],
    requiresConfirmation: false,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "none",
  },

  get_patient_receivables: {
    canonicalName: "get_patient_receivables",
    aliases: [],
    mutability: "read_only",
    allowedRoles: ["admin"],
    requiredPermissions: ["finance_only"],
    requiresConfirmation: false,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "none",
  },

  get_debt_aging: {
    canonicalName: "get_debt_aging",
    aliases: [],
    mutability: "read_only",
    allowedRoles: ["admin"],
    requiredPermissions: ["finance_only"],
    requiresConfirmation: false,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "none",
  },

  get_doctor_commission: {
    canonicalName: "get_doctor_commission",
    aliases: [],
    mutability: "read_only",
    allowedRoles: ["admin", "doctor"],
    requiresConfirmation: false,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "none",
  },

  search_patient: {
    canonicalName: "search_patient",
    aliases: [],
    mutability: "read_only",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: true,
    clinicalOnly: false,
    resourceType: "patient",
  },

  get_patient_summary: {
    canonicalName: "get_patient_summary",
    aliases: ["find_patient", "patient_info", "query_patient"],
    mutability: "read_only",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: true,
    clinicalOnly: false,
    resourceType: "patient",
  },

  get_today_appointments: {
    canonicalName: "get_today_appointments",
    aliases: [],
    mutability: "read_only",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "appointment",
  },

  get_ortho_summary: {
    canonicalName: "get_ortho_summary",
    aliases: [],
    mutability: "read_only",
    allowedRoles: ["admin", "doctor"],
    requiresConfirmation: false,
    patientScoped: true,
    clinicalOnly: true,
    resourceType: "patient",
  },

  get_ortho_followups: {
    canonicalName: "get_ortho_followups",
    aliases: ["get_ortho_followups_due"],
    mutability: "read_only",
    allowedRoles: ["admin", "doctor"],
    requiresConfirmation: false,
    patientScoped: false,
    clinicalOnly: true,
    resourceType: "none",
  },

  get_ceph_analysis: {
    canonicalName: "get_ceph_analysis",
    aliases: [],
    mutability: "read_only",
    allowedRoles: ["admin", "doctor"],
    requiresConfirmation: false,
    patientScoped: true,
    clinicalOnly: true,
    resourceType: "patient",
  },

  get_inventory_summary: {
    canonicalName: "get_inventory_summary",
    aliases: [],
    mutability: "read_only",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "inventory",
  },

  get_lab_cases: {
    canonicalName: "get_lab_cases",
    aliases: [],
    mutability: "read_only",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "lab_order",
  },

  get_service_pricing: {
    canonicalName: "get_service_pricing",
    aliases: ["dental_prices", "service_prices", "price_list"],
    mutability: "read_only",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "none",
  },

  get_service_prices: {
    canonicalName: "get_service_prices",
    aliases: ["get_services"],
    mutability: "read_only",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "none",
  },

  get_clinic_statistics: {
    canonicalName: "get_clinic_statistics",
    aliases: [],
    mutability: "read_only",
    allowedRoles: ["admin"],
    requiresConfirmation: false,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "none",
  },

  get_doctors: {
    canonicalName: "get_doctors",
    aliases: [],
    mutability: "read_only",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "none",
  },

  get_system_guide: {
    canonicalName: "get_system_guide",
    aliases: ["get_system_feature_guide"],
    mutability: "read_only",
    allowedRoles: ["admin", "doctor", "reception"],
    requiresConfirmation: false,
    patientScoped: false,
    clinicalOnly: false,
    resourceType: "none",
  },
};
