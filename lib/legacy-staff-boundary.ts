import "server-only";
import type { DbClient } from "./db";
import { revalidateLegacySessionEvidence, sessionCredentialVersion, sessionPermissionVersion, type VerifiedLegacySession } from "./auth";
import { classifyStaffPermissionEnvelope } from "./staff-permission-envelope";
import { parseDoctorPermissions } from "./doctor-permissions";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";

type Query = Pick<DbClient,"query">;
import { readLegacyStaffSchema, staffLifecycleLockKey } from "./legacy-staff-schema.mjs";
export { readLegacyStaffSchema } from "./legacy-staff-schema.mjs";
function refuse(reason:string):never{throw new Error(`LEGACY_STAFF_${reason}`);}
export function assertLegacyPermissionEnvelope(raw:unknown):void{
 if(classifyStaffPermissionEnvelope(raw).kind!=="legacy")refuse("PERMISSION_ENVELOPE_HELD");
}
/** Fixed shared fence before any target/domain locks. Future installation and
 * conversion MUST take the matching exclusive fence; no installer exists here. */
export async function lockLegacyStaffBoundary(source:Query,schema="public"):Promise<void>{
 const s=staffIdentitySchemaName(schema);
 await source.query("SAVEPOINT legacy_staff_transaction");await source.query("RELEASE SAVEPOINT legacy_staff_transaction");
 await source.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",[staffLifecycleLockKey(s)]);
 if(await readLegacyStaffSchema(source,s)!=="base")refuse("BASE_SCHEMA_UNREADABLE");
}
export interface LegacyStaffWriteAuthorization { readonly evidence:VerifiedLegacySession; readonly selfPassword?:boolean }
/** Call only in the actual write transaction, before commission/party effects.
 * Actor selection is from private original signed evidence, NEVER audit labels. */
export async function assertLegacyStaffWrite(source:Query,authorization:LegacyStaffWriteAuthorization|undefined,targetId:number|null,action:"create"|"update"|"link",schema="public"){
 if(!authorization)refuse("SIGNED_EVIDENCE_REQUIRED");
 const signed=revalidateLegacySessionEvidence(authorization.evidence);
 if(!signed?.credentialVersion)refuse("SIGNED_EVIDENCE_REQUIRED");
 const s=staffIdentitySchemaName(schema);
 await lockLegacyStaffBoundary(source,s);
 const ids=[...new Set([signed.userId,...(targetId===null?[]:[targetId])])].sort((a,b)=>a-b);
 const {rows}=await source.query<{id:number;username:string;role:string;is_active:boolean;password_hash:string;permissions:unknown}>(`SELECT id,username,role,is_active,password_hash,permissions FROM ${s}.users WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE`,[ids]);
 const actor=rows.find(r=>r.id===signed.userId);
 if(!actor || !actor.is_active || actor.username!==signed.username || actor.role!==signed.role || sessionCredentialVersion(actor.password_hash)!==signed.credentialVersion)refuse("ACTOR_REVOKED");
 for(const row of rows)assertLegacyPermissionEnvelope(row.permissions);
 if((actor.role==="cashier" || actor.role==="accountant") && signed.permissionVersion!==sessionPermissionVersion(actor.role,parseDoctorPermissions(actor.permissions,actor.role)?.financeAccess))refuse("ACTOR_REVOKED");
 if(authorization.selfPassword){if(action!=="update" || targetId!==actor.id)refuse("SELF_PASSWORD_SCOPE");}
 else if(actor.role!=="admin")refuse("ADMIN_REQUIRED");
 if(!revalidateLegacySessionEvidence(authorization.evidence))refuse("SESSION_EXPIRED");
 return Object.freeze({userId:actor.id,username:actor.username,role:actor.role,targetExists:targetId===null || rows.some(r=>r.id===targetId)});
}
/** Final expiry/schema/envelope check for the same held transaction. Intended
 * local credential/profile changes may revoke the old token without undoing the
 * authorized change; foreign changes cannot pass the already-held actor row lock. */
export async function finishLegacyStaffWrite(source:Query,authorization:LegacyStaffWriteAuthorization,targetId:number|null,schema="public"){
 const signed=revalidateLegacySessionEvidence(authorization.evidence);
 if(!signed)refuse("SESSION_EXPIRED");
 await readLegacyStaffSchema(source,schema);
 const s=staffIdentitySchemaName(schema);
 const {rows}=await source.query<{permissions:unknown}>(`SELECT permissions FROM ${s}.users WHERE id=ANY($1::integer[])`,[[signed.userId,...(targetId===null?[]:[targetId])]]);
 for(const row of rows)assertLegacyPermissionEnvelope(row.permissions);
}
