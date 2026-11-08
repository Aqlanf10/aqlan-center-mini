/** INACTIVE. Reserve and execute MUST run in different caller-owned, committed
 * transaction lifetimes. Caller owns reset fence, patient locks and rollback.
 * There is deliberately no combined save/transaction wrapper here. */
import { canonicalJourneyJSON, journeyContentHash } from './ortho-case-journey-hash';
import type { ProblemSourceCommand, ProblemSourceReceipt } from './ortho-problem-sources';
import type { ProblemSubmissionIdentity, ProblemSubmissionRecovery } from './ortho-problem-submission-contract';
import { createProblemOperation, detachProblemValue, problemCommand, problemFail, problemHash, problemId,
  ProblemFault, type ProblemOperation, type ProblemOwner, type ProblemQuery, type ProblemScope, type ProblemWritePorts, type ProblemReadPorts } from './ortho-problem-core-contract';
import { matchProblemOwner, problemDate, readProblemOwner, runProblemReview } from './ortho-problem-review-core';

interface SubmissionRow {
  id:number; patient_id:number; recorded_patient_id:number; ortho_case_id:number; clinical_case_id:number; actor_user_id:number;
  command_id:string; request_fingerprint:string; command:unknown|null; state:'pending'|'committed'|'cancelled'; review_id:number|null;
  created_at:Date|string; settled_at:Date|string|null; acknowledged_at:Date|string|null;
}
export interface ProblemSubmissionRequest extends ProblemScope { clinicalCaseId:number; actorId:number; command:unknown }
export interface ProblemTransitionRequest extends ProblemScope { clinicalCaseId:number; actorId:number; commandId:string; requestFingerprint:string; action:'cancel'|'acknowledge' }
function corrupt(code = 'invalid_problem_submission'): never { return problemFail(500,code,'integrity'); }
const key = (value:unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value);
const identity = (row:SubmissionRow):ProblemSubmissionIdentity => ({id:row.id,commandId:row.command_id,requestFingerprint:row.request_fingerprint});
const sameOriginal = (row:SubmissionRow,owner:ProblemOwner,actorId:number) => row.patient_id === owner.patientId && row.recorded_patient_id === owner.patientId
  && row.ortho_case_id === owner.orthoCaseId && row.clinical_case_id === owner.clinicalCaseId && row.actor_user_id === actorId;
