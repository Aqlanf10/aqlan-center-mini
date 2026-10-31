import type { SessionPayload } from "./auth";
import { findUserByUsername } from "./db";
/** requireSession already revalidates accounts. Reception grant is read freshly,
 * never inferred from a role or an old token. Patient scope is checked separately. */
export async function canPrintSavedPrescription(session: SessionPayload): Promise<boolean> {
  if (session.role === "admin" || session.role === "doctor") return true;
  if (session.role !== "reception") return false;
  const user = await findUserByUsername(session.username).catch(() => null);
  return Boolean(user?.isActive && user.id === session.userId && user.role === "reception"
    && user.permissions?.canPrintSavedPrescriptions === true);
}
