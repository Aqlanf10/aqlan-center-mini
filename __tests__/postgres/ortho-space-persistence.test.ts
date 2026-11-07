import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,expect,it,vi} from 'vitest';
import {createSessionToken,sessionCredentialVersion,type SessionPayload} from '../../lib/auth';
import {openPeriodontalFixture} from './_periodontal-fixture';
import {assessmentCommandV2} from '../fixtures/ortho-assessment-schema2';
import {appendOrthoAssessment} from '../../lib/ortho-assessment-store';
import {appendOrthoTreatmentStrategy} from '../../lib/ortho-treatment-strategy-store';
import {getOrthoSpaceLedger,getOrthoSpaceLedgerForPrint} from '../../lib/ortho-space-store';
import {reserveSpaceSubmission,saveJournaledSpace,getSpaceSubmissionRecovery,transitionSpaceSubmission} from '../../lib/ortho-space-submission-store';
import {journeyContentHash} from '../../lib/ortho-case-journey-hash';
import type {SpacePersistenceCommand as SpaceCommand} from '../../lib/ortho-space-command';
const request=vi.hoisted(()=>({token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='aqlan_flow_session'?{value:request.token}:undefined}),headers:async()=>new Headers()}));
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-space-secret-at-least-32-characters');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();});
afterAll(async()=>{try{await f?.close();}finally{vi.unstubAllEnvs();}});
async function setup(withImage=false){
 const key=randomUUID(),password='Synthetic credential';
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic space patient') RETURNING id",[key])).rows[0].id;
 const actorId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic doctor',$2,'admin') RETURNING id",[key,password])).rows[0].id;
 const session:SessionPayload={userId:actorId,username:key,role:'admin',credentialVersion:sessionCredentialVersion(password),expiresAt:Date.now()+600000};request.token=createSessionToken(session);
 const orthoCaseId=(await f.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'active','synthetic') RETURNING id",[patientId])).rows[0].id;
 const clinicalCaseId=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id",[patientId,orthoCaseId])).rows[0].id;
 const problemId=(await f.pool.query("INSERT INTO patient_problems(patient_id,case_id,specialty,label,noted_by) VALUES($1,$2,'orthodontics','Synthetic crowding','synthetic') RETURNING id",[patientId,clinicalCaseId])).rows[0].id;
 const scope={patientId,orthoCaseId,clinicalCaseId,actorId,session};
 const strategyCommand={schemaVersion:1,commandId:randomUUID(),expectedRevisionId:null,reason:'Synthetic explicit strategy',rows:[{problemId,objective:'Synthetic objective',strategy:'Synthetic conservative option',planItemIds:[],rationale:'Synthetic rationale'}]};
 const strategy=await appendOrthoTreatmentStrategy({...scope,command:strategyCommand});if(!strategy.ok)throw Error(strategy.code);
 const assessmentCommand=assessmentCommandV2();let documentId:number|null=null;
 if(withImage){const hash='a'.repeat(64);documentId=(await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'Synthetic basis','image/png',123,$3,'synthetic-unused-space-image','synthetic') RETURNING id",[patientId,orthoCaseId,hash])).rows[0].id;
 assessmentCommand.content.observations.observations.find(o=>o.id==='available_upper')!.provenance!.sources=[{kind:'document',id:documentId!,version:`sha256:${hash}`}];}
 const assessment=await appendOrthoAssessment({...scope,command:{...assessmentCommand,commandId:randomUUID()}});if(!assessment.ok)throw Error(assessment.code);
 const ledger=await getOrthoSpaceLedger(scope);if(!ledger.ok)throw Error(ledger.code);
 const command:SpaceCommand={schemaVersion:1,clientRequestId:randomUUID(),expectedHeadId:null,reason:'Synthetic reviewed plan',content:{kind:'plan',arch:'upper',strategyRevisionId:strategy.revision.revisionId,baseline:ledger.baselines[0].ref,gains:[],uses:[],contacts:[{teeth:[11,12],plannedUm:200,budgetGainUm:100,clinicianLimitUm:300,note:'Synthetic contact examination'}],rationale:'Synthetic choice',alternatives:'Synthetic other option'}};
 return {...scope,command,strategyCommand,assessmentId:assessment.revision.id,documentId};
}
type Prepared=Omit<Awaited<ReturnType<typeof setup>>,'command'>&{command:SpaceCommand};
const transition=(s:Prepared,action:'cancel'|'acknowledge')=>transitionSpaceSubmission({...s,action,commandId:s.command.clientRequestId,requestFingerprint:journeyContentHash(s.command)});
it('reserves without clinical write; concurrent retries produce one audited outcome and exact recovery',async()=>{
 const s=await setup();expect(await reserveSpaceSubmission(s)).toMatchObject({ok:true});
 expect((await f.pool.query('SELECT id FROM ortho_space_entries WHERE ortho_case_id=$1',[s.orthoCaseId])).rows).toEqual([]);
 expect(await getSpaceSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'pending',expected:{command:s.command}}});
 const [a,b]=await Promise.all([saveJournaledSpace(s),saveJournaledSpace(s)]);expect(a.ok&&b.ok).toBe(true);if(!a.ok||!b.ok)throw Error('save failed');expect(a.entryId).toBe(b.entryId);
 expect(await getSpaceSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'committed',expected:{command:s.command}}});
 expect(await transition(s,'acknowledge')).toMatchObject({ok:true,acknowledged:true});
 expect(await saveJournaledSpace(s)).toMatchObject({ok:true,entryId:a.entryId,replayed:true});
 expect((await f.pool.query("SELECT count(*)::int n FROM audit_log WHERE action='ortho.journey_record' AND entity='ortho_space_entries' AND entity_id=$1",[a.entryId])).rows[0].n).toBe(1);
});
it('cancellation-before-arrival survives acknowledgment and cannot become a clinical write',async()=>{
 const s=await setup();expect(await transition(s,'cancel')).toMatchObject({ok:true,state:'cancelled'});expect(await transition(s,'acknowledge')).toMatchObject({ok:true,acknowledged:true});
 expect(await saveJournaledSpace(s)).toMatchObject({ok:false,code:'space_submission_cancelled'});
});
it('rejects mismatched exact actor, case, patient and changed intent',async()=>{
 const s=await setup();expect(await reserveSpaceSubmission(s)).toMatchObject({ok:true});
 expect(await saveJournaledSpace({...s,actorId:s.actorId+9999})).toMatchObject({ok:false,code:'space_submission_actor_changed'});
 expect(await saveJournaledSpace({...s,clinicalCaseId:s.clinicalCaseId+9999})).toMatchObject({ok:false,code:'space_submission_context_changed'});
 expect(await saveJournaledSpace({...s,patientId:s.patientId+99999})).toMatchObject({ok:false});
 expect(await saveJournaledSpace({...s,command:{...s.command,reason:'Different intent'}})).toMatchObject({ok:false,code:'request_key_conflict'});
});
it('pending plan refuses a newer baseline while exact historical committed replay survives',async()=>{
 const pending=await setup();await reserveSpaceSubmission(pending);
 const newer=assessmentCommandV2();newer.expectedRevisionId=pending.assessmentId;expect((await appendOrthoAssessment({...pending,command:{...newer,commandId:randomUUID()}})).ok).toBe(true);
 expect(await saveJournaledSpace(pending)).toMatchObject({ok:false,code:'space_baseline_changed'});
 expect(await getSpaceSubmissionRecovery(pending)).toMatchObject({ok:true,recovery:{state:'blocked',canCancel:true}});
 const committed=await setup();const saved=await saveJournaledSpace(committed);expect(saved.ok).toBe(true);newer.expectedRevisionId=committed.assessmentId;
 expect((await appendOrthoAssessment({...committed,command:{...newer,commandId:randomUUID()}})).ok).toBe(true);
 expect(await saveJournaledSpace(committed)).toMatchObject({ok:true,replayed:true});
});
it('pending plan refuses changed strategy and revoked plan edit permission',async()=>{
 const s=await setup();await reserveSpaceSubmission(s);if(s.command.content.kind!=='plan')throw Error('fixture');
 expect((await appendOrthoTreatmentStrategy({...s,command:{...s.strategyCommand,commandId:randomUUID(),expectedRevisionId:s.command.content.strategyRevisionId}})).ok).toBe(true);
 expect(await saveJournaledSpace(s)).toMatchObject({ok:false,code:'space_strategy_changed'});
 await f.pool.query("UPDATE users SET role='doctor',permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewPlans:true,canEditPlans:false}),s.actorId]);s.session={...s.session,role:'doctor'};request.token=createSessionToken(s.session);
 expect(await saveJournaledSpace(s)).toMatchObject({ok:false,status:403});
});
it('archived source or revoked image access withholds recovery content',async()=>{
 const s=await setup(true);await reserveSpaceSubmission(s);await f.pool.query('UPDATE patient_documents SET removed_at=NOW() WHERE id=$1',[s.documentId]);
 const r=await getSpaceSubmissionRecovery(s);expect(r).toMatchObject({ok:true,recovery:{state:'blocked',canCancel:true}});expect(JSON.stringify(r)).not.toContain('Synthetic choice');
 const other=await setup(true);await saveJournaledSpace(other);await f.pool.query("UPDATE users SET role='doctor',permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewPlans:true,canEditPlans:true,canViewXrays:false}),other.actorId]);other.session={...other.session,role:'doctor'};request.token=createSessionToken(other.session);
 expect(await getSpaceSubmissionRecovery(other)).toMatchObject({ok:true,recovery:{state:'blocked',identity:null,canCancel:false}});
 expect(await getOrthoSpaceLedger(other)).toMatchObject({ok:false,status:403});
});
async function actual(s:Prepared,planId:number,performedUm:number|null=100){
 const visit=(await f.pool.query("INSERT INTO visits(patient_id,patient_name,case_id) VALUES($1,'Synthetic actual session',NULL) RETURNING id",[s.patientId])).rows[0].id;
 const adjustment=(await f.pool.query("INSERT INTO ortho_adjustments(case_id,visit_id,done_on,recorded_by) VALUES($1,$2,'2026-10-01','Synthetic doctor') RETURNING id",[s.orthoCaseId,visit])).rows[0].id;
 const command:SpaceCommand={schemaVersion:2,expectedSession:{visitId:visit,occurredOn:'2026-10-01',recordedBy:'Synthetic doctor'},clientRequestId:randomUUID(),expectedHeadId:planId,reason:'Synthetic performed care',content:{kind:'ipr',arch:'upper',planEntryId:planId,teeth:[11,12],adjustmentId:adjustment,performedUm,measurementNote:'Synthetic actual measurement',supersedesEntryId:null,reviewReason:performedUm===null?'Synthetic unknown measured amount':null}};
 return {...s,command,visit,adjustment};
}
it('records existing actual session, preserves unknown and corrections without double counting',async()=>{
 const s=await setup(),plan=await saveJournaledSpace(s);if(!plan.ok)throw Error(plan.code);await transition(s,'acknowledge');
 const a=await actual(s,plan.entryId,null),saved=await saveJournaledSpace(a);expect(saved.ok).toBe(true);if(!saved.ok)throw Error(saved.code);await transition(a,'acknowledge');
 expect(await getOrthoSpaceLedger(s)).toMatchObject({ok:true,ipr:{totals:[{performedUm:null}]}});
 if(a.command.content.kind!=='ipr')throw Error('fixture');const correction={...a,command:{...a.command,clientRequestId:randomUUID(),expectedHeadId:saved.entryId,content:{...a.command.content,performedUm:50,supersedesEntryId:saved.entryId,reviewReason:'Synthetic corrected measured amount'}}};
 const corrected=await saveJournaledSpace(correction);expect(corrected.ok).toBe(true);
 const ledger=await getOrthoSpaceLedger(s);expect(ledger).toMatchObject({ok:true,ipr:{totals:[{performedUm:50}]}});if(!ledger.ok)throw Error(ledger.code);expect(ledger.history).toHaveLength(3);
});
it('rejects booking IDs, foreign visit ownership and duplicate session/contact facts',async()=>{
 const s=await setup(),plan=await saveJournaledSpace(s);if(!plan.ok)throw Error(plan.code);await transition(s,'acknowledge');
 const a=await actual(s,plan.entryId);if(a.command.content.kind!=='ipr')throw Error('fixture');
 expect(await saveJournaledSpace({...a,command:{...a.command,content:{...a.command.content,adjustmentId:999999}}})).toMatchObject({ok:false,code:'ipr_session_missing'});
 const saved=await saveJournaledSpace(a);if(!saved.ok)throw Error(saved.code);await transition(a,'acknowledge');
 expect(await saveJournaledSpace({...a,command:{...a.command,clientRequestId:randomUUID(),expectedHeadId:saved.entryId}})).toMatchObject({ok:false,code:'ipr_duplicate_session_contact'});
 const foreign=await setup();request.token=createSessionToken(s.session);
 await expect(f.pool.query('UPDATE visits SET patient_id=$2 WHERE id=$1',[a.visit,foreign.patientId])).rejects.toThrow();
});

it('parallel recovery stays read-only and committed readback survives edit permission revocation',async()=>{
 const s=await setup();expect((await saveJournaledSpace(s)).ok).toBe(true);
 const recoveries=await Promise.all(Array.from({length:6},()=>getSpaceSubmissionRecovery(s)));
 expect(recoveries.every(r=>r.ok&&r.recovery?.state==='committed')).toBe(true);
 await f.pool.query("UPDATE users SET role='doctor',permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewPlans:true,canEditPlans:false,canViewXrays:true}),s.actorId]);
 s.session={...s.session,role:'doctor'};request.token=createSessionToken(s.session);
 expect(await getSpaceSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'committed',expected:{command:s.command}}});
 expect(await saveJournaledSpace(s)).toMatchObject({ok:false,status:403});
});

it('rejects unwitnessed new IPR and changed visit/date before reservation and after reservation',async()=>{
 const s=await setup(),plan=await saveJournaledSpace(s);if(!plan.ok)throw Error(plan.code);await transition(s,'acknowledge');
 const a=await actual(s,plan.entryId);if(a.command.schemaVersion!==2)throw Error('fixture');
 const base={clientRequestId:a.command.clientRequestId,expectedHeadId:a.command.expectedHeadId,reason:a.command.reason,content:a.command.content};
 expect(await reserveSpaceSubmission({...a,command:{...base,schemaVersion:1}})).toMatchObject({ok:false,code:'ipr_session_witness_required'});
 await f.pool.query("UPDATE ortho_adjustments SET done_on='2026-10-02' WHERE id=$1",[a.adjustment]);
 expect(await reserveSpaceSubmission(a)).toMatchObject({ok:false,code:'ipr_session_changed'});
 const fresh={...a,command:{...a.command,expectedSession:{...a.command.expectedSession,occurredOn:'2026-10-02'}}};
 expect(await reserveSpaceSubmission(fresh)).toMatchObject({ok:true});
 await f.pool.query("UPDATE ortho_adjustments SET done_on='2026-10-03' WHERE id=$1",[a.adjustment]);
 expect(await saveJournaledSpace(fresh)).toMatchObject({ok:false,code:'ipr_session_changed'});
 expect(await getSpaceSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'blocked',canCancel:true}});
 await transition(fresh,'cancel');await transition(fresh,'acknowledge');
 const visit=(await f.pool.query("INSERT INTO visits(patient_id,patient_name) VALUES($1,'Synthetic replacement visit') RETURNING id",[s.patientId])).rows[0].id;
 const b={...a,command:{...a.command,clientRequestId:randomUUID(),expectedSession:{...a.command.expectedSession,occurredOn:'2026-10-03'}}};
 await f.pool.query('UPDATE ortho_adjustments SET visit_id=$2 WHERE id=$1',[a.adjustment,visit]);
 expect(await reserveSpaceSubmission(b)).toMatchObject({ok:false,code:'ipr_session_changed'});
 const selected={...b,command:{...b.command,expectedSession:{...b.command.expectedSession,visitId:visit}}};
 expect(await reserveSpaceSubmission(selected)).toMatchObject({ok:true});
 await f.pool.query('UPDATE ortho_adjustments SET visit_id=$2 WHERE id=$1',[a.adjustment,a.visit]);
 expect(await saveJournaledSpace(selected)).toMatchObject({ok:false,code:'ipr_session_changed'});
});
it('committed receipt preserves its original date/recorder after later canonical correction',async()=>{
 const s=await setup(),plan=await saveJournaledSpace(s);if(!plan.ok)throw Error(plan.code);await transition(s,'acknowledge');
 const a=await actual(s,plan.entryId),saved=await saveJournaledSpace(a);if(!saved.ok)throw Error(saved.code);await transition(a,'acknowledge');
 await f.pool.query("UPDATE ortho_adjustments SET done_on='2026-10-04',recorded_by='Synthetic corrected recorder' WHERE id=$1",[a.adjustment]);
 const replay=await saveJournaledSpace(a);expect(replay).toMatchObject({ok:true,replayed:true,revision:{content:{adjustment:{occurredOn:'2026-10-01',recordedBy:'Synthetic doctor'}}}});
 if(replay.ok)expect(replay.entryId).toBe(saved.entryId);
});

