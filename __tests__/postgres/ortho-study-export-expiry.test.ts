import { randomUUID, createHash } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { syntheticStudyCommand } from '../fixtures/ortho-case-study';
import { saveConfirmedStudy } from '../helpers/ortho-study-submit';
import { openPeriodontalFixture } from './_periodontal-fixture';
import { reserveStudyExport, claimStudyExport, publishStudyExport, listStudyExports, readStudyExportArtifact, type StudyExportLease } from '../../lib/ortho-study-export-archive-store';
const request=vi.hoisted(()=>({token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='aqlan_flow_session'?{value:request.token}:undefined}),headers:async()=>new Headers()}));
let fixture:Awaited<ReturnType<typeof openPeriodontalFixture>>;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-archive-secret-at-least-32-characters');fixture=await openPeriodontalFixture(process.env,{pristine:true});await fixture.db.ensureSchema();});
afterAll(async()=>{await fixture?.close();vi.unstubAllEnvs();});
async function actor(role:SessionPayload['role']='admin',permissions:Record<string,unknown>={}){
 const username=`synthetic-${randomUUID()}`,password='synthetic-password';const user=(await fixture.pool.query('INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES($1,$2,$3,$4,$5) RETURNING id',[username,'Synthetic archive operator',password,role,permissions])).rows[0];
 return {userId:user.id,username,role,credentialVersion:sessionCredentialVersion(password),expiresAt:Date.now()+600000} satisfies SessionPayload;
}
function login(s:SessionPayload){request.token=createSessionToken(s);}
async function seed(withSource=false){
 const session=await actor();login(session);const patientId=(await fixture.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic archive patient') RETURNING id",[randomUUID()])).rows[0].id;
 const orthoCaseId=(await fixture.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,appliance,arches,slot,start_date,planned_months,created_by) VALUES($1,'assessment','assessment',NULL,NULL,NULL,NULL,NULL,'synthetic') RETURNING id",[patientId])).rows[0].id;
 const clinicalCaseId=(await fixture.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic archive case',$2,'synthetic') RETURNING id",[patientId,orthoCaseId])).rows[0].id;
 const scope={session,patientId,orthoCaseId,clinicalCaseId};const studyCommand=syntheticStudyCommand();let documentId:number|null=null;
 if(withSource){
  documentId=(await fixture.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'photo','Synthetic source','image/png',10,$3,'synthetic-unused-metadata-only','synthetic') RETURNING id",[patientId,orthoCaseId,'b'.repeat(64)])).rows[0].id;
  studyCommand.content.sources=[{key:'source_photo',kind:'document',id:documentId!,version:null,contentHash:'b'.repeat(64)}];
  studyCommand.content.panels=[{instanceId:'face',layoutKey:'face-overview',included:true,state:'available',sourceKeys:['source_photo'],images:[],comment:''}];
 }
 const saved=await saveConfirmedStudy({...scope,command:studyCommand});if(!saved.ok)throw Error(saved.code);
 const command={schemaVersion:1 as const,clientRequestId:randomUUID(),revisionId:saved.revision.id,revisionHash:saved.revision.contentHash,format:'text-pptx' as const};return {scope,command,documentId};
}
async function reserved(s:Awaited<ReturnType<typeof seed>>){const r=await reserveStudyExport({...s.scope,command:s.command});if(!r.ok)throw Error(r.code);return r.job;}
const bytes=Buffer.from('Synthetic artifact payload for transactional store tests (not a rendered PPTX)');
const sha256=createHash('sha256').update(bytes).digest('hex');
const artifact={storageKey:`${sha256.slice(0,2)}/${sha256.slice(2,4)}/${sha256}.pptx`,sha256,sizeBytes:bytes.length,pageCount:1,renditions:[]};

// Real signed-cookie expiry and PostgreSQL row/table waits: no mocked clock or
// auth helper. A longer input payload must never extend the actual signed token.
it.each(['claim', 'publish', 'download', 'list'] as const)('rejects %s when the signed session expires waiting for the archive job lock', async action => {
 const s=await seed(), job=await reserved(s);
 let lease: StudyExportLease | null = null;
 if(action==='publish'||action==='download'){
  const c=await claimStudyExport({...s.scope,jobId:job.id,expectedGeneration:0});
  if(!c.ok||!c.lease)throw Error('Synthetic claim failed');lease=c.lease;
  if(action==='download')expect(await publishStudyExport({...s.scope,lease,artifact})).toMatchObject({ok:true});
 }
 const before=(await fixture.pool.query('SELECT * FROM ortho_study_export_jobs WHERE id=$1',[job.id])).rows;
 const blocker=await fixture.pool.connect();await blocker.query('BEGIN');
 await blocker.query('SELECT id FROM ortho_study_export_jobs WHERE id=$1 FOR UPDATE',[job.id]);
 const expiresAt=Date.now()+2000;login({...s.scope.session,expiresAt});
 const pending=action==='claim'?claimStudyExport({...s.scope,jobId:job.id,expectedGeneration:0})
  :action==='publish'?publishStudyExport({...s.scope,lease:lease!,artifact})
  :action==='download'?readStudyExportArtifact({...s.scope,jobId:job.id})
  :listStudyExports({...s.scope,revisionId:s.command.revisionId});
 try{
  await vi.waitFor(async()=>{
   const {rows:[row]}=await fixture.pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM ortho_study_export_jobs%'");
   expect(row.n).toBe(1);
  },{timeout:1500,interval:20});
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiresAt-Date.now()+30)));
 }finally{
  await blocker.query('ROLLBACK');blocker.release();
  // Drain even if lock observation fails, so no request outlives its fixture.
  await pending.catch(()=>undefined);
 }
 expect(await pending).toMatchObject({ok:false,status:401,code:'session_expired'});
 expect((await fixture.pool.query('SELECT * FROM ortho_study_export_jobs WHERE id=$1',[job.id])).rows).toEqual(before);
});

