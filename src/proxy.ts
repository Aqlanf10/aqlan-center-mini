import { NextResponse, type NextRequest } from "next/server";

/**
 * Cheap edge-level gate for protected pages.
 *
 * This middleware only checks that a session cookie is present — it cannot
 * verify the session against the database on the Edge runtime. Real
 * verification happens server-side in `requireUser` / `requireRole`
 * (see src/lib/auth/guards.ts) inside every protected page and layout.
 */

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/today",
  "/patients",
  "/appointments",
  "/follow-up",
] as const;

const SESSION_COOKIE_NAME = "better-auth.session_token";

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_NAME);

  if (isProtectedPath(pathname) && !hasSessionCookie) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  if (pathname === "/login" && hasSessionCookie) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/login",
    "/dashboard/:path*",
    "/today/:path*",
    "/patients/:path*",
    "/appointments/:path*",
    "/follow-up/:path*",
  ],
};
