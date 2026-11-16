import type { DbClient } from "./db";
import type { SessionPayload } from "./auth";
import { revalidateSessionInTransaction } from "./session";
import { canAccessPatient } from "./patient-access";
/** A clinical create cannot become a grant of another doctor's patient access.
 * Called before inserting either case, so the proposed responsibility is never
 * itself a witness. No actor string or missing-session fixture bypass is trusted.
 */
export async function authorizeInitialResponsibility(client: DbClient, admitted: SessionPayload | undefined,
 patientId: number, doctorId: number): Promise<SessionPayload | null> {
 if (!admitted) return null;
 const session = await revalidateSessionInTransaction(admitted, client);
 if (!session || !["admin", "doctor"].includes(session.role)) return null;
 if (session.role === "doctor" && session.partyId !== doctorId) return null;
 if (!await canAccessPatient(session, patientId, undefined, client, "nowait")) return null;
 const { rows } = await client.query("SELECT id FROM parties WHERE id=$1 AND kind='doctor' AND is_active FOR SHARE NOWAIT", [doctorId]);
 return rows.length === 1 ? session : null;
}
