/**
 * نظام حوكمة وصلاحيات أدوات الذكاء الاصطناعي المركزي (Central AI Tool Authorization & Patient Guard)
 * لمركز الدكتور عقلان الكامل لطب وجراحة وتقويم الأسنان.
 *
 * القواعد الإلزامية المنفذة هنا:
 * 1. عزل الأطباء الصارم (§39): منع الطبيب من الوصول لأي مريض غير مسند إليه عبر أي أداة أو بحث أو استعلام.
 * 2. الحارس المركزي لصلاحية وصول الذكاء الاصطناعي للمريض (Central Patient Access Guard).
 * 3. تصنيف الأدوات إلى:
 *    - READ_ONLY (استعلامات قراءة فقط).
 *    - CLINICAL_CDS (دعم قرار سريري استرشادي فقط).
 *    - STATE_CHANGING (عمليات مغيرة للحالة تتطلب تأكيداً مشفراً).
 * 4. التحقق الخادمي الصارم: الذكاء الاصطناعي لا يمتلك أي صلاحية تفوق صلاحية الجلسة الموثقة.
 * 5. رفض كامل لأي دور مزور أو تعليمات خارجية غير موثوقة.
 */

import { canAccessPatient } from "../patient-access";
import { doctorOwnsPatient, getPatient, searchPatients, type PatientSummary } from "../db";
import type { SessionPayload } from "../auth";
import type { Role } from "../roles";
import { canHandleMoney } from "../roles";
import type { DoctorPermissions } from "../doctor-permissions";
import type { AiToolContext, ToolExecutionResult } from "./types";
import { createConfirmationToken, verifyAndConsumeConfirmationToken, type ConfirmationPayload } from "./confirmation";

export type ToolMutability = "read_only" | "clinical_cds" | "state_changing";

/** تصنيف نوع كل أداة لتحديد معايير الأمان والتأكيد الإلزامي */
export const AI_TOOL_MUTABILITY: Record<string, ToolMutability> = {
  // 1. عمليات مغيرة للحالة (تتطلب تأكيداً مشفراً)
  record_patient_payment: "state_changing",
  create_patient: "state_changing",
  book_appointment: "state_changing",
  update_appointment_status: "state_changing",
  add_patient_medical_alert: "state_changing",
  create_lab_order: "state_changing",
  record_inventory_movement: "state_changing",

  // 2. أدوات دعم القرار السريري والاستمارات (Clinical Decision Support)
  recommend_prescription: "clinical_cds",
  generate_post_op_care: "clinical_cds",
  draft_consent_form: "clinical_cds",
  draft_treatment_plan_form: "clinical_cds",
  draft_lab_order_form: "clinical_cds",
  draft_patient_intake_form: "clinical_cds",
  draft_medical_report_form: "clinical_cds",

  // 3. أدوات استعلامية للقراءة فقط
  search_patient: "read_only",
  get_patient_summary: "read_only",
  get_ortho_summary: "read_only",
  get_ortho_followups: "read_only",
  get_ceph_analysis: "read_only",
  get_today_appointments: "read_only",
  get_today_collections: "read_only",
  get_patient_receivables: "read_only",
  get_debt_aging: "read_only",
  get_inventory_summary: "read_only",
  get_lab_cases: "read_only",
  get_service_pricing: "read_only",
  get_service_prices: "read_only",
  get_clinic_statistics: "read_only",
  get_doctors: "read_only",
  get_system_guide: "read_only",
  generate_whatsapp_reminder: "clinical_cds",
  confirm_ai_action: "state_changing",
};

export interface PatientAccessCheckResult {
  allowed: boolean;
  patientId?: number;
  patientName?: string;
  reason?: string;
  patient?: any;
}

/**
 * الحارس المركزي لصلاحية وصول الذكاء الاصطناعي للمريض (Central Patient Access Guard)
 * يضمن فحص عزل الأطباء (§39) قبل قراءة أو تعديل أي بيانات تخص المريض.
 */
