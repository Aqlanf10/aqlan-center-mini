/** Summary visibility and API role gate for patient-supplied medical history.
 * Patient-specific access remains enforced independently at the API.
 */
export function canViewPatientIntakeHistory(role: string | null | undefined): boolean {
  return role === "admin" || role === "doctor";
}
