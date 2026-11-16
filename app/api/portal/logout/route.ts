import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/db";
import {
  PORTAL_ADMIN_PREVIEW_COOKIE,
  PORTAL_COOKIE,
  readPortalAdminPreviewToken,
  readPortalToken,
} from "@/lib/portal";
import { revokePortalSessionByPatient } from "@/lib/portal-security";

export const dynamic = "force-dynamic";

/** خروج البوابة — يبطل الجلسة على الخادم فورًا ويمسح كوكي الجلسة وأي كوكي معاينة إدارية. */
export async function POST() {
  try {
    const store = await cookies();
    const patientToken = readPortalToken(store.get(PORTAL_COOKIE)?.value);
    if (patientToken) {
      await revokePortalSessionByPatient(patientToken.patientId);
    }
    const preview = readPortalAdminPreviewToken(store.get(PORTAL_ADMIN_PREVIEW_COOKIE)?.value);
    if (preview) {
      await recordAudit({
        action: "portal.admin_preview.exit",
        entity: "patient",
        entityId: preview.patientId,
        details: {
          staffUserId: preview.staffUserId,
          staffUsername: preview.staffUsername,
          reason: preview.reason,
          via: "portal_logout",
        },
        actor: preview.staffUsername,
        actorRole: preview.staffRole,
      });
    }
  } catch {
    // لا نحجب مسح الكوكي عند أي تعذّر عابر في القاعدة.
  }

  const response = NextResponse.json({ ok: true });
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
}
