import { problemScenario } from './fixtures/ortho-problem-core';
import { describe, expect, it } from 'vitest';
import { appendProblemSourceWith, getProblemSourcesWith, findProblemReview } from '../lib/ortho-problem-review-core';
import { reserveProblemSubmissionWith, recoverProblemSubmissionWith } from '../lib/ortho-problem-submission-core';
import { createProblemOperation } from '../lib/ortho-problem-core-contract';
import { journeyContentHash } from '../lib/ortho-case-journey-hash';
import { ProblemHarness, command, candidate, problem, review, submission, scope, expected, facialCandidate, type Row } from './fixtures/ortho-problem-core';
// Independent synthetic mismatch digest; never an image or clinical-record fingerprint.
const syntheticConflictHash=journeyContentHash({fixture:'problem-companion-refresh-v1',purpose:'mismatched-source'});
const syntheticObservationClosure=journeyContentHash({fixture:'problem-companion-refresh-v1',purpose:'observation-proof'});
// Arithmetic-generated observation, unrelated to any clinical measurement.
const syntheticOverjetMm=11/4;
const append=(h:ProblemHarness,c=command())=>appendProblemSourceWith(h.client,scope,c,h.write());
const list=(h:ProblemHarness)=>getProblemSourcesWith(h.client,scope,h.read());
const replayHarness=()=>{const h=new ProblemHarness();h.problems=[problem()];h.reviews=[review()];return h;};

