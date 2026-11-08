import { describe, expect, it } from 'vitest';
import { reserveProblemSubmissionWith, executeProblemSubmissionWith, transitionProblemSubmissionWith, recoverProblemSubmissionWith } from '../lib/ortho-problem-submission-core';
import { journeyContentHash } from '../lib/ortho-case-journey-hash';
import { ProblemFault } from '../lib/ortho-problem-core-contract';
import { ProblemHarness, command, problem, review, submission, scope, expected, problemScenario, facialCandidate, type Row } from './fixtures/ortho-problem-core';
// Literal IDs such as 99/32/72 are deliberately foreign-key mismatch sentinels.
// Timestamps and expected identities below come from the reviewed synthetic core fixture.
const reserve=(h:ProblemHarness,c=command())=>reserveProblemSubmissionWith(h.client,{...expected,command:c},h.write());
const execute=(h:ProblemHarness,c=command())=>executeProblemSubmissionWith(h.client,{...expected,command:c},h.write());
const recover=(h:ProblemHarness)=>recoverProblemSubmissionWith(h.client,scope,h.read());
const transition=(h:ProblemHarness,action:'cancel'|'acknowledge',c=command())=>transitionProblemSubmissionWith(h.client,{...expected,commandId:c.commandId,requestFingerprint:journeyContentHash(c),action},h.write());
const committed=()=>{const h=new ProblemHarness();h.reviews=[review()];h.problems=[problem()];h.submissions=[submission(command(),'committed')];return h;};

