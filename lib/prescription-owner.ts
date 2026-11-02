import { staffAuthorizationFingerprint } from "./staff-capabilities";
import { loadCanonicalOwnerAuthority } from "./staff-owner-authority";

/** Opaque canonical authority must match the freshly loaded actor AND provider.
 * Relinking the account cannot carry an old owner-clinician proof forward. */
export async function getPrescriptionOwnerAuthority(user: {
  id: number; username: string; role: string; isActive: boolean; partyId: number | null;
}): Promise<{ bindingVersion: string; fingerprint: string } | null> {
  if (!user.isActive || user.role !== "admin" || !Number.isSafeInteger(user.partyId) || user.partyId! <= 0) return null;
  const proof = await loadCanonicalOwnerAuthority(user.id);
  if (!proof || !proof.bindingVersion || proof.access.status !== "allowed" || !proof.access.isOwner
    || proof.access.userId !== user.id || proof.access.clinicianPartyId !== user.partyId) return null;
  // Serialized/fabricated access cannot pass the shared WeakMap-backed contract.
  const fingerprint = staffAuthorizationFingerprint(proof.access);
  return fingerprint ? { bindingVersion: proof.bindingVersion, fingerprint } : null;
}
