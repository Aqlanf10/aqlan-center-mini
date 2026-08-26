import { headers } from "next/headers";
import { redirect } from "next/navigation";

import type { UserRole } from "@/db/schema/enums";
import { auth } from "@/lib/auth/server";
import { isRoleAllowed } from "@/lib/auth/rbac";
import { parseSessionUser, type SessionUser } from "@/lib/auth/session-user";

export type { SessionUser };

export { isRoleAllowed };

/**
 * Resolve the signed-in staff user from the request session.
 * Returns null for anonymous visitors, for deactivated accounts
 * (blocking deactivated users even if a session row still exists), and for
 * sessions carrying an unknown role (fail closed — never a default role).
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  const user = parseSessionUser(session?.user);
  if (!user || !user.active) {
    return null;
  }
  return user;
}

/** Require a signed-in active user; otherwise redirect to /login. */
export async function requireUser(returnTo?: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    const next = returnTo ? `?next=${encodeURIComponent(returnTo)}` : "";
    redirect(`/login${next}`);
  }
  return user;
}

/**
 * Require a user with one of the allowed roles; otherwise send them back to
 * the dashboard. Server-side enforcement — never rely on hiding UI buttons.
 */
export async function requireRole(
  allowed: readonly UserRole[],
  returnTo?: string
): Promise<SessionUser> {
  const user = await requireUser(returnTo);
  if (!isRoleAllowed(user.role, allowed)) {
    redirect("/dashboard");
  }
  return user;
}
