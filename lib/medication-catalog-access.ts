import type { DoctorPermissions } from "./doctor-permissions";

/**
 * Who may edit the medication catalog (owner decision 6839071994): an administrator, or a doctor
 * holding the explicit grant. A separate permission from prescribing: it never edits, voids or
 * rewrites a patient's saved prescription. Server callers pass the current database user.
 */
export function canManageMedicationCatalog(actor: {
  role: string; isActive?: boolean;
  permissions?: Pick<DoctorPermissions, "canManageMedicationCatalog"> | null;
} | null | undefined): boolean {
  return !!actor && actor.isActive !== false
    && (actor.role === "admin" || (actor.role === "doctor" && actor.permissions?.canManageMedicationCatalog === true));
}
