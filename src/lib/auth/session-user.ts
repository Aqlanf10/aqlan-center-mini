import type { UserRole } from "@/db/schema/enums";
import { isUserRole } from "@/lib/auth/rbac";

export type SessionUser = {
  id: string;
  name: string;
  username: string;
  role: UserRole;
  active: boolean;
};

/**
 * Validate the raw session user payload coming from Better Auth into our
 * strictly-typed SessionUser. Better Auth returns additional fields
 * (role/active/username) as runtime data, so they are checked here instead
 * of trusting the library's inference.
 *
 * Security: an unknown role fails CLOSED — the session is treated as
 * invalid (null) and never falls back to a default role. A fallback role
 * could silently grant unintended permissions.
 *
 * Pure function (no server imports) so it is directly unit-testable.
 */
export function parseSessionUser(raw: unknown): SessionUser | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.name !== "string") {
    return null;
  }
  if (!isUserRole(record.role)) {
    return null;
  }
  return {
    id: record.id,
    name: record.name,
    username: typeof record.username === "string" ? record.username : "",
    role: record.role,
    active: record.active !== false,
  };
}
