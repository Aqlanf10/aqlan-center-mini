import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/db";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { consumeLoginAttemptFor } from "@/lib/loginLimit";
import {
  PORTAL_ADMIN_PREVIEW_COOKIE,
  PORTAL_COOKIE,
  PORTAL_DURATION_MS,
  createPortalToken,
  validatePortalAccountLogin,
} from "@/lib/portal";
import * as portalSecurity from "@/lib/portal-security";
import { FORM_BODY_LIMIT_BYTES } from "@/lib/security-limits";

export const dynamic = "force-dynamic";

const LEGACY_DEPRECATION_MESSAGE =
  "أُوقف الدخول برقم الهاتف ورقم الملف نهائيًا لحماية سرية ملفك الطبي. راجع استقبال العيادة لتفعيل اسم المستخدم أو استعادة الحساب برابط مؤقت أحادي الاستخدام.";

/**
 * دخول بوابة المريض المعتمد: اسم مستخدم + كلمة مرور مفعّلة عبر رابط أحادي الاستخدام.
 *
 * مسار الدخول القديم بـ (رقم الهاتف + رقم الملف) محذوف وموقوف نهائيًا (`403`) بلا أي استثناء طوارئ،
 * ولا تُسجَّل كلمات المرور أو الهواتف الخام في السجلات أبدًا.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await readJsonBody(request, FORM_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const rawRecord = (body ?? {}) as Record<string, unknown>;

  // رفض قطعي لأي محاولة دخول قديمة تعتمد على (phone / patientNumber) بلا اسم مستخدم وكلمة مرور:
  if (
    typeof rawRecord.username !== "string" &&
    (typeof rawRecord.phone === "string" || typeof rawRecord.patientNumber === "string")
  ) {
    const rawPhoneDigits =
      typeof rawRecord.phone === "string" ? rawRecord.phone.replace(/\D/g, "").slice(-9) : "";
    const phoneFingerprint = rawPhoneDigits
      ? createHash("sha256").update(`legacy-portal-phone:${rawPhoneDigits}`).digest("hex")
      : "missing";

    try {
      const rateKey = rawPhoneDigits || "legacy-portal-attempt";
      const sharedLimit = await consumeLoginAttemptFor("portal", rateKey, request.headers);
      if (!sharedLimit.allowed) {
        return NextResponse.json(
          {
            message: `محاولات كثيرة. أعد المحاولة بعد ${Math.ceil(sharedLimit.retryAfterSeconds / 60)} دقيقة.`,
          },
          { status: 429, headers: { "Retry-After": String(sharedLimit.retryAfterSeconds) } },
        );
      }

      await recordAudit({
        action: "portal.login.legacy_blocked",
        details: { ok: false, phone_fingerprint: phoneFingerprint },
        actor: "بوابة المريض",
      });
      return NextResponse.json(
        { code: "legacy_login_disabled", message: LEGACY_DEPRECATION_MESSAGE },
        { status: 403 },
      );
    } catch {
      return NextResponse.json(
        { message: "تعذّر تسجيل الدخول الآن. حاول من جديد." },
        { status: 500 },
      );
    }
  }

  const validation = validatePortalAccountLogin(rawRecord);
  if (!validation.ok) {
    return NextResponse.json({ message: validation.message }, { status: 400 });
  }
  const { username, password } = validation.value;
  const userFingerprint = createHash("sha256")
    .update(`portal-login:${username}`)
    .digest("hex");

  try {
    const sharedLimit = await consumeLoginAttemptFor("portal", username, request.headers);
    if (!sharedLimit.allowed) {
      return NextResponse.json(
        {
          message: `محاولات كثيرة. أعد المحاولة بعد ${Math.ceil(sharedLimit.retryAfterSeconds / 60)} دقيقة.`,
        },
        { status: 429, headers: { "Retry-After": String(sharedLimit.retryAfterSeconds) } },
      );
    }

    let outcome: portalSecurity.PortalAuthenticationOutcome;
    if (typeof portalSecurity.authenticatePortalAccountWithPolicy === "function") {
      outcome = await portalSecurity.authenticatePortalAccountWithPolicy(username, password);
    } else {
      const fallback = await portalSecurity.authenticatePortalAccount(username, password);
      outcome = fallback
        ? { ok: true, ...fallback, sessionDurationMs: PORTAL_DURATION_MS }
        : { ok: false, reason: "invalid_credentials" };
    }

    if (!outcome.ok) {
      if (outcome.reason === "account_locked") {
        const retrySec = Math.max(1, outcome.retryAfterSeconds ?? 900);
        await recordAudit({
          action: "portal.login",
          details: { ok: false, reason: "account_locked", login_fingerprint: userFingerprint },
          actor: "بوابة المريض",
        });
        return NextResponse.json(
          {
            code: "account_locked",
            lockedUntil: outcome.lockedUntil ?? null,
            message: `تم إيقاف محاولات الدخول مؤقتًا لحماية حسابك بعد عدة محاولات غير صحيحة. حاول بعد ${Math.ceil(retrySec / 60)} دقيقة أو تواصل مع الاستقبال.`,
          },
          { status: 423, headers: { "Retry-After": String(retrySec) } },
        );
      }

      await recordAudit({
        action: "portal.login",
        details: { ok: false, login_fingerprint: userFingerprint },
        actor: "بوابة المريض",
      });
      return NextResponse.json(
        { message: "اسم المستخدم أو كلمة المرور غير صحيحة، أو لم يُفعَّل الحساب بعد." },
        { status: 401 },
      );
    }

    await recordAudit({
      action: "portal.login",
      entity: "patient",
      entityId: outcome.patientId,
      details: { ok: true, method: "username_password", loginName: outcome.loginName },
      actor: `مريض: ${outcome.fullName}`,
    });

    const durationMs = outcome.sessionDurationMs || PORTAL_DURATION_MS;
    const issuedAt = Date.now();
    const token = createPortalToken({
      patientId: outcome.patientId,
      patientNumber: outcome.patientNumber,
      fullName: outcome.fullName,
      expiresAt: issuedAt + durationMs,
      credentialVersion: outcome.credentialVersion,
      issuedAt,
      phoneFingerprint: outcome.phoneFingerprint,
    });

    const response = NextResponse.json({
      patientNumber: outcome.patientNumber,
      fullName: outcome.fullName,
      loginName: outcome.loginName,
    });
    response.cookies.set(PORTAL_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(durationMs / 1000),
    });
    response.cookies.set(PORTAL_ADMIN_PREVIEW_COOKIE, "", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch {
    return NextResponse.json(
      { message: "تعذّر تسجيل الدخول الآن. حاول من جديد." },
      { status: 500 },
    );
  }
}