describe('inactive problem review transaction kernel',()=>{
  it('creates only an explicitly reviewed fact, exact snapshot and same-client audit',async()=>{
    const h=new ProblemHarness(),c=command();c.label="  Synthetic privacy fixture 3 04f3086d  ";
    const result=await append(h,c);
    expect(result).toMatchObject({ok:true,replayed:false,actorId:695444321,problemId:751402319,reviewId:612935468,requestFingerprint:journeyContentHash(c)});
    expect(h.problems[0]).toMatchObject({label:"Synthetic privacy fixture 3 04f3086d",specialty:'orthodontics',noted_by:"Synthetic reviewer B 04f3086d",case_id:788771589});
    expect(h.reviews[0]).toMatchObject({recorded_patient_id:734599007,source_snapshot:candidate(),reason:c.reason});
    expect(h.audits).toEqual([{actor:h.actor,entityId:612935468,action:'ortho.problem_source.review',entity:'ortho_problem_source_reviews',details:{patientId:734599007,orthoCaseId:639752548,problemId:751402319,sourceIdentity:'clinical_diagnosis:skeletal',sourceVersion:c.source.version,action:'create',requestFingerprint:journeyContentHash(c)}}]);
  });
  it('links an active same-case problem without asserting clinical creation',async()=>{
    const h=new ProblemHarness();h.problems=[problem()];h.createAllowed=false;
    const c=command();c.action='link';c.label=null;c.problemId=751402319;
    await expect(append(h,c)).resolves.toMatchObject({problemId:751402319,replayed:false});expect(h.problems).toHaveLength(1);expect(h.creates).toBe(0);
  });
  it.each([false,null,'true',1])('refuses clinicianReviewed=%s',async flag=>{
    const h=new ProblemHarness(),c={...command(),clinicianReviewed:flag};
    await expect(appendProblemSourceWith(h.client,scope,c,h.write())).rejects.toThrow();expect(h.sql).toHaveLength(0);
  });
  it('detaches raw command and nested source before any await',async()=>{
    const h=new ProblemHarness(),c=command(),hash=journeyContentHash(c);
    h.onQuery=()=>{c.source.version=`sha256:${syntheticConflictHash}`;c.label='Mutated';c.reason='Changed';};
    const result=await append(h,c);expect(result.requestFingerprint).toBe(hash);expect(h.problems[0].label).toBe("Synthetic privacy fixture 3 04f3086d");
  });
  it.each(['assessment','active','retention','completed','discontinued'])('preserves reference documentation status %s without lifecycle mutation',async status=>{
    const h=new ProblemHarness();h.owner.status=status;await append(h);expect(h.owner.status).toBe(status);
  });
  it.each(['intake','cancelled','toString',null])('rejects unsupported owner status %s',async status=>{
    const h=new ProblemHarness();h.owner.status=status;await expect(append(h)).rejects.toMatchObject({code:'invalid_case_state'});
  });
  it('new source revision keeps longitudinal identity and must explicitly link',async()=>{
    const h=replayHarness(),c=command();c.commandId='problem_command_002';c.source.id=52;c.source.version=`sha256:${syntheticConflictHash}`;c.expectedReviewId=612935468;c.action='link';c.problemId=751402319;c.label=null;
    h.candidates[0].ref={...c.source};
    const result=await append(h,c);expect(result.sourceIdentity).toBe('clinical_diagnosis:skeletal');expect(h.reviews[1].supersedes_review_id).toBe(612935468);expect(h.creates).toBe(0);
  });
  it.each(['head','version','create'])('refuses %s conflict without writes',async kind=>{
    const h=replayHarness(),c=command();c.commandId='problem_command_002';
    if(kind!=='head')c.expectedReviewId=612935468;
    if(kind==='create'){c.source.version=`sha256:${syntheticConflictHash}`;h.candidates[0].ref={...c.source};}
    await expect(append(h,c)).rejects.toMatchObject({code:kind==='head'?'problem_review_changed':kind==='version'?'problem_source_already_reviewed':'problem_source_has_problem'});expect(h.reviews).toHaveLength(1);
  });
  it.each(['inactive','foreign','missing'])('refuses %s link target',async kind=>{
    const h=new ProblemHarness();h.problems=kind==='missing'?[]:[{...problem(),...(kind==='inactive'?{status:'resolved'}:{case_id:99})}];
    const c=command();c.action='link';c.problemId=751402319;c.label=null;await expect(append(h,c)).rejects.toMatchObject({code:'problem_not_active_in_case'});expect(h.reviews).toHaveLength(0);
  });
  it('refuses active normalized label/site duplicate, but permits different site',async()=>{
    const h=new ProblemHarness();h.problems=[{...problem(),label:"  SYNTHETIC PRIVACY FIXTURE 3 04F3086D  "}];await expect(append(h)).rejects.toMatchObject({code:'matching_problem_exists'});
    h.problems[0].site='different';await expect(append(h)).resolves.toMatchObject({replayed:false});
  });
  it('ordinary replay accepts stale/unavailable source and resolved problem without capture/create/audit',async()=>{
    const h=replayHarness();h.problems[0].status='resolved';h.candidates=[];h.captureError=Error('must not capture');h.createAllowed=false;
    await expect(append(h)).resolves.toMatchObject({replayed:true,reviewId:612935468});expect(h.captures).toBe(0);expect(h.creates).toBe(0);expect(h.audits).toHaveLength(0);
  });
  it.each(['missing','foreign'])('exact replay refuses %s linked problem',async kind=>{
    const h=replayHarness();if(kind==='missing')h.problems=[];else h.problems[0].case_id=99;
    await expect(append(h)).rejects.toMatchObject({code:'problem_unavailable'});
  });
  it('fresh-source recovery blocks the same stale replay ordinary append accepts',async()=>{
    const h=replayHarness();h.candidates=[];await append(h);h.submissions=[submission(command(),'committed')];
    const result=await recoverProblemSubmissionWith(h.client,scope,h.read());expect(result.recovery).toEqual({state:'blocked',identity:null,canCancel:false});expect(h.captures).toBe(1);
  });
  it('does not rewrite complete command fingerprint to its trimmed label or source ref',async()=>{
    const h=replayHarness(),c=command();c.label="  Synthetic privacy fixture 3 04f3086d  ";await expect(append(h,c)).rejects.toMatchObject({code:'request_key_conflict'});
  });
  it('whole saved image-dependent history fails closed for unrelated non-image list',async()=>{
    const h=replayHarness();(h.reviews[0].source_snapshot as ReturnType<typeof candidate>).requiresImages=true;h.imagesAllowed=false;
    await expect(list(h)).rejects.toMatchObject({code:'image_revoked'});expect(h.captures).toBe(0);
  });
  it('non-image list works without image permission and never generates numerical diagnoses',async()=>{
    const h=new ProblemHarness();h.imagesAllowed=false;const result=await list(h);expect(result.candidates[0].summary).toBe("Synthetic privacy fixture 3 04f3086d");expect(h.problems).toHaveLength(0);expect(h.reviews).toHaveLength(0);
  });
  it('lists current, newer and unavailable history states without editing history',async()=>{
    const h=replayHarness();expect((await list(h)).reviews[0].currentSourceState).toBe('current');
    h.candidates[0].ref.version=`sha256:${syntheticConflictHash}`;expect((await list(h)).reviews[0].currentSourceState).toBe('newer_version');
    h.candidates=[];expect((await list(h)).reviews[0].currentSourceState).toBe('unavailable');
  });
  it('reservation validates create semantics but never asserts mutation or creates facts',async()=>{
    const h=new ProblemHarness();h.createAllowed=false;await reserveProblemSubmissionWith(h.client,{...expected,command:command()},h.write());
    expect(h.creates).toBe(0);expect(h.problems).toHaveLength(0);expect(h.reviews).toHaveLength(0);expect(h.submissions[0].state).toBe('pending');
  });
  it.each(['review','audit','authority'])('caller rollback removes created fact after late %s failure',async stage=>{
    const h=new ProblemHarness();
    if(stage==='audit')h.auditError=Error('audit unavailable');
    if(stage==='review')h.onQuery=(sql,_v,rows)=>{if(sql.startsWith('INSERT INTO ortho_problem_source_reviews'))rows[0].problem_id=99;};
    if(stage==='authority')h.onAudit=()=>{h.writeAllowed=false;};
    await expect(h.transaction(()=>append(h))).rejects.toThrow();expect(h.problems).toHaveLength(0);expect(h.reviews).toHaveLength(0);expect(h.audits).toHaveLength(0);
  });
  it.each(['id','patient_id','case_id','specialty','label','site','noted_by','status'])('rejects incorrect clinical INSERT RETURNING %s before review/audit',async key=>{
    const h=new ProblemHarness();h.onQuery=(sql,_v,rows)=>{if(sql.startsWith('INSERT INTO patient_problems'))rows[0][key]=key==='id'?0:'wrong';};
    await expect(h.transaction(()=>append(h))).rejects.toMatchObject({code:'invalid_problem_returning'});expect(h.reviews).toHaveLength(0);expect(h.audits).toHaveLength(0);
  });
  it.each(['actor_user_id','created_by','reason','source_version','problem_label','command_id','request_fingerprint','recorded_patient_id'])('rejects incorrect review RETURNING %s',async key=>{
    const h=new ProblemHarness();h.onQuery=(sql,_v,rows)=>{if(sql.startsWith('INSERT INTO ortho_problem_source_reviews'))rows[0][key]=key.endsWith('_id')?99:'wrong';};
    await expect(h.transaction(()=>append(h))).rejects.toThrow();expect(h.audits).toHaveLength(0);
  });
  it.each([NaN,-1,1.5,Number.MAX_SAFE_INTEGER+1,'-1','1e2',' 1'])('rejects malformed history metadata %s before reading payloads',async n=>{
    const h=new ProblemHarness();h.metadata={n,bytes:'0',images:false};await expect(list(h)).rejects.toThrow();expect(h.sql.some(s=>s.startsWith('SELECT *,octet_length'))).toBe(false);
  });
  it.each([{n:'501',bytes:'0',images:false},{n:'0',bytes:'2097153',images:false},{n:'0',bytes:'0',images:'false'}])('rejects over-budget/malformed metadata',async meta=>{
    const h=new ProblemHarness();h.metadata=meta;await expect(list(h)).rejects.toThrow();
  });
  it.each([{count:0,bytes:'262145',candidate_bytes:262145},{count:-1,bytes:'10',candidate_bytes:10},{count:0,bytes:'5',candidate_bytes:10}])('rejects malformed/prospective SQL storage budget before insert',async budget=>{
    const h=new ProblemHarness();h.budget=budget;await expect(append(h)).rejects.toThrow();expect(h.problems).toHaveLength(0);
  });
  it('rejects history count and snapshot-byte mismatch rather than truncating',async()=>{
    for(const metadata of [{n:'0',bytes:'0',images:false},{n:'1',bytes:'1',images:false}]){const h=replayHarness();h.metadata=metadata;await expect(list(h)).rejects.toThrow();}
  });
  it('rejects more than 500 case problems',async()=>{
    const h=new ProblemHarness();h.problems=Array.from({length:501},(_,i)=>problem(i+1));await expect(list(h)).rejects.toMatchObject({code:'problem_list_budget'});
  });
  it.each(['patient_id','recorded_patient_id','clinical_case_id','source_identity','source_version','supersedes_review_id'])('rejects invalid saved history %s',async key=>{
    const h=replayHarness();h.reviews[0][key]=key.endsWith('_id')?99:'wrong';await expect(list(h)).rejects.toThrow();
  });
  it('detaches returned source and history rows before post-query authority waits',async()=>{
    const h=replayHarness();let mutate=false;
    h.onQuery=sql=>{if(sql.startsWith('SELECT *,octet_length')&&sql.includes('ORDER BY'))mutate=true;};
    h.onAssert=()=>{if(mutate){mutate=false;h.reviews[0].reason='mutated after response';}};
    // Duplicate read sees newer conflicting row and fails, never returns mixed evidence.
    await expect(append(h)).rejects.toMatchObject({code:'invalid_problem_history'});
  });
  it.each(['review','journal'])('direct append cannot bypass %s journal history',async kind=>{
    const h=new ProblemHarness();h.submissions=[submission(command(),kind==='review'?'pending':'cancelled')];
    if(kind==='journal')h.submissions[0].acknowledged_at=problemScenario.acknowledged;
    if(kind==='journal')h.submissions[0].command=null;
    await expect(append(h)).rejects.toMatchObject({code:'problem_submission_requires_journal'});expect(h.problems).toHaveLength(0);
  });
  it('owner change during source wait fails before clinical insert',async()=>{
    const h=new ProblemHarness();h.onCapture=()=>{h.bridges[0].id=32;};await expect(append(h)).rejects.toThrow();expect(h.problems).toHaveLength(0);
  });
  it('rejects source candidate without required trusted proof',async()=>{
    const h=new ProblemHarness();h.onProof=p=>{delete (p as unknown as Row).locked;};await expect(append(h)).rejects.toMatchObject({code:'invalid_problem_source_proof'});
  });
});


