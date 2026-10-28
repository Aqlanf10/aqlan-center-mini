import "server-only";
import type { DbClient } from "./db";
import { sessionCredentialVersion } from "./auth";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";
import { inspectStaffRuntimeSchema } from "./staff-runtime-probe.mjs";
import { revalidateVerifiedDurableSession, type DurableSessionClaims, type VerifiedDurableSession } from "./staff-durable-session";
import { parseStaffCapabilityDocument } from "./staff-permission-envelope";
import { hasStaffCapability, ownerContextFromTrustedBinding, resolveStaffCapabilities, staffAuthorizationFingerprint, type ResolvedStaffAccess } from "./staff-capabilities";
import type { StaffCapability, StaffCapabilityDocument } from "./staff-capability-catalogue";
import type { StaffRuntimeAction } from "./staff-operation-runtime";
function refuse(reason: string): never { throw new Error(`STAFF_OPERATION_${reason}`); }
type RowLock = " FOR SHARE" | "";
/** Current authority tuple proved for one account. Internal evidence only: never
 * serialized, returned to a browser or accepted back from a caller. */
export interface ProvedAccountAuthority {
 readonly realmId: string;
 readonly generationId: string;
 readonly registryRevision: string;
 readonly controlEpoch: string;
 readonly ownerUserId: number;
 readonly readyOwnerSubjectId: string;
 readonly subjectId: string;
 readonly user: Readonly<{ id: number; username: string; displayName: string | null; role: string; authorizationEpoch: string; passwordHash: string }>;
 readonly provider: Readonly<{ partyId: number; clinicalEpoch: string }> | null;
 readonly document: StaffCapabilityDocument;
 readonly access: ResolvedStaffAccess;
}
/** Internal common authority evidence, NOT operation admission. Only the owning
 * runtimes (operation runtime, directory reader, durable issuer, session admission)
 * establish transaction/fence lifetime. No callbacks, arbitrary SQL or
 * caller-selectable locking mode are exported. The user ID is a locator; nothing
 * about the account is trusted until every anchor below is proved from current rows. */
