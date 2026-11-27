import type { SessionPayload } from "./auth";
import { canViewMoney } from "./roles";

/** Reception collects patient payments, but cannot read any expense voucher. */
export function canReadExpenseVoucher(
  session: Pick<SessionPayload, "username" | "role">,
  _expense?: { createdBy: string | null },
): boolean {
  return session.role !== "reception" && canViewMoney(session.role);
}
