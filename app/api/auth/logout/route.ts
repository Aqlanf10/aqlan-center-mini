import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { staffSessionCookieSecure } from "@/lib/sessionCookie";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const response = NextResponse.json({ ok: true });

  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    /* (P2-FINAL-1) نفس قرار كوكي الدخول: الإنتاج Secure=true دائمًا — لا
       Host يكتبه العميل ولا ترويسة مُعاد توجيهها يستطيع إطفاءها، والتساهل
       المحلي dev/test-only فوق مضيف محلي حقيقي. */
    secure: staffSessionCookieSecure(request.headers.get("host")),
    sameSite: "lax",     // (P2/S4) مطابقة لسمات كوكي الدخول نفسها
    path: "/",
    maxAge: 0,
  });
  return response;
}
