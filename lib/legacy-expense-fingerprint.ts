import { parseExpenseRequest, type ParsedExpenseRequest } from "./expense-request";
import { expenseRequestHash } from "./expense-request-hash";
import type { RateMap } from "./supplier-payments";

/**
 * The legacy expense route's request fingerprint (0128), shared by the create and the 0133 retirement so a
 * retirement always binds to exactly the request it fences. A legacy session pays from the drawer only.
 */
export function legacyExpenseFingerprint(username: string, admin: boolean, source: Record<string, unknown>, rates: RateMap):
  { ok: true; request: ParsedExpenseRequest; hash: string } | { ok: false; status: number; message: string } {
  const parsed = parseExpenseRequest(source, rates, admin);
  if (!parsed.ok) return { ok: false, status: parsed.status, message: parsed.message };
  const request = parsed.value;
  const hash = expenseRequestHash(username, request,
    { source: "drawer", drawerMinor: request.amountMinor, ownerPrivateMinor: 0, ownerPrivateReason: null });
  return { ok: true, request, hash };
}
