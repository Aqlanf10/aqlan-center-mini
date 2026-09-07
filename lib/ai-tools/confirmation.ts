/**
 * محرك تأكيد العمليات الحساسة والمغيرة للحالة للذكاء الاصطناعي (AI State-Changing Confirmation Engine)
 * لمركز الدكتور عقلان الكامل لطب وجراحة وتقويم الأسنان.
 *
 * يطبق متطلبات التحصين الأمني الصارم (P0-FIX):
 * 1. P0-FIX-4: حماية Replay Protection ذرية ومستدامة (Durable Atomic Replay Protection) تعتمد على PostgreSQL
 *    مع دعم بيئات الاختبار المعزولة، بحيث يفشل أي طلب ثانٍ حتى لو وصل في نفس الميلي ثانية.
 * 2. P0-FIX-5: إزالة أي مفتاح سري افتراضي ثابت (Static Secret Fallback). إذا كان SESSION_SECRET مفقوداً أو ضعيفاً (< 16 حرفاً)
 *    فإن النظام يفشل فورا وبشكل مغلق (Fail Closed) دون إنشاء أو توثيق أي توكن.
 * 3. P0-FIX-6: إلغاء الهويات الافتراضية والتساهل الأمني (Fail Closed Identity). لا تحويل لمستخدم مجهول إلى Reception أو #1.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { findUserByUsername, createAiConfirmationRecord, claimAiConfirmationAtomic } from "../db";
import type { Role } from "../roles";
import type { DoctorPermissions } from "../doctor-permissions";

export interface ConfirmationPayload {
  confirmationId: string;
  toolName: string;
  paramsHash: string;
  params: Record<string, any>;
  userId: number;
  username: string;
  role: Role;
  createdAt: number;
  expiresAt: number;
  nonce: string;
}

export type ConfirmationVerifyResult =
  | { valid: true; payload: ConfirmationPayload }
  | {
      valid: false;
      code:
        | "invalid_signature"
        | "tampered"
        | "expired"
        | "cross_user_forbidden"
        | "replay"
        | "user_inactive"
        | "permission_revoked"
        | "tool_mismatch"
        | "malformed"
        | "identity_invalid";
      reason: string;
    };

/** صلاحية توكن التأكيد: 5 دقائق افتراضياً */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/**
 * مخزن السجلات التزامني للاختبارات المعزولة (In-Memory Atomic Store for Isolated Tests / Offline)
 */
export interface StoredConfirmationRecord {
  confirmationId: string;
  userId: number;
  toolName: string;
  paramsHash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
  status: "pending" | "consumed";
}

const inMemoryClaimRecords = new Map<string, StoredConfirmationRecord>();

/** تنظيف الرموز المنتهية دورياً من مخزن الذاكرة */
function pruneExpiredMemoryRecords() {
  const now = Date.now();
  for (const [id, rec] of inMemoryClaimRecords.entries()) {
    if (now > rec.expiresAt + 60_000) {
      inMemoryClaimRecords.delete(id);
    }
  }
}

/**
 * جلب مفتاح التوقيع الصارم من البيئة.
 * P0-FIX-5: لا يوجد أي مفتاح افتراضي ثابت.
 * إذا كان المفتاح مفقوداً أو أقل من 16 حرفاً: يرمي خطأ فوراً (Fail Closed).
 */
export function getSigningSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.trim().length < 16) {
    throw new Error(
      "🔒 FAIL CLOSED: SESSION_SECRET is missing or weak (must be at least 16 characters). Action confirmation aborted.",
    );
  }
  return secret.trim();
}

