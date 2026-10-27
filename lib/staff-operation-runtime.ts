import "server-only";
import type { DbClient, DbPool } from "./db";
import { withIsolation } from "./transactions";
import { sessionCredentialVersion } from "./auth";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";
import { inspectStaffRuntimeSchema } from "./staff-runtime-probe.mjs";
import { revalidateVerifiedDurableSession, type VerifiedDurableSession } from "./staff-durable-session";
import { parseStaffCapabilityDocument } from "./staff-permission-envelope";
import { hasStaffCapability, ownerContextFromTrustedBinding, resolveStaffCapabilities, staffAuthorizationFingerprint } from "./staff-capabilities";

export type StaffRuntimeAction = "staff.view" | "staff.permissions.edit" | "inventory.references.view" | "inventory.items.create";
const actions = new Set<string>(["staff.view","staff.permissions.edit","inventory.references.view","inventory.items.create"]);
declare const operationBrand: unique symbol;
export interface StaffOperationHandle { readonly [operationBrand]: true }
interface OperationState {
 client: DbClient; xid: string; action: StaffRuntimeAction; session: VerifiedDurableSession;
 schema: string; fingerprint: string;
}
const operations = new WeakMap<StaffOperationHandle, OperationState>();
function refuse(reason: string): never { throw new Error(`STAFF_OPERATION_${reason}`); }
async function xid(client: DbClient): Promise<string> {
 await client.query("SAVEPOINT staff_runtime_transaction_check");
 await client.query("RELEASE SAVEPOINT staff_runtime_transaction_check");
 const {rows} = await client.query<{xid:string;isolation:string}>("SELECT pg_current_xact_id()::text AS xid,current_setting('transaction_isolation') AS isolation");
 if(rows.length!==1 || rows[0].isolation!=="read committed")refuse("TRANSACTION_REQUIRED");
 return rows[0].xid;
}
async function load(client: DbClient, session: VerifiedDurableSession, action: StaffRuntimeAction, schema:string) {
 const claims=revalidateVerifiedDurableSession(session);
 if(!claims || !actions.has(action))refuse("SESSION_OR_ACTION_INVALID");
 const d=claims.durableIdentity,s=staffIdentitySchemaName(schema),transactionId=await xid(client);
 // Shared runtime fence, same key as exclusive phase1 lifecycle operations.
 // Fixed order; no inventory/domain fence may precede this.
 await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",[`aqlan.canonical.identity.substrate.v1:${s}`]);
 await inspectStaffRuntimeSchema(client,s);
 const {rows:controls}=await client.query<{state:string;realm_id:string;owner_user_id:number;binding_epoch:string}>(`SELECT state,realm_id,owner_user_id,binding_epoch::text FROM ${s}.staff_authority_control WHERE singleton FOR SHARE`);
 const c=controls[0];
 if(controls.length!==1 || c.state!=="active" || c.realm_id!==d.realmId || c.binding_epoch!==d.controlEpoch)refuse("CONTROL_STALE");
 const {rows:states}=await client.query<{status:string;realm_id:string;generation_id:string;registry_revision:string;ready_owner_subject_id:string;ready_control_epoch:string}>(`SELECT status,realm_id::text,generation_id::text,registry_revision::text,ready_owner_subject_id::text,ready_control_epoch::text FROM ${s}.staff_identity_state WHERE singleton FOR SHARE`);
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
 const {rows:users}=await client.query<{id:number;username:string;role:string;is_active:boolean;authorization_mode:string;authorization_epoch:string;password_hash:string;permissions:unknown;party_id:number|null}>(`SELECT id,username,role,is_active,authorization_mode,authorization_epoch::text,password_hash,permissions,party_id FROM ${s}.users WHERE id=ANY($1::integer[]) ORDER BY id FOR SHARE`,[[c.owner_user_id,claims.userId]]);
 const owner=users.find(u=>u.id===c.owner_user_id),user=users.find(u=>u.id===claims.userId);
 if(!owner || !owner.is_active || owner.role!=="admin" || owner.authorization_mode!=="canonical" || !user || !user.is_active || user.authorization_mode!=="canonical")refuse("ACCOUNT_INVALID");
 const {rows:bindings}=await client.query<{user_id:number;subject_id:string}>(`SELECT user_id,subject_id::text FROM ${s}.staff_identity_current WHERE user_id=ANY($1::integer[]) ORDER BY user_id FOR SHARE`,[[c.owner_user_id,claims.userId]]);
 if(bindings.find(b=>b.user_id===c.owner_user_id)?.subject_id!==h.ready_owner_subject_id || bindings.find(b=>b.user_id===claims.userId)?.subject_id!==d.subjectId)refuse("SUBJECT_STALE");
 if(user.username!==claims.username)refuse("USERNAME_STALE");
 if(user.authorization_epoch!==d.accountEpoch || typeof user.password_hash!=="string" || sessionCredentialVersion(user.password_hash)!==d.credentialVersion)refuse("CREDENTIAL_OR_ACCOUNT_STALE");
 let partyId:number|null=null;
 if(user.party_id!==null){
  const {rows}=await client.query<{id:number;kind:string;is_active:boolean;clinical_authority_epoch:string}>(`SELECT id,kind,is_active,clinical_authority_epoch::text FROM ${s}.parties WHERE id=$1 FOR SHARE`,[user.party_id]);
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
 if(await xid(client)!==transactionId)refuse("TRANSACTION_CHANGED");
 return {xid:transactionId,fingerprint,access,identity:Object.freeze({realmId:d.realmId,subjectId:d.subjectId,generationId:d.generationId,userId:user.id,username:user.username,role:user.role})};
}
/** Protected SQL callers must assert inside the callback, not accept projections.
 * Reacquires all fences and fresh proof; XID is not a subtransaction identifier. */
async function assertAndLoadStaffOperation(client:DbClient,handle:StaffOperationHandle,action:StaffRuntimeAction,schema?:string){
 const state=operations.get(handle);
 if(!state || state.client!==client || state.action!==action)refuse("HANDLE_INVALID");
 if(schema!==undefined && staffIdentitySchemaName(schema)!==state.schema)refuse("HANDLE_SCHEMA_MISMATCH");
 if(await xid(client)!==state.xid)refuse("TRANSACTION_CHANGED");
 const current=await load(client,state.session,action,state.schema);
 if(current.xid!==state.xid || current.fingerprint!==state.fingerprint)refuse("AUTHORITY_CHANGED");
 return current;
}
/** Fresh proof through the private handle, client, XID and exact action. This frozen
 * display/provenance projection is never accepted as authority by this runtime. */
export async function staffOperationIdentity(client:DbClient,handle:StaffOperationHandle,action:StaffRuntimeAction,schema?:string):Promise<Readonly<{realmId:string;subjectId:string;generationId:string;userId:number;username:string;role:string}>> {
 return (await assertAndLoadStaffOperation(client,handle,action,schema)).identity;
}
export async function assertStaffOperation(client:DbClient,handle:StaffOperationHandle,action:StaffRuntimeAction,schema?:string):Promise<void>{
 await assertAndLoadStaffOperation(client,handle,action,schema);
}
/** Bounded display preview, never operation admission. An exact reference-read
 * handle is freshly asserted (including schema) before exposing the sole supported
 * create action. A caller must acquire a separate exact create handle to write. */
export async function staffOperationReferenceCapabilities(client:DbClient,handle:StaffOperationHandle,schema:string):Promise<readonly "inventory.items.create"[]>{
 const exactSchema=staffIdentitySchemaName(schema);
 const current=await assertAndLoadStaffOperation(client,handle,"inventory.references.view",exactSchema);
 return Object.freeze(hasStaffCapability(current.access,"inventory.items.create")?["inventory.items.create" as const]:[]);
}
/** Owns transaction/commit. Trusted callback MUST NOT issue top-level transaction
 * control. Changed/ended XID refuses, but a malicious early COMMIT cannot be undone.
 * Savepoints are created only after admission fences. No handle survives callback. */
export async function withStaffOperation<T>(pool:DbPool,session:VerifiedDurableSession,action:StaffRuntimeAction,work:(client:DbClient,handle:StaffOperationHandle)=>Promise<T>,schema="public"):Promise<T>{
 return withIsolation(pool,"READ COMMITTED",async client=>{
  const proof=await load(client,session,action,schema);
  const handle=Object.freeze({}) as StaffOperationHandle;
  operations.set(handle,{client,xid:proof.xid,action,session,schema,fingerprint:proof.fingerprint});
  try{
   const result=await work(client,handle);
   await assertStaffOperation(client,handle,action);
   return result;
  }finally{operations.delete(handle);}
 });
}
