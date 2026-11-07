import {createHash,randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {createSessionToken,sessionCredentialVersion,type SessionPayload} from '../../lib/auth';
import {MEASUREMENTS,computeAll,type LandmarkCode} from '../../lib/ceph';
import {parseCephCompletionSnapshot} from '../../lib/ceph-completion-snapshot';
import {buildCephCompletionWitness,cephProvenanceHash} from '../../lib/ceph-completion-provenance';
import {journeyContentHash} from '../../lib/ortho-case-journey-hash';
import {getOrthoCaseStudy,saveOrthoCaseStudy} from '../../lib/ortho-case-study-store';
import {getOrthoStudySourceChoices} from '../../lib/ortho-case-study-inventory';
import {getStudySubmissionRecovery,reserveStudySubmission,transitionStudySubmission} from '../../lib/ortho-study-submission-store';
import {getStudyLongitudinalEligibility} from '../../lib/ortho-study-longitudinal-store';
import {fullBackupBlocks} from '../../lib/fullBackup';
import {stagedRestore} from '../../lib/restore/staging';
import {saveConfirmedStudy} from '../helpers/ortho-study-submit';
import {syntheticStudyCommand} from '../fixtures/ortho-case-study';
import type {StudySourceSelection} from '../../lib/ortho-case-study';
import {openPeriodontalFixture} from './_periodontal-fixture';
const request=vi.hoisted(()=>({token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='aqlan_flow_session'?{value:request.token}:undefined}),headers:async()=>new Headers()}));
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>,session:SessionPayload;
const bytes=Buffer.from('synthetic-witness-source'),sha=createHash('sha256').update(bytes).digest('hex');
const points={S:[100,100],N:[169,92],A:[167.57,151.98],B:[163.84,179.85],Pog:[164.03,186.87],Me:[160,205],Go:[82.97,169.08],Or:[160,125],Po:[100,125],U1A:[160,134],U1:[174.08,171.44],L1A:[149,199.2],L1:[168,164],OcclA:[170,148],OcclP:[100,135.3],Gn:[161.5,195.5]};
beforeAll(async()=>{
 vi.stubEnv('SESSION_SECRET','synthetic-study-witness-lifecycle-secret');
 f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();
 const username=`synthetic-${randomUUID()}`,password='synthetic-test-not-a-password';
 const actor=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic signer',$2,'admin') RETURNING id",[username,password])).rows[0];
 session={userId:actor.id,username,role:'admin',expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion(password)};request.token=createSessionToken(session);
});
afterAll(async()=>{try{await f?.close();}finally{vi.unstubAllEnvs();}});
async function sealed(witnessVersion:1|2=2){
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic witness patient') RETURNING id",[randomUUID()])).rows[0].id;
 const orthoCaseId=(await f.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,$2,'active') RETURNING id",[patientId,session.username])).rows[0].id;
 const clinicalCaseId=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,$3) RETURNING id",[patientId,orthoCaseId,session.username])).rows[0].id;
 const documentId=(await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,width,height) VALUES($1,$2,'Synthetic source','image/png',$3,$4,$5,$6,500,500) RETURNING id",[patientId,orthoCaseId,bytes.length,sha,randomUUID(),session.username])).rows[0].id;
 const refKey=`synthetic-${randomUUID()}`,refId=(await f.pool.query("INSERT INTO ceph_reference_sets(key,name,population,version,created_by) VALUES($1,'Synthetic reference','Synthetic population','synthetic-v1',$2) RETURNING id",[refKey,session.username])).rows[0].id;
 for(const d of MEASUREMENTS)if(d.mean!==null&&d.tol!==null&&d.tol>0)await f.pool.query('INSERT INTO ceph_reference_values(set_id,code,mean,sd) VALUES($1,$2,$3,$4)',[refId,d.code,d.mean,d.tol]);
 const analysisId=Number((await f.pool.query("INSERT INTO ceph_analyses(patient_id,ortho_case_id,document_id,created_by,ref_set,cal_x1,cal_y1,cal_x2,cal_y2,cal_mm,mm_per_pixel) VALUES($1,$2,$3,$4,$5,0,0,100,0,100,1) RETURNING id",[patientId,orthoCaseId,documentId,session.username,refKey])).rows[0].id);
 for(const [code,[x,y]]of Object.entries(points))await f.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,$2,$3,$4,'manual',$5)",[analysisId,code,x,y,session.username]);
 const diagnosis={skeletal:'Synthetic skeletal',dental:null,softTissue:null,note:null,finalDx:'Synthetic reviewed diagnosis'};
 await f.pool.query('INSERT INTO ceph_diagnoses(analysis_id,skeletal,final_dx,created_by) VALUES($1,$2,$3,$4)',[analysisId,diagnosis.skeletal,diagnosis.finalDx,session.username]);
 const snapshot=parseCephCompletionSnapshot({patientId,documentId,refSet:refKey,calibration:{x1:0,y1:0,x2:100,y2:0,mm:100},mmPerPixel:1,landmarks:Object.entries(points).map(([code,[x,y]])=>({code:code as LandmarkCode,x,y,source:'manual'})),diagnosis});
 if(!snapshot)throw Error('Invalid synthetic snapshot');
 const sourceBundle=(await f.db.getCephStudy(analysisId))?.completionSources;
 if(sourceBundle?.state!=='available')throw Error('Synthetic completion sources unavailable');
 if(witnessVersion===2){
  expect(await f.db.completeCephAnalysis(analysisId,session.username,snapshot,session,sourceBundle.identity)).toMatchObject({ok:true,provenance:{state:'versioned',witness:{schemaVersion:2}}});
 }else{
  // Deliberately constructed historical synthetic fixture. Never rewrite a v2
  // seal into v1 or add this path to production completion code.
  const reviews=(await f.pool.query<{code:string;confirmedBy:string;confirmedAt:string}>(`SELECT code,confirmed_by AS "confirmedBy",to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "confirmedAt" FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code`,[analysisId])).rows;
  const geometry=Object.fromEntries(Object.entries(points).map(([code,[x,y]])=>[code,{x,y}]));
  const measurements=computeAll(geometry,1).filter(row=>row.value!==null).map(row=>({code:row.code,value:row.value!}));
  const witness=buildCephCompletionWitness({analysisId,actor:{userId:session.userId!,username:session.username},sealedAt:new Date().toISOString(),snapshot,
   image:{documentId,sha256:sha,width:500,height:500},landmarkReviews:reviews,referenceSet:sourceBundle.referenceSet,measurements});
  const client=await f.pool.connect();try{
   await client.query('BEGIN');
   for(const row of measurements)await client.query('INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,$2,$3)',[analysisId,row.code,row.value]);
   await client.query("UPDATE ceph_analyses SET status='completed',completed_by=$2,completed_at=$3::timestamptz WHERE id=$1",[analysisId,session.username,witness.sealedAt]);
   await client.query('INSERT INTO ceph_completion_provenance(analysis_id,schema_version,witness,witness_sha256,actor_user_id,sealed_by,sealed_at) VALUES($1,1,$2::jsonb,$3,$4,$5,$6::timestamptz)',[analysisId,JSON.stringify(witness),cephProvenanceHash(witness),session.userId,session.username,witness.sealedAt]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  expect((await f.db.getCephStudy(analysisId))?.provenance).toMatchObject({state:'versioned',witness:{schemaVersion:1}});
 }
 return {patientId,orthoCaseId,clinicalCaseId,analysisId,documentId,session};
}
type Owner=Awaited<ReturnType<typeof sealed>>;
async function choice(owner:Owner){
 const result=await getOrthoStudySourceChoices({...owner,kind:'ceph_study'});
 if(!result.ok||result.state!=='available')throw Error('Synthetic inventory unavailable');
 const selected=result.choices.find(row=>row.id===owner.analysisId)?.selection;if(!selected)throw Error('Synthetic source missing');return selected;
}
function command(source:StudySourceSelection){
 const c=syntheticStudyCommand();c.content.sources=[source];c.content.panels=[{instanceId:'ceph',layoutKey:'ceph-measurements',included:true,state:'available',sourceKeys:[source.key],images:[],comment:''}];
 c.content.groups=[{id:'stage1',label:'Synthetic T1',phase:'T1',sourceKeys:[source.key],occurrence:{occurredOn:null,dateProvenance:'unknown',sourceNote:'Synthetic unknown date'}}];return c;
}
async function legacyChoice(owner:Owner):Promise<StudySourceSelection>{
 const a=(await f.pool.query('SELECT *,xray_date::text date FROM ceph_analyses WHERE id=$1',[owner.analysisId])).rows[0];
 const dx=(await f.pool.query('SELECT * FROM ceph_diagnoses WHERE analysis_id=$1',[owner.analysisId])).rows[0];
 const ms=(await f.pool.query('SELECT code,value FROM ceph_measurements WHERE analysis_id=$1 ORDER BY code',[owner.analysisId])).rows;
 const payload={id:owner.analysisId,status:a.status,phase:a.phase,acquisitionDate:a.date,device:a.device,referenceSetKey:a.ref_set,studyKind:a.study_kind,note:a.note,createdAt:a.created_at.toISOString(),createdBy:a.created_by,completedAt:a.completed_at.toISOString(),completedBy:a.completed_by,correctsStudyId:null,
 image:{documentId:owner.documentId,contentHash:sha,state:'available'},measurements:ms.map(m=>({...m,unit:null,provenance:'stored_measurement_unit_not_versioned'})),diagnosis:{skeletal:dx.skeletal,dental:dx.dental,softTissue:dx.soft_tissue,note:dx.note,finalDx:dx.final_dx,createdBy:dx.created_by,createdAt:dx.created_at.toISOString(),updatedAt:dx.updated_at.toISOString()},interpretation:{state:'unavailable',reason:'review_and_reference_witness_not_versioned'},historicalCompletionMeaning:'stored_completion_not_new_clinical_validation'};
 return {key:'old_ceph',kind:'ceph_study',id:owner.analysisId,version:null,contentHash:journeyContentHash(payload)};
}
const args=(owner:Owner,c:ReturnType<typeof command>)=>({...owner,actorId:session.userId!,commandId:c.clientRequestId,requestFingerprint:journeyContentHash(c)});
it('preserves an old pending source hash and exact documentation, then appends witnessed capture without rewriting history',async()=>{
 const owner=await sealed(),old=command(await legacyChoice(owner));
 expect(await reserveStudySubmission({...owner,actorId:session.userId!,command:old})).toMatchObject({ok:true});
 expect(await getStudySubmissionRecovery(owner)).toMatchObject({recovery:{state:'pending',expected:{command:old}}});
 const legacy=await saveConfirmedStudy({...owner,command:old});if(!legacy.ok)throw Error(legacy.code);
 expect(legacy.revision.content.sources[0].payload).not.toHaveProperty('captureVersion');
 const ref={id:legacy.revision.id,contentHash:legacy.revision.contentHash};
 const documented=await saveConfirmedStudy({...owner,command:{...old,clientRequestId:randomUUID(),kind:'documented',expectedHead:ref,documentedFrom:ref}});if(!documented.ok)throw Error(documented.code);
 expect(documented.revision.contentHash).toBe(legacy.revision.contentHash);expect(documented.revision.content).toEqual(legacy.revision.content);
 const next=command(await choice(owner));next.expectedHead={id:documented.revision.id,contentHash:documented.revision.contentHash};next.baseDocumentedRevision=next.expectedHead;
 const saved=await saveOrthoCaseStudy({...owner,actorId:session.userId!,command:next});if(!saved.ok)throw Error(saved.code);
 expect(saved.revision.content.sources[0].payload).toMatchObject({captureVersion:3,completion:{witness:{schemaVersion:2,sourceIdentityMeaning:'submitted_source_identity_matches_server_capture'}}});
 expect(await getStudySubmissionRecovery(owner)).toMatchObject({recovery:{state:'committed',expected:{command:next}}});
 expect(await saveOrthoCaseStudy({...owner,actorId:session.userId!,command:next})).toMatchObject({ok:true,replayed:true,revision:saved.revision});
 expect(await transitionStudySubmission({...args(owner,next),action:'acknowledge'})).toMatchObject({ok:true});
 await f.pool.query("UPDATE ceph_reference_sets SET version='later-reference-version' WHERE key=(SELECT ref_set FROM ceph_analyses WHERE id=$1)",[owner.analysisId]);
 await f.pool.query('UPDATE ceph_reference_values SET mean=mean+100 WHERE set_id=(SELECT id FROM ceph_reference_sets WHERE key=(SELECT ref_set FROM ceph_analyses WHERE id=$1))',[owner.analysisId]);
 expect((await choice(owner)).contentHash).toBe(next.content.sources[0].contentHash);
 const oldRead=await getOrthoCaseStudy({...owner,revisionId:legacy.revision.id});expect(oldRead).toMatchObject({ok:true,revision:{content:legacy.revision.content,contentHash:legacy.revision.contentHash}});
 expect(await getStudyLongitudinalEligibility({...owner,revisionId:saved.revision.id})).toMatchObject({ok:true,stages:[{state:'unavailable',sources:[{witness:'versioned_source_identity_matched'}]}]});
});
it('captures after canonical patient merge without conflating the two recorded identities',async()=>{
 const owner=await sealed(),original=owner.patientId,target=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic canonical patient') RETURNING id",[randomUUID()])).rows[0].id;
 expect(await f.db.mergeDuplicatePatient(original,target,{actor:session.username,actorRole:'admin'})).toMatchObject({ok:true});
 const moved={...owner,patientId:target},saved=await saveConfirmedStudy({...moved,command:command(await choice(moved))});if(!saved.ok)throw Error(saved.code);
 expect(saved.revision.content).toMatchObject({recordedPatientId:target,sources:[{payload:{captureVersion:3,completion:{witness:{recordedPatientId:original}}}}]});
 expect(await getOrthoCaseStudy(moved)).toMatchObject({ok:true,revision:{contentHash:saved.revision.contentHash}});
});
it('keeps a pending witnessed intent metadata-cancellable when stored measurement integrity changes',async()=>{
 const owner=await sealed(),c=command(await choice(owner)),input={...owner,actorId:session.userId!,command:c};
 expect(await reserveStudySubmission(input)).toMatchObject({ok:true});
 const before=(await f.pool.query("SELECT value FROM ceph_measurements WHERE analysis_id=$1 AND code='SNA'",[owner.analysisId])).rows[0].value;
 await f.pool.query("UPDATE ceph_measurements SET value=value+1 WHERE analysis_id=$1 AND code='SNA'",[owner.analysisId]);
 try{
  const recovery=await getStudySubmissionRecovery(owner);expect(recovery).toMatchObject({recovery:{state:'blocked',canCancel:true}});expect(JSON.stringify(recovery)).not.toContain('Synthetic physician comment');expect(JSON.stringify(recovery)).not.toContain('content');
  expect(await saveOrthoCaseStudy(input)).toMatchObject({ok:false,status:409});
  expect(await transitionStudySubmission({...args(owner,c),action:'cancel'})).toMatchObject({ok:true,state:'cancelled'});
  expect(await transitionStudySubmission({...args(owner,c),action:'acknowledge'})).toMatchObject({ok:true,state:'cancelled'});
 }finally{await f.pool.query("UPDATE ceph_measurements SET value=$2 WHERE analysis_id=$1 AND code='SNA'",[owner.analysisId,before]);}
});
it.each(['legacy','witness1','witness2'] as const)('rechecks backing-image case scope for saved %s reads, replay, documentation and export',async kind=>{
 const owner=await sealed(kind==='witness2'?2:1),c=command(kind==='legacy'?await legacyChoice(owner):await choice(owner));
 const saved=await saveConfirmedStudy({...owner,command:c});if(!saved.ok)throw Error(saved.code);
 const before=(await f.pool.query('SELECT to_jsonb(r)::text value FROM ortho_case_study_revisions r WHERE ortho_case_id=$1 ORDER BY id',[owner.orthoCaseId])).rows;
 const other=(await f.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,$2,'completed') RETURNING id",[owner.patientId,session.username])).rows[0].id;
 try{
  await f.pool.query('UPDATE patient_documents SET ortho_case_id=NULL WHERE id=$1',[owner.documentId]);
  expect(await getOrthoCaseStudy({...owner,revisionId:saved.revision.id})).toMatchObject({ok:true,revision:{contentHash:saved.revision.contentHash}});
  await f.pool.query('UPDATE patient_documents SET ortho_case_id=$2 WHERE id=$1',[owner.documentId,other]);
  expect(await getOrthoCaseStudy({...owner,revisionId:saved.revision.id})).toMatchObject({ok:false,status:403});
  expect(await getStudyLongitudinalEligibility({...owner,revisionId:saved.revision.id})).toMatchObject({ok:false,status:403});
  expect(await saveOrthoCaseStudy({...owner,actorId:session.userId!,command:c})).toMatchObject({ok:false,status:403});
  const ref={id:saved.revision.id,contentHash:saved.revision.contentHash};
  expect(await saveOrthoCaseStudy({...owner,actorId:session.userId!,command:{...c,clientRequestId:randomUUID(),kind:'documented',expectedHead:ref,documentedFrom:ref}})).toMatchObject({ok:false,status:403});
  const {GET}=await import('../../app/api/ortho/[id]/case-study/text-pptx/route');
  const response=await GET(new Request(`http://localhost/api/ortho/${owner.orthoCaseId}/case-study/text-pptx?patientId=${owner.patientId}&revisionId=${saved.revision.id}`),{params:Promise.resolve({id:String(owner.orthoCaseId)})});
  expect(response.status).toBe(403);expect(response.headers.get('Content-Type')).not.toContain('presentationml');
  expect((await f.pool.query('SELECT to_jsonb(r)::text value FROM ortho_case_study_revisions r WHERE ortho_case_id=$1 ORDER BY id',[owner.orthoCaseId])).rows).toEqual(before);
 }finally{await f.pool.query('UPDATE patient_documents SET ortho_case_id=$2 WHERE id=$1',[owner.documentId,owner.orthoCaseId]);}
});
it('keeps historical witness1 and capture2 exact without assigning source-review assurance',async()=>{
 const owner=await sealed(1),selected=await choice(owner),saved=await saveConfirmedStudy({...owner,command:command(selected)});if(!saved.ok)throw Error(saved.code);
 const payload=saved.revision.content.sources[0].payload;
 expect(payload).toMatchObject({captureVersion:2,completion:{witness:{schemaVersion:1,sourceIdentityMeaning:'server_captured_at_completion_not_confirmed_as_viewed'}}});
 expect(JSON.stringify(payload)).not.toContain('sourceReview');
 const before=(await f.pool.query('SELECT to_jsonb(p)::text value FROM ceph_completion_provenance p WHERE analysis_id=$1',[owner.analysisId])).rows;
 await f.pool.query("UPDATE ceph_reference_sets SET version='changed-after-historical-seal' WHERE key=(SELECT ref_set FROM ceph_analyses WHERE id=$1)",[owner.analysisId]);
 expect((await choice(owner)).contentHash).toBe(selected.contentHash);
 expect(await getOrthoCaseStudy({...owner,revisionId:saved.revision.id})).toMatchObject({ok:true,revision:{contentHash:saved.revision.contentHash,content:saved.revision.content}});
 expect(await getStudyLongitudinalEligibility({...owner,revisionId:saved.revision.id})).toMatchObject({ok:true,stages:[{state:'unavailable',sources:[{witness:'versioned_unconfirmed_view',reasons:['source_identity_not_view_bound']}]}]});
 expect((await f.pool.query('SELECT to_jsonb(p)::text value FROM ceph_completion_provenance p WHERE analysis_id=$1',[owner.analysisId])).rows).toEqual(before);
});
it('round-trips mixed captures, witnesses and pending receipts through a full archive and refuses reset before backup',async()=>{
 const archivedOwner=await sealed(),archived=await saveConfirmedStudy({...archivedOwner,command:command(await choice(archivedOwner))});if(!archived.ok)throw Error(archived.code);
 const archivedRevisionId=archived.revision.id,archivedHash=archived.revision.contentHash;
 const pendingOwner=await sealed(),pending=command(await choice(pendingOwner));expect(await reserveStudySubmission({...pendingOwner,actorId:session.userId!,command:pending})).toMatchObject({ok:true});
 const state=async()=>{
  const result:Record<string,unknown>={};for(const table of ['ortho_case_study_revisions','ortho_study_submissions','ceph_completion_provenance','invoices','payments'])result[table]=(await f.pool.query(`SELECT to_jsonb(t)::text value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;return result;
 };
 expect((await f.pool.query('SELECT DISTINCT schema_version FROM ceph_completion_provenance ORDER BY schema_version')).rows.map(row=>row.schema_version)).toEqual([1,2]);
 const expected=await state(),backup=vi.fn(async()=>({ok:false as const,failure:'Must not run'}));
 await expect(f.db.resetClinicData({actor:session.username,actorRole:'admin'},backup)).rejects.toThrow();expect(backup).not.toHaveBeenCalled();expect(await state()).toEqual(expected);
 const directory=await mkdtemp(path.join(tmpdir(),'ortho-study-witness-restore-'));
 try{
  const archivePath=path.join(directory,'synthetic-full.tar.gz'),source=await f.pool.connect();
  try{await pipeline(Readable.from(fullBackupBlocks({source,readDocument:async()=>bytes})),createGzip(),createWriteStream(archivePath));}finally{source.release();}
  await f.close();f=await openPeriodontalFixture(process.env,{pristine:true});
  const restored=await stagedRestore({archivePath,targetUrl:f.url,stagingDir:path.join(directory,'synthetic-documents')});expect(restored.errors).toEqual([]);expect(restored.ok).toBe(true);expect(await state()).toEqual(expected);
  expect(await getOrthoCaseStudy({...archivedOwner,revisionId:archivedRevisionId})).toMatchObject({ok:true,revision:{contentHash:archivedHash}});
  expect(await getStudySubmissionRecovery(pendingOwner)).toMatchObject({recovery:{state:'pending',expected:{command:pending}}});
  const replay=await saveConfirmedStudy({...pendingOwner,command:pending});expect(replay).toMatchObject({ok:true,revision:{content:{sources:[{payload:{captureVersion:3}}]}}});
 }finally{await rm(directory,{recursive:true,force:true});}
});
