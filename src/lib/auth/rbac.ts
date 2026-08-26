import type { UserRole } from "@/db/schema/enums";

/** All staff roles recognized by the system. */
export const USER_ROLES: readonly UserRole[] = ["ADMIN", "DOCTOR", "RECEPTION"];

export function isUserRole(value: unknown): value is UserRole {
  return value === "ADMIN" || value === "DOCTOR" || value === "RECEPTION";
}

/** Pure role check used by server guards — the RBAC decision core. */
export function isRoleAllowed(
  role: UserRole,
  allowed: readonly UserRole[]
): boolean {
  return allowed.includes(role);
}
