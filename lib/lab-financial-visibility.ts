import type { SessionPayload } from "./auth";
import { findUserByUsername } from "./db";
import { canDoctorViewCostPrices } from "./doctor-permissions";

/** Response visibility only, not route admission. Keep existing role guards.
 * Resolve before writers, and fail closed on missing/current-user lookup errors. */
export async function canViewLabFinancials(
  session: Pick<SessionPayload, "role" | "username">,
): Promise<boolean> {
  if (session.role !== "doctor") return true;
  try {
    const user = await findUserByUsername(session.username);
    return canDoctorViewCostPrices(user?.permissions, session.role);
  } catch {
    return false;
  }
}
