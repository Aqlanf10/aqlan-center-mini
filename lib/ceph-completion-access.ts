import type { SessionPayload } from "./auth";
import type { DbClient } from "./db";
import { canWriteCephClinical } from "./ceph-access";
import { canAccessPatient } from "./patient-access";
import { revalidateSessionInTransaction } from "./session";

/** Authorize only an already authenticated server-side session, never client JSON.
 * Call inside the completion transaction before document/analysis locks, and
 * compare the eventual locked analysis's patient with this scope. Patient, user,
 * and positive ownership witnesses stay locked until commit. Historical completed
 * records do not acquire new attestation evidence through this helper.
 */
export async function authorizeCephCompletion(
  client: DbClient, session: SessionPayload, patientId: number, by: string,
  admit?: (client: DbClient, patientId: number) => Promise<SessionPayload>,
): Promise<number | null> {
  if (admit) {
    // Canonical admission: same patient-first order; the admitted actor must be the signer.
    if (!Number.isSafeInteger(patientId) || patientId <= 0) return null;
    const patient = await client.query<{ id: number }>("SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE", [patientId]);
    if (!patient.rows[0]) return null;
    const current = await admit(client, patientId);
    return current.username === by && current.userId === session.userId && current.expiresAt >= Date.now() ? current.userId : null;
  }
  if (!Number.isSafeInteger(patientId) || patientId <= 0 || !session
    || !Number.isSafeInteger(session.userId) || session.userId <= 0
    || !Number.isFinite(session.expiresAt) || session.expiresAt < Date.now()
    || by !== session.username) return null;
  const patient = await client.query<{ id: number }>(
    "SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE", [patientId]);
  const current = await revalidateSessionInTransaction(session, client);
  if (!current || !canWriteCephClinical(current.role) || !patient.rows[0]) return null;
  if (!await canAccessPatient(current, patientId, "canUploadXrays", client)) return null;
  // Expiry can occur while waiting for an ownership witness. The caller must
  // check it once more immediately before writing its completion witness.
  return current.expiresAt >= Date.now() ? current.userId : null;
}
