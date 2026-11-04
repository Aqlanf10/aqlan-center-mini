import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createSessionToken,sessionCredentialVersion,type SessionPayload} from '../../lib/auth';
import {openPeriodontalFixture} from './_periodontal-fixture';
import {putFile,readFileByKey} from '../../lib/files';
import {getStudyImageBasis,getStudyImagePreview} from '../../lib/ortho-study-image-store';
import {defaultOrthoMediaRecipe} from '../../lib/ortho-study-media';
import {identityDatabaseState} from '../helpers/hr-identity-state';
import {saveOrthoCaseStudy} from '../../lib/ortho-case-study-store';
import {withIllustratedStudy} from '../../lib/ortho-study-illustrated-store';
import {CASE_TEMPLATE_VERSION} from '../../lib/ortho-case-template';
import {STUDY_TEMPLATE_HASH} from '../../lib/ortho-case-study-template';
import {randomUUID} from 'node:crypto';
let directory = '';
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>, n = 0;
beforeAll(async () => { vi.stubEnv("SESSION_SECRET", "synthetic-study-image-review-secret-at-least32characters"); f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema(); directory = await mkdtemp(join(tmpdir(),"study-images-synthetic-")); vi.stubEnv("DOCUMENTS_DIR", directory); });
afterAll(async () => { try { await f?.close(); } finally { if(directory) await rm(directory,{recursive:true,force:true}); vi.unstubAllEnvs(); } });
async function setup() {
  const seq = ++n, password = "Synthetic credential";
  const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic mixed analysis') RETURNING id", [`SYN-STUDY-${seq}`])).rows[0].id;
  const userId = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic examiner',$2,'admin') RETURNING id", [`synthetic-study-image-${seq}`, password])).rows[0].id;
  const session: SessionPayload = { userId, username: `synthetic-study-image-${seq}`, role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 600000 };
  request.token = createSessionToken(session);
  const orthoCaseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,appliance,arches,slot,start_date,planned_months,created_by) VALUES($1,'assessment','assessment',NULL,NULL,NULL,NULL,NULL,'synthetic') RETURNING id", [patientId])).rows[0].id;
  const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic mixed analysis bridge',$2,'synthetic') RETURNING id", [patientId, orthoCaseId])).rows[0].id;
  return { patientId, orthoCaseId, clinicalCaseId, session };
}

