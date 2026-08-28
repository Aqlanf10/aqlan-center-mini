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
  "/finance",
  "/labs",
  "/suppliers",
  "/my-work",
  "/settings",
  "/reports",
  "/visits",
  "/print",
] as const;

// Better Auth names its session cookie with the `__Secure-` prefix when the
// base URL is HTTPS (production) and without it over plain HTTP (local dev).
// The edge gate cannot know which flavor applies, so accept both.
const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) =>
    request.cookies.has(name)
  );

  if (isProtectedPath(pathname) && !hasSessionCookie) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  // NOTE: /login is intentionally NOT redirected here. The edge runtime
  // cannot verify the session, and blindly sending cookie-bearing visitors
  // to /dashboard loops forever when the session is expired or was revoked
  // server-side (deactivation, password change, 7-day expiry). The login
  // PAGE performs the real database check and redirects only when the
  // session is genuinely alive.

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
    "/finance/:path*",
    "/labs/:path*",
    "/suppliers/:path*",
    "/my-work/:path*",
    "/settings/:path*",
    "/reports/:path*",
    "/visits/:path*",
    "/print/:path*",
  ],
};