async function proveAccount(client: Pick<DbClient, "query">, userId: number, schema: string, rowLock: RowLock): Promise<ProvedAccountAuthority> {
 if (!Number.isSafeInteger(userId) || userId <= 0) refuse("ACCOUNT_INVALID");
 const s = staffIdentitySchemaName(schema);
 await inspectStaffRuntimeSchema(client, s);
 const {rows:controls}=await client.query<{state:string;realm_id:string;owner_user_id:number;binding_epoch:string}>(`SELECT state,realm_id,owner_user_id,binding_epoch::text FROM ${s}.staff_authority_control WHERE singleton${rowLock}`);
 const c=controls[0];
 if(controls.length!==1 || c.state!=="active" || !Number.isSafeInteger(c.owner_user_id))refuse("CONTROL_STALE");
 const {rows:states}=await client.query<{status:string;realm_id:string;generation_id:string;registry_revision:string;ready_owner_subject_id:string;ready_control_epoch:string}>(`SELECT status,realm_id::text,generation_id::text,registry_revision::text,ready_owner_subject_id::text,ready_control_epoch::text FROM ${s}.staff_identity_state WHERE singleton${rowLock}`);
 const h=states[0];
 if(states.length!==1 || h.status!=="ready" || h.realm_id!==c.realm_id || h.ready_control_epoch!==c.binding_epoch)refuse("IDENTITY_NOT_READY");
 const {rows:[integrity]}=await client.query<{valid:boolean}>(`WITH RECURSIVE chain AS (
 SELECT generation_id,previous_generation_id FROM ${s}.staff_identity_generations WHERE generation_id=$1
 UNION SELECT g.generation_id,g.previous_generation_id FROM ${s}.staff_identity_generations g JOIN chain c ON g.generation_id=c.previous_generation_id
 ) SELECT
 (SELECT count(*) FROM chain)=(SELECT count(*) FROM ${s}.staff_identity_generations) AND
 $3::bigint=(SELECT count(*) FROM ${s}.staff_identity_generations)+(SELECT count(*) FROM ${s}.staff_identity_binding_events) AND
 NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_generations WHERE realm_id<>$2::uuid) AND
 NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_subjects WHERE realm_id<>$2::uuid OR created_registry_revision>$3::bigint) AND
 NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_binding_events WHERE registry_revision>$3::bigint) AND
 NOT EXISTS(SELECT 1 FROM (SELECT previous_subject_id,lag(new_subject_id) OVER(PARTITION BY user_id ORDER BY registry_revision) AS prior FROM ${s}.staff_identity_binding_events) e WHERE previous_subject_id IS DISTINCT FROM prior) AND
 NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_subjects p LEFT JOIN ${s}.staff_identity_binding_events e ON e.registry_revision=p.created_registry_revision WHERE e.new_subject_id IS DISTINCT FROM p.subject_id OR e.user_id IS DISTINCT FROM p.user_id_at_binding OR e.generation_id IS DISTINCT FROM p.created_generation_id) AND
 NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_binding_events e LEFT JOIN ${s}.staff_identity_current b ON b.user_id=e.user_id WHERE NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_binding_events later WHERE later.user_id=e.user_id AND later.registry_revision>e.registry_revision) AND ((e.new_subject_id IS NULL AND b.user_id IS NOT NULL) OR (e.new_subject_id IS NOT NULL AND (b.subject_id IS DISTINCT FROM e.new_subject_id OR b.bound_registry_revision IS DISTINCT FROM e.registry_revision)))) AND
 NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_current b LEFT JOIN ${s}.staff_identity_subjects p ON p.subject_id=b.subject_id LEFT JOIN ${s}.staff_identity_binding_events e ON e.registry_revision=b.bound_registry_revision WHERE p.user_id_at_binding IS DISTINCT FROM b.user_id OR p.realm_id IS DISTINCT FROM $2::uuid OR e.new_subject_id IS DISTINCT FROM b.subject_id OR e.user_id IS DISTINCT FROM b.user_id OR EXISTS(SELECT 1 FROM ${s}.staff_identity_binding_events later WHERE later.user_id=b.user_id AND later.registry_revision>e.registry_revision)) AS valid`,[h.generation_id,h.realm_id,h.registry_revision]);
 if(integrity?.valid!==true)refuse("HISTORY_INVALID");
 const {rows:users}=await client.query<{id:number;username:string;display_name:unknown;role:string;is_active:boolean;authorization_mode:string;authorization_epoch:string;password_hash:string;permissions:unknown;party_id:number|null}>(`SELECT id,username,display_name,role,is_active,authorization_mode,authorization_epoch::text,password_hash,permissions,party_id FROM ${s}.users WHERE id=ANY($1::integer[]) ORDER BY id${rowLock}`,[[c.owner_user_id,userId]]);
 const owner=users.find(u=>u.id===c.owner_user_id),user=users.find(u=>u.id===userId);
 if(!owner || !owner.is_active || owner.role!=="admin" || owner.authorization_mode!=="canonical" || !user || !user.is_active || user.authorization_mode!=="canonical")refuse("ACCOUNT_INVALID");
 if(typeof user.username!=="string" || user.username.length<1 || user.username.length>200 || typeof user.password_hash!=="string" || !user.password_hash)refuse("ACCOUNT_INVALID");
 const {rows:bindings}=await client.query<{user_id:number;subject_id:string}>(`SELECT user_id,subject_id::text FROM ${s}.staff_identity_current WHERE user_id=ANY($1::integer[]) ORDER BY user_id${rowLock}`,[[c.owner_user_id,userId]]);
 const subjectId=bindings.find(b=>b.user_id===userId)?.subject_id;
 if(bindings.find(b=>b.user_id===c.owner_user_id)?.subject_id!==h.ready_owner_subject_id || typeof subjectId!=="string")refuse("SUBJECT_STALE");
 let provider:ProvedAccountAuthority["provider"]=null;
 if(user.party_id!==null){
  const {rows}=await client.query<{id:number;kind:string;is_active:boolean;clinical_authority_epoch:string}>(`SELECT id,kind,is_active,clinical_authority_epoch::text FROM ${s}.parties WHERE id=$1${rowLock}`,[user.party_id]);
  const p=rows[0];
  if(rows.length!==1 || p.kind!=="doctor" || !p.is_active)refuse("PROVIDER_STALE");
  provider=Object.freeze({partyId:p.id,clinicalEpoch:p.clinical_authority_epoch});
 }
 const parsed=parseStaffCapabilityDocument(user.permissions);
 if(!parsed.ok)refuse("PERMISSIONS_STALE");
 const ownerContext=ownerContextFromTrustedBinding({ownerUserId:c.owner_user_id,bindingVersion:`${h.ready_owner_subject_id}:${c.binding_epoch}`});
 const access=resolveStaffCapabilities({subject:{userId:user.id,role:user.role,isActive:user.is_active,clinicianPartyId:provider?.partyId ?? null},permissionDocument:parsed.value},ownerContext);
 if(access.status!=="allowed")refuse("ACCOUNT_INVALID");
 const displayName=typeof user.display_name==="string" && user.display_name.length<=200 ? user.display_name : null;
 return Object.freeze({realmId:h.realm_id,generationId:h.generation_id,registryRevision:h.registry_revision,controlEpoch:c.binding_epoch,ownerUserId:c.owner_user_id,readyOwnerSubjectId:h.ready_owner_subject_id,subjectId,
  user:Object.freeze({id:user.id,username:user.username,displayName,role:user.role,authorizationEpoch:user.authorization_epoch,passwordHash:user.password_hash}),
  provider,document:parsed.value,access});
}
/** Every signed anchor must equal the freshly proved tuple; any drift denies. */
function assertClaimsCurrent(proof: ProvedAccountAuthority, claims: Readonly<DurableSessionClaims>): void {
 const d = claims.durableIdentity;
 if(proof.realmId!==d.realmId || proof.controlEpoch!==d.controlEpoch)refuse("CONTROL_STALE");
 if(proof.generationId!==d.generationId || proof.registryRevision!==d.registryRevision)refuse("IDENTITY_NOT_READY");
 if(proof.subjectId!==d.subjectId)refuse("SUBJECT_STALE");
 if(proof.user.username!==claims.username)refuse("USERNAME_STALE");
 if(proof.user.authorizationEpoch!==d.accountEpoch || sessionCredentialVersion(proof.user.passwordHash)!==d.credentialVersion)refuse("CREDENTIAL_OR_ACCOUNT_STALE");
 if(proof.provider===null ? d.provider!==null : (!d.provider || d.provider.partyId!==proof.provider.partyId || d.provider.clinicalEpoch!==proof.provider.clinicalEpoch))refuse("PROVIDER_STALE");
 if(proof.document.revision!==d.permissionRevision)refuse("PERMISSIONS_STALE");
}
async function proveSession(client: Pick<DbClient, "query">, session: VerifiedDurableSession, schema: string, rowLock: RowLock): Promise<ProvedAccountAuthority> {
 const claims = revalidateVerifiedDurableSession(session);
 if (!claims) refuse("SESSION_OR_ACTION_INVALID");
 const proof = await proveAccount(client, claims.userId, schema, rowLock);
 assertClaimsCurrent(proof, claims);
 return proof;
}
async function loadAuthority(client: Pick<DbClient, "query">, session: VerifiedDurableSession, action: StaffRuntimeAction, schema: string, rowLock: RowLock) {
 const proof = await proveSession(client, session, schema, rowLock);
 if(!hasStaffCapability(proof.access,action))refuse("CAPABILITY_DENIED");
 const fingerprint=staffAuthorizationFingerprint(proof.access);
 if(!fingerprint || !revalidateVerifiedDurableSession(session))refuse("SESSION_EXPIRED");
 return {fingerprint,access:proof.access,identity:Object.freeze({realmId:proof.realmId,subjectId:proof.subjectId,generationId:proof.generationId,userId:proof.user.id,username:proof.user.username,role:proof.user.role})};
}
/** Writer evidence only; owning writer must hold its lifecycle fence and XID. */
export async function loadLockedStaffAuthority(client: DbClient, session: VerifiedDurableSession, action: StaffRuntimeAction, schema: string) {
 return loadAuthority(client, session, action, schema, " FOR SHARE");
}
/** Snapshot evidence only; no reusable admission capability is returned. The
 * directory owner must already hold its pre-BEGIN session fence and RR identity. */
