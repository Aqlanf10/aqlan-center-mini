import { NextResponse } from "next/server";
import { PORTAL_COOKIE } from "@/lib/portal";

export const dynamic = "force-dynamic";

/** خروج البوابة — حذف الكوكي، فالجلسة موقّعة لا مخزَّنة. */
export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(PORTAL_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    partitioned: true,
    path: "/",
    maxAge: 0,
  });
  return response;
}
