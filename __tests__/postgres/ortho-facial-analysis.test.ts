import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { appendFacialAnalysis, getFacialAnalysis, getFacialImage } from "../../lib/ortho-facial-store";
import { facialImageBasis } from "../../lib/ortho-facial-image";
import { readFacialRead, verifyFacialSaved } from "../../lib/ortho-facial-records";
import { ORTHO_FACIAL_ANALYSIS_SQL } from "../../lib/ortho-facial-analysis-schema";
import { CLINIC_TIME_ZONE } from "../../lib/db";
import { clinicDateString } from "../../lib/schedule";
import { journeyContentHash } from "../../lib/ortho-case-journey-hash";
import { computeFacialResults } from "../../lib/ortho-facial-analysis";
import { syntheticFace } from "../fixtures/ortho-facial-analysis";
import { ProtectedOrthoFacialHistoryError, RESET_KEEP_TABLES, RESET_WIPE_TABLES } from "../../lib/clinic-reset";
import { putFile } from "../../lib/files";
const request=vi.hoisted(()=>({token:""}));
vi.mock("next/headers",()=>({cookies:async()=>({get:(name:string)=>name==="aqlan_flow_session"?{value:request.token}:undefined}),headers:async()=>new Headers()}));
let fixture:Awaited<ReturnType<typeof openPeriodontalFixture>>,session:SessionPayload,directory:string;
const priorDir=process.env.DOCUMENTS_DIR;
beforeAll(async()=>{
 vi.stubEnv("SESSION_SECRET","synthetic-facial-secret-at-least-32-characters");
 directory=await mkdtemp(join(tmpdir(),"aqlan-synthetic-face-"));process.env.DOCUMENTS_DIR=directory;
 fixture=await openPeriodontalFixture(process.env,{pristine:true});await fixture.db.ensureSchema();
 const password="synthetic-facial-credential", user=(await fixture.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('face-admin','Synthetic facial clinician',$1,'admin') RETURNING id",[password])).rows[0];
 session={userId:user.id,username:"face-admin",role:"admin",credentialVersion:sessionCredentialVersion(password),expiresAt:Date.now()+3600000};request.token=createSessionToken(session);
});
afterAll(async()=>{await fixture?.close();if(priorDir===undefined)delete process.env.DOCUMENTS_DIR;else process.env.DOCUMENTS_DIR=priorDir;if(directory)await rm(directory,{recursive:true,force:true});vi.unstubAllEnvs();});
async function scope(){
 const patientId=(await fixture.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic face') RETURNING id",[randomUUID()])).rows[0].id;
 const orthoCaseId=(await fixture.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'synthetic') RETURNING id",[patientId])).rows[0].id;
 const clinicalCaseId=(await fixture.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id",[patientId,orthoCaseId])).rows[0].id;
 const bytes=await sharp({create:{width:1000,height:1200,channels:3,background:"#667788"}}).png().toBuffer(),stored=await putFile(bytes,"png");
 const documentId=(await fixture.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,photo_view) VALUES($1,$2,'Synthetic image','image/png',$3,$4,$5,'synthetic','extraoral_frontal') RETURNING id",[patientId,orthoCaseId,stored.sizeBytes,stored.sha256,stored.key])).rows[0].id;
 const content=syntheticFace();content.image.sha256=stored.sha256;
 const command={schemaVersion:1 as const,clientRequestId:randomUUID(),documentId,expectedHeadId:null as number|null,reason:"Synthetic first review",content};
 return {owner:{patientId,orthoCaseId,clinicalCaseId,session},command,stored};
}
const unrelated=async()=>(await fixture.pool.query("SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM visits) visits,(SELECT count(*)::int FROM appointments) appointments,(SELECT count(*)::int FROM patient_opening_balances) opening")).rows;
describe("facial source-bound immutable reviews on PostgreSQL",()=>{
 it("applies identical runtime and CLI migration without inferred reviews",async()=>{
  expect(await readFile("migrations/0115_ortho_facial_revisions.sql","utf8")).toBe(ORTHO_FACIAL_ANALYSIS_SQL);
  expect((await fixture.pool.query("SELECT checksum,adopted FROM schema_migrations WHERE version='0115'")).rows).toEqual([{checksum:createHash("sha256").update(ORTHO_FACIAL_ANALYSIS_SQL).digest("hex"),adopted:false}]);
  expect((await fixture.pool.query("SELECT count(*)::int n FROM ortho_facial_revisions")).rows[0].n).toBe(0);
  expect(RESET_KEEP_TABLES).toContain("ortho_facial_revisions");expect(RESET_WIPE_TABLES).not.toContain("ortho_facial_revisions");
  await fixture.pool.query("TRUNCATE ortho_facial_revisions, ortho_facial_submissions");
 });
 it("saves, verifies, restores and corrects the same source without financial/visit writes",async()=>{
  const {owner,command,stored}=await scope(),before=await unrelated();
  const initial=await getFacialAnalysis({...owner,documentId:command.documentId});expect(initial).toMatchObject({ok:true,history:[],image:command.content.image});
  const saved=await appendFacialAnalysis({...owner,command});expect(saved.ok).toBe(true);if(!saved.ok)throw Error(saved.code);
  await expect(verifyFacialSaved(saved,{...owner,actorId:session.userId!,command},201)).resolves.toEqual(saved.revision);
  expect(await appendFacialAnalysis({...owner,command})).toEqual({...saved,replayed:true});
  expect(await appendFacialAnalysis({...owner,command:{...command,reason:"different"}})).toMatchObject({ok:false,status:409,code:"request_key_conflict"});
  const next=structuredClone(command);next.clientRequestId=randomUUID();next.expectedHeadId=saved.revision.id;next.content.landmarks.tr={state:"unavailable",reason:"Hair obscures the synthetic landmark"};
  const corrected=await appendFacialAnalysis({...owner,command:next});expect(corrected).toMatchObject({ok:true,revision:{version:2}});
  const loaded=await getFacialAnalysis({...owner,documentId:command.documentId});await expect(readFacialRead(loaded,owner,command.documentId)).resolves.toEqual(loaded);
  if(!loaded.ok)throw Error(loaded.code);expect(loaded.history[1]).toEqual(saved.revision);expect(loaded.history[0].results.measures.find(m=>m.id==="thirds")?.state).toBe("incomplete");
  expect(await unrelated()).toEqual(before);
  expect((await fixture.pool.query("SELECT count(*)::int n FROM audit_log WHERE action='ortho.facial_revision' AND details->>'orthoCaseId'=$1",[String(owner.orthoCaseId)])).rows[0].n).toBe(2);
  const displayed=await getFacialImage({...owner,documentId:command.documentId,sha256:stored.sha256});expect(displayed.ok).toBe(true);if(displayed.ok)expect(await sharp(displayed.png).metadata()).toMatchObject({width:1000,height:1200,format:"png"});
  await expect(fixture.pool.query("UPDATE ortho_facial_revisions SET version=9 WHERE id=$1",[saved.revision.id])).rejects.toThrow("append-only");
 });
 it("serializes competing reviews and rejects stale heads and wrong image geometry",async()=>{
  const {owner,command}=await scope();const competing=await Promise.all([appendFacialAnalysis({...owner,command}),appendFacialAnalysis({...owner,command:{...command,clientRequestId:randomUUID()}})]);
  expect(competing.filter(r=>r.ok)).toHaveLength(1);expect(competing.find(r=>!r.ok)).toMatchObject({status:409,code:"facial_head_changed"});
  expect(await appendFacialAnalysis({...owner,command:{...command,clientRequestId:randomUUID(),content:{...command.content,image:{...command.content.image,width:1200}}}})).toMatchObject({ok:false,code:"facial_image_changed"});
 });
 it("refuses foreign/removed documents, invalid dates and source-byte tampering",async()=>{
  const one=await scope(),two=await scope();
  expect(await appendFacialAnalysis({...one.owner,command:{...one.command,documentId:two.command.documentId}})).toMatchObject({ok:false,status:404});
  expect(await appendFacialAnalysis({...one.owner,command:{...one.command,content:{...one.command.content,occurrence:{occurredOn:"2999-01-01",dateProvenance:"historical_source",sourceNote:"Synthetic future"}}}})).toMatchObject({ok:false,code:"invalid_image_date"});
  await fixture.pool.query("UPDATE patient_documents SET removed_at=now() WHERE id=$1",[one.command.documentId]);
  expect(await getFacialImage({...one.owner,documentId:one.command.documentId,sha256:one.stored.sha256})).toMatchObject({ok:false,status:404});
  await fixture.pool.query("UPDATE patient_documents SET sha256=$1 WHERE id=$2",["a".repeat(64),two.command.documentId]);
  expect(await getFacialAnalysis({...two.owner,documentId:two.command.documentId})).toMatchObject({ok:false,code:"facial_image_integrity"});
 });
 it("rolls back the review if audit fails and refuses parent ownership drift",async()=>{
  const one=await scope(),two=await scope();
  await fixture.pool.query("CREATE FUNCTION synthetic_face_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.facial_revision' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_face_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_face_audit_fail()");
  try{await expect(appendFacialAnalysis({...one.owner,command:one.command})).rejects.toThrow("synthetic audit failure");}finally{await fixture.pool.query("DROP TRIGGER synthetic_face_audit_fail ON audit_log;DROP FUNCTION synthetic_face_audit_fail()");}
  expect(await getFacialAnalysis({...one.owner,documentId:one.command.documentId})).toMatchObject({ok:true,history:[]});
  expect(await appendFacialAnalysis({...one.owner,command:one.command})).toMatchObject({ok:true});
  await expect(fixture.pool.query("UPDATE patient_documents SET ortho_case_id=$1 WHERE id=$2",[two.owner.orthoCaseId,one.command.documentId])).rejects.toThrow("ownership");
 });
 it("enforces current image permissions, read-only reception and revoked credentials",async()=>{
  const {owner,command}=await scope(),password="synthetic-doctor-face";
  const user=(await fixture.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES('face-doctor','Synthetic doctor',$1,'doctor',$2) RETURNING id",[password,JSON.stringify({canViewAllPatients:true,canViewXrays:false})])).rows[0];
  let actor:SessionPayload={userId:user.id,username:"face-doctor",role:"doctor",credentialVersion:sessionCredentialVersion(password),expiresAt:Date.now()+3600000};
  try{
   request.token=createSessionToken(actor);expect(await getFacialAnalysis({...owner,session:actor,documentId:command.documentId})).toMatchObject({ok:false,status:403});
   await fixture.pool.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewXrays:true}),user.id]);
   expect(await appendFacialAnalysis({...owner,session:actor,command})).toMatchObject({ok:true});
   await fixture.pool.query("UPDATE users SET role='reception' WHERE id=$1",[user.id]);actor={...actor,role:"reception"};request.token=createSessionToken(actor);
   expect(await getFacialAnalysis({...owner,session:actor,documentId:command.documentId})).toMatchObject({ok:true,canWrite:false});
   expect(await appendFacialAnalysis({...owner,session:actor,command})).toMatchObject({ok:false,status:403});
   await fixture.pool.query("UPDATE users SET is_active=FALSE WHERE id=$1",[user.id]);expect(await getFacialImage({...owner,session:actor,documentId:command.documentId,sha256:command.content.image.sha256})).toMatchObject({ok:false,status:401});
  }finally{request.token=createSessionToken(session);}
 });
 it("orients EXIF once, preserves originals and refuses malformed raster input",async()=>{
  const bytes=await sharp({create:{width:40,height:70,channels:3,background:"#224466"}}).jpeg().withMetadata({orientation:6}).toBuffer(),stored=await putFile(bytes,"jpg");
  const doc={sha256:stored.sha256,storage_key:stored.key,size_bytes:stored.sizeBytes,mime_type:"image/jpeg"};
  const image=await facialImageBasis(doc,true);expect(image.basis).toMatchObject({width:70,height:40,exifOrientation:6});expect(await sharp(image.png!).metadata()).toMatchObject({width:70,height:40});expect(await readFile(join(directory,stored.key))).toEqual(bytes);
  const invalid=await putFile(Buffer.from("synthetic non-image"),"png");await expect(facialImageBasis({sha256:invalid.sha256,storage_key:invalid.key,size_bytes:invalid.sizeBytes,mime_type:"image/png"},true)).rejects.toMatchObject({code:"facial_image_decode"});
 });
 it("preserves immutable provenance and refuses parent specialty, patient and bridge drift",async()=>{
  const one=await scope(),two=await scope(),saved=await appendFacialAnalysis({...one.owner,command:one.command});
  if(!saved.ok)throw Error(saved.code);
  for(const sql of ["UPDATE ortho_facial_revisions SET recorded_patient_id=999 WHERE id=$1","DELETE FROM ortho_facial_revisions WHERE id=$1","UPDATE ortho_facial_revisions SET created_by='changed' WHERE id=$1"])
   await expect(fixture.pool.query(sql,[saved.revision.id])).rejects.toThrow(/append-only/);
  await expect(fixture.pool.query("TRUNCATE ortho_facial_revisions, ortho_facial_submissions")).rejects.toThrow(/append-only/);
  await expect(fixture.pool.query("UPDATE ortho_cases SET patient_id=$1 WHERE id=$2",[two.owner.patientId,one.owner.orthoCaseId])).rejects.toThrow();
  await expect(fixture.pool.query("UPDATE clinical_cases SET specialty='general' WHERE id=$1",[one.owner.clinicalCaseId])).rejects.toThrow();
  await expect(fixture.pool.query("UPDATE clinical_cases SET ortho_case_id=NULL WHERE id=$1",[one.owner.clinicalCaseId])).rejects.toThrow();
  await expect(fixture.pool.query("UPDATE patient_documents SET patient_id=$1 WHERE id=$2",[two.owner.patientId,one.command.documentId])).rejects.toThrow();
  let backupCalled=false;
  await expect(fixture.db.resetClinicData({actor:session.username,actorRole:session.role},async()=>{backupCalled=true;return {ok:false,failure:"must not back up protected facial history"};})).rejects.toBeInstanceOf(ProtectedOrthoFacialHistoryError);
  expect(backupCalled).toBe(false);
 });
 it("merges canonical patient ownership without rewriting recorded identity or command proofs",async()=>{
  const one=await scope(),target=(await fixture.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic merge target') RETURNING id",[randomUUID()])).rows[0].id;
  const saved=await appendFacialAnalysis({...one.owner,command:one.command});if(!saved.ok)throw Error(saved.code);
  const before=(await fixture.pool.query("SELECT to_jsonb(r)-'patient_id' value FROM ortho_facial_revisions r WHERE id=$1",[saved.revision.id])).rows;
  expect(await fixture.db.mergeDuplicatePatient(one.owner.patientId,target,{actor:session.username})).toMatchObject({ok:true,moved:{"ortho_facial_revisions.patient_id":1}});
  expect((await fixture.pool.query("SELECT to_jsonb(r)-'patient_id' value FROM ortho_facial_revisions r WHERE id=$1",[saved.revision.id])).rows).toEqual(before);
  expect((await fixture.pool.query("SELECT patient_id,recorded_patient_id FROM ortho_facial_revisions WHERE id=$1",[saved.revision.id])).rows).toEqual([{patient_id:target,recorded_patient_id:one.owner.patientId}]);
  expect(await appendFacialAnalysis({...one.owner,patientId:target,command:one.command})).toMatchObject({ok:true,replayed:true,revision:{patientId:target,recordedPatientId:one.owner.patientId}});
 });

 it("lists only unarchived frontal sources and refuses archived or other-view access",async()=>{
  const one=await scope();
  for(const update of ["photo_view='extraoral_profile'","photo_view='extraoral_frontal',photo_stage='archived'"]){
   await fixture.pool.query(`UPDATE patient_documents SET ${update} WHERE id=$1`,[one.command.documentId]);
   expect(await getFacialAnalysis({...one.owner,documentId:null})).toMatchObject({ok:true,documents:[]});
   expect(await getFacialAnalysis({...one.owner,documentId:one.command.documentId})).toMatchObject({ok:false,status:404});
   expect(await getFacialImage({...one.owner,documentId:one.command.documentId,sha256:one.stored.sha256})).toMatchObject({ok:false,status:404});
   expect(await appendFacialAnalysis({...one.owner,command:one.command})).toMatchObject({ok:false,status:404});
  }
 });
 it("rejects schema drift and newly reviewed invalid geometry without writing history",async()=>{
  const one=await scope();expect(await appendFacialAnalysis({...one.owner,command:{...one.command,schemaVersion:2}})).toMatchObject({ok:false,status:400});
  const invalid=structuredClone(one.command);invalid.content.review={state:"reviewed",note:"Synthetic clinician review"};
  invalid.content.quality={frontalRest:true,headPosition:true,visibleLandmarks:true,perspectiveReviewed:true,note:""};
  invalid.content.landmarks.tr={state:"located",x:0.5,y:0.8};
  expect(await appendFacialAnalysis({...one.owner,command:invalid})).toMatchObject({ok:false,status:400});
  expect((await fixture.pool.query("SELECT id FROM ortho_facial_revisions WHERE ortho_case_id=$1",[one.owner.orthoCaseId])).rows).toEqual([]);
 });
 it("records historical occurrence explicitly and replays without requiring today's date",async()=>{
  const one=await scope();one.command.content.occurrence={occurredOn:"2001-02-03",dateProvenance:"historical_source",sourceNote:"Synthetic source dated 2001"};
  const saved=await appendFacialAnalysis({...one.owner,command:one.command});expect(saved).toMatchObject({ok:true,revision:{command:{content:{occurrence:one.command.content.occurrence}}}});
  expect(await appendFacialAnalysis({...one.owner,command:one.command})).toEqual({...saved,replayed:true});
 });

 it("retains replay of a historical reviewed payload with invalid geometry without authorizing a new copy",async()=>{
  const one=await scope(),command=one.command;
  command.content.review={state:"reviewed",note:"Synthetic historical reviewed record"};
  command.content.quality={frontalRest:true,headPosition:true,visibleLandmarks:true,perspectiveReviewed:true,note:""};
  command.content.landmarks.tr={state:"located",x:0.5,y:0.8};
  const results=computeFacialResults(command.content);
  await fixture.pool.query(`INSERT INTO ortho_facial_revisions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,document_id,version,actor_user_id,created_by,command_id,request_fingerprint,content_sha256,command,results)
   VALUES($1,$1,$2,$3,$4,1,$5,'Synthetic historical clinician',$6,$7,$8,$9,$10)`,[one.owner.patientId,one.owner.orthoCaseId,one.owner.clinicalCaseId,command.documentId,session.userId,command.clientRequestId,journeyContentHash(command),journeyContentHash({content:command.content,results}),JSON.stringify(command),JSON.stringify(results)]);
  const replay=await appendFacialAnalysis({...one.owner,command});expect(replay).toMatchObject({ok:true,replayed:true});if(!replay.ok)throw Error(replay.code);
  expect(await appendFacialAnalysis({...one.owner,command:{...command,clientRequestId:randomUUID(),expectedHeadId:replay.revision.id}})).toMatchObject({ok:false,status:400});
 });

 it("serializes deferred direct-SQL source ownership against an uncommitted parent change",async()=>{
  const one=await scope(),two=await scope(),parent=await fixture.pool.connect(),writer=await fixture.pool.connect();
  let pending:Promise<unknown>|undefined;
  try{
   await parent.query("BEGIN");await parent.query("UPDATE patient_documents SET ortho_case_id=$1 WHERE id=$2",[two.owner.orthoCaseId,one.command.documentId]);
   await writer.query("BEGIN");const pid=(await writer.query("SELECT pg_backend_pid() pid")).rows[0].pid;
   const results=computeFacialResults(one.command.content);
   await writer.query(`INSERT INTO ortho_facial_revisions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,document_id,version,actor_user_id,created_by,command_id,request_fingerprint,content_sha256,command,results)
    VALUES($1,$1,$2,$3,$4,1,$5,'Synthetic race clinician',$6,$7,$8,$9,$10)`,[one.owner.patientId,one.owner.orthoCaseId,one.owner.clinicalCaseId,one.command.documentId,session.userId,one.command.clientRequestId,journeyContentHash(one.command),journeyContentHash({content:one.command.content,results}),JSON.stringify(one.command),JSON.stringify(results)]);
   pending=writer.query("COMMIT").then(()=>({committed:true}),error=>error);
   await expect.poll(async()=>(await fixture.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock') waiting",[pid])).rows[0].waiting,{timeout:5000}).toBe(true);
   await parent.query("COMMIT");expect(await pending).toMatchObject({code:"23514"});
   expect((await fixture.pool.query("SELECT id FROM ortho_facial_revisions WHERE ortho_case_id=$1",[one.owner.orthoCaseId])).rows).toEqual([]);
  }finally{await parent.query("ROLLBACK");await writer.query("ROLLBACK");parent.release();writer.release();if(pending)await pending;}
 });

 it("keeps original contemporaneous evidence date separate from today's entry date",async()=>{
  for(const occurredOn of ["2001-02-03",clinicDateString(new Date(),CLINIC_TIME_ZONE)]){
   const one=await scope();one.command.content.occurrence={occurredOn,dateProvenance:"contemporaneous_record",sourceNote:"Synthetic evidence documented at original image acquisition"};
   const saved=await appendFacialAnalysis({...one.owner,command:one.command});expect(saved).toMatchObject({ok:true,revision:{command:{content:{occurrence:one.command.content.occurrence}}}});
   expect(await appendFacialAnalysis({...one.owner,command:one.command})).toEqual({...saved,replayed:true});
  }
  const future=await scope();future.command.content.occurrence={occurredOn:"2999-01-01",dateProvenance:"contemporaneous_record",sourceNote:"Synthetic future evidence"};
  expect(await appendFacialAnalysis({...future.owner,command:future.command})).toMatchObject({ok:false,status:400,code:"invalid_image_date"});
 });

});
