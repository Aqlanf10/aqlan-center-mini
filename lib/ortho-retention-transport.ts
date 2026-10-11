import { readRetentionResponseJSON } from "./ortho-retention-client";
import type { RetentionOwner } from "./ortho-retention-owner";
import { journeyId } from "./ortho-case-journey-records";
type RequestLease = NonNullable<ReturnType<RetentionOwner["beginRetry"]>>;
export function hasRetentionNoStore(response: Response): boolean {
  const value = response.headers.get("cache-control") ?? "";
  // This endpoint emits unquoted private,no-store. Refuse quoted extensions
  // rather than mistaking a comma inside their value for a directive boundary.
  return !/["\\]/.test(value) && value.split(",").some(directive => directive.trim().toLowerCase() === "no-store");
}
export type RetentionTransportOutcome = "confirmed" | "refused" | "uncertain" | "denied" | "retired";
/** The owner captured the immutable body before this function. Temporary view
 * detachment does not cancel ownership of the result; only its UI callback. */
export async function sendRetentionCommand(lease: RequestLease): Promise<RetentionTransportOutcome> {
  const orthoCaseId = lease.orthoCaseId, controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    if (!journeyId(orthoCaseId) || !lease.current()) return "retired";
    timer = setTimeout(() => controller.abort(), 20_000);
    const response = await fetch(`/api/ortho/${orthoCaseId}/retention-events`, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "content-type": "application/json" }, body: lease.body, signal: controller.signal });
    if (!lease.checkHeaders(response)) return response.status === 401 || response.status === 403 ? "denied" : "retired";
    if (!hasRetentionNoStore(response)) throw new Error("retention_result_not_private");
    const raw = await readRetentionResponseJSON(response);
    if (!lease.current()) return "retired";
    if (!response.ok) {
      const refusal = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      if (refusal?.ok === false && typeof refusal.code === "string" && /^[a-z0-9_]{1,100}$/.test(refusal.code) && [400, 404, 409, 413].includes(response.status)) {
        lease.refuse(response.status); return "refused";
      }
      throw new Error("retention_result_unknown");
    }
    const confirmed = await lease.confirmResponse(raw, response.status);
    return confirmed && lease.current() ? "confirmed" : "retired";
  } catch { lease.markUncertain(); return "uncertain"; }
  finally { if (timer !== null) clearTimeout(timer); lease.finish(); }
}
