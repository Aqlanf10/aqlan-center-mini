import "server-only";
import type { DbClient } from "./db";
import { sessionCredentialVersion } from "./auth";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";
import { inspectStaffRuntimeSchema } from "./staff-runtime-probe.mjs";
import { revalidateVerifiedDurableSession, type VerifiedDurableSession } from "./staff-durable-session";
import { parseStaffCapabilityDocument } from "./staff-permission-envelope";
import { hasStaffCapability, ownerContextFromTrustedBinding, resolveStaffCapabilities, staffAuthorizationFingerprint } from "./staff-capabilities";
import type { StaffRuntimeAction } from "./staff-operation-runtime";
function refuse(reason: string): never { throw new Error(`STAFF_OPERATION_${reason}`); }
/** Internal common authority evidence, NOT operation admission. Only the owning
 * runtimes establish transaction/fence lifetime and private handles. No callbacks,
 * arbitrary SQL or caller-selectable locking mode are exported. */
async function loadAuthority(client: Pick<DbClient, "query">, session: VerifiedDurableSession, action: StaffRuntimeAction, schema: string, rowLock: " FOR SHARE" | "") {
 const claims = revalidateVerifiedDurableSession(session);
 if (!claims) refuse("SESSION_OR_ACTION_INVALID");
 const d = claims.durableIdentity, s = staffIdentitySchemaName(schema);
 await inspectStaffRuntimeSchema(client, s);
 const {rows:controls}=await client.query<{state:string;realm_id:string;owner_user_id:number;binding_epoch:string}>(`SELECT state,realm_id,owner_user_id,binding_epoch::text FROM ${s}.staff_authority_control WHERE singleton${rowLock}`);
 const c=controls[0];
 if(controls.length!==1 || c.state!=="active" || c.realm_id!==d.realmId || c.binding_epoch!==d.controlEpoch)refuse("CONTROL_STALE");
 const {rows:states}=await client.query<{status:string;realm_id:string;generation_id:string;registry_revision:string;ready_owner_subject_id:string;ready_control_epoch:string}>(`SELECT status,realm_id::text,generation_id::text,registry_revision::text,ready_owner_subject_id::text,ready_control_epoch::text FROM ${s}.staff_identity_state WHERE singleton${rowLock}`);
 const h=states[0];
 if(states.length!==1 || h.status!=="ready" || h.realm_id!==d.realmId || h.generation_id!==d.generationId || h.registry_revision!==d.registryRevision || h.ready_control_epoch!==c.binding_epoch)refuse("IDENTITY_NOT_READY");
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
 const {rows:users}=await client.query<{id:number;username:string;role:string;is_active:boolean;authorization_mode:string;authorization_epoch:string;password_hash:string;permissions:unknown;party_id:number|null}>(`SELECT id,username,role,is_active,authorization_mode,authorization_epoch::text,password_hash,permissions,party_id FROM ${s}.users WHERE id=ANY($1::integer[]) ORDER BY id${rowLock}`,[[c.owner_user_id,claims.userId]]);
 const owner=users.find(u=>u.id===c.owner_user_id),user=users.find(u=>u.id===claims.userId);
 if(!owner || !owner.is_active || owner.role!=="admin" || owner.authorization_mode!=="canonical" || !user || !user.is_active || user.authorization_mode!=="canonical")refuse("ACCOUNT_INVALID");
 const {rows:bindings}=await client.query<{user_id:number;subject_id:string}>(`SELECT user_id,subject_id::text FROM ${s}.staff_identity_current WHERE user_id=ANY($1::integer[]) ORDER BY user_id${rowLock}`,[[c.owner_user_id,claims.userId]]);
 if(bindings.find(b=>b.user_id===c.owner_user_id)?.subject_id!==h.ready_owner_subject_id || bindings.find(b=>b.user_id===claims.userId)?.subject_id!==d.subjectId)refuse("SUBJECT_STALE");
 if(user.username!==claims.username)refuse("USERNAME_STALE");
 if(user.authorization_epoch!==d.accountEpoch || typeof user.password_hash!=="string" || sessionCredentialVersion(user.password_hash)!==d.credentialVersion)refuse("CREDENTIAL_OR_ACCOUNT_STALE");
 let partyId:number|null=null;
 if(user.party_id!==null){
  const {rows}=await client.query<{id:number;kind:string;is_active:boolean;clinical_authority_epoch:string}>(`SELECT id,kind,is_active,clinical_authority_epoch::text FROM ${s}.parties WHERE id=$1${rowLock}`,[user.party_id]);
  const p=rows[0];
  if(rows.length!==1 || p.kind!=="doctor" || !p.is_active || !d.provider || d.provider.partyId!==p.id || d.provider.clinicalEpoch!==p.clinical_authority_epoch)refuse("PROVIDER_STALE");
  partyId=p.id;
 }else if(d.provider!==null)refuse("PROVIDER_STALE");
 const parsed=parseStaffCapabilityDocument(user.permissions);
 if(!parsed.ok || parsed.value.revision!==d.permissionRevision)refuse("PERMISSIONS_STALE");
 const ownerContext=ownerContextFromTrustedBinding({ownerUserId:c.owner_user_id,bindingVersion:`${h.ready_owner_subject_id}:${c.binding_epoch}`});
 const access=resolveStaffCapabilities({subject:{userId:user.id,role:user.role,isActive:user.is_active,clinicianPartyId:partyId},permissionDocument:parsed.value},ownerContext);
 if(!hasStaffCapability(access,action))refuse("CAPABILITY_DENIED");
 const fingerprint=staffAuthorizationFingerprint(access);
 if(!fingerprint || !revalidateVerifiedDurableSession(session))refuse("SESSION_EXPIRED");
 return {fingerprint,access,identity:Object.freeze({realmId:d.realmId,subjectId:d.subjectId,generationId:d.generationId,userId:user.id,username:user.username,role:user.role})};
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
