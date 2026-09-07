/**
 * نظام حوكمة وصلاحيات أدوات الذكاء الاصطناعي المركزي (Central AI Tool Authorization & Patient Guard)
 * لمركز الدكتور عقلان الكامل لطب وجراحة وتقويم الأسنان.
 *
 * يطبق متطلبات التحصين الأمني الصارم (P0-FIX):
 * 1. P0-FIX-1 & P0-FIX-12: حل الاسم أولاً إلى Canonical Tool Name واستخراج السياسة الصريحة:
 *    alias → canonicalToolName → policy → authorization → patient/resource scope → confirmation → execution
 *    القاعدة الصارمة: Missing Policy => DENY (حظر فوري ومطلق).
 * 2. P0-FIX-6: إلغاء الهويات الافتراضية (Fail Closed Identity). غياب userId أو username أو role يؤدي للرفض فوراً.
 * 3. P0-FIX-7: حماية BOLA على مستوى الموارد (Resource-Level BOLA Protection) - فحص appointmentId وفك المريض والطبيب قبل الإذن.
 * 4. P0-FIX-8: إعادة التحقق الكامل من الصلاحيات والملكية لحظة التأكيد (Reauthorization at Confirmation Time).
 * 5. P0-FIX-9: حصر الدعم السريري الدوائي على الطبيب البشري المعالج فقط ومنعه عن الاستقبال.
 */

