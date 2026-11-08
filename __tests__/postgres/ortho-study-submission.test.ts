import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {openPeriodontalFixture} from './_periodontal-fixture';
import {createSessionToken,sessionCredentialVersion,type SessionPayload} from '../../lib/auth';
import {syntheticStudyCommand as study} from '../fixtures/ortho-case-study';
import {prepareStudySave,saveOrthoCaseStudy} from '../../lib/ortho-case-study-store';
import {getStudySubmissionRecovery,reserveStudySubmission,transitionStudySubmission} from '../../lib/ortho-study-submission-store';
import {appendLockedStudyRevision} from '../../lib/ortho-case-study-repository';
import {authorizeJourney,journeyTransaction} from '../../lib/ortho-case-journey-authority';
import {journeyContentHash} from '../../lib/ortho-case-journey-hash';
const request=vi.hoisted(()=>({token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='aqlan_flow_session'?{value:request.token}:undefined}),headers:async()=>new Headers()}));
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>,n=0;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-durable-study-secret-at-least-32');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();});
afterAll(async()=>{try{await f?.close();}finally{vi.unstubAllEnvs();}});
async function actor(role:SessionPayload['role']='doctor',permissions={canViewAllPatients:true,canViewXrays:true,canViewPlans:true,canEditPlans:true}){
 const username=`synthetic-journal-${++n}`,password='synthetic-only';
 const id=(await f.pool.query('INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES($1,$1,$2,$3,$4) RETURNING id',[username,password,role,JSON.stringify(permissions)])).rows[0].id;
 return {userId:id,username,role,credentialVersion:sessionCredentialVersion(password),expiresAt:Date.now()+3600000} satisfies SessionPayload;
}
function select(session:SessionPayload){request.token=createSessionToken(session);}
async function scope(){
 const session=await actor();select(session);
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic submission') RETURNING id",[randomUUID()])).rows[0].id;
 const orthoCaseId=(await f.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status,phase,appliance,arches,slot,start_date,planned_months) VALUES($1,'synthetic','assessment','assessment',NULL,NULL,NULL,NULL,NULL) RETURNING id",[patientId])).rows[0].id;
 const clinicalCaseId=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic submission bridge',$2,'synthetic') RETURNING id",[patientId,orthoCaseId])).rows[0].id;
 return {session,actorId:session.userId,patientId,orthoCaseId,clinicalCaseId};
}
const transition=(owner:Awaited<ReturnType<typeof scope>>,command:ReturnType<typeof study>,action:'cancel'|'acknowledge')=>transitionStudySubmission({...owner,action,commandId:command.clientRequestId,requestFingerprint:journeyContentHash(command)});
const count=async(caseId:number)=>(await f.pool.query('SELECT count(*)::int n FROM ortho_case_study_revisions WHERE ortho_case_id=$1',[caseId])).rows[0].n;
it('recovers a durable reservation without creating clinical facts, and a lost committed reply with its exact original request',async()=>{
 const owner=await scope(),command=study();command.content.comment='PRIVATE_UNACKNOWLEDGED_DRAFT';
 expect(await reserveStudySubmission({...owner,command})).toMatchObject({ok:true});expect(await count(owner.orthoCaseId)).toBe(0);
 expect(await getStudySubmissionRecovery(owner)).toMatchObject({ok:true,recovery:{state:'pending',expected:{command,previousVersion:0}}});
 const saved=await saveOrthoCaseStudy({...owner,command});if(!saved.ok)throw Error(saved.code);
 // Treat the first reply as lost; the next read is independent of browser memory.
 expect(await getStudySubmissionRecovery(owner)).toMatchObject({ok:true,recovery:{state:'committed',expected:{command}}});
 expect(await saveOrthoCaseStudy({...owner,command})).toMatchObject({ok:true,replayed:true,revision:{id:saved.revision.id}});expect(await count(owner.orthoCaseId)).toBe(1);
 expect(await transition(owner,command,'acknowledge')).toMatchObject({ok:true,state:'committed',acknowledged:true});
 expect(await getStudySubmissionRecovery(owner)).toMatchObject({ok:true,recovery:null});
 expect((await f.pool.query('SELECT command,request_fingerprint FROM ortho_study_submissions WHERE ortho_case_id=$1',[owner.orthoCaseId])).rows).toEqual([{command:null,request_fingerprint:journeyContentHash(command)}]);
});
it('fences a different tab/key until the exact terminal result is acknowledged, and retries do not duplicate a revision',async()=>{
 const owner=await scope(),command=study();
 const outcomes=await Promise.all([saveOrthoCaseStudy({...owner,command}),saveOrthoCaseStudy({...owner,command})]);
 expect(outcomes.every(r=>r.ok)).toBe(true);expect(await count(owner.orthoCaseId)).toBe(1);
 expect(await saveOrthoCaseStudy({...owner,command:study()})).toMatchObject({ok:false,code:'study_submission_unacknowledged'});
 expect(await transitionStudySubmission({...owner,action:'acknowledge',commandId:command.clientRequestId,requestFingerprint:'f'.repeat(64)})).toMatchObject({ok:false,code:'request_key_conflict'});
 expect(await getStudySubmissionRecovery(owner)).toMatchObject({ok:true,recovery:{state:'committed'}});
});
it('atomically chooses execution or cancellation and never reopens a cancelled key',async()=>{
 const owner=await scope(),command=study();await reserveStudySubmission({...owner,command});
 const [saved,cancelled]=await Promise.all([saveOrthoCaseStudy({...owner,command}),transition(owner,command,'cancel')]);
 const row=(await f.pool.query('SELECT state,revision_id FROM ortho_study_submissions WHERE ortho_case_id=$1',[owner.orthoCaseId])).rows[0];
 if(row.state==='cancelled'){
  expect(saved).toMatchObject({ok:false,code:'study_submission_cancelled'});expect(cancelled).toMatchObject({ok:true,state:'cancelled'});expect(await count(owner.orthoCaseId)).toBe(0);
  await transition(owner,command,'acknowledge');expect(await saveOrthoCaseStudy({...owner,command})).toMatchObject({ok:false,code:'study_submission_cancelled'});
 }else{expect(saved).toMatchObject({ok:true});expect(cancelled).toMatchObject({ok:false,code:'study_submission_already_committed'});expect(await count(owner.orthoCaseId)).toBe(1);}
});
it('cancels before an uncertain old POST arrives and retains a permanent tombstone after acknowledgment',async()=>{
 const owner=await scope(),command=study();
 expect(await transition(owner,command,'cancel')).toMatchObject({ok:true,state:'cancelled',acknowledged:false});
 expect(await getStudySubmissionRecovery(owner)).toMatchObject({ok:true,recovery:{state:'cancelled'}});
 await transition(owner,command,'acknowledge');
 expect(await saveOrthoCaseStudy({...owner,command})).toMatchObject({ok:false,code:'study_submission_cancelled'});expect(await count(owner.orthoCaseId)).toBe(0);
});
it('preserves a stale expected head until explicit cancellation, never rebasing a recovered command',async()=>{
 const owner=await scope(),first=study();await saveOrthoCaseStudy({...owner,command:first});await transition(owner,first,'acknowledge');
 const stale=study();expect(await saveOrthoCaseStudy({...owner,command:stale})).toMatchObject({ok:false,code:'study_head_changed'});
 expect(await getStudySubmissionRecovery(owner)).toMatchObject({ok:true,recovery:{state:'pending',expected:{command:{expectedHead:null},previousVersion:0}}});
 expect(await count(owner.orthoCaseId)).toBe(1);await transition(owner,stale,'cancel');await transition(owner,stale,'acknowledge');
 expect(await saveOrthoCaseStudy({...owner,command:stale})).toMatchObject({ok:false,code:'study_submission_cancelled'});
});
it('hides commands from another actor and refuses all legacy writer paths while an unacknowledged command exists',async()=>{
 const owner=await scope(),command=study();command.content.comment='PRIVATE_OTHER_ACTOR';await reserveStudySubmission({...owner,command});
 const other=await actor();select(other);const input={...owner,actorId:other.userId,session:other};
 const result=await getStudySubmissionRecovery(input);expect(result).toMatchObject({ok:true,recovery:{state:'blocked',identity:null,canCancel:false}});expect(JSON.stringify(result)).not.toContain('PRIVATE_OTHER_ACTOR');
 expect(await saveOrthoCaseStudy({...input,command:study()})).toMatchObject({ok:false,code:'study_submission_unacknowledged'});
});
it('reauthorizes the recovered source union and permits only metadata cancellation if source access is revoked',async()=>{
 const owner=await scope(),command=study(),hash='a'.repeat(64);
 const documentId=(await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'Synthetic source','image/png',12,$3,'synthetic','synthetic') RETURNING id",[owner.patientId,owner.orthoCaseId,hash])).rows[0].id;
 command.content.comment='PRIVATE_SOURCE_COMMENT';command.content.sources=[{key:'image',kind:'document',id:documentId,version:null,contentHash:hash}];command.content.panels[0]={...command.content.panels[0],state:'available',sourceKeys:['image']};
 await reserveStudySubmission({...owner,command});
 await f.pool.query('UPDATE users SET permissions=$1 WHERE id=$2',[JSON.stringify({canViewAllPatients:true,canViewXrays:false}),owner.session.userId]);
 const result=await getStudySubmissionRecovery(owner);expect(result).toMatchObject({ok:true,recovery:{state:'blocked',canCancel:true}});expect(JSON.stringify(result)).not.toContain('PRIVATE_SOURCE_COMMENT');expect(JSON.stringify(result)).not.toContain('contentHash');
 expect(await saveOrthoCaseStudy({...owner,command})).toMatchObject({ok:false,status:403});
 expect(await transition(owner,command,'cancel')).toMatchObject({ok:true,state:'cancelled'});
});
it('rolls back failed execution atomically but retains the committed intent, and failed acknowledgment preserves its payload',async()=>{
 const owner=await scope(),command=study();
 await f.pool.query("CREATE FUNCTION synthetic_submission_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.journey_record' THEN RAISE EXCEPTION 'synthetic execution audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_submission_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_submission_fail()");
 try{await expect(saveOrthoCaseStudy({...owner,command})).rejects.toThrow('synthetic execution audit failure');}finally{await f.pool.query('DROP TRIGGER synthetic_submission_fail ON audit_log; DROP FUNCTION synthetic_submission_fail()');}
 expect(await count(owner.orthoCaseId)).toBe(0);expect(await getStudySubmissionRecovery(owner)).toMatchObject({ok:true,recovery:{state:'pending',expected:{command}}});
 await saveOrthoCaseStudy({...owner,command});
 await f.pool.query("CREATE FUNCTION synthetic_ack_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.study_submission' THEN RAISE EXCEPTION 'synthetic ack audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_ack_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_ack_fail()");
 try{await expect(transition(owner,command,'acknowledge')).rejects.toThrow('synthetic ack audit failure');}finally{await f.pool.query('DROP TRIGGER synthetic_ack_fail ON audit_log; DROP FUNCTION synthetic_ack_fail()');}
 expect(await getStudySubmissionRecovery(owner)).toMatchObject({ok:true,recovery:{state:'committed',expected:{command}}});
 expect(await transition(owner,command,'acknowledge')).toMatchObject({ok:true,acknowledged:true});
});