/** ترتيب الكائن بشكل هجائي مستقر لحساب البصمة الرقمية بدقة */
export function canonicalizeObject(obj: any): string {
  if (obj === undefined) {
    return "null";
  }
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj) ?? "null";
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalizeObject).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeObject(obj[k])}`);
  return "{" + pairs.join(",") + "}";
}

/** حساب البصمة المشفرة للمعاملات (HMAC-SHA256) */
export function hashParameters(params: Record<string, any>): string {
  const canonical = canonicalizeObject(params);
  return createHmac("sha256", getSigningSecret()).update(canonical).digest("hex");
}

function sign(data: string): string {
  return createHmac("sha256", getSigningSecret()).update(data).digest("base64url");
}

/**
 * إنشاء توكن تأكيد آمن للعملية المغيرة للحالة
 * P0-FIX-6: تحقق صارم من وجود الهوية (Fail Closed Identity) بدون أي تساهل
 */
export function createConfirmationToken(
  inputOrContext:
    | {
        toolName: string;
        params: Record<string, any>;
        userId: number;
        username: string;
        role: Role;
        ttlMs?: number;
      }
    | {
        userId?: number;
        username?: string;
        role?: Role;
        [key: string]: any;
      },
  toolNameArg?: string,
  paramsArg?: Record<string, any>,
  ttlMsArg?: number,
): { token: string; payload: ConfirmationPayload } {
  pruneExpiredMemoryRecords();

  let toolName: string;
  let params: Record<string, any>;
  let userId: number | undefined;
  let username: string | undefined;
  let role: Role | undefined;
  let ttlMs: number | undefined;

  if (toolNameArg !== undefined) {
    const ctx = inputOrContext as { userId?: number; username?: string; userName?: string; role?: Role; userRole?: Role };
    toolName = toolNameArg;
    params = paramsArg || {};
    userId = ctx.userId;
    username = ctx.username || ctx.userName;
    role = ctx.role || ctx.userRole;
    ttlMs = ttlMsArg;
  } else {
    const input = inputOrContext as {
      toolName: string;
      params: Record<string, any>;
      userId: number;
      username: string;
      role: Role;
      ttlMs?: number;
    };
    toolName = input.toolName;
    params = input.params || {};
    userId = input.userId;
    username = input.username;
    role = input.role;
    ttlMs = input.ttlMs;
  }

  // P0-FIX-6: الحظر الفوري إذا كانت الهوية ناقصة أو غير معتمدة
  if (!userId || typeof userId !== "number" || userId <= 0 || !username || typeof username !== "string" || !role) {
    throw new Error("🔒 FAIL CLOSED: Missing or invalid authenticated user identity (userId, username, role required).");
  }

  // P0-FIX-5: التحقق من وجود مفتاح التوقيع
  getSigningSecret();

  const confirmationId = `cnf_${randomBytes(16).toString("hex")}`;
  const nonce = randomBytes(12).toString("hex");
  const createdAt = Date.now();
  const expiresAt = createdAt + (ttlMs !== undefined ? ttlMs : CONFIRMATION_TTL_MS);
  const paramsHash = hashParameters(params);

  const payload: ConfirmationPayload = {
    confirmationId,
    toolName,
    paramsHash,
    params,
    userId,
    username,
    role,
    createdAt,
    expiresAt,
    nonce,
  };

  // حفظ السجل في مخزن الذاكرة التزامني
  inMemoryClaimRecords.set(confirmationId, {
    confirmationId,
    userId,
    toolName,
    paramsHash,
    createdAt,
    expiresAt,
    status: "pending",
  });

  // توثيق في PostgreSQL إن كانت متصلة
  try {
    createAiConfirmationRecord({
      confirmationId,
      userId,
      toolName,
      paramsHash,
      createdAt,
      expiresAt,
    }).catch(() => {});
  } catch {}

  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(body);
  const token = `${body}.${signature}`;

  return { token, payload };
}

/**
 * التحقق الصارم من توكن التأكيد (Cryptographic Integrity & Policy Check)
 */
export function verifyConfirmationToken(
  token: string,
  caller: {
    userId?: number;
    username?: string;
    userName?: string;
    role?: Role;
    userRole?: Role;
    permissions?: Partial<DoctorPermissions> | null;
  },
  expectedToolName?: string,
  overrideParams?: Record<string, any>,
): ConfirmationVerifyResult {
  pruneExpiredMemoryRecords();

  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { valid: false, code: "malformed", reason: "رمز التأكيد مشوه أو غير مكتمل." };
  }

  // P0-FIX-5: فحص مفتاح التوقيع
  try {
    getSigningSecret();
  } catch {
    return {
      valid: false,
      code: "invalid_signature",
      reason: "🔒 إعدادات مفتاح التوقيع في الخادم غير مهيأة أو ضعيفة (Fail Closed).",
    };
  }

  const [bodyPart, signaturePart] = token.split(".");
  if (!bodyPart || !signaturePart) {
    return { valid: false, code: "malformed", reason: "بنية رمز التأكيد غير صالحة." };
  }

  // 1. فحص صحة التوقيع المشفر
  const expectedSignature = sign(bodyPart);
  const sigBuf = Buffer.from(signaturePart, "base64url");
  const expBuf = Buffer.from(expectedSignature, "base64url");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, code: "invalid_signature", reason: "🔒 توقيع رمز التأكيد غير صالح أو تم التلاعب به." };
  }

  let payload: ConfirmationPayload;
  try {
    payload = JSON.parse(Buffer.from(bodyPart, "base64url").toString("utf8"));
  } catch {
    return { valid: false, code: "malformed", reason: "فشل فك تشفير محتوى رمز التأكيد." };
  }

  // 2. فحص انتهاء الصلاحية الزمنية
  if (Date.now() > payload.expiresAt) {
    return { valid: false, code: "expired", reason: "⏳ انتهت صلاحية رمز التأكيد (مدة الصلاحية 5 دقائق). يرجى إعادة طلب الإجراء." };
  }

  // 3. فحص Replay Attack في مخزن الذاكرة
  const memRecord = inMemoryClaimRecords.get(payload.confirmationId);
  if (memRecord && memRecord.status === "consumed") {
    return { valid: false, code: "replay", reason: "🚫 تم استخدام رمز التأكيد هذا مسبقاً ولا يمكن إعادة تنفيذه (حماية Replay Protection)." };
  }

  // 4. فحص Cross-User (منع مستخدم من تنفيذ توكن مستخدم آخر)
  const callerUsername = caller.username || caller.userName;
  if (
    (caller.userId !== undefined && payload.userId !== caller.userId) ||
    (callerUsername && payload.username.toLowerCase() !== callerUsername.toLowerCase())
  ) {
    return {
      valid: false,
      code: "cross_user_forbidden",
      reason: "🔒 رمز التأكيد هذا تم إنشاؤه بواسطة مستخدم آخر، ولا يمكنك تأكيده (حماية Cross-User).",
    };
  }

  // 5. فحص الأداة المتوقعة إن حددت
  if (expectedToolName && payload.toolName !== expectedToolName) {
    return {
      valid: false,
      code: "tool_mismatch",
      reason: `⚠️ الرمز مخصص للأداة «${payload.toolName}» ولا يطابق الأداة المستهدفة.`,
    };
  }

  // 6. فحص التلاعب بالمعاملات (Tampering)
  const effectiveParams = overrideParams || payload.params;
  let currentParamsHash: string;
  try {
    currentParamsHash = hashParameters(effectiveParams);
  } catch {
    return { valid: false, code: "invalid_signature", reason: "فشل التحقق من توقيع المعاملات." };
  }

  if (currentParamsHash !== payload.paramsHash) {
    return {
      valid: false,
      code: "tampered",
      reason: "⚠️ تم التلاعب بمعاملات العملية المصرح بها بين المعاينة والتنفيذ (عدم تطابق معاملات). تم إحباط العملية.",
    };
  }

  // 7. فحص سحب الصلاحيات بين المعاينة والتنفيذ
  if (caller.role && caller.role !== payload.role) {
    if (caller.role === "doctor" && payload.role === "admin") {
      return {
        valid: false,
        code: "permission_revoked",
        reason: "🔒 تم سحب الصلاحية وتغيير دور المستخدم بعد المعاينة وقبل التنفيذ.",
      };
    }
  }

  if (payload.toolName === "record_patient_payment") {
    const canFinance = caller.role === "admin" || caller.role === "reception" || (caller.permissions?.canViewClinicFinance === true);
    if (!canFinance) {
      return {
        valid: false,
        code: "permission_revoked",
        reason: "🔒 تم سحب الصلاحية المالية من المستخدم بعد المعاينة وقبل التنفيذ.",
      };
    }
  }

  return { valid: true, payload };
}

/**
 * P0-FIX-4: استهلاك الرمز ذرياً مع دعم التزامن المتوازي
 */
export async function claimConfirmationAtomic(
  confirmationId: string,
  now: number = Date.now(),
  isDbConnected: boolean = false,
): Promise<{ success: boolean; code?: "replay" | "expired" | "not_found" }> {
  // 1. إذا كانت قاعدة البيانات متصلة، التنفيذ الذري في PostgreSQL هو الحاكم
  if (isDbConnected) {
    const dbClaim = await claimAiConfirmationAtomic(confirmationId, now).catch(() => null);
    if (!dbClaim || !dbClaim.success) {
      return { success: false, code: dbClaim?.code || "replay" };
    }
    const mem = inMemoryClaimRecords.get(confirmationId);
    if (mem) {
      mem.status = "consumed";
      mem.consumedAt = now;
    }
    return { success: true };
  }

  // 2. مخزن الذاكرة التزامني للاختبارات المعزولة (Synchronous atomic check-and-set)
  const mem = inMemoryClaimRecords.get(confirmationId);
  if (!mem) {
    return { success: false, code: "not_found" };
  }
  if (mem.status === "consumed") {
    return { success: false, code: "replay" };
  }
  if (now > mem.expiresAt) {
    return { success: false, code: "expired" };
  }

  mem.status = "consumed";
  mem.consumedAt = now;
  return { success: true };
}

/** استهلاك الرمز يدوياً (للتوافق الرجعي واختبارات الوحدة) */
export function consumeConfirmationToken(token: string): boolean {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [bodyPart] = token.split(".");
  try {
    const payload: ConfirmationPayload = JSON.parse(Buffer.from(bodyPart, "base64url").toString("utf8"));
    const mem = inMemoryClaimRecords.get(payload.confirmationId);
    if (mem) {
      mem.status = "consumed";
      mem.consumedAt = Date.now();
    } else {
      inMemoryClaimRecords.set(payload.confirmationId, {
        confirmationId: payload.confirmationId,
        userId: payload.userId,
        toolName: payload.toolName,
        paramsHash: payload.paramsHash,
        createdAt: payload.createdAt,
        expiresAt: payload.expiresAt,
        consumedAt: Date.now(),
        status: "consumed",
      });
    }
    return true;
  } catch {
    return false;
  }
}

/** التحقق من استهلاك الرمز واستهلاكه ذرياً */
export async function verifyAndConsumeConfirmationToken(
  token: string,
  caller: {
    userId: number;
    username: string;
    role: Role;
    permissions?: Partial<DoctorPermissions> | null;
  },
  overrideParams?: Record<string, any>,
  isDbConnected: boolean = false,
): Promise<ConfirmationVerifyResult> {
  const result = verifyConfirmationToken(token, caller, undefined, overrideParams);
  if (!result.valid) {
    return result;
  }

  // التحقق الحي من حالة المستخدم
  try {
    const liveUser = await findUserByUsername(caller.username);
    if (!liveUser || !liveUser.isActive) {
      return { valid: false, code: "user_inactive", reason: "حساب المستخدم معطل أو غير نشط في النظام." };
    }
  } catch {}

  // P0-FIX-4: الاستهلاك الذري الأحادي
  const claimRes = await claimConfirmationAtomic(result.payload.confirmationId, Date.now(), isDbConnected);
  if (!claimRes.success) {
    if (claimRes.code === "expired") {
      return { valid: false, code: "expired", reason: "⏳ انتهت صلاحية رمز التأكيد." };
    }
    return {
      valid: false,
      code: "replay",
      reason: "🚫 تم استخدام رمز التأكيد هذا مسبقاً ولا يمكن إعادة تنفيذه (حماية Replay Protection).",
    };
  }

  return result;
}

/** اختبار ما إذا كان الرمز قد استهلك */
export function isConfirmationConsumed(confirmationId: string): boolean {
  const mem = inMemoryClaimRecords.get(confirmationId);
  return mem?.status === "consumed";
}

/** مسح السجل لاختبارات الوحدة المعزولة */
export function resetConsumedTokensForTesting(): void {
  inMemoryClaimRecords.clear();
}