async function printSetup(){
 const s=await setup();const saved=await saveJournaledSpace(s);if(!saved.ok)throw Error(saved.code);
 const read=await getOrthoSpaceLedger(s);if(!read.ok)throw Error(read.code);
 return {...s,headId:read.headId!,headHash:read.history[0].contentHash};
}
it('prepares exact saved print once, audits preparation only and leaves clinical rows untouched',async()=>{
 const s=await printSetup();const before=(await f.pool.query('SELECT * FROM ortho_space_entries WHERE ortho_case_id=$1 ORDER BY id',[s.orthoCaseId])).rows;
 expect(await getOrthoSpaceLedger(s)).toMatchObject({ok:true});
 expect((await f.pool.query("SELECT * FROM audit_log WHERE action='ortho.space_print' AND entity_id=$1",[s.headId])).rows).toHaveLength(0);
 expect(await getOrthoSpaceLedgerForPrint(s)).toMatchObject({ok:true,headId:s.headId});
 const audits=(await f.pool.query("SELECT * FROM audit_log WHERE action='ortho.space_print' AND entity_id=$1",[s.headId])).rows;
 expect(audits).toHaveLength(1);expect(JSON.stringify(audits[0])).toContain('prepared_saved_ledger_print');
 expect((await f.pool.query('SELECT * FROM ortho_space_entries WHERE ortho_case_id=$1 ORDER BY id',[s.orthoCaseId])).rows).toEqual(before);
});
it('refuses stale print head, hash, clinical scope and revoked account without export audits',async()=>{
 const s=await printSetup();for(const patch of [{headId:s.headId+1},{headHash:'0'.repeat(64)},{clinicalCaseId:s.clinicalCaseId+1}])expect(await getOrthoSpaceLedgerForPrint({...s,...patch})).toMatchObject({ok:false});
 await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[s.actorId]);
 expect(await getOrthoSpaceLedgerForPrint(s)).toMatchObject({ok:false});
 expect((await f.pool.query("SELECT * FROM audit_log WHERE action='ortho.space_print' AND entity_id=$1",[s.headId])).rows).toHaveLength(0);
});
it('rolls print preparation back when audit storage fails',async()=>{
 const s=await printSetup();await f.pool.query(`CREATE FUNCTION reject_space_print() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.space_print' THEN RAISE EXCEPTION 'synthetic print audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_space_print BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_space_print()`);
 try{await expect(getOrthoSpaceLedgerForPrint(s)).rejects.toThrow('synthetic print audit failure');}finally{await f.pool.query('DROP TRIGGER reject_space_print ON audit_log; DROP FUNCTION reject_space_print()');}
 expect((await f.pool.query("SELECT * FROM audit_log WHERE action='ortho.space_print' AND entity_id=$1",[s.headId])).rows).toHaveLength(0);
 expect(await getOrthoSpaceLedger(s)).toMatchObject({ok:true,headId:s.headId});
});
it('refuses expiry during an observed audit lock wait and rolls back the prepared audit',async()=>{
 const s=await printSetup(),blocker=await f.pool.connect();let pending:ReturnType<typeof getOrthoSpaceLedgerForPrint>|undefined;
 await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 await blocker.query('LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE');
 try{
  s.session={...s.session,expiresAt:Date.now()+1800};request.token=createSessionToken(s.session);pending=getOrthoSpaceLedgerForPrint(s);
  let blocked=false;const deadline=Date.now()+1500;while(Date.now()<deadline){const rows=(await f.pool.query("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query ILIKE '%INSERT INTO audit_log%'",[pid])).rows;if(rows.length){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}expect(blocked).toBe(true);
  await new Promise(r=>setTimeout(r,Math.max(0,s.session.expiresAt-Date.now()+20)));await blocker.query('COMMIT');
  expect(await pending).toMatchObject({ok:false,code:'session_expired'});
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>{});}
 expect((await f.pool.query("SELECT * FROM audit_log WHERE action='ortho.space_print' AND entity_id=$1",[s.headId])).rows).toHaveLength(0);
});