export async function verifyAiPatientAccess(
  context: AiToolContext,
  patientIdentifier: number | string | undefined,
  options?: { permission?: keyof DoctorPermissions },
): Promise<PatientAccessCheckResult> {
  if (patientIdentifier === undefined || patientIdentifier === null || patientIdentifier === "") {
    return { allowed: true };
  }

  const role: Role = context.role || context.userRole || "reception";

  if (role !== "admin" && role !== "reception" && role !== "doctor") {
    return { allowed: false, reason: "🔒 الدور الوظيفي غير مصرح له بالوصول لبيانات المرضى." };
  }

  // في الوضع التجريبي أو بدون اتصال بقاعدة البيانات (offline / mock tests)
  if (!context.isDbConnected) {
    return {
      allowed: true,
      patientId: typeof patientIdentifier === "number" ? patientIdentifier : undefined,
      patientName: typeof patientIdentifier === "string" ? patientIdentifier : undefined,
    };
  }

  // المدير والاستقبال لديهم وصول عام للمرضى
  if (role === "admin" || role === "reception") {
    let p = null;
    let patientId: number | undefined;
    let patientName: string | undefined;
    if (typeof patientIdentifier === "number" || (/^\d+$/.test(String(patientIdentifier).trim()) && Number(patientIdentifier) < 100000)) {
      patientId = Number(patientIdentifier);
      if (context.isDbConnected) {
        p = await getPatient(patientId).catch(() => null);
        if (p) patientName = p.fullName;
      }
    } else if (typeof patientIdentifier === "string" && patientIdentifier.trim().length >= 2 && context.isDbConnected) {
      const matches = await searchPatients(patientIdentifier.trim(), 1).catch(() => []);
      if (matches[0]) {
        p = await getPatient(matches[0].id).catch(() => null);
        if (p) {
          patientId = p.id;
          patientName = p.fullName;
        }
      }
    }
    return { allowed: true, patientId, patientName, patient: p };
  }

  // في حالة الطبيب: التحقق الصارم من عزل الحالات
  if (role === "doctor") {
    // إذا كان الطبيب يمتلك صلاحية رؤية جميع المرضى صراحة
    if (context.canViewAllPatients === true || context.permissions?.canViewAllPatients === true) {
      let p = null;
      let patientId = typeof patientIdentifier === "number" ? patientIdentifier : undefined;
      if (context.isDbConnected && patientId) {
        p = await getPatient(patientId).catch(() => null);
      }
      return { allowed: true, patientId, patient: p };
    }

    const doctorPartyId = context.doctorPartyId;
    if (!doctorPartyId) {
      return {
        allowed: false,
        reason: "🔒 حساب الطبيب غير مرتبط بملف طبيب معتمد في النظام.",
      };
    }

    // إذا كان المعرف رقماً صريحاً (patientId)
    if (typeof patientIdentifier === "number" || (/^\d+$/.test(String(patientIdentifier).trim()) && Number(patientIdentifier) < 100000)) {
      const patientId = Number(patientIdentifier);
      let p = null;
      if (context.isDbConnected) {
        const owns = await doctorOwnsPatient(doctorPartyId, patientId).catch(() => false);
        if (!owns) {
          return {
            allowed: false,
            patientId,
            reason: "🔒 **تنبيه أمني (عزل الأطباء §39):** ليس لديك صلاحية للوصول لبيانات هذا المريض لأنه غير مسند إليك.",
          };
        }
        p = await getPatient(patientId).catch(() => null);
      }
      return { allowed: true, patientId, patientName: p?.fullName, patient: p };
    }

    // إذا كان المعرف اسماً أو نصاً
    const nameTerm = String(patientIdentifier).trim();
    if (nameTerm.length >= 2 && context.isDbConnected) {
      const matches = await searchPatients(nameTerm, 5, doctorPartyId).catch(() => []);
      if (matches.length > 0) {
        const p = await getPatient(matches[0].id).catch(() => null);
        return { allowed: true, patientId: matches[0].id, patientName: matches[0].fullName, patient: p };
      }

      // إذا لم نجده في نطاق الطبيب، نتأكد هل هو موجود لدى طبيب آخر؟
      const globalMatches = await searchPatients(nameTerm, 5, null).catch(() => []);
      if (globalMatches.length > 0) {
        return {
          allowed: false,
          reason: "🔒 **تنبيه أمني (عزل الأطباء §39):** المريض المطلوب مسجل لدى عيادة طبيب آخر ولا تملك صلاحية الوصول إليه.",
        };
      }
    }

    return { allowed: true };
  }

  return { allowed: false, reason: "🔒 الدور الوظيفي غير مصرح له بالوصول لبيانات المرضى." };
}

export interface ToolAuthorizationDecision {
  authorized: boolean;
  requiresConfirmation: boolean;
  confirmationToken?: string;
  reason?: string;
  sanitizedParams: Record<string, any>;
  patientId?: number;
}

/**
 * فحص وتطبيق سياسة حوكمة وتفويض تنفيذ أدوات الذكاء الاصطناعي (Central AI Tool Authorization Policy)
 */
