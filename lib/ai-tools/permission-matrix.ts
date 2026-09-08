/**
 * مصفوفة تدقيق صلاحيات أدوات الذكاء الاصطناعي مقابل المسارات الرسمية
 * (AI Tool ↔ Normal API Permission Matrix) — مراجعة P0 المستقلة.
 *
 * الثابت المُثبَت: **AI permissions ⊆ normal API permissions.**
 * كل أداة AI تقابلها هنا المسارات/الدومينات الرسمية التي تقيس عليها، ونموذج
 * صلاحية المسار الرسمي موثّق نصًّا. الاختبار الآلي
 * (`__tests__/ai-api-permission-matrix.test.ts`) يثبت:
 *   ١) الاكتمال: لا أداة بلا مدخل مصفوفة، ولا مدخل بلا أداة — «لا تعيين أو
 *      غموض ⇒ DENY» مطبقة على مستوى المصفوفة نفسها.
 *   ٢) الأسماء البديلة كلها مشمولة بمدخل أصلها.
 *   ٣) لكل صلاحية مطلوبة: طبيب=false ⇒ رفض، طبيب=true ⇒ سماح (ضمن دوره)،
 *      مدير ⇒ سماح، استقبال ⇒ وفق افتراضاته الرسمية.
 *
 * المرجع الذي تقيس عليه المصفوفة (قراءة كود المسارات الرسمية وقت المراجعة):
 * - /api/services (GET): الطبيب canViewServicePrices فقط؛ الاستقبال
 *   والمدير بالسماح العام (canHandleMoney للمسار).
 * - /api/finance/commissions: الطبيب canViewOwnCommissions (شخصية فقط ما لم
 *   canViewOtherDoctorsAccounts/إيراد)؛ المدير كامل؛ الاستقبال 403.
 * - /api/finance/report: الطبيب canViewClinicRevenue||canViewClinicFinance؛
 *   المدير كامل؛ الاستقبال 403.
 * - /api/patients (POST): الطبيب بلا canAddPatient=false يُمنع.
 * - /api/patients/[id] (PATCH): الطبيب بلا canEditPatient يُمنع.
 * - /api/appointments (GET): الطبيب بلا canViewAllAppointments يرى جدوله فقط.
 * - /api/prescriptions (POST): طبيب مربوط بجهة، أو مدين مربوط صراحةً —
 *   والاستقبال مرفوض.
 * - /api/inventory (GET): القراءة لكل من دخل البرنامج؛ (POST) للمدير والاستقبال.
 * - /api/lab (POST): كل الأدوار المسجلة (أمر معمل تشغيلي).
 * - مسارات الرؤية السريرية (سيفالو/أشعة): canViewXrays للطبيب.
 */

import type { Role } from "../roles";
import type { DoctorPermissions } from "../doctor-permissions";
import { AI_TOOL_ALIAS_TO_CANONICAL, AI_TOOL_POLICIES } from "./policy";

export interface AiToolApiMatrixEntry {
  /** الاسم الكانوني للأداة. */
  canonicalName: string;
  /** المسارات/الدومينات الرسمية المكافئة التي يقيس عليها الـAI. */
  apiEquivalents: string[];
  /** نموذج صلاحية المسار الرسمي — توثيق نصي قابل للمراجعة والتدقيق. */
  apiPermissionModel: string;
  /** الصلاحيات التي تشترطها سياسة AI لهذه الأداة (يجب ⊆ نموذج المسار). */
  aiRequiredPermissions: (keyof DoctorPermissions)[];
  /** أدوار سياسة AI (يجب ⊆ أدوار المسار الرسمي المكافئ). */
  aiAllowedRoles: Role[];
  /** هل تتطلب هوية سريرية (أدوات دعم قرار سريري حساسة). */
  requiresClinicalIdentity: boolean;
}

