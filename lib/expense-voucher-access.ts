import type { SessionPayload } from "./auth";
import { canViewMoney } from "./roles";

/** Reception keeps access to its own vouchers, not other staff's vouchers. */
export function canReadExpenseVoucher(
  session: Pick<SessionPayload, "username" | "role">,
  expense: { createdBy: string | null },
): boolean {
  return canViewMoney(session.role) && (session.role !== "reception" || expense.createdBy === session.username);
}