describe('reviewer paired source-owner and site boundaries',()=>{
  it.each(['patientId','orthoCaseId','clinicalCaseId'] as const)('rejects self-consistent foreign facial %s from live evidence',async key=>{
    const h=new ProblemHarness(),f=facialCandidate(),r=(f.candidate.snapshot as {revision:Row}).revision;
    r[key]=99;if(key==='patientId')r.recordedPatientId=99;
    f.candidate.ref.version=`sha256:${journeyContentHash(r)}`;f.proof.sourceVersion=f.candidate.ref.version;
    h.candidates=[f.candidate];h.proof=()=>f.proof;
    await expect(list(h)).rejects.toThrow();
  });
  it.each(['patientId','orthoCaseId','clinicalCaseId'] as const)('rejects foreign facial %s in saved history even without source capture',async key=>{
    const h=new ProblemHarness(),f=facialCandidate(),r=(f.candidate.snapshot as {revision:Row}).revision;
    r[key]=99;if(key==='patientId')r.recordedPatientId=99;
    f.candidate.ref.version=`sha256:${journeyContentHash(r)}`;
    const c=command();c.source=f.candidate.ref;h.problems=[problem()];h.reviews=[{...review(c),source_snapshot:f.candidate,snapshot_bytes:JSON.stringify(f.candidate).length}];
    await expect(append(h,c)).rejects.toThrow();expect(h.captures).toBe(0);
  });
  it('accepts original-owner facial evidence and exact replay',async()=>{
    const h=new ProblemHarness(),f=facialCandidate();h.candidates=[f.candidate];h.proof=()=>f.proof;
    expect((await list(h)).candidates).toHaveLength(1);
    const c=command();c.source=f.candidate.ref;h.problems=[problem()];h.reviews=[{...review(c),source_snapshot:f.candidate,snapshot_bytes:JSON.stringify(f.candidate).length}];
    await expect(append(h,c)).resolves.toMatchObject({replayed:true});
  });
  it.each([false,true])('preserves observation site derivation (tampered=%s)',async tampered=>{
    const h=new ProblemHarness(),c=candidate();c.ref={kind:'assessment_observation',id:9,member:'synthetic_overjet_case_v1',version:c.ref.version};c.identity='assessment_observation:synthetic_overjet_case_v1';c.summary=`${syntheticOverjetMm} mm`;c.proposedLabel=null;c.site=tampered?'FDI 18':null; // Valid schema tooth code deliberately conflicts with the case-level target.
    c.snapshot={observation:{id:'synthetic_overjet_case_v1',definition:'overjet',definitionVersion:1,label:'Synthetic case-level overjet observation',unit:'mm',target:{kind:'case'},value:{state:'measured',value:syntheticOverjetMm},occurredOn:{state:'unknown',reason:'Synthetic observation without an assigned date'},provenance:{performer:{state:'unknown'},method:{version:1,kind:'direct_examination',description:'Synthetic direct-examination method placeholder'},sources:[],copiedFrom:null}},revisionVersion:1,sourceStates:[]};
    h.candidates=[c];h.proof=()=>({kind:'assessment_observation',revisionId:9,schemaVersion:2,closureHash:syntheticObservationClosure,sourceVersion:c.ref.version,complete:true});
    if(tampered)await expect(list(h)).rejects.toThrow();else expect((await list(h)).candidates[0].site).toBeNull();
  });
});


