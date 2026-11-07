/** Same clinical-write roles as the existing orthodontic assessment policy.
 * Image viewing/upload permission alone does not authorize clinical attestation.
 * Patient-specific imaging-write scope must still be checked by the caller. */
export function canWriteCephClinical(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'doctor';
}
