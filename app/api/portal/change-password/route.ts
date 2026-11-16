import { NextResponse } from "next/server";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  PORTAL_ADMIN_PREVIEW_COOKIE,
  PORTAL_COOKIE,
  createPortalToken,
  isPortalAdminPreview,
} from "@/lib/portal";
import { changePortalPasswordByPatient } from "@/lib/portal-security";
import { requirePortalSession } from "@/lib/portal-server";
import { FORM_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { consumeSecurityLimit } from "@/lib/security-rate-limit";

export const dynamic = "force-dynamic";

/**
 * تغيير كلمة مرور حساب بوابة المريض ذاتيًا من داخل الجلسة النشطة:
 * - محظور كليًا أثناء العرض الإداري للقراءة فقط (`adminPreview`).
 * - يتحقق من كلمة المرور الحالية، ثم يرفع `credential_version` ويبطل جميع الجلسات الأخرى والروابط المفتوحة،
 *   ويصدر كوكي جلسة جديدًا للمتصفح الحالي فقط.
 */
export async function POST(request: Request) {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }
  if (isPortalAdminPreview(session)) {
    return NextResponse.json(
      {
        message:
          "هذا عرضٌ إداري للقراءة فقط باسم الموظف — لا تُغيَّر كلمة مرور المريض من العرض الإداري.",
      },
      { status: 403 },
    );
  }

  const limit = await consumeSecurityLimit({
    scope: "portal-change-password",
    identifier: String(session.patientId),
    maximum: 8,
    windowMinutes: 15,
    headers: request.headers,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { message: "محاولات متكررة لتغيير كلمة المرور. انتظر قليلًا ثم أعد المحاولة." },
      { status: 429, headers: { "Retry-After": String(Math.max(1, limit.retryAfterSeconds)) } },
    );
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, FORM_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const source = (body ?? {}) as Record<string, unknown>;
  const currentPassword =
    typeof source.currentPassword === "string" ? source.currentPassword : "";
  const newPassword = typeof source.newPassword === "string" ? source.newPassword : "";

  try {
    const result = await changePortalPasswordByPatient({
      patientId: session.patientId,
      currentPassword,
      newPassword,
    });
    if (!result.ok) {
      return NextResponse.json(
        { code: result.code, message: result.message },
        { status: result.status },
      );
    }

    const issuedAt = Math.max(Date.now(), result.issuedAtFloorMs);
    const sessionToken = createPortalToken({
      patientId: result.patientId,
      patientNumber: result.patientNumber,
      fullName: result.fullName,
      expiresAt: issuedAt + result.sessionDurationMs,
      credentialVersion: result.credentialVersion,
      issuedAt,
      phoneFingerprint: result.phoneFingerprint,
    });

    const response = NextResponse.json({
      ok: true,
      message: "تم تحديث كلمة المرور بنجاح وإبطال جميع الجلسات السابقة على الأجهزة الأخرى.",
    });
    response.cookies.set(PORTAL_COOKIE, sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(result.sessionDurationMs / 1000),
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
      { message: "تعذّر تحديث كلمة المرور الآن." },
      { status: 500 },
    );
  }
}