export async function loadStaffDirectorySnapshotAuthority(client: Pick<DbClient, "query">, session: VerifiedDurableSession) {
 return loadAuthority(client, session, "staff.view", "public", "");
}
/** Snapshot evidence for the generic owning RR reader (`lib/canonical-read-snapshot.ts`)
 * only: the same predicates, no row locks, an exact registered read action. */
export async function loadCanonicalSnapshotAuthority(client: Pick<DbClient, "query">, session: VerifiedDurableSession, action: StaffRuntimeAction) {
 return loadAuthority(client, session, action, "public", "");
}
/** Recorded-approver evidence for a writer that already holds the shared lifecycle
 * fence (for example a waste approval consumed later): does `userId` CURRENTLY prove
 * as an active canonical account holding `capability`? Target-specific drift answers
 * false (the record no longer carries authority); realm/control drift still refuses. */
export async function lockedAccountHoldsCapability(client: DbClient, userId: number, capability: StaffCapability, schema: string): Promise<boolean> {
 try {
  const proof = await proveAccount(client, userId, schema, " FOR SHARE");
  return hasStaffCapability(proof.access, capability);
 } catch (error) {
  if (error instanceof Error && /^STAFF_OPERATION_(ACCOUNT_INVALID|SUBJECT_STALE|PROVIDER_STALE|PERMISSIONS_STALE)$/.test(error.message)) return false;
  throw error;
 }
}
/** Issuer evidence only: the private durable issuer holds the shared lifecycle
 * fence and its own READ COMMITTED XID. It proves the password-selected account's
 * CURRENT tuple; the issuer compares its captured candidate before deriving
 * claims. Entry needs no capability: each later operation proves its own. */