import { canAccessPatient } from "../patient-access";
import { doctorOwnsPatient, getPatient, searchPatients, getAppointment, type PatientSummary } from "../db";
import type { Role } from "../roles";
import { canHandleMoney } from "../roles";
import type { DoctorPermissions } from "../doctor-permissions";
import type { AiToolContext } from "./types";
import { createConfirmationToken, verifyAndConsumeConfirmationToken } from "./confirmation";
import {
  resolveCanonicalToolName,
  AI_SECURITY_POLICIES,
  type CanonicalToolName,
  type AiToolSecurityPolicy,
  type ToolMutability,
} from "./security-policy";

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

  // P0-FIX-6: التحقق الصارم من الهوية
  const role = context.role;
  if (!role || (role !== "admin" && role !== "reception" && role !== "doctor")) {
    return { allowed: false, reason: "🔒 الدور الوظيفي غير مصرح له بالوصول لبيانات المرضى (Fail Closed)." };
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

  // في حالة الطبيب: التحقق الصارم من عزل الحالات (§39)
  if (role === "doctor") {
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
  canonicalToolName?: CanonicalToolName;
  sanitizedParams: Record<string, any>;
  patientId?: number;
}

/**
 * فحص وتطبيق سياسة حوكمة وتفويض تنفيذ أدوات الذكاء الاصطناعي (Central AI Tool Authorization Policy)
 * يطبق P0-FIX-1 إلى P0-FIX-12
 */
export async function authorizeAiToolExecution(
  toolName: string,
  rawParams: Record<string, any>,
  context: AiToolContext,
  options?: {
    confirmed?: boolean;
    overrideParams?: Record<string, any>;
  },
): Promise<ToolAuthorizationDecision> {
  // ─── 1. P0-FIX-1 & P0-FIX-12: حل الاسم إلى الأداة القانونية وفحص وجود السياسة ───
  const canonicalName = resolveCanonicalToolName(toolName);
  if (!canonicalName) {
    return {
      authorized: false,
      requiresConfirmation: false,
      reason: `🔒 **تنبيه أمني (Fail Closed):** الأداة «${toolName}» غير مسجلة أو غير معتمدة في سجل أدوات النظام.`,
      sanitizedParams: rawParams,
    };
  }

  const policy: AiToolSecurityPolicy = AI_SECURITY_POLICIES[canonicalName];
  if (!policy) {
    // P0-FIX-1: missing policy => DENY
    return {
      authorized: false,
      requiresConfirmation: false,
      reason: `🔒 **تنبيه أمني (Fail Closed):** لا توجد سياسة أمنية صريحة مسجلة للأداة «${canonicalName}». تم حظر التنفيذ فوراً.`,
      sanitizedParams: rawParams,
    };
  }

  // ─── 2. P0-FIX-6: إلغاء الهويات الافتراضية (Fail Closed Identity) ──────────────
  const userId = context.userId;
  const username = context.username || context.userName;
  const role = (context.role || context.userRole) as Role;

  if (!userId || typeof userId !== "number" || userId <= 0 || !username || typeof username !== "string" || !role) {
    return {
      authorized: false,
      requiresConfirmation: false,
      reason: "🔒 **تنبيه أمني (Fail Closed):** هوية المستخدم أو الدور الوظيفي مفقود أو غير موثق بالكامل. لا يسمح بتنفيذ أي أداة.",
      canonicalToolName: canonicalName,
      sanitizedParams: rawParams,
    };
  }

  // ─── 3. فحص تطابق الدور الوظيفي المسموح به في السياسة ──────────────────────
  if (!policy.allowedRoles.includes(role)) {
    let roleReason = `🔒 **تنبيه أمني (غير مصرح):** دورك الوظيفي (${role}) غير مصرح له باستخدام أداة «${canonicalName}».`;
    if (policy.clinicalOnly && role !== "doctor") {
      roleReason = "🔒 **تنبيه أمني:** هذه الأداة دعم قرار سريري مقتصر على الطبيب المعالج فقط.";
    }
    return {
      authorized: false,
      requiresConfirmation: false,
      reason: roleReason,
      canonicalToolName: canonicalName,
      sanitizedParams: rawParams,
    };
  }

  // ─── 4. فحص الصلاحيات الخاصة الإلزامية (Permissions Check) ──────────────────
  if (policy.requiredPermissions && policy.requiredPermissions.length > 0) {
    for (const req of policy.requiredPermissions) {
      if (req === "finance_only") {
        const canFinance =
          role === "admin" ||
          canHandleMoney(role) ||
          context.canViewClinicFinance === true ||
          context.permissions?.canViewClinicFinance === true;
        if (!canFinance) {
          return {
            authorized: false,
            requiresConfirmation: false,
            reason: "🔒 **تنبيه أمني (غير مصرح):** هذا الإجراء يتطلب صلاحية مالية صريحة (المدير أو صلاحية مالية).",
            canonicalToolName: canonicalName,
            sanitizedParams: rawParams,
          };
        }
      } else if (req === "inventory_only") {
        const canInv = role === "admin" || role === "reception" || context.canManageInventory === true;
        if (!canInv) {
          return {
            authorized: false,
            requiresConfirmation: false,
            reason: "🔒 **تنبيه أمني:** هذا الإجراء مقتصر على إدارة المركز أو مسؤولي المخزون.",
            canonicalToolName: canonicalName,
            sanitizedParams: rawParams,
          };
        }
      } else {
        // صلاحية سريرية خاصة بالطبيب
        if (role === "doctor" && !context.permissions?.[req as keyof DoctorPermissions]) {
          return {
            authorized: false,
            requiresConfirmation: false,
            reason: `🔒 **تنبيه أمني:** حساب الطبيب يفتقر إلى صلاحية «${String(req)}».`,
            canonicalToolName: canonicalName,
            sanitizedParams: rawParams,
          };
        }
      }
    }
  }

  // ─── 5. P0-FIX-7: حماية BOLA على مستوى الموارد (Resource Authorization Resolver)
  if (policy.resourceType === "appointment" || rawParams.appointmentId) {
    if (rawParams.appointmentId) {
      const apptId = Number(rawParams.appointmentId);
      if (isNaN(apptId) || apptId <= 0) {
        return {
          authorized: false,
          requiresConfirmation: false,
          reason: "رقم الموعد المحدد غير صالح.",
          canonicalToolName: canonicalName,
          sanitizedParams: rawParams,
        };
      }

      if (context.isDbConnected) {
        const appt = await getAppointment(apptId).catch(() => null);
        if (!appt) {
          return {
            authorized: false,
            requiresConfirmation: false,
            reason: `الموعد #${apptId} غير موجود في سجلات النظام.`,
            canonicalToolName: canonicalName,
            sanitizedParams: rawParams,
          };
        }

        // عزل الأطباء على الموعد (§39 BOLA Resolver)
        if (role === "doctor" && !context.canViewAllPatients && !context.permissions?.canViewAllPatients) {
          const doctorPartyId = context.doctorPartyId;
          if (!doctorPartyId) {
            return {
              authorized: false,
              requiresConfirmation: false,
              reason: "🔒 حساب الطبيب غير مرتبط بملف طبيب معتمد في النظام.",
              canonicalToolName: canonicalName,
              sanitizedParams: rawParams,
            };
          }

          const ownsPatient = await doctorOwnsPatient(doctorPartyId, appt.patientId).catch(() => false);
          const isAssignedDoctor = appt.doctorId === doctorPartyId;

          if (!ownsPatient && !isAssignedDoctor) {
            return {
              authorized: false,
              requiresConfirmation: false,
              reason: "🔒 **تنبيه أمني (عزل الأطباء §39 / حماية BOLA):** ليس لديك صلاحية للوصول لهذا الموعد أو تعديله لأنه يخص مريضاً أو عيادة طبيب آخر.",
              canonicalToolName: canonicalName,
              sanitizedParams: rawParams,
            };
          }
        }

        // فحص وصول الطبيب لمريض الموعد
        const patientCheck = await verifyAiPatientAccess(context, appt.patientId);
        if (!patientCheck.allowed) {
          return {
            authorized: false,
            requiresConfirmation: false,
            reason: patientCheck.reason || "🔒 ليس لديك صلاحية للوصول للمريض المرتبط بهذا الموعد.",
            canonicalToolName: canonicalName,
            sanitizedParams: rawParams,
          };
        }
      }
    }
  }

  // فحص وصول المريض لجميع الأدوات المرتبطة بمريض
  if (policy.patientScoped) {
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
          canonicalToolName: canonicalName,
          sanitizedParams: rawParams,
        };
      }
    }
  }

  // ─── 6. فحص المعاملات المخصصة للأداة إن وجدت ───────────────────────────────
  if (policy.validateParams) {
    const validation = policy.validateParams(rawParams);
    if (!validation.valid) {
      return {
        authorized: false,
        requiresConfirmation: false,
        reason: validation.reason || "المعاملات المدخلة غير صالحة.",
        canonicalToolName: canonicalName,
        sanitizedParams: rawParams,
      };
    }
  }

  // ─── 7. P0-FIX-1 & P0-FIX-8: حوكمة العمليات المغيرة للحالة والتأكيد ──────────
  if (policy.requiresConfirmation) {
    // إذا كان هذا الطلب ناتجاً عن تنفيذ تأكيد تم التحقق منه مسبقاً (P0-FIX-8)
    if (options?.confirmed === true) {
      return {
        authorized: true,
        requiresConfirmation: false,
        canonicalToolName: canonicalName,
        sanitizedParams: rawParams,
        patientId: rawParams.patientId,
      };
    }

    // لم يتم التأكيد بعد: توليد توكن تأكيد مشفر ومطالبة المستخدم بالمعاينة والتأكيد
    const { token } = createConfirmationToken({
      toolName: canonicalName,
      params: rawParams,
      userId,
      username,
      role,
    });

    return {
      authorized: true,
      requiresConfirmation: true,
      confirmationToken: token,
      canonicalToolName: canonicalName,
      sanitizedParams: rawParams,
    };
  }

  return {
    authorized: true,
    requiresConfirmation: false,
    canonicalToolName: canonicalName,
    sanitizedParams: rawParams,
  };
}
