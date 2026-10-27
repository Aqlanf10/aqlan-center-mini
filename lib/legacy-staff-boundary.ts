import "server-only";
import type { DbClient } from "./db";
import { revalidateLegacySessionEvidence, sessionCredentialVersion, sessionPermissionVersion, type VerifiedLegacySession } from "./auth";
import { classifyStaffPermissionEnvelope } from "./staff-permission-envelope";
import { parseDoctorPermissions } from "./doctor-permissions";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";

type Query = Pick<DbClient,"query">;
const relations=["staff_authority_control","staff_identity_generations","staff_identity_subjects","staff_identity_state","staff_identity_binding_events","staff_identity_current","staff_authority_identity","staff_execution_epochs","users_staff_subject_identity"];
const functions=["staff_authority_control_guard","staff_account_authority_epoch_guard","staff_clinical_authority_epoch_guard","staff_identity_history_guard","staff_identity_state_guard","staff_identity_subject_guard","staff_identity_event_guard","staff_identity_current_guard","staff_subject_identity_immutable","staff_realm_identity_immutable","staff_execution_epoch_immutable"];
const triggers=["staff_authority_control_guard_row","staff_authority_control_guard_truncate","staff_account_authority_epoch","staff_clinical_authority_epoch","users_subject_identity_immutable","staff_realm_identity_immutable","staff_execution_epoch_immutable",...['staff_identity_generations','staff_identity_subjects','staff_identity_binding_events'].flatMap(t=>[`${t}_immutable`,`${t}_no_truncate`]),...['staff_identity_state','staff_identity_subjects','staff_identity_binding_events','staff_identity_current'].map(t=>`${t}_guard`),"staff_identity_state_no_truncate","staff_identity_current_no_truncate"];
function refuse(reason:string):never{throw new Error(`LEGACY_STAFF_${reason}`);}
/** SELECT-only inspection. Any authority footprint means disruptive maintenance
 * hold, NOT a compatible mixed-authority rollout. Errors never mean absence. */
export async function readLegacyStaffSchema(source:Query,schema="public"):Promise<"base"|"empty">{
 const s=staffIdentitySchemaName(schema);
 const {rows}=await source.query<{markers:string;users_kind:string|null;parties_kind:string|null}>(`SELECT (
 (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]))+
 (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=ANY($3::text[]))+
 (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND t.tgname=ANY($4::text[]))+
 (SELECT count(*) FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT a.attisdropped AND ((c.relname='users' AND a.attname=ANY(ARRAY['authorization_mode','authorization_epoch','staff_subject_id'])) OR (c.relname='parties' AND a.attname='clinical_authority_epoch')))
 )::text AS markers,
 (SELECT c.relkind::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='users') AS users_kind,
 (SELECT c.relkind::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='parties') AS parties_kind`,[s,relations,functions,triggers]);
 if(rows.length!==1 || rows[0].markers!=="0")refuse("AUTHORITY_SCHEMA_HELD");
 if(rows[0].users_kind===null && rows[0].parties_kind===null)return "empty";
 if(rows[0].users_kind!=="r" || rows[0].parties_kind!=="r")refuse("BASE_SCHEMA_UNREADABLE");
 return "base";
}
export function assertLegacyPermissionEnvelope(raw:unknown):void{
 if(classifyStaffPermissionEnvelope(raw).kind!=="legacy")refuse("PERMISSION_ENVELOPE_HELD");
}
/** Fixed shared fence before any target/domain locks. Future installation and
 * conversion MUST take the matching exclusive fence; no installer exists here. */
export async function lockLegacyStaffBoundary(source:Query,schema="public"):Promise<void>{
 const s=staffIdentitySchemaName(schema);
 await source.query("SAVEPOINT legacy_staff_transaction");await source.query("RELEASE SAVEPOINT legacy_staff_transaction");
 await source.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",[`aqlan.canonical.identity.substrate.v1:${s}`]);
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