describe('inactive problem durable submission state machine',()=>{
  it('separates reservation and execution lifetimes with no implicit reserve',async()=>{
    const h=new ProblemHarness();await expect(execute(h)).rejects.toMatchObject({code:'request_key_conflict'});expect(h.submissions).toHaveLength(0);
    await h.transaction(()=>reserve(h));expect(h.submissions[0].state).toBe('pending');expect(h.problems).toHaveLength(0);
    const result=await h.transaction(()=>execute(h));expect(result.replayed).toBe(false);expect(h.submissions[0]).toMatchObject({state:'committed',review_id:612935468});
    expect(h.audits.map(a=>a.action==='ortho.problem_submission'?a.details.event:'review')).toEqual(['reserved','review','committed']);
    expect(h.sql.some(sql=>/^(BEGIN|COMMIT|ROLLBACK)\b/.test(sql))).toBe(false);
  });
  it('acquires review and journal table fences before patient/owner authority',async()=>{
    const h=new ProblemHarness();let first=true;h.onAssert=()=>{if(first){first=false;expect(h.sql.slice(0,2)).toEqual(['LOCK TABLE ortho_problem_source_reviews IN ROW EXCLUSIVE MODE','LOCK TABLE ortho_problem_source_submissions IN ROW EXCLUSIVE MODE']);}};
    await reserve(h);
  });
  it('existing exact reserve skips source capture and new reserved audit',async()=>{
    const h=new ProblemHarness();await reserve(h);h.captureError=Error('must not capture');const before=h.captures;await reserve(h);expect(h.captures).toBe(before);expect(h.audits).toHaveLength(1);
  });
  it('adopts pre-journal exact review as committed without new clinical fact',async()=>{
    const h=committed();h.submissions=[];h.candidates=[];await reserve(h);expect(h.submissions[0]).toMatchObject({state:'committed',review_id:612935468,settled_at:problemScenario.settled});expect(h.reviews).toHaveLength(1);expect(h.problems).toHaveLength(1);expect(h.captures).toBe(0);expect(h.audits.map(a=>a.details)).toEqual([{event:'reserved',orthoCaseId:639752548,requestFingerprint:journeyContentHash(command()),state:'committed'}]);
  });
  it.each(['pending','committed','cancelled'] as const)('all %s unacknowledged case rows block another actor/key',async state=>{
    const h=new ProblemHarness();h.submissions=[{...submission(command(),state),actor_user_id:99}];const c=command();c.commandId='another_command_001';
    await expect(reserve(h,c)).rejects.toMatchObject({code:'problem_submission_unacknowledged'});expect(h.captures).toBe(0);
  });
  it('different content under same key conflicts even if sources are available',async()=>{
    const h=new ProblemHarness();await reserve(h);const c=command();c.reason='Different';await expect(reserve(h,c)).rejects.toMatchObject({code:'request_key_conflict'});await expect(execute(h,c)).rejects.toMatchObject({code:'request_key_conflict'});
  });
  it('acknowledged committed execute uses only exact fingerprint-matching caller command',async()=>{
    const h=committed();h.submissions[0].acknowledged_at=problemScenario.acknowledged;h.submissions[0].command=null;h.createAllowed=false;h.candidates=[];
    await expect(execute(h)).resolves.toMatchObject({replayed:true,reviewId:612935468});expect(h.creates).toBe(0);expect(h.audits).toHaveLength(0);
    const c=command();c.reason='Changed';await expect(execute(h,c)).rejects.toMatchObject({code:'request_key_conflict'});
  });
  it.each([
    {state:'pending',command:null},{state:'pending',acknowledged_at:problemScenario.acknowledged},{state:'pending',settled_at:problemScenario.settled},{state:'pending',review_id:612935468},
    {state:'committed',review_id:null,settled_at:problemScenario.settled},{state:'committed',review_id:612935468,settled_at:null},
    {state:'committed',review_id:612935468,settled_at:problemScenario.settled,command:null},{state:'cancelled',review_id:612935468,settled_at:problemScenario.settled},
    {state:'cancelled',settled_at:null},{state:'cancelled',settled_at:problemScenario.settled,acknowledged_at:problemScenario.acknowledged},
    {settled_at:problemScenario.prematureSettlement},{created_at:'not a date'},
  ])('rejects illegal journal envelope %j',async patch=>{
    const h=new ProblemHarness();h.submissions=[{...submission(),...patch}];await expect(execute(h)).rejects.toThrow();expect(h.captures).toBe(0);expect(h.problems).toHaveLength(0);
  });
  it('retained command hash mismatch is corruption, not blocked recovery',async()=>{
    const h=new ProblemHarness();h.submissions=[submission()];(h.submissions[0].command as Row).reason='Changed';await expect(recover(h)).rejects.toMatchObject({code:'invalid_problem_submission'});
  });
  it('committed result mismatch fails instead of returning unrelated receipt',async()=>{
    const h=committed();h.submissions[0].review_id=72;await expect(execute(h)).rejects.toMatchObject({code:'problem_submission_result_mismatch'});
  });
  it('pre-arrival cancellation inserts NULL payload tombstone, repeated cancel has no audit',async()=>{
    const h=new ProblemHarness();h.createAllowed=false;h.imagesAllowed=false;h.captureError=Error('no sources');
    const result=await transition(h,'cancel');expect(result).toMatchObject({state:'cancelled',acknowledged:false});expect(h.submissions[0]).toMatchObject({command:null,review_id:null,state:'cancelled'});
    await transition(h,'cancel');expect(h.audits).toHaveLength(1);expect(h.captures).toBe(0);expect(h.creates).toBe(0);
  });
  it.each(['same','different'])('pre-arrival cancellation refuses %s fingerprint pre-journal review',async kind=>{
    const h=committed();h.submissions=[];const c=command();if(kind==='different')c.reason='Changed';
    await expect(transition(h,'cancel',c)).rejects.toMatchObject({code:kind==='same'?'problem_submission_already_committed':'request_key_conflict'});expect(h.submissions).toHaveLength(0);
  });
  it('pending cancellation retains payload until explicit terminal acknowledgment',async()=>{
    const h=new ProblemHarness();await reserve(h);await transition(h,'cancel');expect(h.submissions[0]).toMatchObject({state:'cancelled',command:command()});
    await transition(h,'acknowledge');expect(h.submissions[0]).toMatchObject({command:null,acknowledged_at:problemScenario.acknowledged});
    const count=h.audits.length;await transition(h,'acknowledge');expect(h.audits).toHaveLength(count);
  });
  it('terminal acknowledgment unblocks another exact command only after acknowledgment',async()=>{
    const h=new ProblemHarness();await transition(h,'cancel');const c=command();c.commandId='problem_command_002';await expect(reserve(h,c)).rejects.toMatchObject({code:'problem_submission_unacknowledged'});
    await transition(h,'acknowledge');await reserve(h,c);expect(h.submissions).toHaveLength(2);
  });
  it('cannot acknowledge pending, cancel committed, or reuse cancelled key',async()=>{
    const h=new ProblemHarness();await reserve(h);await expect(transition(h,'acknowledge')).rejects.toMatchObject({code:'problem_submission_pending'});
    await execute(h);await expect(transition(h,'cancel')).rejects.toMatchObject({code:'problem_submission_already_committed'});
    const other=new ProblemHarness();await transition(other,'cancel');await transition(other,'acknowledge');await expect(reserve(other)).rejects.toMatchObject({code:'problem_submission_cancelled'});await expect(execute(other)).rejects.toMatchObject({code:'problem_submission_cancelled'});
  });
  it('missing acknowledgment is not found without source access',async()=>{
    const h=new ProblemHarness();await expect(transition(h,'acknowledge')).rejects.toMatchObject({code:'problem_submission_not_found'});expect(h.captures).toBe(0);
  });
  it.each(['pending','committed','cancelled'] as const)('keeps original ownership for %s and acknowledged tombstones',async state=>{
    for(const acknowledged of [false,true]){
      if(state==='pending'&&acknowledged)continue;
      const h=committed();h.submissions=[submission(command(),state)];if(acknowledged){h.submissions[0].acknowledged_at=problemScenario.acknowledged;h.submissions[0].command=null;}
      h.submissions[0].clinical_case_id=32;
      await expect(transition(h,'cancel')).rejects.toMatchObject({code:'problem_submission_context_changed'});
      await expect(reserve(h)).rejects.toMatchObject({code:'problem_submission_context_changed'});
    }
  });
  it.each(['recorded_patient_id','actor_user_id','patient_id','ortho_case_id','clinical_case_id'])('does not disclose foreign %s journal command/key on recovery',async key=>{
    const h=new ProblemHarness();h.submissions=[submission()];h.submissions[0][key]=99;
    if(key==='patient_id')h.submissions[0].recorded_patient_id=99;
    if(key==='recorded_patient_id') {await expect(recover(h)).rejects.toMatchObject({code:'invalid_problem_submission'});return;}
    const result=await recover(h);
    expect(result.recovery).toEqual(key==='ortho_case_id'?null:{state:'blocked',identity:null,canCancel:false});expect(JSON.stringify(result)).not.toContain(command().commandId);expect(h.captures).toBe(0);
  });
  it('create revoked after committed reserve preserves durable intent but metadata cancel remains independent',async()=>{
    const h=new ProblemHarness();await h.transaction(()=>reserve(h));h.createAllowed=false;
    await expect(h.transaction(()=>execute(h))).rejects.toMatchObject({code:'create_revoked'});expect(h.submissions[0].state).toBe('pending');expect(h.problems).toHaveLength(0);
    h.captureError=Error('unavailable');h.imagesAllowed=false;await transition(h,'cancel');expect(h.submissions[0].state).toBe('cancelled');
  });
  it('metadata revocation retains pending block; re-grant admits only original exact retry',async()=>{
    const h=new ProblemHarness();await reserve(h);h.writeAllowed=false;
    await expect(h.transaction(()=>transition(h,'cancel'))).rejects.toMatchObject({code:'write_revoked'});expect(h.submissions[0].state).toBe('pending');
    h.writeAllowed=true;const c=command();c.reason='Changed';await expect(execute(h,c)).rejects.toMatchObject({code:'request_key_conflict'});await execute(h);expect(h.submissions[0].state).toBe('committed');
  });
  it('pending command remains readable after create/write revocation, not an execution grant',async()=>{
    const h=new ProblemHarness();await reserve(h);h.writeAllowed=false;h.createAllowed=false;
    const result=await recover(h);expect(result.recovery).toMatchObject({state:'pending',expected:{command:command(),actorId:695444321}});expect(h.creates).toBe(0);
  });
  it.each([true,false])('blocked pending cancellation eligibility %s uses independent metadata policy',async allowed=>{
    const h=new ProblemHarness();await reserve(h);h.candidates=[];h.cancelledAllowed=allowed;
    expect((await recover(h)).recovery).toEqual({state:'blocked',identity:allowed?{id:743062302,commandId:command().commandId,requestFingerprint:journeyContentHash(command())}:null,canCancel:allowed});
  });
  it('cancelled recovery ignores unavailable images/sources and never decodes absent command',async()=>{
    const h=new ProblemHarness();await transition(h,'cancel');h.imagesAllowed=false;h.captureError=Error('not used');expect((await recover(h)).recovery).toMatchObject({state:'cancelled',identity:{id:743062302}});expect(h.captures).toBe(0);
  });
  it.each([new ProblemFault(401,'expired'),new ProblemFault(500,'corrupt'),Error('infrastructure'),new ProblemFault(403,'expired_handle','authority'),new ProblemFault(409,'bad_witness','integrity')])('propagates recovery fault %s rather than blocked success',async error=>{
    const h=new ProblemHarness();await reserve(h);h.captureError=error;await expect(recover(h)).rejects.toThrow(error.message);
  });
  it('source-domain refusal yields blocked but current read revocation hides command',async()=>{
    const h=new ProblemHarness();await reserve(h);h.captureError=new ProblemFault(409,'problem_source_changed');expect((await recover(h)).recovery).toMatchObject({state:'blocked'});
    h.onCapture=()=>{h.readAllowed=false;};await expect(recover(h)).rejects.toMatchObject({code:'read_revoked',category:'authority'});
  });
  it.each(['reserve','execute','cancel','acknowledge'] as const)('rejects malformed %s RETURNING before success or audit',async action=>{
    const h=action==='acknowledge'?committed():new ProblemHarness();if(action==='execute')await reserve(h);
    const count=h.audits.length;h.onQuery=(sql,_v,rows)=>{if((sql.startsWith('INSERT INTO ortho_problem_source_submissions')||sql.startsWith('UPDATE ortho_problem_source_submissions'))&&rows[0])rows[0].actor_user_id=99;};
    const run=action==='reserve'?()=>reserve(h):action==='execute'?()=>execute(h):()=>transition(h,action);
    await expect(h.transaction<unknown>(run)).rejects.toMatchObject({code:'invalid_problem_submission_returning'});expect(h.audits).toHaveLength(count);
  });
  it.each(['command','request_fingerprint','command_id','state','review_id','patient_id','recorded_patient_id','created_at'])('validates exact transition RETURNING %s',async key=>{
    const h=new ProblemHarness();await reserve(h);h.onQuery=(sql,_v,rows)=>{if(sql.startsWith('UPDATE'))rows[0][key]=key==='command'?null:key.endsWith('_id')?99:'wrong';};
    await expect(h.transaction(()=>transition(h,'cancel'))).rejects.toThrow();expect(h.submissions[0].state).toBe('pending');
  });
  it('raw first-arrival actor/scope/command mutation cannot retarget intent',async()=>{
    const h=new ProblemHarness(),input={...expected,command:command()};h.onQuery=()=>{input.actorId=99;input.clinicalCaseId=99;input.command.source.id=99;};
    await reserveProblemSubmissionWith(h.client,input,h.write());expect(h.submissions[0]).toMatchObject({actor_user_id:695444321,clinical_case_id:788771589,command:command()});
  });
  it.each(['actor','bridge'])('rejects stale first-arrival %s before source read',async kind=>{
    const h=new ProblemHarness(),input={...expected,command:command(),...(kind==='actor'?{actorId:99}:{clinicalCaseId:99})};await expect(reserveProblemSubmissionWith(h.client,input,h.write())).rejects.toThrow();expect(h.captures).toBe(0);
  });
  it('image-dependent replay rechecks image authority after journal settlement audit',async()=>{
    const h=new ProblemHarness(),f=facialCandidate(),c=command();c.source=f.candidate.ref;
    h.reviews=[{...review(c),source_snapshot:f.candidate,snapshot_bytes:JSON.stringify(f.candidate).length}];h.problems=[problem()];h.submissions=[submission(c)];
    h.onAudit=()=>{h.imagesAllowed=false;};
    await expect(h.transaction(()=>execute(h,c))).rejects.toMatchObject({code:'image_revoked'});
    expect(h.submissions[0].state).toBe('pending');expect(h.captures).toBe(0);
  });
  it('fresh authority after journal audit refuses late revocation with caller rollback',async()=>{
    const h=new ProblemHarness();await reserve(h);h.onAudit=()=>{if(h.audits.at(-1)?.action==='ortho.problem_submission')h.writeAllowed=false;};
    await expect(h.transaction(()=>execute(h))).rejects.toMatchObject({code:'write_revoked'});expect(h.submissions[0].state).toBe('pending');expect(h.reviews).toHaveLength(0);expect(h.problems).toHaveLength(0);
  });
});


