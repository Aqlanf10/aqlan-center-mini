import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/db";
import {
  PORTAL_ADMIN_PREVIEW_COOKIE,
  readPortalAdminPreviewToken,
} from "@/lib/portal";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** إنهاء وضع «عرض بوابة المريض» الإداري صراحةً مع تسجيل وقت الخروج في سجل التدقيق. */
export async function POST() {
  const store = await cookies();
  const preview = readPortalAdminPreviewToken(store.get(PORTAL_ADMIN_PREVIEW_COOKIE)?.value);
  const staffSession = await requireSession();

  if (preview) {
    await recordAudit({
      action: "portal.admin_preview.exit",
      entity: "patient",
      entityId: preview.patientId,
      details: {
        staffUserId: preview.staffUserId,
        staffUsername: preview.staffUsername,
        reason: preview.reason,
        durationSeconds: Math.max(0, Math.round((Date.now() - preview.startedAt) / 1000)),
      },
      actor: staffSession?.username ?? preview.staffUsername,
      actorRole: staffSession?.role ?? preview.staffRole,
    });
  }

  const response = NextResponse.json({
    ok: true,
    returnTo: preview ? `/patients/${preview.patientId}` : "/",
  });
  response.cookies.set(PORTAL_ADMIN_PREVIEW_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
