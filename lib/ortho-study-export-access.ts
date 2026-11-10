import type { DoctorPermissions } from './doctor-permissions';

/** Export is a separate grant, never patient, image or clinical source access.
 * Server callers must pass the current database user, not request/token claims. */
export function canExportOrthoStudy(actor: {
  role: string;
  permissions?: Pick<DoctorPermissions, 'canExportOrthoStudies'> | null;
} | null | undefined): boolean {
  return !!actor && (actor.role === 'admin'
    || (actor.role === 'doctor' || actor.role === 'reception') && actor.permissions?.canExportOrthoStudies === true);
}