it('metadata-only pre-arrival cancellation selects no clinical source payload',async()=>{
  const h=committed();h.submissions=[];h.imagesAllowed=false;
  await expect(transition(h,'cancel')).rejects.toMatchObject({code:'problem_submission_already_committed'});
  const selected=h.sql.filter(s=>s.includes('FROM ortho_problem_source_reviews'));
  expect(selected).toHaveLength(1);
  expect(selected[0]).not.toMatch(/source_snapshot|SELECT \*/);
  expect(h.captures).toBe(0);
});


/** Metadata controls exercise legacy kernel behavior only. They do NOT prove
 * canonical metadata-first payload projection, which remains separately held. */
describe('clinical-read branch separation from journal metadata',()=>{
  const metadataOnly=(h:ProblemHarness)=>{h.clinicalAllowed=false;h.createAllowed=false;h.imagesAllowed=false;h.captureError=Error('metadata must not capture sources');};
  it.each(['pending','committed'] as const)('E-only existing %s reserve needs no C/D/X',async state=>{
    const h=new ProblemHarness();h.submissions=[submission(command(),state)];metadataOnly(h);
    await expect(reserve(h)).resolves.toMatchObject({ok:true,identity:{id:743062302}});expect(h.clinicals).toBe(0);expect(h.creates).toBe(0);expect(h.captures).toBe(0);
  });
  it.each(['pending','pre-arrival','cancel-repeat','acknowledge','ack-repeat','pending-ack'] as const)('E-only %s keeps clinical permission out of metadata admission',async branch=>{
    const h=new ProblemHarness();
    if(branch==='pending'||branch==='pending-ack')h.submissions=[submission()];
    if(branch==='cancel-repeat')h.submissions=[submission(command(),'cancelled')];
    if(branch==='acknowledge'||branch==='ack-repeat')h.submissions=[submission(command(),'committed')];
    if(branch==='ack-repeat'){h.submissions[0].command=null;h.submissions[0].acknowledged_at=problemScenario.acknowledged;}
    metadataOnly(h);
    if(branch==='pending-ack')await expect(transition(h,'acknowledge')).rejects.toMatchObject({code:'problem_submission_pending'});
    else await expect(transition(h,branch==='acknowledge'||branch==='ack-repeat'?'acknowledge':'cancel')).resolves.toMatchObject({ok:true});
    expect(h.clinicals).toBe(0);expect(h.creates).toBe(0);expect(h.captures).toBe(0);
  });
  it.each(['empty','cancelled'] as const)('V-only %s recovery requires no clinical permission',async state=>{
    const h=new ProblemHarness();if(state==='cancelled')h.submissions=[{...submission(command(),'cancelled'),command:null}];metadataOnly(h);h.writeAllowed=false;
    const result=await recover(h);expect(result.recovery).toEqual(state==='empty'?null:{state:'cancelled',identity:{id:743062302,commandId:command().commandId,requestFingerprint:journeyContentHash(command())}});expect(h.clinicals).toBe(0);expect(h.captures).toBe(0);
  });
  it('new create reservation requires C for fact validation but does not assert D',async()=>{
    const h=new ProblemHarness();h.createAllowed=false;await reserve(h);expect(h.clinicals).toBeGreaterThan(0);expect(h.creates).toBe(0);expect(h.problems).toHaveLength(0);
    const denied=new ProblemHarness();denied.createAllowed=false;denied.clinicalAllowed=false;await expect(reserve(denied)).rejects.toMatchObject({code:'clinical_revoked'});expect(denied.submissions).toHaveLength(0);
  });
  it.each(['pending','committed'] as const)('C absent on %s recovery fails as authority, not blocked-success',async state=>{
    const h=state==='committed'?committed():new ProblemHarness();if(state==='pending')h.submissions=[submission()];h.clinicalAllowed=false;
    await expect(recover(h)).rejects.toMatchObject({code:'clinical_revoked',category:'authority'});expect(h.captures).toBe(0);
  });
  it.each([403,409])('domain-shaped C error%s cannot enter recovery domain fallback',async status=>{
    const h=new ProblemHarness();h.submissions=[submission()];h.clinicalError=new ProblemFault(status,'clinical_source_denied','domain');
    await expect(recover(h)).rejects.toMatchObject({status,code:'clinical_source_denied',category:'authority'});
  });
  it('C revocation during journal settlement audit cannot publish an otherwise valid receipt',async()=>{
    const h=new ProblemHarness();await reserve(h);h.onAudit=()=>{if(h.audits.at(-1)?.action==='ortho.problem_submission')h.clinicalAllowed=false;};
    await expect(h.transaction(()=>execute(h))).rejects.toMatchObject({code:'clinical_revoked'});expect(h.submissions[0].state).toBe('pending');expect(h.reviews).toHaveLength(0);
  });
  it('pre-journal already-committed cancellation check remains metadata-only without C',async()=>{
    const h=committed();h.submissions=[];metadataOnly(h);await expect(transition(h,'cancel')).rejects.toMatchObject({code:'problem_submission_already_committed'});expect(h.clinicals).toBe(0);expect(h.captures).toBe(0);
  });
});
