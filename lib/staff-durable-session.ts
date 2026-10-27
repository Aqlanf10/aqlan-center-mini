import "server-only";
import { readSignedSessionEnvelope } from "./auth";
import { isPlainCapabilityRecord } from "./staff-permission-envelope";
import { STAFF_AUTHORIZATION_POLICY_VERSION } from "./staff-capability-catalogue";

export interface DurableIdentityClaims {
 readonly schemaVersion: 2;
 readonly policyVersion: typeof STAFF_AUTHORIZATION_POLICY_VERSION;
 readonly realmId: string;
 readonly subjectId: string;
 readonly generationId: string;
 readonly registryRevision: string;
 readonly controlEpoch: string;
 readonly accountEpoch: string;
 readonly permissionRevision: number;
 readonly credentialVersion: string;
 readonly provider: Readonly<{ partyId: number; clinicalEpoch: string }> | null;
}
export interface DurableSessionClaims {
 readonly userId: number;
 readonly username: string;
 readonly expiresAt: number;
 readonly durableIdentity: Readonly<DurableIdentityClaims>;
}
declare const verifiedBrand: unique symbol;
export interface VerifiedDurableSession { readonly [verifiedBrand]: true }
const verified = new WeakMap<VerifiedDurableSession, string>();
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const epoch = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) < 9223372036854775807n;
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join(",") === [...keys].sort().join(",");
function parse(token: string): Readonly<DurableSessionClaims> | null {
 const p = readSignedSessionEnvelope(token);
 if (!isPlainCapabilityRecord(p) || !exact(p,["userId","username","expiresAt","durableIdentity"])) return null;
 if (!id(p.userId) || typeof p.username !== "string" || p.username.length < 1 || p.username.length > 200 || typeof p.expiresAt !== "number" || !Number.isFinite(p.expiresAt) || p.expiresAt <= Date.now()) return null;
 const d = p.durableIdentity;
 if (!isPlainCapabilityRecord(d) || !exact(d,["schemaVersion","policyVersion","realmId","subjectId","generationId","registryRevision","controlEpoch","accountEpoch","permissionRevision","credentialVersion","provider"])) return null;
 if (d.schemaVersion !== 2 || d.policyVersion !== STAFF_AUTHORIZATION_POLICY_VERSION || !uuid(d.realmId) || !uuid(d.subjectId) || !uuid(d.generationId) || !epoch(d.registryRevision) || !epoch(d.controlEpoch) || !epoch(d.accountEpoch) || !id(d.permissionRevision) || typeof d.credentialVersion !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(d.credentialVersion)) return null;
 let provider: DurableIdentityClaims["provider"] = null;
 if (d.provider !== null) {
  if (!isPlainCapabilityRecord(d.provider) || !exact(d.provider,["partyId","clinicalEpoch"]) || !id(d.provider.partyId) || !epoch(d.provider.clinicalEpoch)) return null;
  provider = Object.freeze({partyId:d.provider.partyId,clinicalEpoch:d.provider.clinicalEpoch});
 }
 return Object.freeze({userId:p.userId,username:p.username,expiresAt:p.expiresAt,durableIdentity:Object.freeze({schemaVersion:2,policyVersion:STAFF_AUTHORIZATION_POLICY_VERSION,realmId:d.realmId,subjectId:d.subjectId,generationId:d.generationId,registryRevision:d.registryRevision,controlEpoch:d.controlEpoch,accountEpoch:d.accountEpoch,permissionRevision:d.permissionRevision,credentialVersion:d.credentialVersion,provider})});
}
/** Verifies signed claims only. Database identity/readiness is still unproven. */
export function readVerifiedDurableSession(token: string | undefined): VerifiedDurableSession | null {
 if (typeof token !== "string" || !parse(token)) return null;
 const handle = Object.freeze({}) as VerifiedDurableSession;
 verified.set(handle,token);
 return handle;
}
/** Freshly reverify the private original token, including expiration. This
 * projection is NOT operation admission and never accepts caller claims. */
export function revalidateVerifiedDurableSession(handle: VerifiedDurableSession): Readonly<DurableSessionClaims> | null {
 const token = verified.get(handle);
 return token ? parse(token) : null;
}
