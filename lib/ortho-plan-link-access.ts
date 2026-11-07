import type { SessionPayload } from "./auth";
import { doctorOwnsPatient, findUserByUsername, type DbClient } from "./db";

/** Linking or unlinking changes future adjustment coverage, even when no money
 * is written. Every ortho entry point must use the same current plan boundary;
 * global clinical visibility does not authorize another doctor's plan. */
export async function canChangeOrthoPlanLink(session: SessionPayload, patientId: number, client?: DbClient, ownershipLockMode?: "nowait"): Promise<boolean> {
  if (client && session.expiresAt < Date.now()) return false;
  if (session.role === "admin" || session.role === "reception") return true;
  if (session.role !== "doctor") return false;
  try {
    const user = await (client ? findUserByUsername(session.username, client) : findUserByUsername(session.username));
    if (!user?.isActive || !user.partyId || user.permissions?.canViewPlans !== true
      || user.permissions.canEditPlans !== true) return false;
    return await (client ? doctorOwnsPatient(user.partyId, patientId, client, ownershipLockMode) : doctorOwnsPatient(user.partyId, patientId));
  } catch (error) {
    if (ownershipLockMode === "nowait" && (error as { code?: string }).code === "55P03") throw error;
    return false;
  }
}
