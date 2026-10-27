import { randomUUID } from "node:crypto";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";
import { inspectStaffIdentitySubstrate } from "./staff-identity-substrate-probe.mjs";
const LOCK="aqlan.canonical.identity.substrate.v1";
const uuid=v=>typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const revision=v=>typeof v==="string"&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<9223372036854775807n;
function refuse(code){throw new Error(code);}
async function transaction(source){
 // SAVEPOINT cannot execute in autocommit. This helper never owns BEGIN/COMMIT.
 await source.query("SAVEPOINT staff_identity_substrate_transaction");
 await source.query("RELEASE SAVEPOINT staff_identity_substrate_transaction");
 const {rows}=await source.query("SELECT pg_current_xact_id()::text AS xid,current_setting('transaction_isolation') AS isolation");
 if(rows.length!==1||rows[0].isolation!=="read committed"||!revision(rows[0].xid))refuse("STAFF_IDENTITY_TRANSACTION_REQUIRED");
 return rows[0].xid;
}
async function finish(source,xid){if(await transaction(source)!==xid)refuse("STAFF_IDENTITY_TRANSACTION_CHANGED");}
async function lock(source,schema){
 const s=staffIdentitySchemaName(schema),xid=await transaction(source);
 // Fixed order: installer/lifecycle mutex, frozen control row, target state,
 // affected account/current binding; inventory/domain locks must come AFTER.
 await source.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${LOCK}:${s}`]);
 await inspectStaffIdentitySubstrate(source,s);
 const {rows}=await source.query(`SELECT realm_id FROM ${s}.staff_authority_control WHERE singleton FOR SHARE`);
 if(rows.length!==1||!uuid(rows[0].realm_id))refuse("STAFF_IDENTITY_TARGET_REALM_INVALID");
 return {s,xid,realmId:rows[0].realm_id};
}
async function state(source,s,realmId){
 const {rows}=await source.query(`SELECT realm_id::text,generation_id::text,registry_revision::text,status FROM ${s}.staff_identity_state WHERE singleton FOR UPDATE`);
 if(rows.length!==1||rows[0].realm_id!==realmId||rows[0].status!=="quarantined"||!uuid(rows[0].generation_id)||!revision(rows[0].registry_revision))refuse("STAFF_IDENTITY_STATE_INVALID");
 const h=rows[0];
 const {rows:[integrity]}=await source.query(`WITH RECURSIVE chain AS (
   SELECT generation_id,previous_generation_id,realm_id FROM ${s}.staff_identity_generations WHERE generation_id=$1
   UNION SELECT g.generation_id,g.previous_generation_id,g.realm_id FROM ${s}.staff_identity_generations g JOIN chain c ON g.generation_id=c.previous_generation_id
 ) SELECT
 (SELECT count(*) FROM chain)=(SELECT count(*) FROM ${s}.staff_identity_generations) AND
 $3::bigint=(SELECT count(*) FROM ${s}.staff_identity_generations)+(SELECT count(*) FROM ${s}.staff_identity_binding_events) AND
 NOT EXISTS(SELECT 1 FROM (SELECT previous_subject_id,lag(new_subject_id) OVER(PARTITION BY user_id ORDER BY registry_revision) AS expected_previous FROM ${s}.staff_identity_binding_events) history WHERE previous_subject_id IS DISTINCT FROM expected_previous) AND
 NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_generations WHERE realm_id<>$2::uuid) AND
 NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_subjects WHERE realm_id<>$2::uuid OR created_registry_revision>$3::bigint) AND
 NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_binding_events WHERE registry_revision>$3::bigint) AND
 NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_subjects p LEFT JOIN ${s}.staff_identity_binding_events e ON e.registry_revision=p.created_registry_revision
 WHERE e.new_subject_id IS DISTINCT FROM p.subject_id OR e.user_id IS DISTINCT FROM p.user_id_at_binding OR e.generation_id IS DISTINCT FROM p.created_generation_id) AND
 NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_binding_events e LEFT JOIN ${s}.staff_identity_current b ON b.user_id=e.user_id
 WHERE NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_binding_events later WHERE later.user_id=e.user_id AND later.registry_revision>e.registry_revision)
 AND ((e.new_subject_id IS NULL AND b.user_id IS NOT NULL) OR (e.new_subject_id IS NOT NULL AND (b.subject_id IS DISTINCT FROM e.new_subject_id OR b.bound_registry_revision IS DISTINCT FROM e.registry_revision)))) AND
 NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_current b LEFT JOIN ${s}.staff_identity_subjects p ON p.subject_id=b.subject_id
 LEFT JOIN ${s}.staff_identity_binding_events e ON e.registry_revision=b.bound_registry_revision
 WHERE p.subject_id IS NULL OR p.user_id_at_binding<>b.user_id OR p.realm_id<>$2::uuid OR e.new_subject_id IS DISTINCT FROM b.subject_id OR e.user_id<>b.user_id
 OR EXISTS(SELECT 1 FROM ${s}.staff_identity_binding_events later WHERE later.user_id=b.user_id AND later.registry_revision>e.registry_revision)) AS valid`,[h.generation_id,realmId,h.registry_revision]);
 if(integrity?.valid!==true)refuse("STAFF_IDENTITY_HISTORY_INTEGRITY");
 return h;
}
function snapshot(h){return Object.freeze({realmId:h.realm_id,generationId:h.generation_id,registryRevision:h.registry_revision,status:"quarantined",authorizesSessions:false});}
function expected(input){
 if(!input||Object.keys(input).sort().join(",")!=="generationId,registryRevision"||!uuid(input.generationId)||!revision(input.registryRevision))refuse("STAFF_IDENTITY_EXPECTATION_INVALID");
}
function compare(h,input){if(h.generation_id!==input.generationId||h.registry_revision!==input.registryRevision)refuse("STAFF_IDENTITY_STALE_CAS");}
/** Explicit nonauthorizing storage initialization. No owner, grant, user update,
 * schema install or credential issuance. Existing history is never adopted. */
export async function initializeStaffIdentitySubstrate(source,schema="public"){
 const {s,xid,realmId}=await lock(source,schema);
 const {rows:[r]}=await source.query(`SELECT
 (SELECT count(*) FROM ${s}.staff_identity_state)+(SELECT count(*) FROM ${s}.staff_identity_generations)+
 (SELECT count(*) FROM ${s}.staff_identity_subjects)+(SELECT count(*) FROM ${s}.staff_identity_binding_events)+
 (SELECT count(*) FROM ${s}.staff_identity_current) AS count`);
 if(String(r?.count)!=="0")refuse("STAFF_IDENTITY_INITIALIZATION_REFUSED");
 const id=randomUUID();
 await source.query(`INSERT INTO ${s}.staff_identity_generations(generation_id,realm_id,reason) VALUES($1,$2,'initialize')`,[id,realmId]);
 await source.query(`INSERT INTO ${s}.staff_identity_state(singleton,realm_id,generation_id,registry_revision,status) VALUES(TRUE,$1,$2,1,'quarantined')`,[realmId,id]);
 const h=await state(source,s,realmId);await finish(source,xid);return snapshot(h);
}
/** Inspection is still caller-transaction-bound; no names-only readiness success. */
export async function readStaffIdentitySubstrate(source,schema="public"){
 const {s,xid,realmId}=await lock(source,schema);const h=await state(source,s,realmId);await finish(source,xid);return snapshot(h);
}
/** Registry binding, NOT an account grant. Old subjects are never reused. Both
 * absent and replacement bindings require exact caller-observed CAS. */
export async function bindStaffAccountIncarnation(source,input,schema="public"){
 if(!input||Object.keys(input).sort().join(",")!=="currentSubjectId,expected,userId"||!Number.isSafeInteger(input.userId)||input.userId<1||!(input.currentSubjectId===null||uuid(input.currentSubjectId)))refuse("STAFF_IDENTITY_BINDING_INVALID");
 expected(input.expected);
 const {s,xid,realmId}=await lock(source,schema);const h=await state(source,s,realmId);compare(h,input.expected);
 const {rows:users}=await source.query(`SELECT id FROM ${s}.users WHERE id=$1 FOR SHARE`,[input.userId]);
 if(users.length!==1)refuse("STAFF_IDENTITY_ACCOUNT_MISSING");
 const {rows:bindings}=await source.query(`SELECT subject_id::text FROM ${s}.staff_identity_current WHERE user_id=$1 FOR UPDATE`,[input.userId]);
 if(bindings.length>1||(bindings[0]?.subject_id??null)!==input.currentSubjectId)refuse("STAFF_IDENTITY_STALE_CAS");
 const next=(BigInt(h.registry_revision)+1n).toString(),subjectId=randomUUID();
 await source.query(`UPDATE ${s}.staff_identity_state SET registry_revision=$1 WHERE singleton`,[next]);
 await source.query(`INSERT INTO ${s}.staff_identity_subjects(subject_id,realm_id,user_id_at_binding,created_generation_id,created_registry_revision) VALUES($1,$2,$3,$4,$5)`,[subjectId,realmId,input.userId,h.generation_id,next]);
 await source.query(`INSERT INTO ${s}.staff_identity_binding_events(registry_revision,generation_id,user_id,previous_subject_id,new_subject_id) VALUES($1,$2,$3,$4,$5)`,[next,h.generation_id,input.userId,input.currentSubjectId,subjectId]);
 if(input.currentSubjectId!==null)await source.query(`DELETE FROM ${s}.staff_identity_current WHERE user_id=$1`,[input.userId]);
 await source.query(`INSERT INTO ${s}.staff_identity_current(user_id,subject_id,bound_registry_revision) VALUES($1,$2,$3)`,[input.userId,subjectId,next]);
 const result=await state(source,s,realmId);await finish(source,xid);return Object.freeze({...snapshot(result),userId:input.userId,subjectId});
}
/** Only retires registry association in quarantine; does not delete/authorize an
 * account. History has no users FK and survives later numeric-ID reuse. */
export async function retireStaffAccountIncarnation(source,input,schema="public"){
 if(!input||Object.keys(input).sort().join(",")!=="currentSubjectId,expected,userId"||!Number.isSafeInteger(input.userId)||input.userId<1||!uuid(input.currentSubjectId))refuse("STAFF_IDENTITY_BINDING_INVALID");
 expected(input.expected);
 const {s,xid,realmId}=await lock(source,schema);const h=await state(source,s,realmId);compare(h,input.expected);
 const {rows}=await source.query(`SELECT subject_id::text FROM ${s}.staff_identity_current WHERE user_id=$1 FOR UPDATE`,[input.userId]);
 if(rows.length!==1||rows[0].subject_id!==input.currentSubjectId)refuse("STAFF_IDENTITY_STALE_CAS");
 const next=(BigInt(h.registry_revision)+1n).toString();
 await source.query(`UPDATE ${s}.staff_identity_state SET registry_revision=$1 WHERE singleton`,[next]);
 await source.query(`INSERT INTO ${s}.staff_identity_binding_events(registry_revision,generation_id,user_id,previous_subject_id) VALUES($1,$2,$3,$4)`,[next,h.generation_id,input.userId,input.currentSubjectId]);
 await source.query(`DELETE FROM ${s}.staff_identity_current WHERE user_id=$1`,[input.userId]);
 const result=await state(source,s,realmId);await finish(source,xid);return snapshot(result);
}
/** Target-only rotation. Does NOT replay source rows, change0076owner state,
 * clear existing bindings, activate authority or make a restore usable. */
export async function advanceStaffIdentityTargetGeneration(source,input,schema="public"){
 if(!input||Object.keys(input).sort().join(",")!=="expected,reason"||!["reset","restore"].includes(input.reason))refuse("STAFF_IDENTITY_ADVANCE_INVALID");
 expected(input.expected);
 const {s,xid,realmId}=await lock(source,schema);const h=await state(source,s,realmId);compare(h,input.expected);
 const id=randomUUID(),next=(BigInt(h.registry_revision)+1n).toString();
 await source.query(`INSERT INTO ${s}.staff_identity_generations(generation_id,realm_id,previous_generation_id,reason) VALUES($1,$2,$3,$4)`,[id,realmId,h.generation_id,input.reason]);
 await source.query(`UPDATE ${s}.staff_identity_state SET generation_id=$1,registry_revision=$2 WHERE singleton`,[id,next]);
 const result=await state(source,s,realmId);await finish(source,xid);return snapshot(result);
}
/** Phase1 has NO supported source authority import, even for empty/absent claims.
 * No parser result may be mistaken for permission to use application restore. */
export function assertStaffIdentitySourceRestoreAllowed(_sourcePayload){
 refuse("STAFF_IDENTITY_SOURCE_RESTORE_UNSUPPORTED");
}