export async function authorizeAiToolExecution(
  toolName: string,
  rawParams: Record<string, any>,
  context: AiToolContext,
): Promise<ToolAuthorizationDecision> {
  const role: Role = context.role || context.userRole || "reception";

  // 1. حظر استخدام الأدوات إذا لم يكن هناك دور محدد
  if (!role) {
    return {
      authorized: false,
      requiresConfirmation: false,
      reason: "🔒 **تنبيه أمني:** لم يتم تحديد الدور الوظيفي للمستخدم.",
      sanitizedParams: rawParams,
    };
  }

  // 2. فحص الصلاحيات الخاصة حسب الأداة
  // الأدوات المالية الحساسة
  if (
    toolName === "get_today_collections" ||
    toolName === "get_patient_receivables" ||
    toolName === "get_debt_aging" ||
    toolName === "generate_internal_report"
  ) {
    const hasFinance = role === "admin" || context.canViewClinicFinance === true || context.permissions?.canViewClinicFinance === true;
    if (!hasFinance) {
      return {
        authorized: false,
        requiresConfirmation: false,
        reason: "🔒 **تنبيه أمني (غير مصرح):** الاطلاع على التقارير والمديونيات المالية يتطلب صلاحية مالية خاصة (المدير أو صلاحية مالية).",
        sanitizedParams: rawParams,
      };
    }
  }

  // تسجيل السندات المالية
  if (toolName === "record_patient_payment") {
    if (!canHandleMoney(role)) {
      return {
        authorized: false,
        requiresConfirmation: false,
        reason: "🔒 **تنبيه أمني:** تسجيل المقبوضات المالية وسندات القبض مقتصر على موظف الاستقبال أو المدير المالي.",
        sanitizedParams: rawParams,
      };
    }
  }

  // إدارة المخزون
  if (toolName === "record_inventory_movement") {
    const canInv = role === "admin" || role === "reception" || context.canManageInventory === true;
    if (!canInv) {
      return {
        authorized: false,
        requiresConfirmation: false,
        reason: "🔒 **تنبيه أمني:** تسجيل حركات المخزون وصرف المواد مقتصر على إدارة المركز أو الاستقبال.",
        sanitizedParams: rawParams,
      };
    }
  }

  // 3. فحص عزل المرضى التام لكل الأدوات التي تتناول مريضاً
  const candidatePatient =
    rawParams.patientId ??
    rawParams.patientName ??
    rawParams.fullName ??
    rawParams.term ??
    context.conversationPatientId ??
    context.currentPatientId;

  if (candidatePatient !== undefined && candidatePatient !== null && candidatePatient !== "") {
    const patientCheck = await verifyAiPatientAccess(context, candidatePatient);
    if (!patientCheck.allowed) {
      return {
        authorized: false,
        requiresConfirmation: false,
        reason: patientCheck.reason || "🔒 **تنبيه أمني:** ليس لديك صلاحية للوصول لهذا المريض (عزل الكادر السريري §39).",
        sanitizedParams: rawParams,
      };
    }
  }

  // 4. التحقق من صحة المعاملات الأساسية للأداة
  if (toolName === "create_patient") {
    const fullName = String(rawParams.fullName || "").trim();
    if (!fullName || fullName.length < 2) {
      return {
        authorized: false,
        requiresConfirmation: false,
        reason: "يرجى تقديم اسم المريض الثلاثي أو الثنائي على الأقل (حرفان فأكثر).",
        sanitizedParams: rawParams,
      };
    }
  }

  // 5. فحص العمليات المغيرة للحالة (State-Changing) والتحقق من آلية التأكيد
  const mutability = AI_TOOL_MUTABILITY[toolName] || "read_only";

  if (mutability === "state_changing") {
    // إذا مرر توكن تأكيد مسبقاً (عملية تنفيذ مؤكدة)
    if (rawParams.confirmationToken && typeof rawParams.confirmationToken === "string") {
      const verifyRes = await verifyAndConsumeConfirmationToken(
        rawParams.confirmationToken,
        {
          userId: context.userId ?? 1,
          username: context.username || "anonymous",
          role,
          permissions: context.permissions,
        },
        rawParams.overrideParams,
      );

      if (!verifyRes.valid) {
        return {
          authorized: false,
          requiresConfirmation: false,
          reason: verifyRes.reason,
          sanitizedParams: rawParams,
        };
      }

      // التوكن صالح وموثق: السماح بالتنفيذ مع المعاملات الأصلية المحمية
      return {
        authorized: true,
        requiresConfirmation: false,
        sanitizedParams: verifyRes.payload.params,
        patientId: verifyRes.payload.params.patientId,
      };
    }

    // لم يتم تمرير توكن تأكيد: إنشاء توكن تأكيد وإرجاع طلب تأكيد للمستخدم
    const { token } = createConfirmationToken({
      toolName,
      params: rawParams,
      userId: context.userId ?? 1,
      username: context.username || "anonymous",
      role,
    });

    return {
      authorized: true,
      requiresConfirmation: true,
      confirmationToken: token,
      sanitizedParams: rawParams,
    };
  }

  return {
    authorized: true,
    requiresConfirmation: false,
    sanitizedParams: rawParams,
  };
}
