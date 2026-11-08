/** Durable command intent, not another clinical fact store. Reservation is a
 * separate commit; revision and terminal receipt commit atomically. */
import {insertAuditRow,type DbClient} from './db';
import {authorizeJourney,discoverJourneyOwner,lockJourneyOwner,assertJourneyCurrent,journeyTransaction,journeyFail,JourneyFault,type JourneyOwnerInput,type JourneyAuthority} from './ortho-case-journey-authority';
import {readProblemSourceCommand,type ProblemSourceCommand as ProblemCommand} from './ortho-problem-sources';
function checkProblemCommand(raw:unknown){const value=readProblemSourceCommand(raw);return value?{ok:true as const,value}:{ok:false as const,code:'invalid_problem_review'};}
import {journeyContentHash,canonicalJourneyJSON} from './ortho-case-journey-hash';
import {runProblemSourceCommand} from './ortho-problem-source-store';
import {PURCHASE_RESET_FENCE} from './clinic-reset';
import type {ProblemSubmissionIdentity,ProblemSubmissionRecovery,ProblemSubmissionAcknowledgment} from './ortho-problem-submission-contract';
import {journeyId,journeyHash,type JourneyScope} from './ortho-case-journey-records';
interface SubmissionRow {id:number;patient_id:number;recorded_patient_id:number;ortho_case_id:number;clinical_case_id:number;actor_user_id:number;command_id:string;request_fingerprint:string;command:unknown|null;state:'pending'|'committed'|'cancelled';review_id:number|null;acknowledged_at:Date|null}
const identity=(r:SubmissionRow):ProblemSubmissionIdentity=>({id:r.id,commandId:r.command_id,requestFingerprint:r.request_fingerprint});
export async function lockProblemSubmissionTables(client:DbClient){await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',[PURCHASE_RESET_FENCE]);await client.query('LOCK TABLE ortho_problem_source_reviews IN ROW EXCLUSIVE MODE');await client.query('LOCK TABLE ortho_problem_source_submissions IN ROW EXCLUSIVE MODE');}
async function find(client:DbClient,input:JourneyOwnerInput,actorId:number,commandId:string){return (await client.query<SubmissionRow>('SELECT * FROM ortho_problem_source_submissions WHERE patient_id=$1 AND actor_user_id=$2 AND command_id=$3 FOR UPDATE',[input.patientId,actorId,commandId])).rows[0]??null;}
async function outstanding(client:DbClient,caseId:number){return (await client.query<SubmissionRow>('SELECT * FROM ortho_problem_source_submissions WHERE ortho_case_id=$1 AND acknowledged_at IS NULL FOR UPDATE',[caseId])).rows[0]??null;}
function sameOriginal(r:SubmissionRow,scope:JourneyScope,actor:number){return r.actor_user_id===actor&&r.patient_id===scope.patientId&&r.recorded_patient_id===scope.patientId&&r.ortho_case_id===scope.orthoCaseId&&r.clinical_case_id===scope.clinicalCaseId;}
function decode(r:SubmissionRow):ProblemCommand {
 const c=checkProblemCommand(r.command);if(!c.ok||c.value.commandId!==r.command_id||journeyContentHash(c.value)!==r.request_fingerprint)journeyFail(500,'invalid_problem_submission');return c.value;
}
async function audit(client:DbClient,a:JourneyAuthority,r:SubmissionRow,event:string){await insertAuditRow(client,{actor:a.name,actorRole:a.session.role,action:'ortho.problem_submission',entity:'ortho_problem_source_submissions',entityId:r.id,details:{event,orthoCaseId:r.ortho_case_id,requestFingerprint:r.request_fingerprint,state:r.state}});}
export async function reserveProblemSubmission(input:JourneyOwnerInput&{clinicalCaseId:number;actorId:number;command:unknown}){
 if(!journeyId(input.clinicalCaseId)||!journeyId(input.actorId))return {ok:false as const,status:400,code:'invalid_problem_submission_scope',message:'طلب غير صالح.'};
 const checked=checkProblemCommand(input.command);if(!checked.ok)return {ok:false as const,status:400,code:checked.code,message:'لم يُقبل الطلب.'};const command=checked.value;
 return journeyTransaction(true,async client=>{
  await lockProblemSubmissionTables(client);const authority=await authorizeJourney(client,input,true);
  if(authority.userId!==input.actorId)journeyFail(409,'problem_submission_actor_changed');
  const bound=await discoverJourneyOwner(client,input);if(bound.clinicalCaseId!==input.clinicalCaseId)journeyFail(409,'problem_submission_context_changed');
  const existing=await find(client,input,authority.userId,command.commandId);
  if(existing){
   if(existing.request_fingerprint!==journeyContentHash(command))journeyFail(409,'request_key_conflict');
   const owner=await lockJourneyOwner(client,input,false);
   if(owner.clinicalCaseId!==input.clinicalCaseId||existing.clinical_case_id!==owner.clinicalCaseId||existing.patient_id!==owner.patientId||!sameOriginal(existing,owner,authority.userId))journeyFail(409,'problem_submission_context_changed');
   if(existing.state==='cancelled')journeyFail(409,'problem_submission_cancelled');
   assertJourneyCurrent(authority);return {ok:true as const,identity:identity(existing)};
  }
  if(await outstanding(client,input.orthoCaseId))journeyFail(409,'problem_submission_unacknowledged');
  const prepared=await runProblemSourceCommand(client,input,command,true);
  if((await lockJourneyOwner(client,input,true)).clinicalCaseId!==input.clinicalCaseId)journeyFail(409,'problem_submission_context_changed');
  const replay=prepared.receipt;
  const {rows:[row]}=await client.query<SubmissionRow>(`INSERT INTO ortho_problem_source_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,state,review_id,settled_at)
   VALUES($1,$1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,CASE WHEN $9::integer IS NULL THEN NULL ELSE clock_timestamp() END) RETURNING *`,[bound.patientId,bound.orthoCaseId,bound.clinicalCaseId,authority.userId,command.commandId,journeyContentHash(command),canonicalJourneyJSON(command),replay?'committed':'pending',replay?.reviewId??null]);
  await audit(client,authority,row,'reserved');assertJourneyCurrent(authority);return {ok:true as const,identity:identity(row)};
 });
}
export async function saveJournaledProblemSource(input:JourneyOwnerInput&{clinicalCaseId:number;actorId:number;command:unknown}){
 const reserved=await reserveProblemSubmission(input);if(!reserved.ok)return reserved;
 return journeyTransaction(true,async client=>{
  await lockProblemSubmissionTables(client);const authority=await authorizeJourney(client,input,true);
  if(authority.userId!==input.actorId)journeyFail(409,'problem_submission_actor_changed');
  const bound=await discoverJourneyOwner(client,input);if(bound.clinicalCaseId!==input.clinicalCaseId)journeyFail(409,'problem_submission_context_changed');
  const checked=checkProblemCommand(input.command);if(!checked.ok)journeyFail(400,checked.code);const command=checked.value;
  const row=await find(client,input,authority.userId,command.commandId);
  if(!row||row.request_fingerprint!==journeyContentHash(command))journeyFail(409,'request_key_conflict');
  if(row.state==='cancelled')journeyFail(409,'problem_submission_cancelled');
  const persisted=row.command===null?command:decode(row);
  const prepared=await runProblemSourceCommand(client,input,persisted);
  if((await lockJourneyOwner(client,input,true)).clinicalCaseId!==input.clinicalCaseId||row.patient_id!==bound.patientId||row.clinical_case_id!==bound.clinicalCaseId||!sameOriginal(row,bound,authority.userId))journeyFail(409,'problem_submission_context_changed');
  const result=prepared.receipt;if(!result)journeyFail(500,'missing_problem_receipt');
  if(row.state==='pending'){
   const {rows:[settled]}=await client.query<SubmissionRow>("UPDATE ortho_problem_source_submissions SET state='committed',review_id=$2,settled_at=clock_timestamp() WHERE id=$1 RETURNING *",[row.id,result.reviewId]);
   await audit(client,authority,settled,'committed');
  }else if(row.review_id!==result.reviewId)journeyFail(500,'problem_submission_result_mismatch');
  assertJourneyCurrent(authority);return result;
 });
}
export async function getProblemSubmissionRecovery(input:JourneyOwnerInput){
 return journeyTransaction(false,async client=>{
  await lockProblemSubmissionTables(client);const authority=await authorizeJourney(client,input,false),row=await outstanding(client,input.orthoCaseId),discovered=await discoverJourneyOwner(client,input);
  const output=(scope:JourneyScope,recovery:ProblemSubmissionRecovery['recovery']):ProblemSubmissionRecovery=>({ok:true,actorId:authority.userId,scope:{patientId:scope.patientId,orthoCaseId:scope.orthoCaseId,clinicalCaseId:scope.clinicalCaseId},recovery});
  if(!row){const owner=await lockJourneyOwner(client,input,false);assertJourneyCurrent(authority);return output(owner,null);}
  if(!sameOriginal(row,discovered,authority.userId)){const owner=await lockJourneyOwner(client,input,false);assertJourneyCurrent(authority);return output(owner,{state:'blocked',identity:null,canCancel:false});}
  if(row.state==='cancelled'){const owner=await lockJourneyOwner(client,input,false);assertJourneyCurrent(authority);return output(owner,{state:'cancelled',identity:identity(row)});}
  const command=decode(row);
  try{
   await runProblemSourceCommand(client,input,command,true,true,false);
   const bound=await discoverJourneyOwner(client,input);
   if(!sameOriginal(row,bound,authority.userId))journeyFail(409,'problem_submission_context_changed');
   assertJourneyCurrent(authority);return output(bound,{state:row.state,identity:identity(row),expected:{actorId:authority.userId,scope:{patientId:bound.patientId,orthoCaseId:bound.orthoCaseId,clinicalCaseId:bound.clinicalCaseId},command}});
  }catch(error){
   if(!(error instanceof JourneyFault)||![400,403,404,409].includes(error.status))throw error;
   const owner=await lockJourneyOwner(client,input,false);assertJourneyCurrent(authority);
   return output(owner,{state:'blocked',identity:sameOriginal(row,owner,authority.userId)&&authority.canWrite&&row.state==='pending'?identity(row):null,canCancel:sameOriginal(row,owner,authority.userId)&&authority.canWrite&&row.state==='pending'});
  }
 });
}
export async function transitionProblemSubmission(input:JourneyOwnerInput&{clinicalCaseId:number;actorId:number;commandId:string;requestFingerprint:string;action:'acknowledge'|'cancel'}){
 if(!journeyId(input.clinicalCaseId)||!journeyId(input.actorId)||!/^[a-zA-Z0-9_-]{16,80}$/.test(input.commandId)||!journeyHash(input.requestFingerprint)||!['acknowledge','cancel'].includes(input.action))return {ok:false as const,status:400,code:'invalid_problem_submission_transition',message:'طلب غير صالح.'};
 return journeyTransaction(true,async client=>{
  await lockProblemSubmissionTables(client);const authority=await authorizeJourney(client,input,true);
  if(authority.userId!==input.actorId)journeyFail(409,'problem_submission_actor_changed');
  const bound=await discoverJourneyOwner(client,input);if(bound.clinicalCaseId!==input.clinicalCaseId)journeyFail(409,'problem_submission_context_changed');
  let row=await find(client,input,authority.userId,input.commandId);
  if(row&&row.request_fingerprint!==input.requestFingerprint)journeyFail(409,'request_key_conflict');
  if(!row&&await outstanding(client,input.orthoCaseId))journeyFail(409,'problem_submission_unacknowledged');
  const owner=await lockJourneyOwner(client,input,true);
  if(owner.clinicalCaseId!==input.clinicalCaseId||row&&!sameOriginal(row,owner,authority.userId))journeyFail(409,'problem_submission_context_changed');
  if(!row){
   if(input.action!=='cancel')journeyFail(404,'problem_submission_not_found');
   // Pre-journal revisions already committed this identity. Never manufacture
   // a cancellation proof for them (nor rely on a deferred-trigger 500).
   const legacy=(await client.query<{request_fingerprint:string}>('SELECT request_fingerprint FROM ortho_problem_source_reviews WHERE patient_id=$1 AND actor_user_id=$2 AND command_id=$3',[owner.patientId,authority.userId,input.commandId])).rows[0];
   if(legacy)journeyFail(409,legacy.request_fingerprint===input.requestFingerprint?'problem_submission_already_committed':'request_key_conflict');
   const {rows:[inserted]}=await client.query<SubmissionRow>(`INSERT INTO ortho_problem_source_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,state,settled_at)
    VALUES($1,$1,$2,$3,$4,$5,$6,NULL,'cancelled',clock_timestamp()) RETURNING *`,[owner.patientId,owner.orthoCaseId,owner.clinicalCaseId,authority.userId,input.commandId,input.requestFingerprint]);row=inserted;await audit(client,authority,row,'cancelled_before_arrival');
  }else if(input.action==='cancel'&&row.state==='pending'){
   const {rows:[cancelled]}=await client.query<SubmissionRow>("UPDATE ortho_problem_source_submissions SET state='cancelled',settled_at=clock_timestamp() WHERE id=$1 RETURNING *",[row.id]);row=cancelled;await audit(client,authority,row,'cancelled');
  }else if(input.action==='cancel'&&row.state==='committed')journeyFail(409,'problem_submission_already_committed');
  if(input.action==='acknowledge'){
   if(row.state==='pending')journeyFail(409,'problem_submission_pending');
   if(row.acknowledged_at===null){const {rows:[ack]}=await client.query<SubmissionRow>('UPDATE ortho_problem_source_submissions SET acknowledged_at=clock_timestamp(),command=NULL WHERE id=$1 RETURNING *',[row.id]);row=ack;await audit(client,authority,row,'acknowledged');}
  }
  assertJourneyCurrent(authority);return {ok:true as const,scope:{patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:owner.clinicalCaseId},actorId:authority.userId,identity:identity(row),state:row.state,acknowledged:row.acknowledged_at!==null} as ProblemSubmissionAcknowledgment|{ok:true;scope:JourneyScope;actorId:number;identity:ProblemSubmissionIdentity;state:'cancelled';acknowledged:false};
 });
}
