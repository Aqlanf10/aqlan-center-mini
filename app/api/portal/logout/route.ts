import { NextResponse } from "next/server";
import { revokePortalSession } from "@/lib/portal-server";
import { PORTAL_COOKIE } from "@/lib/portal";

export const dynamic = "force-dynamic";

/** خروج البوابة يبطل نسخة التوكن المحفوظة أيضًا قبل حذف الكوكي. */
export async function POST() {
  try { await revokePortalSession(); }
  catch { return NextResponse.json({ message: "تعذّر تأكيد الخروج. أعد المحاولة." }, { status: 503 }); }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(PORTAL_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",     // (P2/S4) مطابقة لسمات كوكي دخول البوابة نفسها
    path: "/",
    maxAge: 0,
  });
  return response;
}