export const AI_TOOL_API_MATRIX: Record<string, AiToolApiMatrixEntry> = {
  /* ─── المالية ─── */
  generate_internal_report: {
    canonicalName: "generate_internal_report",
    apiEquivalents: ["/api/finance/report", "/api/reports"],
    apiPermissionModel: "المدير كامل؛ الطبيب canViewClinicRevenue||canViewClinicFinance؛ الاستقبال 403.",
    aiRequiredPermissions: ["canViewClinicFinance"], aiAllowedRoles: ["admin", "doctor"],
    requiresClinicalIdentity: false,
  },
  get_today_collections: {
    canonicalName: "get_today_collections",
    apiEquivalents: ["/api/finance/report (صندوق اليوم)", "/api/shifts"],
    apiPermissionModel: "المدير كامل؛ الطبيب canViewClinicRevenue||canViewClinicFinance؛ الاستقبال 403 (لا يرى الربح).",
    aiRequiredPermissions: ["canViewClinicFinance"], aiAllowedRoles: ["admin", "doctor"],
    requiresClinicalIdentity: false,
  },
  get_patient_receivables: {
    canonicalName: "get_patient_receivables",
    apiEquivalents: ["/api/finance/debts", "/api/finance/report (مديونيات)"],
    apiPermissionModel: "المدير والاستقبال (canHandleMoney) للمسار المصرفي؛ الطبيب بالمالية المخفية فقط.",
    aiRequiredPermissions: ["canViewClinicFinance"], aiAllowedRoles: ["admin", "doctor"],
    requiresClinicalIdentity: false,
  },
  get_debt_aging: {
    canonicalName: "get_debt_aging",
    apiEquivalents: ["/api/finance/report (أعمار الديون)"],
    apiPermissionModel: "المدير كامل؛ الطبيب canViewClinicRevenue||canViewClinicFinance؛ الاستقبال 403.",
    aiRequiredPermissions: ["canViewClinicFinance"], aiAllowedRoles: ["admin", "doctor"],
    requiresClinicalIdentity: false,
  },
  get_doctor_commission: {
    canonicalName: "get_doctor_commission",
    apiEquivalents: ["/api/finance/commissions"],
    apiPermissionModel: "الطبيب canViewOwnCommissions=true (شخصية فقط ما لم canViewOtherDoctorsAccounts/إيراد)؛ المدير كامل؛ الاستقبال 403.",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "doctor"],
    requiresClinicalIdentity: false,
  },

  /* ─── المرضى ─── */
  search_patient: {
    canonicalName: "search_patient",
    apiEquivalents: ["/api/patients (GET)"],
    apiPermissionModel: "كل الأدوار؛ الطبيب بلا canViewAllPatients يبحث في مرضاه فقط (scoping خادمي).",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  get_patient_summary: {
    canonicalName: "get_patient_summary",
    apiEquivalents: ["/api/patients/[id]", "/api/patients/[id]/card"],
    apiPermissionModel: "canAccessPatient (عزل الطبيب عبر doctorOwnsPatient/canViewAllPatients).",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },

  /* ─── المواعيد ─── */
  get_today_appointments: {
    canonicalName: "get_today_appointments",
    apiEquivalents: ["/api/appointments (GET)"],
    apiPermissionModel: "كل الأدوار؛ الطبيب بلا canViewAllAppointments يرى جدوله فقط.",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },

  /* ─── الأورثو والسيفالو ─── */
  get_ortho_followups: {
    canonicalName: "get_ortho_followups",
    apiEquivalents: ["/api/ortho", "شاشة متابعات التقويم"],
    apiPermissionModel: "كل الأدوار مع عزل الطبيب في مجاله داخل الأداة.",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  get_cephalometric_summary: {
    canonicalName: "get_cephalometric_summary",
    apiEquivalents: ["/api/ceph", "print/ceph/[id]"],
    apiPermissionModel: "canViewXrays للطبيب + canAccessPatient.",
    aiRequiredPermissions: ["canViewXrays"], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },

  /* ─── المخزون والمعمل ─── */
  get_inventory_summary: {
    canonicalName: "get_inventory_summary",
    apiEquivalents: ["/api/inventory (GET)"],
    apiPermissionModel: "القراءة لكل من دخل البرنامج؛ أسعار التكلفة تُخفى بلا canViewCostPrices (الأداة تعرض الأرصدة لا التكاليف).",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  get_lab_cases: {
    canonicalName: "get_lab_cases",
    apiEquivalents: ["/api/lab (GET)"],
    apiPermissionModel: "كل الأدوار؛ تكاليف المعمل تُخفى للطبيب بلا canViewCostPrices (الأداة تعرض الحالات لا التكاليف).",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },

  /* ─── الإدارة والدليل ─── */
  get_doctors: {
    canonicalName: "get_doctors",
    apiEquivalents: ["دليل الأطباء العام", "/api/users (قائمة الكادر للمدير)"],
    apiPermissionModel: "أسماء وتخصصات الكادر معلنة للطاقم؛ إدارة الحسابات للمدير.",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  get_service_prices: {
    canonicalName: "get_service_prices",
    apiEquivalents: ["/api/services (GET)"],
    apiPermissionModel: "الطبيب canViewServicePrices فقط؛ الاستقبال والمدير بالسماح العام.",
    aiRequiredPermissions: ["canViewServicePrices"], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  get_clinic_statistics: {
    canonicalName: "get_clinic_statistics",
    apiEquivalents: ["لوحة المعلومات", "إحصاءات مجمعة بعد عزل مجال الطبيب"],
    apiPermissionModel: "كل الأدوار؛ التجميعات تُحسب بعد تطبيق عزل الطبيب (P0.14).",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  get_system_guide: {
    canonicalName: "get_system_guide",
    apiEquivalents: ["دليل استخدام النظام (شاشة)"],
    apiPermissionModel: "دليل تشغيلي لكل الطاقم (أدلة تشغيلية لا بيانات مرضى).",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  get_service_pricing: {
    canonicalName: "get_service_pricing",
    apiEquivalents: ["/api/services (GET)", "dليل أسعار الخدمات"],
    apiPermissionModel: "نفس /api/services: الطبيب canViewServicePrices فقط؛ الاستقبال والمدير بالسماح العام.",
    aiRequiredPermissions: ["canViewServicePrices"], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },

  /* ─── تغيير الحالة ─── */
  create_patient: {
    canonicalName: "create_patient",
    apiEquivalents: ["/api/patients (POST)"],
    apiPermissionModel: "الاستقبال والمدير؛ الطبيب إلا إذا canAddPatient=false.",
    aiRequiredPermissions: ["canAddPatient"], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  book_appointment: {
    canonicalName: "book_appointment",
    apiEquivalents: ["/api/appointments (POST)"],
    apiPermissionModel: "كل الأدوار على مرضاها (canAccessPatient) — حجز تشغيلي.",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  update_appointment_status: {
    canonicalName: "update_appointment_status",
    apiEquivalents: ["/api/appointments/[id] (PATCH الحالة)"],
    apiPermissionModel: "كل الأدوار على مرضاها (canAccessPatient).",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  record_patient_payment: {
    canonicalName: "record_patient_payment",
    apiEquivalents: ["/api/payments (POST)", "سند القبض"],
    apiPermissionModel: "canHandleMoney: المدير والاستقبال فقط — الطبيب لا يمسك المال.",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception"],
    requiresClinicalIdentity: false,
  },
  add_patient_medical_alert: {
    canonicalName: "add_patient_medical_alert",
    apiEquivalents: ["/api/patients/[id] (PATCH التنبيه الطبي)"],
    apiPermissionModel: "الطبيب canEditPatient على مرضاه؛ الاستقبال يسجّل حساسية المريض المصرّح بها عند الفتح.",
    aiRequiredPermissions: ["canEditPatient"], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  create_lab_order: {
    canonicalName: "create_lab_order",
    apiEquivalents: ["/api/lab (POST)"],
    apiPermissionModel: "كل الأدوار المسجلة (أمر عمل تشغيلي) — التكاليف المالية تُدار من مساراتها.",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  record_inventory_movement: {
    canonicalName: "record_inventory_movement",
    apiEquivalents: ["/api/inventory/[id]/movements (POST)"],
    apiPermissionModel: "الطبيب يصرف (issue out) على بنود قائمة؛ التوريد والتسوية للمدير والاستقبال (canManageInventory).",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },

  /* ─── التواصل ─── */
  generate_whatsapp_reminder: {
    canonicalName: "generate_whatsapp_reminder",
    apiEquivalents: ["/api/reminders", "رسائل واتساب المريض"],
    apiPermissionModel: "بيئة PII تخص مريضًا: canAccessPatient.",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },

  /* ─── دعم القرار السريري الحساس ─── */
  recommend_prescription: {
    canonicalName: "recommend_prescription",
    apiEquivalents: ["/api/prescriptions (POST — الوصفة الرسمية)"],
    apiPermissionModel: "طبيب مربوط بجهة طبيب، أو مدين مربط صراحةً بجهة؛ الاستقبال 403 — الأداة CDS أدنى صلاحيةً من الإصدار الرسمي لا أعلى.",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "doctor"],
    requiresClinicalIdentity: true,
  },
  generate_post_op_care: {
    canonicalName: "generate_post_op_care",
    apiEquivalents: ["print/post-op/[id]", "إرشادات ما بعد الإجراء"],
    apiPermissionModel: "إرشادات علاجية سريرية: هوية سريرية (كإصدار الوصفة) — الاستقبال لا يولّد توصية علاجية.",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "doctor"],
    requiresClinicalIdentity: true,
  },

  /* ─── صياغة النماذج ─── */
  draft_consent_form: {
    canonicalName: "draft_consent_form",
    apiEquivalents: ["/api/plans/[id]/consent", "print/consent/[id]"],
    apiPermissionModel: "canHandleMoney/الطاقم الإداري يعدّ الموافقة كما في V2 + canAccessPatient.",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  draft_treatment_plan_form: {
    canonicalName: "draft_treatment_plan_form",
    apiEquivalents: ["/api/plans (POST)"],
    apiPermissionModel: "الإدارة والاستقبال كما في V2؛ الطبيب الذي فُتح له تحرير الخطط (canEditPlans) لمرضاه.",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  draft_lab_order_form: {
    canonicalName: "draft_lab_order_form",
    apiEquivalents: ["/api/lab (POST)"],
    apiPermissionModel: "كل الأدوار المسجلة (أمر عمل تشغيلي).",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  draft_patient_intake_form: {
    canonicalName: "draft_patient_intake_form",
    apiEquivalents: ["/api/patients (POST — السيرة المرضية عند الفتح)"],
    apiPermissionModel: "كل الأدوار (بيانات يصرّح بها المريض عند التسجيل) + canAccessPatient.",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "reception", "doctor"],
    requiresClinicalIdentity: false,
  },
  draft_medical_report_form: {
    canonicalName: "draft_medical_report_form",
    apiEquivalents: ["/api/prescriptions (الهوية السريرية للمُصدر)", "التقارير الطبية الرسمية"],
    apiPermissionModel: "تقرير طبي يعتمد قرارًا طبيًا: طبيب مربوط بجهة، أو مدين مربط صراحةً — كإصدار الوصفة.",
    aiRequiredPermissions: [], aiAllowedRoles: ["admin", "doctor"],
    requiresClinicalIdentity: true,
  },
};

/** مدخل المصفوفة لأداة (كانوني أو بديل) — المرادف يعود لمدخل أصله دائمًا. */
export function matrixEntryFor(toolName: string): AiToolApiMatrixEntry | null {
  const canonical = AI_TOOL_ALIAS_TO_CANONICAL[toolName];
  if (!canonical) return null;
  return AI_TOOL_API_MATRIX[canonical] ?? null;
}

/** كل الأسماء (الكانونية والبديلة) التي تغطيها المصفوفة عبر أصولها. */
export function matrixCoveredNames(): string[] {
  return Object.keys(AI_TOOL_ALIAS_TO_CANONICAL);
}
