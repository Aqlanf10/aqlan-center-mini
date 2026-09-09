import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { portalLogin, portalLoginFailures, recordAudit } from "@/lib/db";
import { consumeLoginAttemptFor } from "@/lib/loginLimit";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { FORM_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import {
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  PORTAL_COOKIE,
  PORTAL_DURATION_MS,
  createPortalToken,
  validatePortalLogin,
} from "@/lib/portal";

export const dynamic = "force-dynamic";

/**
 * دخول البوابة: هاتف + رقم ملف.
 *
 * الحد هنا حمايةُ هوية لا راحةُ خادم: من يحاول رقمَ هاتفٍ غريب مرارًا يبحث عن
 * ملفٍ لا يملكه. المحاولات تُعدّ من سجل التدقيق نفسه — فالهاتف لا يُخزَّن
 * مرة ثانية ولا يظهر كاملًا في أي سطر، ويُقاس ببصمة sha256 لآخر تسع خاناته.
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

  const phoneHash = createHash("sha256")
    .update(phone.replace(/\D/g, "").slice(-9))
    .digest("hex");

  try {
    /* الحدّ المشترك الجديد (من مستودع الوكيل الآخر) فوق حدّ البصمة القائم:
       مفتاح HMAC على الهاتف بين النسخ ومع إعادة التشغيل — فتدوير IP أو إقلاع
       الخادم لا يصفّر العدّاد، وحدُّ المصدر خلف وسيطٍ موثّق فقط. */
    const sharedLimit = await consumeLoginAttemptFor("portal", phone, request.headers);
    if (!sharedLimit.allowed) {
      return NextResponse.json(
        { message: `محاولات كثيرة. أعد المحاولة بعد ${Math.ceil(sharedLimit.retryAfterSeconds / 60)} دقيقة.` },
        { status: 429, headers: { "Retry-After": String(sharedLimit.retryAfterSeconds) } },
      );
    }
    const now = Date.now();
    const failures = await portalLoginFailures(
      phoneHash,
      new Date(now - LOGIN_WINDOW_MS).toISOString(),
    );
    if (failures.count >= LOGIN_MAX_FAILURES && failures.oldestIso) {
      const remaining = Math.ceil(
        ((Date.parse(failures.oldestIso) + LOGIN_WINDOW_MS - now) / 60_000),
      );
      return NextResponse.json(
        { message: `محاولات كثيرة على هذا الرقم. أعد المحاولة بعد ${Math.max(1, remaining)} دقيقة.` },
        { status: 429 },
      );
    }

    const result = await portalLogin(phone, patientNumber);
    if (!result) {
      await recordAudit({
        action: "portal.login",
        details: { ok: false, phone_fingerprint: phoneHash },
        actor: "بوابة المريض",
      });
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
