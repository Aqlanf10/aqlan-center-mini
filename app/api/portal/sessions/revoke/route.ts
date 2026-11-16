import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/db";
import {
  PORTAL_ADMIN_PREVIEW_COOKIE,
  PORTAL_COOKIE,
  isPortalAdminPreview,
} from "@/lib/portal";
import { revokePortalSessionByPatient } from "@/lib/portal-security";
import { requirePortalSession } from "@/lib/portal-server";

export const dynamic = "force-dynamic";

/**
 * إنهاء جميع جلسات المريض النشطة على كافة الأجهزة ذاتيًا:
 * - محظور أثناء العرض الإداري للقراءة فقط (`adminPreview`).
 * - يرفع `credential_version` ويمسح كوكي المتصفح الحالي ويسجّل الحدث في `audit_log`.
 */
export async function POST() {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }
  if (isPortalAdminPreview(session)) {
    return NextResponse.json(
      { message: "هذا عرضٌ إداري للقراءة فقط باسم الموظف — لا تُدار جلسات المريض منه." },
      { status: 403 },
    );
  }

  try {
    await revokePortalSessionByPatient(session.patientId);
    await recordAudit({
      action: "portal.account.sessions_revoked",
      entity: "patient",
      entityId: session.patientId,
      details: { source: "patient_self_service" },
      actor: `مريض: ${session.fullName}`,
    });

    const response = NextResponse.json({
      ok: true,
      message: "أُنهيت جميع جلسات البوابة النشطة على كافة الأجهزة بنجاح.",
    });
    response.cookies.set(PORTAL_COOKIE, "", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
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
      { message: "تعذّر إنهاء الجلسات الآن." },
      { status: 500 },
    );
  }
}