// Saved case-study integration uses the same real journal and current-authority boundaries.
import {getOrthoStudySourceChoices} from '../../lib/ortho-case-study-inventory';
import {readStudyInventoryResponse} from '../../lib/ortho-case-study-inventory-client';
import {saveConfirmedStudy} from '../helpers/ortho-study-submit';
import {getOrthoCaseStudy,saveOrthoCaseStudy} from '../../lib/ortho-case-study-store';
import {CASE_TEMPLATE_VERSION} from '../../lib/ortho-case-template';
import {STUDY_TEMPLATE_HASH} from '../../lib/ortho-case-study-template';
import type {StudySaveCommand,StudySourceSelection} from '../../lib/ortho-case-study';
import {getStudySubmissionRecovery} from '../../lib/ortho-study-submission-store';
async function studyChoice(s:Awaited<ReturnType<typeof printSetup>>){const response=await getOrthoStudySourceChoices({...s,kind:'space_ledger'});if(!response.ok)throw Error(response.code);const checked=readStudyInventoryResponse(response,s,'space_ledger');return checked.choices[0].selection!;}
function studyCommand(selection:StudySourceSelection):StudySaveCommand{return {schemaVersion:1,clientRequestId:randomUUID(),expectedHead:null,baseDocumentedRevision:null,kind:'draft',documentedFrom:null,reason:'Synthetic saved space study',content:{template:{key:'full-orthodontic-case',version:CASE_TEMPLATE_VERSION,contentHash:STUDY_TEMPLATE_HASH},identityDisclosure:'case_only',sources:[selection],groups:[],panels:[{instanceId:'space-panel',layoutKey:'model-measurements',included:true,state:'available',sourceKeys:[selection.key],images:[],comment:''}],mediaUses:[],comment:''}};}
it('captures a prefix, preserves it after append, documents exact draft, replays and recovers unchanged',async()=>{
 const s=await printSetup(),selection=await studyChoice(s),command=studyCommand(selection);
 const first=await saveConfirmedStudy({...s,command});expect(first.ok).toBe(true);if(!first.ok)throw Error(first.code);
 const captured=first.revision.content.sources[0].payload;
 expect(await transition(s,'acknowledge')).toMatchObject({ok:true});
 const next={...s,command:{...s.command,clientRequestId:randomUUID(),expectedHeadId:s.headId,reason:'Later space plan'}};
 expect(await saveJournaledSpace(next)).toMatchObject({ok:true});
 const read=await getOrthoCaseStudy({...s,revisionId:first.revision.id});expect(read.ok).toBe(true);if(!read.ok)throw Error(read.code);expect(read.revision!.content.sources[0].payload).toEqual(captured);
 const documented:StudySaveCommand={...command,clientRequestId:randomUUID(),kind:'documented',expectedHead:{id:first.revision.id,contentHash:first.revision.contentHash},documentedFrom:{id:first.revision.id,contentHash:first.revision.contentHash}};
 const result=await saveOrthoCaseStudy({...s,command:documented});expect(result.ok).toBe(true);if(!result.ok)throw Error(result.code);expect(result.revision.content).toEqual(first.revision.content);
 expect(await saveOrthoCaseStudy({...s,command:documented})).toMatchObject({ok:true,replayed:true});
 expect(await getStudySubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'committed'}});
 expect((await studyChoice(s)).id).not.toBe(selection.id);
});
it('refuses stale new selections and altered prefix hash without creating study revisions',async()=>{
 const s=await printSetup(),selection=await studyChoice(s);
 expect(await saveConfirmedStudy({...s,command:studyCommand({...selection,contentHash:'0'.repeat(64)})})).toMatchObject({ok:false});
 expect(await transition(s,'acknowledge')).toMatchObject({ok:true});
 expect(await saveJournaledSpace({...s,command:{...s.command,clientRequestId:randomUUID(),expectedHeadId:s.headId,reason:'Newer plan'}})).toMatchObject({ok:true});
 expect(await saveConfirmedStudy({...s,command:studyCommand(selection)})).toMatchObject({ok:false,code:'study_space_head_changed'});
 expect((await f.pool.query('SELECT id FROM ortho_case_study_revisions WHERE ortho_case_id=$1',[s.orthoCaseId])).rows).toHaveLength(0);
});
it('denies historical space capture after current account revocation',async()=>{
 const s=await printSetup(),selection=await studyChoice(s);const result=await saveConfirmedStudy({...s,command:studyCommand(selection)});expect(result.ok).toBe(true);
 await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[s.actorId]);expect(await getOrthoCaseStudy(s)).toMatchObject({ok:false});
});
it('does not inherit unrelated prior study image authority into an image-free space prefix',async()=>{
 const s=await printSetup(),space=await studyChoice(s),hash='c'.repeat(64);
 const doc=(await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'Synthetic unrelated basis','image/png',123,$3,'synthetic-unrelated-space-image','synthetic') RETURNING id",[s.patientId,s.orthoCaseId,hash])).rows[0].id;
 const next=assessmentCommandV2();next.expectedRevisionId=s.assessmentId;next.commandId=randomUUID();next.content.observations.observations.find(o=>o.id==='available_upper')!.provenance!.sources=[{kind:'document',id:doc,version:`sha256:${hash}`}];
 const assessment=await appendOrthoAssessment({...s,command:next});if(!assessment.ok)throw Error(assessment.code);
 const choices=await getOrthoStudySourceChoices({...s,kind:'assessment'});if(!choices.ok)throw Error(choices.code);
 const image=choices.choices.find(c=>c.id===assessment.revision.id)!.selection!;
 const first=await saveConfirmedStudy({...s,command:studyCommand(image)});if(!first.ok)throw Error(first.code);
 expect(first.revision.content.sources[0].access.images).toBe(true);
 const secondCommand={...studyCommand(space),expectedHead:{id:first.revision.id,contentHash:first.revision.contentHash}};
 const second=await saveConfirmedStudy({...s,command:secondCommand});if(!second.ok)throw Error(second.code);
 expect(second.revision.content.sources[0].access).toEqual({images:false,plans:true});
 await f.pool.query("UPDATE users SET role='doctor',permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewPlans:true,canViewXrays:false}),s.actorId]);s.session={...s.session,role:'doctor'};request.token=createSessionToken(s.session);
 expect(await getOrthoCaseStudy({...s,revisionId:second.revision.id})).toMatchObject({ok:true});
});
it('captures corrected IPR once, preserves database visit ownership and denies revoked plan access',async()=>{
 const s=await printSetup();await transition(s,'acknowledge');const actualSession=await actual(s,s.headId,null),first=await saveJournaledSpace(actualSession);if(!first.ok)throw Error(first.code);await transition(actualSession,'acknowledge');
 if(actualSession.command.content.kind!=='ipr')throw Error('fixture');
 const correction={...actualSession,command:{...actualSession.command,clientRequestId:randomUUID(),expectedHeadId:first.entryId,content:{...actualSession.command.content,performedUm:50,supersedesEntryId:first.entryId,reviewReason:'Synthetic correction'}}};
 const corrected=await saveJournaledSpace(correction);if(!corrected.ok)throw Error(corrected.code);
 const selection=await studyChoice(s),saved=await saveConfirmedStudy({...s,command:studyCommand(selection)});if(!saved.ok)throw Error(saved.code);
 const payload=saved.revision.content.sources[0].payload as import('../../lib/ortho-study-space-capture').StudySpaceCapture;
 expect(payload.history).toHaveLength(3);const {projectIpr}=await import('../../lib/ortho-space-ledger');expect(projectIpr(payload.history.map(r=>({id:r.id,version:r.version,content:r.content.authored})))).toMatchObject({ok:true,value:{totals:[{performedUm:50}]}});
 const foreign=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic foreign patient') RETURNING id",[randomUUID()])).rows[0].id;
 await expect(f.pool.query('UPDATE visits SET patient_id=$1 WHERE id=$2',[foreign,actualSession.visit])).rejects.toThrow('Orthodontic space ownership or lineage changed');
 expect(await getOrthoCaseStudy(s)).toMatchObject({ok:true});
 await f.pool.query("UPDATE users SET role='doctor',permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewPlans:false}),s.actorId]);s.session={...s.session,role:'doctor'};request.token=createSessionToken(s.session);
 expect(await getOrthoCaseStudy(s)).toMatchObject({ok:false,status:403});
});
it('rejects invalid prefix bounds without weakening the original full-history reader',async()=>{
 const s=await printSetup(),client=await f.pool.connect();const {spaceHistory}=await import('../../lib/ortho-space-history');const owner={...s,status:'active' as const,recordingContext:'current' as const,planId:null};
 try{for(const version of [0,-1,0.5,Number.MAX_SAFE_INTEGER+1])await expect(spaceHistory(client,owner,version)).rejects.toMatchObject({code:'invalid_space_prefix'});expect((await spaceHistory(client,owner)).revisions).toHaveLength(1);}finally{client.release();}
});
