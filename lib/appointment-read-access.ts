import type { SessionPayload } from "./auth";
import type { AppointmentReadScope } from "./appointment-read-scope";
import { doctorOwnedPatientIds, findUserByUsername } from "./db";
import { restrictedRouteAllowed } from "./role-routes";

/**
 * The existing GET /api/appointments policy, including its proxy role boundary.
 * A doctor sees unassigned appointments, their own appointments, and appointments
 * of canonically owned patients. canViewAllPatients is deliberately unrelated.
 * Call only after requireSession has validated the current account.
 */
export async function resolveAppointmentReadScope(
  session: SessionPayload,
  candidatePatientIds: number[],
): Promise<AppointmentReadScope> {
  if (!restrictedRouteAllowed(session.role, "/api/appointments", "GET", session.financeAccess)) {
    return { kind: "none" };
  }
  if (session.role !== "doctor") return { kind: "all" };
  const user = await findUserByUsername(session.username).catch(() => null);
  if (user?.permissions?.canViewAllAppointments) return { kind: "all" };
  const doctorPartyId = user?.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
  if (!doctorPartyId) return { kind: "none" };
  const ownedPatientIds = await doctorOwnedPatientIds(doctorPartyId, Array.from(new Set(candidatePatientIds)))
    .catch(() => new Set<number>());
  return { kind: "doctor", doctorPartyId, ownedPatientIds };
}
