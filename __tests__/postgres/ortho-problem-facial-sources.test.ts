import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { appendFacialAnalysis } from "../../lib/ortho-facial-store";
import { syntheticFace } from "../fixtures/ortho-facial-analysis";
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
 content.quality={frontalRest:true,headPosition:true,visibleLandmarks:true,perspectiveReviewed:true,note:"Synthetic image reviewed"}; content.review={state:"reviewed",note:"Synthetic explicit facial note"};
 const command={schemaVersion:1 as const,clientRequestId:randomUUID(),documentId,expectedHeadId:null as number|null,reason:"Synthetic first review",content};
 return {owner:{patientId,orthoCaseId,clinicalCaseId,session},command,stored};
}

import { getOrthoProblemSources, appendOrthoProblemSource } from "../../lib/ortho-problem-source-store";
import { reserveProblemSubmission, saveJournaledProblemSource, getProblemSubmissionRecovery } from "../../lib/ortho-problem-submission-store";
import type { ProblemSourceCandidate, ProblemSourceCommand } from "../../lib/ortho-problem-sources";
import { readProblemSourceRead } from "../../lib/ortho-problem-source-client";
import { readFile, writeFile } from "node:fs/promises";
const review=(source:ProblemSourceCandidate):ProblemSourceCommand=>({schemaVersion:1,commandId:randomUUID(),source:source.ref,expectedReviewId:null,action:"create",problemId:null,label:"Synthetic clinician-authored problem",reason:"Explicit review",clinicianReviewed:true});
async function sources(owner:Awaited<ReturnType<typeof scope>>["owner"]){const r=await getOrthoProblemSources(owner);if(!r.ok)throw Error(r.code);return readProblemSourceRead(r,owner);}
it("offers only explicit reviewed prose, no automatic label, and no clinical writes on read",async()=>{
 const {owner,command}=await scope();expect((await sources(owner)).candidates).toEqual([]);
 expect(await appendFacialAnalysis({...owner,command})).toMatchObject({ok:true});
 const r=await sources(owner);expect(r.candidates).toHaveLength(1);expect(r.candidates[0]).toMatchObject({summary:command.content.review.note,proposedLabel:null,requiresImages:true,ref:{kind:"facial_review",member:`document_${command.documentId}_review`}});
 expect(r.problems).toEqual([]);expect(r.reviews).toEqual([]);
});
it("preserves stable identity but versions identical-content resaves, and rejects stale review",async()=>{
 const {owner,command}=await scope();const first=await appendFacialAnalysis({...owner,command});if(!first.ok)throw Error(first.code);
 const old=(await sources(owner)).candidates[0],saved=await appendOrthoProblemSource({...owner,command:review(old)});if(!saved.ok)throw Error(saved.code);
 expect(await appendFacialAnalysis({...owner,command:{...command,clientRequestId:randomUUID(),expectedHeadId:first.revision.id}})).toMatchObject({ok:true});
 const next=await sources(owner);expect(next.candidates[0].identity).toBe(old.identity);expect(next.candidates[0].ref.version).not.toBe(old.ref.version);expect(next.reviews[0].currentSourceState).toBe("newer_version");
 expect(await appendOrthoProblemSource({...owner,command:{...review(old),expectedReviewId:saved.reviewId,action:"link",label:null,problemId:saved.problemId}})).toMatchObject({ok:false,code:"problem_source_already_reviewed"});
 const correction={...review(next.candidates[0]),expectedReviewId:saved.reviewId,action:"link" as const,label:null,problemId:saved.problemId};expect(await appendOrthoProblemSource({...owner,command:correction})).toMatchObject({ok:true});
});
it("never revives an older reviewed note behind a newer draft",async()=>{
 const {owner,command}=await scope(),first=await appendFacialAnalysis({...owner,command});if(!first.ok)throw Error(first.code);
 expect(await appendFacialAnalysis({...owner,command:{...command,clientRequestId:randomUUID(),expectedHeadId:first.revision.id,content:{...command.content,review:{state:"draft",note:""}}}})).toMatchObject({ok:true});
 expect((await sources(owner)).candidates).toEqual([]);
});
it("keeps separate photographs distinct and requires explicit problem creation for each",async()=>{
 const {owner,command,stored}=await scope();await appendFacialAnalysis({...owner,command});
 const id=(await fixture.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,photo_view) VALUES($1,$2,'Second synthetic photo','image/png',$3,$4,$5,'synthetic','extraoral_frontal') RETURNING id",[owner.patientId,owner.orthoCaseId,stored.sizeBytes,stored.sha256,stored.key])).rows[0].id;
 await appendFacialAnalysis({...owner,command:{...command,documentId:id,clientRequestId:randomUUID()}});
 const r=await sources(owner);expect(r.candidates).toHaveLength(2);expect(new Set(r.candidates.map(c=>c.identity)).size).toBe(2);expect(r.problems).toEqual([]);
});
it("does not offer archived or differently classified source photographs",async()=>{
 const {owner,command}=await scope();await appendFacialAnalysis({...owner,command});
 await fixture.pool.query("UPDATE patient_documents SET photo_view='extraoral_profile' WHERE id=$1",[command.documentId]);expect((await sources(owner)).candidates).toEqual([]);
 await fixture.pool.query("UPDATE patient_documents SET photo_view='extraoral_frontal',photo_stage='archived' WHERE id=$1",[command.documentId]);expect((await sources(owner)).candidates).toEqual([]);
});
it("verifies original bytes instead of trusting saved metadata",async()=>{
 const {owner,command,stored}=await scope();await appendFacialAnalysis({...owner,command});
 const original=await readFile(join(directory,stored.key));
 try { await writeFile(join(directory,stored.key),Buffer.from("synthetic damaged bytes"));
 expect(await getOrthoProblemSources(owner)).toMatchObject({ok:false,code:"facial_image_integrity"}); } finally { await writeFile(join(directory,stored.key),original); }
});
it("journals facial identity and retains exact receipt without duplicating a problem",async()=>{
 const {owner,command}=await scope();await appendFacialAnalysis({...owner,command});const selected=review((await sources(owner)).candidates[0]);
 const input={...owner,actorId:owner.session.userId,command:selected};expect(await reserveProblemSubmission(input)).toMatchObject({ok:true});
 expect(await getProblemSubmissionRecovery(owner)).toMatchObject({ok:true,recovery:{state:"pending",expected:{command:selected}}});
 const saved=await saveJournaledProblemSource(input);expect(saved).toMatchObject({ok:true});
 if(!saved.ok)throw Error(saved.code);
 const repeated=await saveJournaledProblemSource(input);expect(repeated).toEqual({...saved,replayed:true});
 expect(await getProblemSubmissionRecovery(owner)).toMatchObject({ok:true,recovery:{state:"committed",expected:{command:selected}}});
 expect((await sources(owner)).problems).toHaveLength(1);expect((await sources(owner)).reviews).toHaveLength(1);
});
it("quarantines pending exact intent after a newer draft without retargeting",async()=>{
 const {owner,command}=await scope(),first=await appendFacialAnalysis({...owner,command});if(!first.ok)throw Error(first.code);
 const selected=review((await sources(owner)).candidates[0]),input={...owner,actorId:owner.session.userId,command:selected};
 expect(await reserveProblemSubmission(input)).toMatchObject({ok:true});
 await appendFacialAnalysis({...owner,command:{...command,clientRequestId:randomUUID(),expectedHeadId:first.revision.id,content:{...command.content,review:{state:"draft",note:""}}}});
 expect(await getProblemSubmissionRecovery(owner)).toMatchObject({ok:true,recovery:{state:"blocked",canCancel:true}});
 expect(await saveJournaledProblemSource(input)).toMatchObject({ok:false,code:"problem_source_changed"});expect((await sources(owner)).problems).toEqual([]);
});
it("revoked image authority withholds pending facial command",async()=>{
 const {owner,command}=await scope();await appendFacialAnalysis({...owner,command});
 await fixture.pool.query("UPDATE users SET role='doctor',permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewXrays:true}),session.userId]);
 owner.session={...session,role:"doctor"};request.token=createSessionToken(owner.session);
 try {
 const selected=review((await sources(owner)).candidates[0]);expect(await reserveProblemSubmission({...owner,actorId:session.userId,command:selected})).toMatchObject({ok:true});
 await fixture.pool.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewXrays:false}),session.userId]);
 const recovered=await getProblemSubmissionRecovery(owner);expect(recovered).toMatchObject({ok:true,recovery:{state:"blocked"}});expect(JSON.stringify(recovered)).not.toContain(command.content.review.note);
 } finally {await fixture.pool.query("UPDATE users SET role='admin',permissions='{}' WHERE id=$1",[session.userId]);request.token=createSessionToken(session);}
});
