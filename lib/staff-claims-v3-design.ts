import { STAFF_AUTHORIZATION_POLICY_VERSION } from "./staff-capability-catalogue";
import type { StaffCapabilityDocument } from "./staff-capability-catalogue";

/**
 * B2 design model (review 6507696166 item 3; CANONICAL_ACCOUNT_WRITES.md §3 and
 * B2_PER_ACCOUNT_BINDING.md). ISOLATED: no runtime module imports this file; it pins the
 * reviewed rules as pure functions with unit tests until M4 registers the schema.
 *
 * - Claims v3 keep every v2 anchor (realm, subject, generation, control epoch, account
 *   epoch, credential, permission revision, provider) and replace the GLOBAL registry
 *   revision by the account's own `bound_registry_revision`: binding another account no
 *   longer moves any existing session, while a rebinding of this account still does.
 * - A new account in a ready identity starts `pending`, with no grant and scope `none`,
 *   until the owner confirms it through the editor.
 * - Disable/enable never retires the binding (the account epoch revokes sessions).
 * - v2 is refused only inside the coordinated transition, which has a proven rollback.
 */
export interface DurableIdentityClaimsV3 {
 readonly schemaVersion: 3;
 readonly policyVersion: typeof STAFF_AUTHORIZATION_POLICY_VERSION;
 readonly realmId: string;
 readonly subjectId: string;
 readonly generationId: string;
 readonly boundRegistryRevision: string;
 readonly controlEpoch: string;
 readonly accountEpoch: string;
 readonly permissionRevision: number;
 readonly credentialVersion: string;
 readonly provider: Readonly<{ partyId: number; clinicalEpoch: string }> | null;
}
/** The freshly proved current tuple of one account (all from locked rows). */
export interface AccountBindingProof {
 readonly realmId: string;
 readonly controlEpoch: string;
 readonly generationId: string;
 /** Global registry revision: proved for history integrity, never compared to a v3 claim. */
 readonly registryRevision: string;
 readonly subjectId: string;
 readonly boundRegistryRevision: string;
 readonly accountEpoch: string;
 readonly credentialVersion: string;
 readonly permissionRevision: number;
 readonly provider: Readonly<{ partyId: number; clinicalEpoch: string }> | null;
}
export type ClaimsDrift = "CONTROL_STALE" | "IDENTITY_NOT_READY" | "SUBJECT_STALE" | "BINDING_STALE" | "CREDENTIAL_OR_ACCOUNT_STALE" | "PROVIDER_STALE" | "PERMISSIONS_STALE";

/** Every v3 anchor must equal the proved tuple; the global registry revision is not an anchor. */
export function claimsV3Drift(proof: AccountBindingProof, d: DurableIdentityClaimsV3): ClaimsDrift | null {
 if (d.schemaVersion !== 3 || d.policyVersion !== STAFF_AUTHORIZATION_POLICY_VERSION) return "IDENTITY_NOT_READY";
 if (proof.realmId !== d.realmId || proof.controlEpoch !== d.controlEpoch) return "CONTROL_STALE";
 if (proof.generationId !== d.generationId) return "IDENTITY_NOT_READY";
 if (proof.subjectId !== d.subjectId) return "SUBJECT_STALE";
 if (proof.boundRegistryRevision !== d.boundRegistryRevision) return "BINDING_STALE";
 if (proof.accountEpoch !== d.accountEpoch || proof.credentialVersion !== d.credentialVersion) return "CREDENTIAL_OR_ACCOUNT_STALE";
 if (proof.provider === null ? d.provider !== null : (!d.provider || d.provider.partyId !== proof.provider.partyId || d.provider.clinicalEpoch !== proof.provider.clinicalEpoch)) return "PROVIDER_STALE";
 if (proof.permissionRevision !== d.permissionRevision) return "PERMISSIONS_STALE";
 return null;
}

/** The only document a ready-state account creation may write. */
export function initialReadyStateDocument(): StaffCapabilityDocument {
 return { schemaVersion: 2, revision: 1, confirmation: "pending", patientScope: "none", appointmentScope: "none", grants: {} };
}

export type AccountLifecycleChange = "create" | "disable" | "enable" | "rebind";
/** Which identity effects a ready-state account change has. Only creation and an explicit
 * rebinding (a reviewed recovery of the same person's account) append a binding event. */
export function readyStateIdentityEffect(change: AccountLifecycleChange): Readonly<{ appendsBinding: boolean; retiresBinding: boolean; incrementsAccountEpoch: boolean }> {
 switch (change) {
  case "create": return Object.freeze({ appendsBinding: true, retiresBinding: false, incrementsAccountEpoch: false });
  case "rebind": return Object.freeze({ appendsBinding: true, retiresBinding: false, incrementsAccountEpoch: true });
  case "disable":
  case "enable": return Object.freeze({ appendsBinding: false, retiresBinding: false, incrementsAccountEpoch: true });
 }
}

/**
 * Coordinated claims transition. `issue` is the version minted at login; `accept` the
 * versions admitted. v2 is refused only in `v3-only`, which is entered after every
 * instance runs `dual`; the rollback steps back one phase at a time and never strands a
 * session that the earlier phase issued.
 */
export type ClaimsPhase = "v2-only" | "dual" | "v3-only";
export const CLAIMS_PHASES: Readonly<Record<ClaimsPhase, Readonly<{ issue: 2 | 3; accept: readonly (2 | 3)[] }>>> = Object.freeze({
 "v2-only": Object.freeze({ issue: 2, accept: Object.freeze([2] as const) }),
 dual: Object.freeze({ issue: 3, accept: Object.freeze([2, 3] as const) }),
 "v3-only": Object.freeze({ issue: 3, accept: Object.freeze([3] as const) }),
});
const ORDER: readonly ClaimsPhase[] = ["v2-only", "dual", "v3-only"];
export function claimsTransitionAllowed(from: ClaimsPhase, to: ClaimsPhase): boolean {
 return Math.abs(ORDER.indexOf(from) - ORDER.indexOf(to)) === 1;
}
/** Sessions issued under `from` that `to` would refuse (they re-login; never silently accepted). */
export function strandedByTransition(from: ClaimsPhase, to: ClaimsPhase): readonly (2 | 3)[] {
 const issuedUnderFromOrEarlier = new Set<2 | 3>(CLAIMS_PHASES[from].accept);
 return [...issuedUnderFromOrEarlier].filter(version => !CLAIMS_PHASES[to].accept.includes(version));
}