it.each(['reserve', 'claim', 'publish'] as const)('rolls back %s when expiry happens later while its audit insert waits before commit',async action=>{
 const s=await seed(),job=await reserved(s),blocker=await fixture.pool.connect();
 let lease:StudyExportLease|null=null;
 if(action==='publish'){const c=await claimStudyExport({...s.scope,jobId:job.id,expectedGeneration:0});if(!c.ok||!c.lease)throw Error('No lease');lease=c.lease;}
 const before=(await fixture.pool.query('SELECT * FROM ortho_study_export_jobs WHERE ortho_case_id=$1 ORDER BY id',[s.scope.orthoCaseId])).rows;
 const auditBefore=(await fixture.pool.query("SELECT count(*)::int n FROM audit_log WHERE entity=$1 AND details->>'orthoCaseId'=$2",['ortho_study_export_jobs',String(s.scope.orthoCaseId)])).rows;
 await blocker.query('BEGIN');await blocker.query('LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE');
 const expiresAt=Date.now()+2000;login({...s.scope.session,expiresAt});
 const pending=action==='reserve'?reserveStudyExport({...s.scope,command:{...s.command,clientRequestId:randomUUID()}})
  :action==='publish'?publishStudyExport({...s.scope,lease:lease!,artifact})
  :claimStudyExport({...s.scope,jobId:job.id,expectedGeneration:0});
 try{
  await vi.waitFor(async()=>{
   const {rows:[row]}=await fixture.pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO audit_log%'");
   expect(row.n).toBe(1);
  },{timeout:1500,interval:20});
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiresAt-Date.now()+30)));
 }finally{
  await blocker.query('ROLLBACK');blocker.release();
  // Drain even if lock observation fails, so no request outlives its fixture.
  await pending.catch(()=>undefined);
 }
 expect(await pending).toMatchObject({ok:false,status:401,code:'session_expired'});
 expect((await fixture.pool.query('SELECT * FROM ortho_study_export_jobs WHERE ortho_case_id=$1 ORDER BY id',[s.scope.orthoCaseId])).rows).toEqual(before);
 expect((await fixture.pool.query('SELECT count(*)::int n FROM ortho_study_export_artifacts WHERE job_id=$1',[job.id])).rows[0].n).toBe(0);
 expect((await fixture.pool.query("SELECT count(*)::int n FROM audit_log WHERE entity=$1 AND details->>'orthoCaseId'=$2",['ortho_study_export_jobs',String(s.scope.orthoCaseId)])).rows).toEqual(auditBefore);
});
