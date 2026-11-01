import type { SessionPayload } from "./auth";
import type { DbClient } from "./db";

/** Integration boundary only, not a new owner identity or a granting provider.
 * The caller owns this transaction and has freshly revalidated the actor after
 * any receipt wait. A legacy SessionPayload is NOT canonical owner proof.
 * Activation requires WORK's VerifiedDurableSession, registered exact Rx action,
 * lifecycle fence and client/XID-bound handle with final authority revalidation.
 * Never fill this boundary from an admin role, preview, environment or settings.
 */
export interface PrescriptionOwnerTransactionRequest {
  readonly client: DbClient;
  readonly session: SessionPayload;
  readonly actor: Readonly<{ id: number; username: string; role: string; isActive: boolean; partyId: number | null }>;
  readonly prescribingDoctorPartyId: number;
}

/** There is deliberately no success variant, provider setter or proof factory.
 * Canonical owner runtime/session/restore integration is not installed in this
 * release. Issuance, replay and recovery must all keep this refusal in force.
 */
export async function admitPrescriptionOwnerInTransaction(_request: PrescriptionOwnerTransactionRequest) {
  return Object.freeze({
    status: "unavailable" as const,
    code: "canonical_prescription_owner_unavailable" as const,
    message: "الإصدار باسم طبيب آخر غير مفعّل؛ يلزم ربط سلطة المالك المحمية بنظام الصلاحيات. يمكنك الإصدار باسمك الطبي المرتبط فقط.",
  });
}