export async function loadLockedIssuanceAuthority(client: DbClient, userId: number, schema: string): Promise<ProvedAccountAuthority> {
 return proveAccount(client, userId, schema, " FOR SHARE");
}
/** Session admission without an operation action, for the session admission owner
 * only (auth/me and shell projection). Same comparisons as operation admission,
 * minus the capability gate; the projection is display, never a grant. */
export async function loadLockedSessionAuthority(client: DbClient, session: VerifiedDurableSession, schema: string): Promise<ProvedAccountAuthority> {
 const proof = await proveSession(client, session, schema, " FOR SHARE");
 if(!revalidateVerifiedDurableSession(session))refuse("SESSION_EXPIRED");
 return proof;
}
/** Writer evidence for a transaction that already holds the EXCLUSIVE lifecycle
 * fence (authority writers). Row locks are FOR UPDATE-free shares: the exclusive
 * fence already excludes every other authority writer and admitted reader. */
export async function loadExclusiveWriterAuthority(client: DbClient, session: VerifiedDurableSession, action: StaffRuntimeAction, schema: string) {
 const proof = await proveSession(client, session, schema, " FOR SHARE");
 if(!hasStaffCapability(proof.access,action))refuse("CAPABILITY_DENIED");
 if(!revalidateVerifiedDurableSession(session))refuse("SESSION_EXPIRED");
 return proof;
}