async function image() {
  const scope = await setup(), bytes = await sharp({create:{width:12,height:8,channels:3,background:'#336699'}}).png().toBuffer();
  const stored = await putFile(bytes,'png');
  const documentId = (await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'photo','Synthetic study image','image/png',$3,$4,$5,'synthetic') RETURNING id",[scope.patientId,scope.orthoCaseId,bytes.length,stored.sha256,stored.key])).rows[0].id;
  const command = {patientId:scope.patientId,documentId,sha256:stored.sha256,useId:'synthetic_use',purpose:'selected-use' as const,recipe:defaultOrthoMediaRecipe(12,8,1),frame:{width:12,height:8}};
  return {scope,bytes,stored,documentId,command};
}
async function savedImage(){
 const p=await image(),selection={key:'image',kind:'document',id:p.documentId,version:null,contentHash:p.stored.sha256};
 const command={schemaVersion:1,clientRequestId:randomUUID(),expectedHead:null,baseDocumentedRevision:null,kind:'draft',documentedFrom:null,reason:'Synthetic saved image export',content:{template:{key:'full-orthodontic-case',version:CASE_TEMPLATE_VERSION,contentHash:STUDY_TEMPLATE_HASH},identityDisclosure:'case_only',sources:[selection],groups:[],comment:'',panels:[{instanceId:'face',layoutKey:'face-overview',included:true,state:'available',sourceKeys:['image'],images:[{slot:'face-front',useId:'saved_use'}],comment:''}],mediaUses:[{useId:'saved_use',documentId:p.documentId,sourceSha256:p.stored.sha256,groupId:null,slotId:'face-front',order:0,view:'face-rest',caption:'Synthetic saved caption',recipe:p.command.recipe}]}};
 const saved=await saveOrthoCaseStudy({...p.scope,command});if(!saved.ok)throw Error(saved.code);
 return {...p,revisionId:saved.revision.id};
}
it('exports only a saved image and rejects removed sources or revoked authority after rendering before releasing bytes',async()=>{
 const p=await savedImage(),input={...p.scope,revisionId:p.revisionId};
 const state=await identityDatabaseState(f.pool);
 const result=await withIllustratedStudy(input,async value=>value.pages.filter(p=>p.image).length);
 expect(result).toMatchObject({ok:true,output:1});expect(await identityDatabaseState(f.pool)).toEqual(state);
 expect(await readFileByKey(p.stored.key)).toEqual(p.bytes);
 const denied=await withIllustratedStudy(input,async()=>{await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[p.scope.session.userId]);return Buffer.from('must not escape');});
 expect(denied).toMatchObject({ok:false,status:401});expect(denied).not.toHaveProperty('output');
 await f.pool.query('UPDATE users SET is_active=true WHERE id=$1',[p.scope.session.userId]);
 const removed=await withIllustratedStudy(input,async()=>{await f.pool.query("UPDATE patient_documents SET removed_at=now(),removed_by='synthetic',removed_note='Synthetic post-render removal' WHERE id=$1",[p.documentId]);return Buffer.from('must not escape');});
 expect(removed).toMatchObject({ok:false,status:403});expect(removed).not.toHaveProperty('output');
});
it('bounds simultaneous illustrated export and releases the slot after consumer failure',async()=>{
 const p=await savedImage(),input={...p.scope,revisionId:p.revisionId};
 await expect(withIllustratedStudy(input,async()=>{expect(await withIllustratedStudy(input,async()=>0)).toMatchObject({ok:false,code:'study_illustrated_busy'});throw Error('synthetic render failure');})).rejects.toThrow('synthetic render failure');
 expect(await withIllustratedStudy(input,async()=>1)).toMatchObject({ok:true,output:1});
});
it('checks real database ownership, renders real private bytes and leaves source/document/clinical records unchanged',async () => {
  const p=await image(), before=(await f.pool.query('SELECT * FROM patient_documents WHERE id=$1',[p.documentId])).rows;
  const databaseBefore=await identityDatabaseState(f.pool);
  expect(await getStudyImageBasis({...p.scope,documentId:p.documentId,sha256:p.stored.sha256})).toMatchObject({ok:true,clinicalCaseId:p.scope.clinicalCaseId,basis:{orientedWidth:12,orientedHeight:8,exifOrientation:1}});
  const result=await getStudyImagePreview({...p.scope,command:p.command}); if(!result.ok) throw Error(result.code);
  expect(result.sourceSha256).toBe(createHash('sha256').update(p.bytes).digest('hex'));
  expect(await readFileByKey(p.stored.key)).toEqual(p.bytes);
  expect((await f.pool.query('SELECT * FROM patient_documents WHERE id=$1',[p.documentId])).rows).toEqual(before);
  expect((await f.pool.query('SELECT count(*)::int n FROM ortho_case_study_revisions WHERE patient_id=$1',[p.scope.patientId])).rows[0].n).toBe(0);
  expect(await identityDatabaseState(f.pool)).toEqual(databaseBefore);
});
it('refuses a foreign case, stale digest, false basis and revoked user before exposing image bytes',async () => {
  const p=await image(), other=await setup(); request.token=createSessionToken(p.scope.session);
  expect(await getStudyImageBasis({...p.scope,orthoCaseId:other.orthoCaseId,documentId:p.documentId,sha256:p.stored.sha256})).toMatchObject({ok:false,status:404});
  expect(await getStudyImageBasis({...p.scope,documentId:p.documentId,sha256:'a'.repeat(64)})).toMatchObject({ok:false,status:409});
  expect(await getStudyImagePreview({...p.scope,command:{...p.command,recipe:defaultOrthoMediaRecipe(8,12,1)}})).toMatchObject({ok:false,status:409});
  await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[p.scope.session.userId]);
  expect(await getStudyImagePreview({...p.scope,command:p.command})).toMatchObject({ok:false,status:401});
});
it('refuses removed files and rechecks actual file digest rather than trusting document metadata',async () => {
  const p=await image();
  await f.pool.query("UPDATE patient_documents SET removed_at=now(),removed_by='synthetic',removed_note='Synthetic removed' WHERE id=$1",[p.documentId]);
  expect(await getStudyImagePreview({...p.scope,command:p.command})).toMatchObject({ok:false,status:404});
  const q=await image(); await f.pool.query('UPDATE patient_documents SET sha256=$1 WHERE id=$2',['b'.repeat(64),q.documentId]);
  expect(await getStudyImagePreview({...q.scope,command:{...q.command,sha256:'b'.repeat(64)}})).toMatchObject({ok:false,status:409});
});
it('rechecks a doctor image permission on every basis and preview request, independently of patient access',async()=>{
 const p=await image(),password='synthetic-image-permission';
 const user=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES('study-image-doctor','Synthetic image doctor',$1,'doctor',$2) RETURNING id",[password,JSON.stringify({canViewAllPatients:true,canViewXrays:false})])).rows[0];
 const actor:SessionPayload={userId:user.id,username:'study-image-doctor',role:'doctor',credentialVersion:sessionCredentialVersion(password),expiresAt:Date.now()+600000};request.token=createSessionToken(actor);
 const scope={...p.scope,session:actor};
 expect(await getStudyImageBasis({...scope,documentId:p.documentId,sha256:p.stored.sha256})).toMatchObject({ok:false,status:403});
 await f.pool.query('UPDATE users SET permissions=$1 WHERE id=$2',[JSON.stringify({canViewAllPatients:true,canViewXrays:true}),user.id]);
 expect(await getStudyImagePreview({...scope,command:p.command})).toMatchObject({ok:true});
 await f.pool.query('UPDATE users SET permissions=$1 WHERE id=$2',[JSON.stringify({canViewAllPatients:true,canViewXrays:false}),user.id]);
 expect(await getStudyImagePreview({...scope,command:p.command})).toMatchObject({ok:false,status:403});
});
