import type { SessionPayload } from "./auth";
import { canViewMoney } from "./roles";

/**
 * Governance & Privacy (§15): Reception is strictly barred from viewing, creating,
 * or printing any clinic expenses or expense vouchers, even if created under an older build.
 */
export function canReadExpenseVoucher(
  session: Pick<SessionPayload, "username" | "role"> | null | undefined,
  _expense?: { createdBy?: string | null },
): boolean {
  if (!session || session.role === "reception") return false;
  return canViewMoney(session.role);
}
