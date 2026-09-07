/**
 * خدمة تنفيذ العمليات المؤكدة مركزياً (Central Confirmed AI Action Execution Service)
 * لمركز الدكتور عقلان الكامل لطب وجراحة وتقويم الأسنان.
 *
 * يطبق متطلبات P0-FIX-2 و P0-FIX-4 و P0-FIX-8:
 * مسار أحادي صارم وغير مزدوج لتنفيذ التأكيدات:
 * 1. فحص سلامة التوكن المشفر والبصمة الرقمية (Cryptographic Integrity).
 * 2. الاستهلاك الذري الأحادي لرمز التأكيد لمنع هجمات التكرار (Atomic Claim / Replay Protection).
 * 3. إعادة تحميل بيانات المستخدم الحالية وصلاحياته من قاعدة البيانات (Live Account Re-check).
 * 4. فك الأداة المستهدفة إلى الاسم القانوني الموحد (Canonical Tool Name).
 * 5. إعادة التفويض والحوكمة الكاملة للأداة المستهدفة (Reauthorization at Confirmation Time §P0-FIX-8).
 * 6. فحص عزل الأطباء والموارد (BOLA & Patient Scope Re-verification).
 * 7. التنفيذ الفعلي للأداة لمرة واحدة فقط (Execute Once).
 * 8. تسجيل السجل في التدقيق الأمني (Audit Result).
 */

import { findUserByUsername, recordAudit } from "../db";
import type { Role } from "../roles";
import type { AiToolContext, ToolExecutionResult } from "./types";
import { verifyConfirmationToken, claimConfirmationAtomic } from "./confirmation";
import { resolveCanonicalToolName } from "./security-policy";
import { authorizeAiToolExecution } from "./authorization";
import { AI_TOOL_DEFINITIONS } from "./registry";

export async function executeConfirmedAiAction(
  token: string,
  callerContext: AiToolContext,
  overrideParams?: Record<string, any>,
): Promise<ToolExecutionResult> {
  // 1. التحقق الأولي من وجود الرمز وهوية المستخدم
  if (!token || typeof token !== "string" || !token.trim()) {
    return {
      success: false,
      textSummary: "❌ رمز التأكيد مفقود أو غير صالح.",
      warnings: ["رمز تأكيد مفقود"],
    };
  }

  const userId = callerContext.userId;
  const username = callerContext.username || callerContext.userName;
  const role = (callerContext.role || callerContext.userRole) as Role;

  if (!userId || !username || !role) {
    return {
      success: false,
      textSummary: "🔒 **تنبيه أمني (Fail Closed):** هوية المستخدم غير موثقة بالكامل لتأكيد العملية.",
      warnings: ["هوية مستخدم مفقودة"],
    };
  }

  // 2. فحص السلامة التشفيرية للتوكن (Signature & Tampering Verification)
  const verifyRes = verifyConfirmationToken(
    token.trim(),
    {
      userId,
      username,
      role,
      permissions: callerContext.permissions,
    },
    undefined,
    overrideParams,
  );

  if (!verifyRes.valid) {
    return {
      success: false,
      textSummary: verifyRes.reason,
      warnings: [verifyRes.reason],
    };
  }

  const payload = verifyRes.payload;

  // 3. P0-FIX-4: الاستهلاك الذري الأحادي لرمز التأكيد (Atomic Claim Replay Protection)
  const claimRes = await claimConfirmationAtomic(
    payload.confirmationId,
    Date.now(),
    callerContext.isDbConnected ?? false,
  );

  if (!claimRes.success) {
    const reason =
      claimRes.code === "expired"
        ? "⏳ انتهت صلاحية رمز التأكيد (مدة الصلاحية 5 دقائق). يرجى إعادة طلب الإجراء."
        : "🚫 تم استخدام رمز التأكيد هذا مسبقاً ولا يمكن إعادة تنفيذه (حماية Replay Protection).";
    return {
      success: false,
      textSummary: reason,
      warnings: [reason],
    };
  }

  // 4. P0-FIX-8: إعادة التحقق الحي من حساب المستخدم وصلاحياته من الخادم
  let liveUser = null;
  if (callerContext.isDbConnected) {
    liveUser = await findUserByUsername(username).catch(() => null);
    if (!liveUser || !liveUser.isActive) {
      return {
        success: false,
        textSummary: "🔒 حساب المستخدم معطل أو غير نشط في النظام. تم إحباط العملية.",
        warnings: ["حساب معطل"],
      };
    }
  }

  const currentRole = (liveUser ? (liveUser.role as Role) : role);
  const currentPermissions = liveUser ? liveUser.permissions : callerContext.permissions;

  const freshContext: AiToolContext = {
    ...callerContext,
    role: currentRole,
    permissions: currentPermissions ?? null,
    canViewAllPatients: currentPermissions?.canViewAllPatients ?? (currentRole !== "doctor"),
    canViewClinicFinance: currentPermissions?.canViewClinicFinance ?? (currentRole === "admin"),
    canManageInventory: currentRole === "admin" || currentRole === "reception",
  };

  // 5. حل الأداة إلى الاسم القانوني الموحد (Canonical Tool)
  const canonicalName = resolveCanonicalToolName(payload.toolName);
  if (!canonicalName) {
    return {
      success: false,
      textSummary: `الأداة المطلوبة غير معتمدة أو غير مسجلة: ${payload.toolName}`,
      warnings: ["أداة غير معروفة"],
    };
  }

  // 6. P0-FIX-8: إعادة التفويض الصارم للأداة المستهدفة مع تفعيل وضع confirmed = true
  const effectiveParams = overrideParams || payload.params;
  const reauth = await authorizeAiToolExecution(
    canonicalName,
    effectiveParams,
    freshContext,
    { confirmed: true },
  );

  if (!reauth.authorized) {
    return {
      success: false,
      textSummary: reauth.reason || "🔒 تم رفض تنفيذ العملية عند إعادة التحقق من الصلاحيات والملكية.",
      warnings: [reauth.reason || "فشل إعادة التفويض"],
    };
  }

  // 7. استدعاء وتنفيذ الأداة المستهدفة لمرة واحدة فقط
  const targetTool = AI_TOOL_DEFINITIONS[canonicalName];
  if (!targetTool) {
    return {
      success: false,
      textSummary: `تعذّر العثور على مشغّل الأداة: ${canonicalName}`,
      warnings: ["مشغل غير موجود"],
    };
  }

  let executionResult: ToolExecutionResult;
  try {
    executionResult = await targetTool.execute(reauth.sanitizedParams, freshContext);
  } catch (err) {
    executionResult = {
      success: false,
      textSummary: `❌ فشل تنفيذ العملية: ${(err as Error).message}`,
      warnings: [(err as Error).message],
    };
  }

  // 8. توثيق السجل في Audit Trail
  try {
    await recordAudit({
      action: "ai.chat",
      entity: "ai_confirmation",
      entityId: String(payload.confirmationId),
      entityLabel: `تنفيذ مؤكد لأداة ${canonicalName} للمستخدم ${username}`,
      details: {
        toolName: canonicalName,
        params: effectiveParams,
        success: executionResult.success,
        textSummary: executionResult.textSummary,
      },
      actor: username,
      actorRole: currentRole,
    });
  } catch {}

  return executionResult;
}
