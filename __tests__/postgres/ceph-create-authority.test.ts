import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {openPeriodontalFixture} from './_periodontal-fixture';
import {createSessionToken,sessionCredentialVersion,type SessionPayload} from '../../lib/auth';
const request=vi.hoisted(()=>({token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='aqlan_flow_session'?{value:request.token}:undefined}),headers:async()=>new Headers()}));
const correctionTokens=new Map<number,import("../../lib/ceph-correction-origin").CephCorrectionSourceToken>();
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-ceph-create-authority-20261106');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();});
afterAll(async()=>{await f?.close();vi.unstubAllEnvs();});
async function setup(){
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic ceph patient') RETURNING id",[randomUUID()])).rows[0].id;
 const documentId=(await f.pool.query("INSERT INTO patient_documents(patient_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,'Synthetic image','image/png',1,$2,$3,'synthetic') RETURNING id",[patientId,'a'.repeat(64),randomUUID()])).rows[0].id;
 const username='synthetic-'+randomUUID(),password='synthetic-password';const userId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES($1,'Synthetic',$2,'admin',$3) RETURNING id",[username,password,JSON.stringify({canViewAllPatients:true,canUploadXrays:true})])).rows[0].id;
 const session:SessionPayload={userId,username,role:'admin',partyId:null,expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion(password)};
 return {patientId,documentId,session};
}
async function source(s:Awaited<ReturnType<typeof setup>>){const id=Number((await f.pool.query("INSERT INTO ceph_analyses(patient_id,document_id,status,created_by,xray_date,phase,device,ref_set,study_kind) VALUES($1,$2,'completed','synthetic','2026-02-03','followup','synthetic device','builtin_default','lateral') RETURNING id",[s.patientId,s.documentId])).rows[0].id);await f.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by,confirmed_at) VALUES($1,'S',20,30,'manual','original reviewer','2026-01-01T00:00:00Z')",[id]);correctionTokens.set(id,await correctionToken(s,id));return id;}
async function run(kind:'create'|'duplicate',s:Awaited<ReturnType<typeof setup>>,id?:number){return kind==='create'?f.db.createAuthorizedCephAnalysis({patientId:s.patientId,documentId:s.documentId},s):f.db.duplicateAuthorizedCephAnalysis(id!,s,correctionTokens.get(id!)??await correctionToken(s,id!));}
async function correctionToken(_s:Awaited<ReturnType<typeof setup>>,id:number){const r=(await f.db.getCephStudy(id))?.correctionSource;if(r?.state!=='available')throw Error('Synthetic opened correction source unavailable');return r.token;}
it.each(['admin','reception','doctor'] as const)('preserves %s creation and duplicate metadata',async role=>{const s=await setup();await f.pool.query('UPDATE users SET role=$2 WHERE id=$1',[s.session.userId,role]);s.session.role=role;const a=await run('create',s);expect(a.ok).toBe(true);await f.pool.query("UPDATE ceph_analyses SET status='discarded' WHERE id=$1",[a.ok?a.id:0]);const id=await source(s),b=await run('duplicate',s,id);expect(b.ok).toBe(true);const row=(await f.pool.query('SELECT xray_date::text,phase,device,ref_set,study_kind FROM ceph_analyses WHERE id=$1',[b.ok?b.id:0])).rows[0];expect(row).toEqual({xray_date:'2026-02-03',phase:'followup',device:'synthetic device',ref_set:'builtin_default',study_kind:'lateral'});expect((await f.pool.query('SELECT confirmed_by,confirmed_at::text FROM ceph_landmarks WHERE analysis_id=$1',[b.ok?b.id:0])).rows[0].confirmed_by).toBe('original reviewer');});
it.each(['create','duplicate'] as const)('rejects revoked %s without draft',async kind=>{const s=await setup(),id=kind==='duplicate'?await source(s):undefined;await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[s.session.userId]);await expect(run(kind,s,id)).rejects.toMatchObject({status:401});expect((await f.pool.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'",[s.patientId])).rowCount).toBe(0);});
it.each(['create','duplicate'] as const)('rejects foreign image for %s',async kind=>{const s=await setup(),other=await setup(),id=kind==='duplicate'?await source(s):undefined;await f.pool.query('UPDATE patient_documents SET patient_id=$2 WHERE id=$1',[s.documentId,other.patientId]);if(kind==='create')expect(await run(kind,s,id)).toMatchObject({ok:false});else await expect(run(kind,s,id)).rejects.toMatchObject({status:409});});
it('preserves hidden historical image duplication but rejects new creation',async()=>{const s=await setup(),id=await source(s);await f.pool.query('UPDATE patient_documents SET removed_at=NOW() WHERE id=$1',[s.documentId]);expect(await run('create',s)).toMatchObject({ok:false});expect(await run('duplicate',s,id)).toMatchObject({ok:true});});
it.each(['create','duplicate'] as const)('atomic audit rollback for %s',async kind=>{const s=await setup(),id=kind==='duplicate'?await source(s):undefined;await f.pool.query("CREATE FUNCTION synthetic_deny_ceph_create() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ceph.create' THEN RAISE EXCEPTION 'synthetic audit rejection'; END IF; RETURN NEW; END $$");await f.pool.query('CREATE TRIGGER synthetic_deny_ceph_create BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_deny_ceph_create()');try{await expect(run(kind,s,id)).rejects.toThrow('synthetic audit rejection');expect((await f.pool.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'",[s.patientId])).rowCount).toBe(0);}finally{await f.pool.query('DROP TRIGGER synthetic_deny_ceph_create ON audit_log');await f.pool.query('DROP FUNCTION synthetic_deny_ceph_create()');}});
async function waitForLock(pid:number,pattern:string){const until=Date.now()+10000;while(Date.now()<until){if((await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid))",[pattern,pid])).rowCount)return;await new Promise(r=>setTimeout(r,15));}throw Error('exact blocker not observed');}
it.each(['create','duplicate'] as const)('revocation winning observed account lock prevents %s',async kind=>{const s=await setup(),id=kind==='duplicate'?await source(s):undefined,block=await f.pool.connect(),pid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;await block.query('BEGIN');await block.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[s.session.userId]);const pending=run(kind,s,id).then(value=>({value}),error=>({error}));try{await waitForLock(pid,'SELECT * FROM users%');await block.query('UPDATE users SET is_active=false WHERE id=$1',[s.session.userId]);await block.query('COMMIT');expect(await pending).toMatchObject({error:{status:401}});}finally{await block.query('ROLLBACK');block.release();await pending;}});
it.each(['create','duplicate'] as const)('expiry during observed insert lock rolls back %s',async kind=>{const s=await setup(),id=kind==='duplicate'?await source(s):undefined,block=await f.pool.connect(),pid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;await block.query('BEGIN');await block.query('LOCK TABLE ceph_analyses IN SHARE MODE');const pending=run(kind,s,id).then(value=>({value}),error=>({error}));try{await waitForLock(pid,'%INSERT INTO ceph_analyses%');vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(s.session.expiresAt+1);await block.query('COMMIT');expect(await pending).toMatchObject({error:{status:401}});expect((await f.pool.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'",[s.patientId])).rowCount).toBe(0);}finally{await block.query('ROLLBACK');block.release();vi.useRealTimers();await pending;}});
it('create never substitutes body scope for admitted request',async()=>{const s=await setup(),other=await setup();await expect(f.db.createAuthorizedCephAnalysis({patientId:other.patientId,documentId:other.documentId},s)).rejects.toMatchObject({status:409});});
it.each(['create','duplicate'] as const)('refuses foreign case binding for %s without rewriting history',async kind=>{const s=await setup(),other=await setup(),caseId=(await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,start_date,created_by) VALUES($1,'active','working','2026-01-01','synthetic') RETURNING id",[other.patientId])).rows[0].id;
 if(kind==='create')expect(await f.db.createAuthorizedCephAnalysis({patientId:s.patientId,documentId:s.documentId,orthoCaseId:caseId},s)).toMatchObject({ok:false});else{const id=await source(s);await f.pool.query('UPDATE ceph_analyses SET ortho_case_id=$2 WHERE id=$1',[id,caseId]);expect(await run(kind,s,id)).toMatchObject({ok:false});expect((await f.pool.query('SELECT ortho_case_id FROM ceph_analyses WHERE id=$1',[id])).rows[0].ortho_case_id).toBe(caseId);}
});
it.each(['image','case'] as const)('create refuses busy %s witness and rolls back authority locks',async kind=>{const s=await setup(),caseId=(await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,start_date,created_by) VALUES($1,'active','working','2026-01-01','synthetic') RETURNING id",[s.patientId])).rows[0].id,block=await f.pool.connect();await block.query('BEGIN');await block.query(kind==='image'?'SELECT id FROM patient_documents WHERE id=$1 FOR UPDATE':'SELECT id FROM ortho_cases WHERE id=$1 FOR UPDATE',[kind==='image'?s.documentId:caseId]);try{await expect(f.db.createAuthorizedCephAnalysis({patientId:s.patientId,documentId:s.documentId,orthoCaseId:caseId},s)).rejects.toMatchObject({status:409});await block.query('SELECT id FROM patients WHERE id=$1 FOR UPDATE NOWAIT',[s.patientId]);await block.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT',[s.session.userId]);}finally{await block.query('ROLLBACK');block.release();}});
it.each(['create','duplicate'] as const)('upload permission loss refuses %s',async kind=>{const s=await setup(),id=kind==='duplicate'?await source(s):undefined;await f.pool.query("UPDATE users SET role='doctor',permissions='{"+'"canViewAllPatients":true,"canUploadXrays":false'+"}' WHERE id=$1",[s.session.userId]);s.session.role='doctor';await expect(run(kind,s,id)).rejects.toMatchObject({status:403});});
it('one-draft conflict preserves original completed evidence and first copy',async()=>{const s=await setup(),id=await source(s);const original=(await f.pool.query('SELECT to_jsonb(c) AS row FROM ceph_analyses c WHERE id=$1',[id])).rows;const landmarks=(await f.pool.query('SELECT code,x,y,source,confirmed_by,confirmed_at::text FROM ceph_landmarks WHERE analysis_id=$1',[id])).rows;const copy=await run('duplicate',s,id);expect(copy.ok).toBe(true);expect(await run('duplicate',s,id)).toMatchObject({ok:false});expect(await run('create',s)).toMatchObject({ok:false});expect((await f.pool.query('SELECT to_jsonb(c) AS row FROM ceph_analyses c WHERE id=$1',[id])).rows).toEqual(original);expect((await f.pool.query('SELECT code,x,y,source,confirmed_by,confirmed_at::text FROM ceph_landmarks WHERE analysis_id=$1',[copy.ok?copy.id:0])).rows).toEqual(landmarks);});
it('persists explicit immutable source while leaving legacy parent and notes untouched',async()=>{
 const s=await setup(),id=await source(s),token=await correctionToken(s,id),before=(await f.pool.query('SELECT to_jsonb(c) AS value FROM ceph_analyses c WHERE id=$1',[id])).rows[0].value;
 const created=await f.db.duplicateAuthorizedCephAnalysis(id,s,token);expect(created.ok).toBe(true);if(!created.ok)throw Error('expected copy');
 const study=await f.db.getCephStudy(created.id);expect(study?.analysis.correctionOrigin).toMatchObject({parentAnalysisId:id,recordedPatientId:s.patientId,documentId:s.documentId,parentCompletion:{state:'unversioned'}});
 expect((await f.db.getCephStudy(id))?.analysis.correctionOrigin).toBeNull();expect((await f.pool.query('SELECT to_jsonb(c) AS value FROM ceph_analyses c WHERE id=$1',[id])).rows[0].value).toEqual(before);
 await expect(f.pool.query('UPDATE ceph_analyses SET corrects_analysis_id=NULL,correction_source=NULL,correction_source_canonical=NULL,correction_source_sha256=NULL WHERE id=$1',[created.id])).rejects.toMatchObject({code:'55000'});
 await expect(f.pool.query('DELETE FROM ceph_analyses WHERE id=$1',[created.id])).rejects.toMatchObject({code:'55000'});
 await expect(f.pool.query('DELETE FROM ceph_analyses WHERE id=$1',[id])).rejects.toMatchObject({code:'23001'});
});
it.each(['landmark','reviewer','note','image_hash','image_dimensions','created_microsecond'] as const)('rejects changed %s since opened correction token without creating a draft',async kind=>{
 const s=await setup(),id=await source(s),token=await correctionToken(s,id);
 if(kind==='landmark')await f.pool.query('UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1',[id]);
 if(kind==='reviewer')await f.pool.query("UPDATE ceph_landmarks SET confirmed_by='Synthetic different reviewer' WHERE analysis_id=$1",[id]);
 if(kind==='created_microsecond')await f.pool.query("UPDATE ceph_analyses SET created_at=created_at+interval '1 microsecond' WHERE id=$1",[id]);
 if(kind==='note')await f.pool.query("UPDATE ceph_analyses SET note='Synthetic changed note' WHERE id=$1",[id]);
 if(kind==='image_hash')await f.pool.query('UPDATE patient_documents SET sha256=$2 WHERE id=$1',[s.documentId,'b'.repeat(64)]);
 if(kind==='image_dimensions')await f.pool.query('UPDATE patient_documents SET width=500,height=800 WHERE id=$1',[s.documentId]);
 expect(await f.db.duplicateAuthorizedCephAnalysis(id,s,token)).toMatchObject({ok:false});expect((await f.pool.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'",[s.patientId])).rows).toEqual([]);
 correctionTokens.set(id,await correctionToken(s,id));expect(await run('duplicate',s,id)).toMatchObject({ok:true});
});
it('retains a two-generation correction chain and detects changed legacy ancestor',async()=>{
 const s=await setup(),id=await source(s),first=await run('duplicate',s,id);if(!first.ok)throw Error('first correction');
 await f.pool.query("UPDATE ceph_analyses SET status='completed' WHERE id=$1",[first.id]);
 const second=await run('duplicate',s,first.id);expect(second.ok).toBe(true);if(!second.ok)throw Error('second correction');
 expect((await f.db.getCephStudy(second.id))?.analysis.correctionOrigin?.parentAnalysisId).toBe(first.id);
 await f.pool.query("UPDATE ceph_analyses SET status='completed' WHERE id=$1",[second.id]);
 correctionTokens.set(second.id,await correctionToken(s,second.id));
 await f.pool.query('UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1',[id]);
 expect((await f.db.getCephStudy(second.id))?.correctionSource.state).toBe('unavailable');
 expect(await run('duplicate',s,second.id)).toMatchObject({ok:false});
});
it('allows atomic current patient merge of complete ancestry without changing recorded identity',async()=>{
 const s=await setup(),id=await source(s),copy=await run('duplicate',s,id),other=await setup();if(!copy.ok)throw Error('copy');
 const origin=(await f.db.getCephStudy(copy.id))?.analysis.correctionOrigin;
 const client=await f.pool.connect();try{await client.query('BEGIN');await client.query('UPDATE ceph_analyses SET patient_id=$2 WHERE patient_id=$1',[s.patientId,other.patientId]);await client.query('UPDATE patient_documents SET patient_id=$2 WHERE id=$1',[s.documentId,other.patientId]);await client.query('COMMIT');}finally{await client.query('ROLLBACK');client.release();}
 const current=await f.db.getCephStudy(copy.id);expect(current?.analysis.patientId).toBe(other.patientId);expect(current?.analysis.correctionOrigin).toEqual(origin);
 await expect(f.pool.query('UPDATE ceph_analyses SET patient_id=$2 WHERE id=$1',[copy.id,s.patientId])).rejects.toMatchObject({code:'23514'});
});
it('rejects malformed partial or falsely versioned direct lineage rows',async()=>{
 const s=await setup(),id=await source(s),read=(await f.db.getCephStudy(id))!.correctionSource;if(read.state!=='available')throw Error('source');
 await expect(f.pool.query("INSERT INTO ceph_analyses(patient_id,document_id,status,created_by,corrects_analysis_id) VALUES($1,$2,'draft','synthetic',$3)",[s.patientId,s.documentId,id])).rejects.toMatchObject({code:'23514'});
 const {canonicalJourneyJSON,journeyContentHash}=await import('../../lib/ortho-case-journey-hash');
 for(const origin of [{...read.origin,parentCompletion:{state:'unversioned',reason:'historical_completion_without_witness',approved:true}}, {...read.origin,parentCompletion:{state:'versioned',witnessVersion:2,witnessSha256:'a'.repeat(64)}}]){
  await expect(f.pool.query("INSERT INTO ceph_analyses(patient_id,document_id,status,created_by,corrects_analysis_id,correction_source,correction_source_canonical,correction_source_sha256) VALUES($1,$2,'draft','synthetic',$3,$4,$5,$6)",[s.patientId,s.documentId,id,JSON.stringify(origin),canonicalJourneyJSON(origin),journeyContentHash(origin)])).rejects.toMatchObject({code:'23514'});
 }
});
it('captures correction ancestry once in saved study and rechecks the original source on read',async()=>{
 const s=await setup(),id=await source(s);
 const orthoCaseId=(await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,created_by) VALUES($1,'active','working','synthetic') RETURNING id",[s.patientId])).rows[0].id;
 const clinicalCaseId=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic lineage case',$2,'synthetic') RETURNING id",[s.patientId,orthoCaseId])).rows[0].id;
 await f.pool.query('UPDATE ceph_analyses SET ortho_case_id=$2 WHERE id=$1',[id,orthoCaseId]);
 correctionTokens.set(id,await correctionToken(s,id));const copy=await run('duplicate',s,id);if(!copy.ok)throw Error('copy');
 request.token=createSessionToken(s.session);
 const owner={patientId:s.patientId,orthoCaseId,clinicalCaseId,session:s.session};
 const {getOrthoStudySourceChoices}=await import('../../lib/ortho-case-study-inventory');
 const inventory=await getOrthoStudySourceChoices({...owner,kind:'ceph_study'});if(!inventory.ok)throw Error(inventory.code);
 const selection=inventory.choices.find(c=>c.id===copy.id)?.selection;if(!selection)throw Error('Synthetic source selection unavailable');
 const {syntheticStudyCommand}=await import('../fixtures/ortho-case-study');const command=syntheticStudyCommand();command.content.sources=[selection];
 command.content.panels=[{instanceId:'lineage',layoutKey:'ceph-measurements',included:true,state:'available',sourceKeys:[selection.key],images:[],comment:''}];
 command.content.groups=[];command.content.mediaUses=[];
 const {saveConfirmedStudy}=await import('../helpers/ortho-study-submit');const saved=await saveConfirmedStudy({...owner,command});if(!saved.ok)throw Error(saved.code);
 const capture=saved.revision.content.sources[0].payload as {captureVersion:number;correctionOrigin:{parentAnalysisId:number};base:{correctsStudyId:number}};
 expect(capture).toMatchObject({captureVersion:4,correctionOrigin:{parentAnalysisId:id},base:{correctsStudyId:id}});
 const {getOrthoCaseStudy}=await import('../../lib/ortho-case-study-store');expect(await getOrthoCaseStudy({...owner,revisionId:saved.revision.id})).toMatchObject({ok:true});
 const {projectStudyRecordedFacts}=await import('../../lib/ortho-case-study-recorded-facts');expect(JSON.stringify(projectStudyRecordedFacts(saved.revision.content,owner,'lineage','draft'))).toContain('الدراسة الأصلية للتصحيح');
 await f.pool.query('UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1',[id]);
 expect(await getOrthoCaseStudy({...owner,revisionId:saved.revision.id})).toMatchObject({ok:false});
 const preserved=(await f.pool.query('SELECT content_sha256 FROM ortho_case_study_revisions WHERE id=$1',[saved.revision.id])).rows[0];expect(preserved.content_sha256).toBe(saved.revision.contentHash);
});
it.each(['cycle','overdepth'] as const)('refuses %s ancestry in one deferred multirow restore transaction',async kind=>{
 const s=await setup(),count=kind==='cycle'?2:66;
 const ids=(await f.pool.query("SELECT nextval(pg_get_serial_sequence('ceph_analyses','id')) AS id FROM generate_series(1,$1)",[count])).rows.map(r=>Number(r.id));
 const {canonicalJourneyJSON,journeyContentHash}=await import('../../lib/ortho-case-journey-hash');
 const client=await f.pool.connect();
 try{
  await client.query('BEGIN');
  for(let i=0;i<count;i++){
   const parent=kind==='cycle'?ids[1-i]:i===0?null:ids[i-1];
   const origin=parent===null?null:{schemaVersion:1,parentAnalysisId:parent,recordedPatientId:s.patientId,orthoCaseId:null,documentId:s.documentId,parentCompletion:{state:'unversioned',reason:'historical_completion_without_witness'},sourceSnapshotSha256:'a'.repeat(64)};
   await client.query("INSERT INTO ceph_analyses(id,patient_id,document_id,status,created_by,corrects_analysis_id,correction_source,correction_source_canonical,correction_source_sha256) VALUES($1,$2,$3,'completed','synthetic',$4,$5,$6,$7)",[ids[i],s.patientId,s.documentId,parent,origin?JSON.stringify(origin):null,origin?canonicalJourneyJSON(origin):null,origin?journeyContentHash(origin):null]);
  }
  await expect(client.query('COMMIT')).rejects.toMatchObject({code:'23514'});
 }finally{await client.query('ROLLBACK');client.release();}
 expect((await f.pool.query('SELECT id FROM ceph_analyses WHERE patient_id=$1',[s.patientId])).rows).toEqual([]);
});
it('permits child-before-parent restore order without assuming increasing parent IDs',async()=>{
 const s=await setup(),ids=(await f.pool.query("SELECT nextval(pg_get_serial_sequence('ceph_analyses','id')) AS id FROM generate_series(1,2)")).rows.map(r=>Number(r.id));
 const origin={schemaVersion:1,parentAnalysisId:ids[1],recordedPatientId:s.patientId,orthoCaseId:null,documentId:s.documentId,parentCompletion:{state:'unversioned',reason:'historical_completion_without_witness'},sourceSnapshotSha256:'a'.repeat(64)};
 const {canonicalJourneyJSON,journeyContentHash}=await import('../../lib/ortho-case-journey-hash'),client=await f.pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("INSERT INTO ceph_analyses(id,patient_id,document_id,status,created_by,corrects_analysis_id,correction_source,correction_source_canonical,correction_source_sha256) VALUES($1,$2,$3,'draft','synthetic',$4,$5,$6,$7)",[ids[0],s.patientId,s.documentId,ids[1],JSON.stringify(origin),canonicalJourneyJSON(origin),journeyContentHash(origin)]);
  await client.query("INSERT INTO ceph_analyses(id,patient_id,document_id,status,created_by) VALUES($1,$2,$3,'completed','synthetic')",[ids[1],s.patientId,s.documentId]);await client.query('COMMIT');
 }finally{await client.query('ROLLBACK');client.release();}
 expect((await f.pool.query('SELECT corrects_analysis_id FROM ceph_analyses WHERE id=$1',[ids[0]])).rows[0].corrects_analysis_id).toBe(String(ids[1]));
 // This exercises DB ordering only; the fabricated snapshot is deliberately
 // not accepted as application source evidence.
 expect((await f.db.getCephStudy(ids[0]))?.correctionSource.state).toBe('unavailable');
});
it('refuses a source image rebound to a different case of the same patient',async()=>{
 const s=await setup(),id=await source(s),token=await correctionToken(s,id);
 const otherCase=(await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,created_by) VALUES($1,'active','working','synthetic') RETURNING id",[s.patientId])).rows[0].id;
 await f.pool.query('UPDATE patient_documents SET ortho_case_id=$2 WHERE id=$1',[s.documentId,otherCase]);
 expect((await f.db.getCephStudy(id))?.correctionSource.state).toBe('unavailable');
 expect(await f.db.duplicateAuthorizedCephAnalysis(id,s,token)).toMatchObject({ok:false});
 expect((await f.pool.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'",[s.patientId])).rows).toEqual([]);
});