it('recognizes an already committed legacy request before creating a cancellation tombstone',async()=>{
 const owner=await scope(),command=study();
 const legacy=await journeyTransaction(true,async client=>{const authority=await authorizeJourney(client,owner,true);return appendLockedStudyRevision(client,await prepareStudySave(client,owner,command,authority));});
 expect(legacy).toMatchObject({ok:true});
 expect(await transition(owner,command,'cancel')).toMatchObject({ok:false,status:409,code:'study_submission_already_committed'});
 expect(await transitionStudySubmission({...owner,action:'cancel',commandId:command.clientRequestId,requestFingerprint:'f'.repeat(64)})).toMatchObject({ok:false,status:409,code:'request_key_conflict'});
 expect((await f.pool.query('SELECT id FROM ortho_study_submissions WHERE ortho_case_id=$1',[owner.orthoCaseId])).rows).toHaveLength(0);
 expect(await saveOrthoCaseStudy({...owner,command})).toMatchObject({ok:true,replayed:true});expect(await count(owner.orthoCaseId)).toBe(1);
 expect(await getStudySubmissionRecovery(owner)).toMatchObject({ok:true,recovery:{state:'committed',expected:{command}}});
});

it('rejects the first delayed arrival after the reviewed bridge or actor changed, without reserving or saving',async()=>{
 const owner=await scope(),command=study();
 await f.pool.query('UPDATE clinical_cases SET ortho_case_id=NULL WHERE id=$1',[owner.clinicalCaseId]);
 const replacement=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic replacement',$2,'synthetic') RETURNING id",[owner.patientId,owner.orthoCaseId])).rows[0].id;
 expect(await saveOrthoCaseStudy({...owner,command})).toMatchObject({ok:false,code:'study_submission_context_changed'});
 expect(await saveOrthoCaseStudy({...owner,clinicalCaseId:replacement,actorId:owner.actorId+100000,command})).toMatchObject({ok:false,code:'study_submission_actor_changed'});
 expect(await transitionStudySubmission({...owner,clinicalCaseId:replacement,actorId:owner.actorId+100000,action:'cancel',commandId:command.clientRequestId,requestFingerprint:journeyContentHash(command)})).toMatchObject({ok:false,code:'study_submission_actor_changed'});
 expect(await count(owner.orthoCaseId)).toBe(0);expect((await f.pool.query('SELECT id FROM ortho_study_submissions WHERE ortho_case_id=$1',[owner.orthoCaseId])).rows).toHaveLength(0);
 expect(await saveOrthoCaseStudy({...owner,clinicalCaseId:replacement,command})).toMatchObject({ok:true});
});
