/** Durable command intent, not another clinical fact store. Reservation is a
 * separate commit; revision and terminal receipt commit atomically. */
import {insertAuditRow,type DbClient} from './db';
import {authorizeJourney,discoverJourneyOwner,lockJourneyOwner,assertJourneyCurrent,journeyTransaction,journeyFail,JourneyFault,type JourneyOwnerInput,type JourneyAuthority} from './ortho-case-journey-authority';
import {readFacialCommand,type FacialCommand} from './ortho-facial-analysis';
function checkFacialCommand(raw:unknown){try{return {ok:true as const,value:readFacialCommand(raw)};}catch{return {ok:false as const,code:'invalid_facial_analysis'};}}
import {journeyContentHash,canonicalJourneyJSON} from './ortho-case-journey-hash';
import {prepareFacialSave,appendPreparedFacialRevision} from './ortho-facial-store';
import type {FacialSubmissionIdentity,FacialSubmissionRecovery,FacialSubmissionAcknowledgment} from './ortho-facial-submission-contract';
import {journeyId,journeyHash,type JourneyScope} from './ortho-case-journey-records';
interface SubmissionRow {id:number;patient_id:number;recorded_patient_id:number;ortho_case_id:number;clinical_case_id:number;actor_user_id:number;document_id:number|null;command_id:string;request_fingerprint:string;command:unknown|null;previous_version:number|null;state:'pending'|'committed'|'cancelled';revision_id:number|null;acknowledged_at:Date|null}
const identity=(r:SubmissionRow):FacialSubmissionIdentity=>({id:r.id,commandId:r.command_id,requestFingerprint:r.request_fingerprint});
export async function lockFacialSubmissionTables(client:DbClient){await client.query('LOCK TABLE ortho_facial_revisions IN ROW EXCLUSIVE MODE');await client.query('LOCK TABLE ortho_facial_submissions IN ROW EXCLUSIVE MODE');}
async function find(client:DbClient,input:JourneyOwnerInput,actorId:number,commandId:string){return (await client.query<SubmissionRow>('SELECT * FROM ortho_facial_submissions WHERE ortho_case_id=$1 AND actor_user_id=$2 AND command_id=$3 FOR UPDATE',[input.orthoCaseId,actorId,commandId])).rows[0]??null;}
async function outstanding(client:DbClient,caseId:number){return (await client.query<SubmissionRow>('SELECT * FROM ortho_facial_submissions WHERE ortho_case_id=$1 AND acknowledged_at IS NULL FOR UPDATE',[caseId])).rows[0]??null;}
function sameOriginal(r:SubmissionRow,scope:JourneyScope,actor:number){return r.actor_user_id===actor&&r.patient_id===scope.patientId&&r.recorded_patient_id===scope.patientId&&r.ortho_case_id===scope.orthoCaseId&&r.clinical_case_id===scope.clinicalCaseId;}
function decode(r:SubmissionRow):FacialCommand {
 const c=checkFacialCommand(r.command);if(!c.ok||c.value.clientRequestId!==r.command_id||c.value.documentId!==r.document_id||journeyContentHash(c.value)!==r.request_fingerprint||!Number.isSafeInteger(r.previous_version)||r.previous_version!<0||(c.value.expectedHeadId===null)!==(r.previous_version===0))journeyFail(500,'invalid_facial_submission');return c.value;
}
async function audit(client:DbClient,a:JourneyAuthority,r:SubmissionRow,event:string){await insertAuditRow(client,{actor:a.name,actorRole:a.session.role,action:'ortho.facial_submission',entity:'ortho_facial_submissions',entityId:r.id,details:{event,orthoCaseId:r.ortho_case_id,requestFingerprint:r.request_fingerprint,state:r.state}});}
export async function reserveFacialSubmission(input:JourneyOwnerInput&{clinicalCaseId:number;actorId:number;command:unknown}){
 if(!journeyId(input.clinicalCaseId)||!journeyId(input.actorId))return {ok:false as const,status:400,code:'invalid_facial_submission_scope',message:'طلب غير صالح.'};
 const checked=checkFacialCommand(input.command);if(!checked.ok)return {ok:false as const,status:400,code:checked.code,message:'لم يُقبل الطلب.'};const command=checked.value;
 return journeyTransaction(true,async client=>{
  await lockFacialSubmissionTables(client);const authority=await authorizeJourney(client,input,true);
  if(authority.userId!==input.actorId)journeyFail(409,'facial_submission_actor_changed');
  const bound=await discoverJourneyOwner(client,input);if(bound.clinicalCaseId!==input.clinicalCaseId)journeyFail(409,'facial_submission_context_changed');
  const existing=await find(client,input,authority.userId,command.clientRequestId);
  if(existing){
   if(existing.request_fingerprint!==journeyContentHash(command))journeyFail(409,'request_key_conflict');
   const owner=await lockJourneyOwner(client,input,false);
   if(owner.clinicalCaseId!==input.clinicalCaseId||existing.clinical_case_id!==owner.clinicalCaseId||existing.patient_id!==owner.patientId||existing.acknowledged_at===null&&!sameOriginal(existing,owner,authority.userId))journeyFail(409,'facial_submission_context_changed');
   if(existing.state==='cancelled')journeyFail(409,'facial_submission_cancelled');
   assertJourneyCurrent(authority);return {ok:true as const,identity:identity(existing)};
  }
  if(await outstanding(client,input.orthoCaseId))journeyFail(409,'facial_submission_unacknowledged');
  const prepared=await prepareFacialSave(client,input,command);
  if(prepared.owner.clinicalCaseId!==input.clinicalCaseId)journeyFail(409,'facial_submission_context_changed');
  const replay=prepared.replay;
  const previousVersion=replay?replay.version-1:(prepared.head?.version??0);
  const {rows:[row]}=await client.query<SubmissionRow>(`INSERT INTO ortho_facial_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,previous_version,state,revision_id,settled_at,document_id)
   VALUES($1,$1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,CASE WHEN $10::integer IS NULL THEN NULL ELSE clock_timestamp() END,$11) RETURNING *`,[prepared.owner.patientId,prepared.owner.orthoCaseId,prepared.owner.clinicalCaseId,authority.userId,command.clientRequestId,journeyContentHash(command),canonicalJourneyJSON(command),previousVersion,replay?'committed':'pending',replay?.id??null,command.documentId]);
  await audit(client,authority,row,'reserved');assertJourneyCurrent(authority);return {ok:true as const,identity:identity(row)};
 });
}
export async function saveJournaledFacial(input:JourneyOwnerInput&{clinicalCaseId:number;actorId:number;command:unknown}){
 const reserved=await reserveFacialSubmission(input);if(!reserved.ok)return reserved;
 return journeyTransaction(true,async client=>{
  await lockFacialSubmissionTables(client);const authority=await authorizeJourney(client,input,true);
  if(authority.userId!==input.actorId)journeyFail(409,'facial_submission_actor_changed');
  const bound=await discoverJourneyOwner(client,input);if(bound.clinicalCaseId!==input.clinicalCaseId)journeyFail(409,'facial_submission_context_changed');
  const checked=checkFacialCommand(input.command);if(!checked.ok)journeyFail(400,checked.code);const command=checked.value;
  const row=await find(client,input,authority.userId,command.clientRequestId);
  if(!row||row.request_fingerprint!==journeyContentHash(command))journeyFail(409,'request_key_conflict');
  if(row.state==='cancelled')journeyFail(409,'facial_submission_cancelled');
  const persisted=row.command===null?command:decode(row);
  const prepared=await prepareFacialSave(client,input,persisted);
  if(prepared.owner.clinicalCaseId!==input.clinicalCaseId||row.patient_id!==prepared.owner.patientId||row.clinical_case_id!==prepared.owner.clinicalCaseId||row.acknowledged_at===null&&!sameOriginal(row,prepared.owner,authority.userId))journeyFail(409,'facial_submission_context_changed');
  const result=await appendPreparedFacialRevision(client,prepared);
  if(row.state==='pending'){
   const {rows:[settled]}=await client.query<SubmissionRow>("UPDATE ortho_facial_submissions SET state='committed',revision_id=$2,settled_at=clock_timestamp() WHERE id=$1 RETURNING *",[row.id,result.revision.id]);
   await audit(client,authority,settled,'committed');
  }else if(row.revision_id!==result.revision.id)journeyFail(500,'facial_submission_result_mismatch');
  assertJourneyCurrent(authority);return result;
 });
}
export async function getFacialSubmissionRecovery(input:JourneyOwnerInput){
 return journeyTransaction(false,async client=>{
  await lockFacialSubmissionTables(client);const authority=await authorizeJourney(client,input,false),row=await outstanding(client,input.orthoCaseId),discovered=await discoverJourneyOwner(client,input);
  const output=(scope:JourneyScope,recovery:FacialSubmissionRecovery['recovery']):FacialSubmissionRecovery=>({ok:true,actorId:authority.userId,scope:{patientId:scope.patientId,orthoCaseId:scope.orthoCaseId,clinicalCaseId:scope.clinicalCaseId},recovery});
  if(!row){const owner=await lockJourneyOwner(client,input,false);assertJourneyCurrent(authority);return output(owner,null);}
  if(!sameOriginal(row,discovered,authority.userId)){const owner=await lockJourneyOwner(client,input,false);assertJourneyCurrent(authority);return output(owner,{state:'blocked',identity:null,canCancel:false});}
  if(row.state==='cancelled'){const owner=await lockJourneyOwner(client,input,false);assertJourneyCurrent(authority);return output(owner,{state:'cancelled',identity:identity(row)});}
  const command=decode(row);
  try{
   const prepared=await prepareFacialSave(client,input,command,false);
   if(!sameOriginal(row,prepared.owner,authority.userId))journeyFail(409,'facial_submission_context_changed');
   assertJourneyCurrent(authority);return output(prepared.owner,{state:row.state,identity:identity(row),expected:{actorId:authority.userId,scope:{patientId:prepared.owner.patientId,orthoCaseId:prepared.owner.orthoCaseId,clinicalCaseId:prepared.owner.clinicalCaseId},command,previousVersion:row.previous_version!}});
  }catch(error){
   if(!(error instanceof JourneyFault)||![400,403,404,409].includes(error.status))throw error;
   const owner=await lockJourneyOwner(client,input,false);assertJourneyCurrent(authority);
   return output(owner,{state:'blocked',identity:sameOriginal(row,owner,authority.userId)&&authority.canWrite&&row.state==='pending'?identity(row):null,canCancel:sameOriginal(row,owner,authority.userId)&&authority.canWrite&&row.state==='pending'});
  }
 });
}
export async function transitionFacialSubmission(input:JourneyOwnerInput&{clinicalCaseId:number;actorId:number;commandId:string;requestFingerprint:string;action:'acknowledge'|'cancel'}){
 if(!journeyId(input.clinicalCaseId)||!journeyId(input.actorId)||!/^[a-zA-Z0-9_-]{16,80}$/.test(input.commandId)||!journeyHash(input.requestFingerprint)||!['acknowledge','cancel'].includes(input.action))return {ok:false as const,status:400,code:'invalid_facial_submission_transition',message:'طلب غير صالح.'};
 return journeyTransaction(true,async client=>{
  await lockFacialSubmissionTables(client);const authority=await authorizeJourney(client,input,true);
  if(authority.userId!==input.actorId)journeyFail(409,'facial_submission_actor_changed');
  const bound=await discoverJourneyOwner(client,input);if(bound.clinicalCaseId!==input.clinicalCaseId)journeyFail(409,'facial_submission_context_changed');
  let row=await find(client,input,authority.userId,input.commandId);
  if(row&&row.request_fingerprint!==input.requestFingerprint)journeyFail(409,'request_key_conflict');
  if(!row&&await outstanding(client,input.orthoCaseId))journeyFail(409,'facial_submission_unacknowledged');
  const owner=await lockJourneyOwner(client,input,true);
  if(owner.clinicalCaseId!==input.clinicalCaseId||row&&!(row.acknowledged_at!==null&&row.patient_id===owner.patientId&&row.clinical_case_id===owner.clinicalCaseId)&&!sameOriginal(row,owner,authority.userId))journeyFail(409,'facial_submission_context_changed');
  if(!row){
   if(input.action!=='cancel')journeyFail(404,'facial_submission_not_found');
   // Pre-journal revisions already committed this identity. Never manufacture
   // a cancellation proof for them (nor rely on a deferred-trigger 500).
   const legacy=(await client.query<{request_fingerprint:string}>('SELECT request_fingerprint FROM ortho_facial_revisions WHERE ortho_case_id=$1 AND actor_user_id=$2 AND command_id=$3',[owner.orthoCaseId,authority.userId,input.commandId])).rows[0];
   if(legacy)journeyFail(409,legacy.request_fingerprint===input.requestFingerprint?'facial_submission_already_committed':'request_key_conflict');
   const {rows:[inserted]}=await client.query<SubmissionRow>(`INSERT INTO ortho_facial_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,previous_version,state,settled_at)
    VALUES($1,$1,$2,$3,$4,$5,$6,NULL,NULL,'cancelled',clock_timestamp()) RETURNING *`,[owner.patientId,owner.orthoCaseId,owner.clinicalCaseId,authority.userId,input.commandId,input.requestFingerprint]);row=inserted;await audit(client,authority,row,'cancelled_before_arrival');
  }else if(input.action==='cancel'&&row.state==='pending'){
   const {rows:[cancelled]}=await client.query<SubmissionRow>("UPDATE ortho_facial_submissions SET state='cancelled',settled_at=clock_timestamp() WHERE id=$1 RETURNING *",[row.id]);row=cancelled;await audit(client,authority,row,'cancelled');
  }else if(input.action==='cancel'&&row.state==='committed')journeyFail(409,'facial_submission_already_committed');
  if(input.action==='acknowledge'){
   if(row.state==='pending')journeyFail(409,'facial_submission_pending');
   if(row.acknowledged_at===null){const {rows:[ack]}=await client.query<SubmissionRow>('UPDATE ortho_facial_submissions SET acknowledged_at=clock_timestamp(),command=NULL WHERE id=$1 RETURNING *',[row.id]);row=ack;await audit(client,authority,row,'acknowledged');}
  }
  assertJourneyCurrent(authority);return {ok:true as const,scope:{patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:owner.clinicalCaseId},actorId:authority.userId,identity:identity(row),state:row.state,acknowledged:row.acknowledged_at!==null} as FacialSubmissionAcknowledgment|{ok:true;scope:JourneyScope;actorId:number;identity:FacialSubmissionIdentity;state:'cancelled';acknowledged:false};
 });
}
