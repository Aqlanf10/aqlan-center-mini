/** Browser-safe presentation helper for inventory screens. It only decides which
 * controls to SHOW; every read and command is re-admitted server-side by its exact
 * capability (canonical) or role policy (legacy). Never a grant. */
import type { StaffCapability } from "./staff-capability-catalogue";

export interface InventoryUiSession {
  readonly role?: string;
  readonly canonical?: boolean;
  readonly isOwner?: boolean;
  readonly capabilities?: readonly string[];
}
/** Canonical: the owner or any listed current grant. Legacy: the administrator role. */
export function inventoryCan(session: InventoryUiSession | null | undefined, ...anyOf: readonly StaffCapability[]): boolean {
  if (!session) return false;
  if (session.canonical === true) return session.isOwner === true || anyOf.some(capability => session.capabilities?.includes(capability) === true);
  return session.role === "admin";
}
