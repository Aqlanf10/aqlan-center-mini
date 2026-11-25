import type { SessionPayload } from "./auth";
import type { DbClient } from "./db";
import { canAccessPatient } from "./patient-access";
import { revalidateSessionInTransaction } from "./session";

export async function canBookOrthoAdjustmentReturn(session: SessionPayload, patientId: number, client?: DbClient) {
  const actor = client ? await revalidateSessionInTransaction(session, client) : session;
  if (!actor || !["admin", "reception", "doctor"].includes(actor.role)) return false;
  return canAccessPatient(actor, patientId, undefined, client, client ? "nowait" : undefined);
}
