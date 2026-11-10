import { randomUUID, createHash } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { syntheticStudyCommand } from '../fixtures/ortho-case-study';
import { saveConfirmedStudy } from '../helpers/ortho-study-submit';
import { openPeriodontalFixture } from './_periodontal-fixture';
import { reserveStudyExport, claimStudyExport, publishStudyExport, failStudyExport, cancelStudyExport, listStudyExports, readStudyExportArtifact } from '../../lib/ortho-study-export-archive-store';
import { ProtectedOrthoStudyHistoryError } from '../../lib/clinic-reset';
import { journeyContentHash } from '../../lib/ortho-case-journey-hash';
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
async function claimed(s:Awaited<ReturnType<typeof seed>>){const job=await reserved(s),c=await claimStudyExport({...s.scope,jobId:job.id,expectedGeneration:0});if(!c.ok||!c.lease)throw Error('Synthetic claim failed');return c;}
const bytes=Buffer.from('Synthetic artifact payload for transactional store tests (not a rendered PPTX)');
const sha256=createHash('sha256').update(bytes).digest('hex');
const artifact={storageKey:`${sha256.slice(0,2)}/${sha256.slice(2,4)}/${sha256}.pptx`,sha256,sizeBytes:bytes.length,pageCount:1,renditions:[]};
it('refuses a restored job pinned to a different renderer contract without silently changing its intent', async () => {
 const s=await seed(),job=await reserved(s),command={...s.command,clientRequestId:randomUUID()};
 const restored=(await fixture.pool.query(`INSERT INTO ortho_study_export_jobs(patient_id,ortho_case_id,clinical_case_id,actor_user_id,revision_id,revision_sha256,command_id,command,request_fingerprint,format,render_binding)
   SELECT patient_id,ortho_case_id,clinical_case_id,actor_user_id,revision_id,revision_sha256,$2,$3::jsonb,$4,format,
   jsonb_set(render_binding,'{contractHash}',to_jsonb($5::text)) FROM ortho_study_export_jobs WHERE id=$1 RETURNING id`,
 [job.id,command.clientRequestId,JSON.stringify(command),journeyContentHash(command),'0'.repeat(64)])).rows[0];
 expect(await claimStudyExport({...s.scope,jobId:restored.id,expectedGeneration:0})).toMatchObject({ok:false,code:'study_export_renderer_unavailable'});
 expect((await fixture.pool.query('SELECT state,generation,render_binding FROM ortho_study_export_jobs WHERE id=$1',[restored.id])).rows[0]).toMatchObject({state:'queued',generation:0,render_binding:{contractHash:'0'.repeat(64)}});
 expect((await fixture.pool.query('SELECT count(*)::int n FROM ortho_study_export_artifacts WHERE job_id=$1',[restored.id])).rows[0].n).toBe(0);
});
it('reads a restored ready artifact with an older renderer without regenerating or changing its bytes reference',async()=>{
 const s=await seed(),current=await claimed(s);
 expect((await publishStudyExport({...s.scope,lease:current.lease!,artifact})).ok).toBe(true);
 const command={...s.command,clientRequestId:randomUUID()},client=await fixture.pool.connect();
 let id:number;
 try {
  await client.query('BEGIN');
  const restored=(await client.query(`INSERT INTO ortho_study_export_jobs(patient_id,ortho_case_id,clinical_case_id,actor_user_id,revision_id,revision_sha256,command_id,command,request_fingerprint,format,render_binding,state,generation)
    SELECT patient_id,ortho_case_id,clinical_case_id,actor_user_id,revision_id,revision_sha256,$2,$3::jsonb,$4,format,
      jsonb_set(jsonb_set(render_binding,'{renderer}',to_jsonb($5::text)),'{contractHash}',to_jsonb($6::text)),'ready',1
    FROM ortho_study_export_jobs WHERE id=$1 RETURNING id,render_binding`,
    [current.job.id,command.clientRequestId,JSON.stringify(command),journeyContentHash(command),'synthetic-previous-renderer','0'.repeat(64)])).rows[0];
  id=restored.id;
  const original=(await client.query('SELECT manifest FROM ortho_study_export_artifacts WHERE job_id=$1',[current.job.id])).rows[0].manifest;
  const manifest={...original,jobId:id,renderBinding:restored.render_binding};
  await client.query(`INSERT INTO ortho_study_export_artifacts(job_id,sha256,storage_key,size_bytes,page_count,manifest,manifest_sha256)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,[id,artifact.sha256,artifact.storageKey,artifact.sizeBytes,artifact.pageCount,JSON.stringify(manifest),journeyContentHash(manifest)]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 const before=(await fixture.pool.query('SELECT * FROM ortho_study_export_artifacts WHERE job_id=$1',[id])).rows;
 expect(await readStudyExportArtifact({...s.scope,jobId:id})).toMatchObject({ok:true,job:{state:'ready'},reference:{storageKey:artifact.storageKey,sha256,sizeBytes:bytes.length}});
 expect(await claimStudyExport({...s.scope,jobId:id,expectedGeneration:1})).toMatchObject({ok:true,lease:null,job:{state:'ready'}});
 expect((await fixture.pool.query('SELECT * FROM ortho_study_export_artifacts WHERE job_id=$1',[id])).rows).toEqual(before);
 // Transactional metadata fixture only; actual rendered-file bytes and downloads
 // are exercised separately by the built archive browser/HTTP suite.
});
it('reserves exactly one job for concurrent exact retry and rejects reused intent keys',async()=>{
 const s=await seed();const attempts=await Promise.all(Array.from({length:4},()=>reserveStudyExport({...s.scope,command:s.command})));
 expect(attempts.every(x=>x.ok)).toBe(true);expect(new Set(attempts.flatMap(x=>x.ok?[x.job.id]:[])).size).toBe(1);
 expect(await reserveStudyExport({...s.scope,command:{...s.command,format:'illustrated-pptx'}})).toMatchObject({ok:false,code:'request_key_conflict'});
 expect((await fixture.pool.query('SELECT COUNT(*)::int n FROM ortho_study_export_jobs WHERE ortho_case_id=$1',[s.scope.orthoCaseId])).rows[0].n).toBe(1);
});
it('fences concurrent claims, atomically publishes once and never changes clinical snapshots',async()=>{
 const s=await seed(),job=await reserved(s);const before=(await fixture.pool.query('SELECT * FROM ortho_case_study_revisions WHERE id=$1',[s.command.revisionId])).rows;
 const attempts=await Promise.all([0,1].map(()=>claimStudyExport({...s.scope,jobId:job.id,expectedGeneration:0})));
 expect(attempts.filter(x=>x.ok)).toHaveLength(1);const c=attempts.find(x=>x.ok);if(!c?.ok||!c.lease)throw Error('No claim');
 expect(await publishStudyExport({...s.scope,lease:c.lease,artifact})).toMatchObject({ok:true,job:{state:'ready',generation:1,artifact:{sha256}}});
 expect(await publishStudyExport({...s.scope,lease:c.lease,artifact})).toMatchObject({ok:false,code:'study_export_lease_changed'});
 expect(await claimStudyExport({...s.scope,jobId:job.id,expectedGeneration:0})).toMatchObject({ok:true,lease:null,job:{state:'ready'}});
 const read=await readStudyExportArtifact({...s.scope,jobId:job.id});expect(read).toMatchObject({ok:true,reference:{sha256,sizeBytes:bytes.length}});
 const listed=await listStudyExports({...s.scope,revisionId:s.command.revisionId});expect(JSON.stringify(listed)).not.toMatch(/storageKey|storage_key|lease_token|manifest|sourceSelections/);
 expect((await fixture.pool.query('SELECT * FROM ortho_case_study_revisions WHERE id=$1',[s.command.revisionId])).rows).toEqual(before);
 await expect(fixture.pool.query('DELETE FROM ortho_study_export_artifacts WHERE job_id=$1',[job.id])).rejects.toThrow(/immutable/);
 await expect(fixture.pool.query("UPDATE ortho_study_export_jobs SET state='queued',generation=0 WHERE id=$1",[job.id])).rejects.toThrow(/terminal/);
});
it('retries a failed job with a new generation and rejects the old worker',async()=>{
 const s=await seed(),c=await claimed(s);
 expect(await failStudyExport({...s.scope,lease:c.lease!,code:'render_failed'})).toMatchObject({ok:true,job:{state:'failed'}});
 const next=await claimStudyExport({...s.scope,jobId:c.job.id,expectedGeneration:1});expect(next).toMatchObject({ok:true,job:{state:'running',generation:2}});
 expect(await publishStudyExport({...s.scope,lease:c.lease!,artifact})).toMatchObject({ok:false,code:'study_export_lease_changed'});
 if(!next.ok||!next.lease)throw Error('No retry');
 expect(await publishStudyExport({...s.scope,lease:next.lease,artifact})).toMatchObject({ok:true,job:{state:'ready'}});
});
it('current export revocation denies publication and download even with a prior valid lease',async()=>{
 const s=await seed();const doctor=await actor('doctor',{canViewAllPatients:true,canExportOrthoStudies:true});s.scope.session=doctor;login(doctor);
 const c=await claimed(s);await fixture.pool.query('UPDATE users SET permissions=$1 WHERE id=$2',[{canViewAllPatients:true,canExportOrthoStudies:false},doctor.userId]);
 expect(await publishStudyExport({...s.scope,lease:c.lease!,artifact})).toMatchObject({ok:false,status:403,code:'study_export_forbidden'});
 await fixture.pool.query('UPDATE users SET permissions=$1 WHERE id=$2',[{canViewAllPatients:true,canExportOrthoStudies:true},doctor.userId]);
 expect(await publishStudyExport({...s.scope,lease:c.lease!,artifact})).toMatchObject({ok:true});
 await fixture.pool.query('UPDATE users SET permissions=$1 WHERE id=$2',[{canViewAllPatients:true,canExportOrthoStudies:false},doctor.userId]);
 expect(await readStudyExportArtifact({...s.scope,jobId:c.job.id})).toMatchObject({ok:false,status:403});
});
it('granted reception can export but another creator cannot run/cancel; foreign patient cannot read',async()=>{
 const s=await seed(),reception=await actor('reception',{canViewAllPatients:true,canExportOrthoStudies:true});s.scope.session=reception;login(reception);const c=await claimed(s);
 const admin=await actor();login(admin);expect(await cancelStudyExport({...s.scope,session:admin,jobId:c.job.id,expectedGeneration:1})).toMatchObject({ok:false,status:403,code:'study_export_creator_required'});
 login(reception);expect(await publishStudyExport({...s.scope,lease:c.lease!,artifact})).toMatchObject({ok:true});
 const other=await seed();expect(await readStudyExportArtifact({...other.scope,jobId:c.job.id})).toMatchObject({ok:false,status:404});
});
it('cancels a queued or running job permanently without deleting recovery evidence',async()=>{
 const s=await seed(),job=await reserved(s);expect(await cancelStudyExport({...s.scope,jobId:job.id,expectedGeneration:0})).toMatchObject({ok:true,job:{state:'cancelled'}});
 expect(await reserveStudyExport({...s.scope,command:s.command})).toMatchObject({ok:true,job:{id:job.id,state:'cancelled'}});
 expect(await claimStudyExport({...s.scope,jobId:job.id,expectedGeneration:0})).toMatchObject({ok:true,lease:null});
 await expect(fixture.pool.query('DELETE FROM ortho_study_export_jobs WHERE id=$1',[job.id])).rejects.toThrow(/erased/);
 const t=await seed(),c=await claimed(t);expect(await cancelStudyExport({...t.scope,jobId:c.job.id,expectedGeneration:1})).toMatchObject({ok:true});
 expect(await publishStudyExport({...t.scope,lease:c.lease!,artifact})).toMatchObject({ok:false,code:'study_export_lease_changed'});
});
it('protects publication invariants and artifact hash/path/size bounds',async()=>{
 const s=await seed(),c=await claimed(s);
 for(const invalid of [{...artifact,sizeBytes:25165825},{...artifact,storageKey:'../../escape.pptx'},{...artifact,pageCount:301},{...artifact,sha256:'invalid'}])
  expect(await publishStudyExport({...s.scope,lease:c.lease!,artifact:invalid})).toMatchObject({ok:false,status:400});
 await expect(fixture.pool.query("UPDATE ortho_study_export_jobs SET state='ready',lease_token=NULL,lease_expires_at=NULL WHERE id=$1",[c.job.id])).rejects.toThrow(/publication mismatch/);
 expect(await publishStudyExport({...s.scope,lease:c.lease!,artifact})).toMatchObject({ok:true});
});
it('fences patient merge and reset before any destructive work',async()=>{
 const s=await seed();await reserved(s);const other=await seed();login(s.scope.session);
 expect(await fixture.db.mergeDuplicatePatient(s.scope.patientId,other.scope.patientId,{actor:s.scope.session.username,actorRole:'admin'})).toMatchObject({ok:false,reason:'source_has_clinical_command_history'});
 const backup=vi.fn();await expect(fixture.db.resetClinicData({actor:s.scope.session.username,actorRole:"admin"},backup)).rejects.toBeInstanceOf(ProtectedOrthoStudyHistoryError);expect(backup).not.toHaveBeenCalled();
});
it('lists a coherent receipt while publication waits for its row-share snapshot',async()=>{
 const s=await seed(),c=await claimed(s),client=await fixture.pool.connect();
 let entered!:()=>void,release!:()=>void;const atRows=new Promise<void>(r=>{entered=r}),gate=new Promise<void>(r=>{release=r});
 const original=client.query.bind(client) as (sql:string,values?:unknown[])=>Promise<unknown>;
 const query=vi.spyOn(client,'query').mockImplementation((async(sql:string,values?:unknown[])=>{
  const result=await original(sql,values);
  if(sql.includes('ORDER BY id DESC LIMIT $5')){entered();await gate;}
  return result;
 }) as typeof client.query);
 const connect=vi.spyOn(fixture.pool,'connect').mockImplementationOnce((()=>Promise.resolve(client)) as typeof fixture.pool.connect);
 let publishing:ReturnType<typeof publishStudyExport>|undefined;
 const listing=listStudyExports({...s.scope,revisionId:s.command.revisionId});
 try{
  await atRows;connect.mockRestore();publishing=publishStudyExport({...s.scope,lease:c.lease!,artifact});
  await vi.waitFor(async()=>{
   const wait=(await fixture.pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM ortho_study_export_jobs WHERE id=$1 FOR UPDATE%'")).rows[0].n;
   expect(wait).toBe(1);
  },{timeout:3000,interval:20});
 }finally{release();connect.mockRestore();}
 try{
  expect(await listing).toMatchObject({ok:true,jobs:[{id:c.job.id,state:'running',artifact:null}]});
  expect(await publishing).toMatchObject({ok:true,job:{state:'ready'}});
 }finally{query.mockRestore();}
});

it('rechecks image-source authority for text archive publication and download',async()=>{
 const s=await seed(true),doctor=await actor('doctor',{canViewAllPatients:true,canExportOrthoStudies:true,canViewXrays:true});s.scope.session=doctor;login(doctor);const c=await claimed(s);
 await fixture.pool.query('UPDATE users SET permissions=$1 WHERE id=$2',[{canViewAllPatients:true,canExportOrthoStudies:true,canViewXrays:false},doctor.userId]);
 expect(await publishStudyExport({...s.scope,lease:c.lease!,artifact})).toMatchObject({ok:false,status:403});
 await fixture.pool.query('UPDATE users SET permissions=$1 WHERE id=$2',[{canViewAllPatients:true,canExportOrthoStudies:true,canViewXrays:true},doctor.userId]);
 expect(await publishStudyExport({...s.scope,lease:c.lease!,artifact})).toMatchObject({ok:true});
 await fixture.pool.query("UPDATE patient_documents SET removed_at=clock_timestamp(),removed_by='synthetic',removed_note='Synthetic removal' WHERE id=$1",[s.documentId]);
 expect(await readStudyExportArtifact({...s.scope,jobId:c.job.id})).toMatchObject({ok:false});
});
