import type { SessionPayload } from "./auth";
import type { DbClient } from "./db";
import type { ResolvedStaffAccess } from "./staff-capabilities";

/**
 * Independent owner-authority gate for patient file numbering settings.
 *
 * Remains closed (`null`) in runtime builds until an out-of-band owner-proof
 * authority, independent monotonic watermark ledger, and recovery cutover
 * fencing are operationally provisioned and explicitly approved.
 */
export async function loadPatientNumberingOwnerAccess(
  _session: SessionPayload,
  _client?: DbClient,
): Promise<ResolvedStaffAccess | null> {
  return null;
}