function decodeCommand(row:SubmissionRow):ProblemSourceCommand {
  let command:ProblemSourceCommand;
  try { command = problemCommand(row.command); } catch { return corrupt(); }
  if (command.commandId !== row.command_id || journeyContentHash(command) !== row.request_fingerprint) return corrupt();
  return command;
}
function envelope(row:SubmissionRow):SubmissionRow {
  if (!row || ['id','patient_id','recorded_patient_id','ortho_case_id','clinical_case_id','actor_user_id'].some(k => !problemId(row[k as keyof SubmissionRow]))
    || row.patient_id !== row.recorded_patient_id || !key(row.command_id) || !problemHash(row.request_fingerprint)
    || typeof row.state !== 'string' || !['pending','committed','cancelled'].includes(row.state)
    || row.review_id !== null && !problemId(row.review_id)) corrupt();
  const created = problemDate(row.created_at), settled = row.settled_at === null ? null : problemDate(row.settled_at), ack = row.acknowledged_at === null ? null : problemDate(row.acknowledged_at);
  if (settled !== null && settled < created || ack !== null && (settled === null || ack < settled)) corrupt();
  if (row.state === 'pending' ? row.command === null || row.review_id !== null || settled !== null || ack !== null
    : settled === null || (row.state === 'committed' ? row.review_id === null : row.review_id !== null)) corrupt();
  if (ack !== null ? row.command !== null : row.command === null && row.state !== 'cancelled') corrupt();
  if (row.command !== null) decodeCommand(row);
  return row;
}
async function find(op:ProblemOperation,commandId:string):Promise<SubmissionRow|null> {
  const row = (await op.query<SubmissionRow>('SELECT * FROM ortho_problem_source_submissions WHERE patient_id=$1 AND actor_user_id=$2 AND command_id=$3 LIMIT 2 FOR UPDATE',
    [op.scope.patientId,op.actor.userId,commandId],false,undefined,{maxRows:1})).rows[0];
  if (!row) return null;
  envelope(row);
  if (row.patient_id !== op.scope.patientId || row.actor_user_id !== op.actor.userId || row.command_id !== commandId) corrupt();
  return row;
}
async function outstanding(op:ProblemOperation):Promise<SubmissionRow|null> {
  const row = (await op.query<SubmissionRow>('SELECT * FROM ortho_problem_source_submissions WHERE ortho_case_id=$1 AND acknowledged_at IS NULL LIMIT 2 FOR UPDATE',
    [op.scope.orthoCaseId],false,undefined,{maxRows:1})).rows[0];
  if (!row) return null;
  envelope(row);
  if (row.ortho_case_id !== op.scope.orthoCaseId || row.acknowledged_at !== null) corrupt();
  return row;
}
function expected(input:{actorId:number;clinicalCaseId:number},op:ProblemOperation,owner:ProblemOwner):void {
  if (input.actorId !== op.actor.userId) problemFail(409,'problem_submission_actor_changed');
  if (input.clinicalCaseId !== owner.clinicalCaseId) problemFail(409,'problem_submission_context_changed');
}
function original(row:SubmissionRow,owner:ProblemOwner,op:ProblemOperation):void {
  if (!sameOriginal(row,owner,op.actor.userId)) problemFail(409,'problem_submission_context_changed');
}
async function checkedOwner(op:ProblemOperation,before:ProblemOwner,input:{actorId:number;clinicalCaseId:number},row?:SubmissionRow):Promise<ProblemOwner> {
  const owner = await readProblemOwner(op,'write'); matchProblemOwner(before,owner); expected(input,op,owner); if (row) original(row,owner,op); return owner;
}
async function audit(op:ProblemOperation,row:SubmissionRow,event:'reserved'|'committed'|'cancelled_before_arrival'|'cancelled'|'acknowledged'):Promise<void> {
  await op.audit({actor:op.actor,action:'ortho.problem_submission',entity:'ortho_problem_source_submissions',entityId:row.id,
    details:{event,orthoCaseId:row.ortho_case_id,requestFingerprint:row.request_fingerprint,state:row.state}});
}
function returning(row:SubmissionRow|undefined,owner:ProblemOwner,op:ProblemOperation,commandId:string,fingerprint:string,state:SubmissionRow['state'],reviewId:number|null,
  command:ProblemSourceCommand|null,acknowledged:boolean,previous?:SubmissionRow):SubmissionRow {
  if (!row) return corrupt('invalid_problem_submission_returning');
  envelope(row);
  if (!sameOriginal(row,owner,op.actor.userId) || row.command_id !== commandId || row.request_fingerprint !== fingerprint || row.state !== state || row.review_id !== reviewId
    || (row.acknowledged_at !== null) !== acknowledged || canonicalJourneyJSON(row.command) !== canonicalJourneyJSON(command)) corrupt('invalid_problem_submission_returning');
  if (previous && (row.id !== previous.id || problemDate(row.created_at) !== problemDate(previous.created_at)
    || previous.settled_at !== null && problemDate(row.settled_at) !== problemDate(previous.settled_at)
    || previous.acknowledged_at !== null && problemDate(row.acknowledged_at) !== problemDate(previous.acknowledged_at))) corrupt('invalid_problem_submission_returning');
  return row;
}
function request(raw:ProblemSubmissionRequest):ProblemSubmissionRequest & {command:ProblemSourceCommand} {
  const input = detachProblemValue(raw,65536,200,12);
  if (!problemId(input.actorId) || !problemId(input.clinicalCaseId)) problemFail(400,'invalid_problem_submission_scope');
  return {...input,command:problemCommand(input.command)};
}
export async function reserveProblemSubmissionWith(client:ProblemQuery,raw:ProblemSubmissionRequest,ports:ProblemWritePorts):Promise<{ok:true;identity:ProblemSubmissionIdentity}> {
  const input = request(raw), command = input.command, fingerprint = journeyContentHash(command), op = createProblemOperation(client,input,ports,'reserve');
  try {
    await op.begin('journal');
    const before = await readProblemOwner(op); expected(input,op,before);
    const existing = await find(op,command.commandId);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) problemFail(409,'request_key_conflict');
      await checkedOwner(op,before,input,existing);
      if (existing.state === 'cancelled') problemFail(409,'problem_submission_cancelled');
      await op.current(); return {ok:true,identity:identity(existing)};
    }
    if (await outstanding(op)) problemFail(409,'problem_submission_unacknowledged');
    const replay = await runProblemReview(op,command,'reserve-validation'), owner = await checkedOwner(op,before,input);
    const [rawRow] = (await op.query<SubmissionRow>(`INSERT INTO ortho_problem_source_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,state,review_id,settled_at)
      VALUES($1,$1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,CASE WHEN $9::integer IS NULL THEN NULL ELSE clock_timestamp() END) RETURNING *`,
      [owner.patientId,owner.orthoCaseId,owner.clinicalCaseId,op.actor.userId,command.commandId,fingerprint,canonicalJourneyJSON(command),replay?'committed':'pending',replay?.reviewId??null],false,undefined,{maxRows:1})).rows;
    const row = returning(rawRow,owner,op,command.commandId,fingerprint,replay?'committed':'pending',replay?.reviewId??null,command,false);
    await audit(op,row,'reserved'); await checkedOwner(op,owner,input,row); await op.current();
    return {ok:true,identity:identity(row)};
  } finally { op.close(); }
}
export async function executeProblemSubmissionWith(client:ProblemQuery,raw:ProblemSubmissionRequest,ports:ProblemWritePorts):Promise<ProblemSourceReceipt> {
  const input = request(raw), command = input.command, fingerprint = journeyContentHash(command), op = createProblemOperation(client,input,ports,'execute');
  try {
    await op.begin('journal');
    const before = await readProblemOwner(op); expected(input,op,before);
    const row = await find(op,command.commandId);
    if (!row || row.request_fingerprint !== fingerprint) problemFail(409,'request_key_conflict');
    original(row,before,op);
    if (row.state === 'cancelled') problemFail(409,'problem_submission_cancelled');
    // envelope() already proved NULL only occurs on acknowledged committed rows.
    const persisted = row.command === null ? command : decodeCommand(row);
    const result = await runProblemReview(op,persisted,'append');
    if (!result) corrupt('missing_problem_receipt');
    const owner = await checkedOwner(op,before,input,row);
    if (row.state === 'pending') {
      const [rawSettled] = (await op.query<SubmissionRow>("UPDATE ortho_problem_source_submissions SET state='committed',review_id=$2,settled_at=clock_timestamp() WHERE id=$1 RETURNING *",[row.id,result.reviewId],false,undefined,{maxRows:1})).rows;
      const settled = returning(rawSettled,owner,op,row.command_id,row.request_fingerprint,'committed',result.reviewId,persisted,false,row);
      await audit(op,settled,'committed'); await checkedOwner(op,owner,input,settled);
    } else if (row.review_id !== result.reviewId) corrupt('problem_submission_result_mismatch');
    await op.current(); return result;
  } finally { op.close(); }
}
export async function transitionProblemSubmissionWith(client:ProblemQuery,raw:ProblemTransitionRequest,ports:ProblemWritePorts) {
  const input = detachProblemValue(raw,16384,100,8);
  if (!problemId(input.actorId) || !problemId(input.clinicalCaseId) || !key(input.commandId) || !problemHash(input.requestFingerprint) || typeof input.action !== 'string' || !['cancel','acknowledge'].includes(input.action)) problemFail(400,'invalid_problem_submission_transition');
  const op = createProblemOperation(client,input,ports,input.action);
  try {
    await op.begin('journal');
    const before = await readProblemOwner(op); expected(input,op,before);
    let row = await find(op,input.commandId);
    if (row && row.request_fingerprint !== input.requestFingerprint) problemFail(409,'request_key_conflict');
    if (!row && await outstanding(op)) problemFail(409,'problem_submission_unacknowledged');
    const owner = await checkedOwner(op,before,input,row??undefined);
    if (!row) {
      if (input.action !== 'cancel') problemFail(404,'problem_submission_not_found');
      const legacy = (await op.query<{patient_id:number;actor_user_id:number;command_id:string;request_fingerprint:string}>(
        'SELECT patient_id,actor_user_id,command_id,request_fingerprint FROM ortho_problem_source_reviews WHERE patient_id=$1 AND actor_user_id=$2 AND command_id=$3 LIMIT 2',
        [owner.patientId,op.actor.userId,input.commandId],false,undefined,{maxRows:1})).rows[0];
      if (legacy) {
        if (legacy.patient_id !== owner.patientId || legacy.actor_user_id !== op.actor.userId || legacy.command_id !== input.commandId || !problemHash(legacy.request_fingerprint)) corrupt();
        problemFail(409,legacy.request_fingerprint === input.requestFingerprint ? 'problem_submission_already_committed' : 'request_key_conflict');
      }
      const [inserted] = (await op.query<SubmissionRow>(`INSERT INTO ortho_problem_source_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,state,settled_at)
        VALUES($1,$1,$2,$3,$4,$5,$6,NULL,'cancelled',clock_timestamp()) RETURNING *`,[owner.patientId,owner.orthoCaseId,owner.clinicalCaseId,op.actor.userId,input.commandId,input.requestFingerprint],false,undefined,{maxRows:1})).rows;
      row = returning(inserted,owner,op,input.commandId,input.requestFingerprint,'cancelled',null,null,false); await audit(op,row,'cancelled_before_arrival');
    } else if (input.action === 'cancel' && row.state === 'pending') {
      const [cancelled] = (await op.query<SubmissionRow>("UPDATE ortho_problem_source_submissions SET state='cancelled',settled_at=clock_timestamp() WHERE id=$1 RETURNING *",[row.id],false,undefined,{maxRows:1})).rows;
      row = returning(cancelled,owner,op,row.command_id,row.request_fingerprint,'cancelled',null,decodeCommand(row),false,row); await audit(op,row,'cancelled');
    } else if (input.action === 'cancel' && row.state === 'committed') problemFail(409,'problem_submission_already_committed');
    if (input.action === 'acknowledge') {
      if (row.state === 'pending') problemFail(409,'problem_submission_pending');
      if (row.acknowledged_at === null) {
        const [ack] = (await op.query<SubmissionRow>('UPDATE ortho_problem_source_submissions SET acknowledged_at=clock_timestamp(),command=NULL WHERE id=$1 RETURNING *',[row.id],false,undefined,{maxRows:1})).rows;
        row = returning(ack,owner,op,row.command_id,row.request_fingerprint,row.state,row.review_id,null,true,row); await audit(op,row,'acknowledged');
      }
    }
    await checkedOwner(op,owner,input,row); await op.current();
    return {ok:true as const,scope:{patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:owner.clinicalCaseId},actorId:op.actor.userId,
      identity:identity(row),state:row.state,acknowledged:row.acknowledged_at !== null};
  } finally { op.close(); }
}
export async function recoverProblemSubmissionWith(client:ProblemQuery,scope:ProblemScope,ports:ProblemReadPorts):Promise<ProblemSubmissionRecovery> {
  const op = createProblemOperation(client,scope,ports,'recover');
  try {
    await op.begin('journal');
    const row = await outstanding(op), discovered = await readProblemOwner(op);
    const output = (owner:ProblemOwner,recovery:ProblemSubmissionRecovery['recovery']):ProblemSubmissionRecovery => ({ok:true,actorId:op.actor.userId,
      scope:{patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:owner.clinicalCaseId},recovery});
    const finalOwner = async () => { const owner = await readProblemOwner(op,'read'); matchProblemOwner(discovered,owner); await op.current(); return owner; };
    if (!row) return output(await finalOwner(),null);
    if (!sameOriginal(row,discovered,op.actor.userId)) return output(await finalOwner(),{state:'blocked',identity:null,canCancel:false});
    if (row.state === 'cancelled') {
      const owner = await finalOwner();
      return output(owner,sameOriginal(row,owner,op.actor.userId)?{state:'cancelled',identity:identity(row)}:{state:'blocked',identity:null,canCancel:false});
    }
    const command = decodeCommand(row);
    try {
      await runProblemReview(op,command,'recovery-validation');
      const owner = await finalOwner();
      if (!sameOriginal(row,owner,op.actor.userId)) return output(owner,{state:'blocked',identity:null,canCancel:false});
      return output(owner,{state:row.state,identity:identity(row),expected:{actorId:op.actor.userId,scope:{patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:owner.clinicalCaseId},command}});
    } catch (error) {
      if (!(error instanceof ProblemFault) || error.category !== 'domain' || ![400,403,404,409].includes(error.status)) throw error;
      const owner = await finalOwner();
      const eligible = sameOriginal(row,owner,op.actor.userId) && row.state === 'pending' && await op.eligibility('cancel');
      await op.current();
      return output(owner,{state:'blocked',identity:eligible?identity(row):null,canCancel:eligible});
    }
  } finally { op.close(); }
}
