import { NextResponse } from "next/server";
import { getSettings, portalLogin, recordAudit } from "@/lib/db";
import { consumeLoginAttemptFor } from "@/lib/loginLimit";
import { consumeSecurityLimit } from "@/lib/security-rate-limit";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { FORM_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import {
  LOGIN_MAX_FAILURES,
  PORTAL_COOKIE,
  PORTAL_DURATION_MS,
  createPortalToken,
  validatePortalLogin,
} from "@/lib/portal";

export const dynamic = "force-dynamic";

/**
 * دخول البوابة: هاتف + رقم ملف.
 *
 * (SEC-05) محاولات الدخول الخاطئة تُحدّ في `login_limits` على كلٍّ من الهاتف ورقم
 * الملف والمصدر — بلا كتابة في `audit_log` لغير الموثّقين كي لا يُغرق سجل التدقيق.
 */
export async function POST(request: Request) {
  let body: unknown;
  try { body = await readJsonBody(request, FORM_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const validation = validatePortalLogin(body);
  if (!validation.ok) {
    return NextResponse.json({ message: validation.message }, { status: 400 });
  }
  const { phone, patientNumber } = validation.value;

  try {
    const settings = await getSettings();
    if (settings["portal.enabled"] === "false") {
      return NextResponse.json(
        { message: "بوابة المريض متوقفة حاليًا بقرار إدارة المركز. يرجى التواصل مع الاستقبال." },
        { status: 403 },
      );
    }

    const sharedLimit = await consumeLoginAttemptFor("portal", phone, request.headers);
    if (!sharedLimit.allowed) {
      return NextResponse.json(
        { message: `محاولات كثيرة. أعد المحاولة بعد ${Math.ceil(sharedLimit.retryAfterSeconds / 60)} دقيقة.` },
        { status: 429, headers: { "Retry-After": String(sharedLimit.retryAfterSeconds) } },
      );
    }
    const fileLimit = await consumeSecurityLimit({
      scope: "portal-file",
      identifier: patientNumber.trim().toUpperCase(),
      maximum: LOGIN_MAX_FAILURES * 2,
      windowMinutes: 15,
      headers: request.headers,
    });
    if (!fileLimit.allowed) {
      return NextResponse.json(
        { message: `محاولات كثيرة على هذا الملف. أعد المحاولة بعد ${Math.ceil(fileLimit.retryAfterSeconds / 60)} دقيقة.` },
        { status: 429, headers: { "Retry-After": String(fileLimit.retryAfterSeconds) } },
      );
    }

    const result = await portalLogin(phone, patientNumber);
    if (!result) {
      return NextResponse.json(
        { message: "لم نطابق هاتفًا مع رقم ملف. تأكد منهما أو اتصل بالاستقبال." },
        { status: 401 },
      );
    }

    await recordAudit({
      action: "portal.login",
      entity: "patient",
      entityId: result.patient.id,
      details: { ok: true },
      actor: `مريض: ${result.patient.fullName}`,
    });

    const token = createPortalToken({
      patientId: result.patient.id,
      patientNumber: result.patient.patientNumber,
      fullName: result.patient.fullName,
      expiresAt: Date.now() + PORTAL_DURATION_MS,
      secretVersion: result.patient.portalSecretVersion ?? 0,
    });
    const response = NextResponse.json({
      patientNumber: result.patient.patientNumber,
      fullName: result.patient.fullName,
    });
    /* (P2/S4) SameSite=Lax مثل جلسة الطاقم: بوابة المريض تعمل كاملة داخل
     * أصلها نفسه (صفحة البوابة واستماراتها) — لا ميزة production اليوم
     * تتطلب None. فحص الكود لم يجد أي تضمين iframe خارجي للبوابة. */
    response.cookies.set(PORTAL_COOKIE, token, {
      httpOnly: true,      // لا تستطيع أي نصوص في الصفحة قراءتها
      secure: true,        // تُرسل عبر HTTPS
      sameSite: "lax",     // (P2/S4) — لا None ولا Partitioned
      path: "/",
      maxAge: Math.floor(PORTAL_DURATION_MS / 1000),
    });
    return response;
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل الدخول الآن. حاول من جديد." }, { status: 500 });
  }
}
