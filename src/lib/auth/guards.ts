import { headers } from "next/headers";
import { redirect } from "next/navigation";

import type { UserRole } from "@/db/schema/enums";
import { auth } from "@/lib/auth/server";

export type SessionUser = {
  id: string;
  name: string;
  username: string;
  role: UserRole;
  active: boolean;
};

function parseUserRole(value: unknown): UserRole | null {
  if (value === "ADMIN" || value === "DOCTOR" || value === "RECEPTION") {
    return value;
  }
  return null;
}

/**
 * Validate the raw session user payload coming from Better Auth into our
 * strictly-typed SessionUser. Better Auth returns additional fields
 * (role/active/username) as runtime data, so they are checked here instead
 * of trusting the library's inference.
 */
function parseSessionUser(raw: unknown): SessionUser | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.name !== "string") {
    return null;
  }
  return {
    id: record.id,
    name: record.name,
    username: typeof record.username === "string" ? record.username : "",
    role: parseUserRole(record.role) ?? "RECEPTION",
    active: record.active !== false,
  };
}

/** Pure role check — unit tested, reused by requireRole. */
export function isRoleAllowed(
  role: UserRole,
  allowed: readonly UserRole[]
): boolean {
  return allowed.includes(role);
}

/**
 * Resolve the signed-in staff user from the request session.
 * Returns null for anonymous visitors and for deactivated accounts
 * (blocking deactivated users even if a session row still exists).
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