describe('clinical authority at full review and problem reads',()=>{
  it.each([false,true])('complete list requires C before full history SQL (allowed=%s)',async allowed=>{
    const h=replayHarness();h.clinicalAllowed=allowed;
    if(allowed){expect((await list(h)).reviews).toHaveLength(1);expect(h.clinicals).toBeGreaterThan(0);}
    else {await expect(list(h)).rejects.toMatchObject({code:'clinical_revoked',category:'authority'});expect(h.sql.some(s=>s.startsWith('SELECT *,octet_length'))).toBe(false);expect(h.captures).toBe(0);}
  });
  it.each([false,true])('duplicate full review lookup requires C before SQL (allowed=%s)',async allowed=>{
    const h=replayHarness();h.clinicalAllowed=allowed;const op=createProblemOperation(h.client,scope,h.write(),'execute');
    try{await op.begin();if(allowed){expect((await findProblemReview(op,command().commandId))?.id).toBe(612935468);expect(h.clinicals).toBeGreaterThan(0);}
      else{await expect(findProblemReview(op,command().commandId)).rejects.toMatchObject({code:'clinical_revoked'});expect(h.sql.some(s=>s.includes('FROM ortho_problem_source_reviews'))).toBe(false);}}
    finally{op.close();}
  });
  it.each([false,true])('live problem choices are protected after source wait (revoked=%s)',async revoked=>{
    const h=new ProblemHarness();h.onCapture=()=>{if(revoked)h.clinicalAllowed=false;};
    if(revoked){await expect(list(h)).rejects.toMatchObject({code:'clinical_revoked'});expect(h.sql.some(s=>s.includes('FROM patient_problems'))).toBe(false);}
    else{await list(h);expect(h.sql.some(s=>s.includes('FROM patient_problems'))).toBe(true);expect(h.clinicals).toBeGreaterThan(0);}
  });
  it.each(['history','problems'] as const)('revocation during full %s SQL refuses output',async kind=>{
    const h=replayHarness();h.onQuery=sql=>{if(kind==='history'?sql.startsWith('SELECT *,octet_length')&&sql.includes('ORDER BY'):sql.includes('FROM patient_problems'))h.clinicalAllowed=false;};
    await expect(list(h)).rejects.toMatchObject({code:'clinical_revoked',category:'authority'});
    if(kind==='history')expect(h.captures).toBe(0);
  });
  it('ordinary exact replay requires C but never fresh source capture or creation permission',async()=>{
    const h=replayHarness();h.problems[0].status='resolved';h.candidates=[];h.createAllowed=false;h.captureError=Error('must not capture');
    await expect(append(h)).resolves.toMatchObject({replayed:true});expect(h.clinicals).toBeGreaterThan(0);expect(h.creates).toBe(0);expect(h.captures).toBe(0);
    h.clinicalAllowed=false;await expect(append(h)).rejects.toMatchObject({code:'clinical_revoked'});expect(h.captures).toBe(0);
  });
  it('late C revocation at audit refuses success and caller rollback restores all facts',async()=>{
    const h=new ProblemHarness();h.onAudit=()=>{h.clinicalAllowed=false;};
    await expect(h.transaction(()=>append(h))).rejects.toMatchObject({code:'clinical_revoked',category:'authority'});expect(h.problems).toHaveLength(0);expect(h.reviews).toHaveLength(0);expect(h.audits).toHaveLength(0);
  });
  it('new link needs C but never D',async()=>{
    const h=new ProblemHarness();h.problems=[problem()];h.createAllowed=false;const c=command();c.action='link';c.problemId=751402319;c.label=null;
    await expect(append(h,c)).resolves.toMatchObject({replayed:false});expect(h.clinicals).toBeGreaterThan(0);expect(h.creates).toBe(0);
  });
});
