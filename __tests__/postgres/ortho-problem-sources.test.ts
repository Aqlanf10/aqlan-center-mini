import { buildCephCompletionWitness, cephProvenanceHash, readCephCompletionSources } from "../../lib/ceph-completion-provenance";
import { computeAll, MEASUREMENTS, type LandmarkCode } from "../../lib/ceph";
import type { CephCompletionSnapshot } from "../../lib/ceph-completion-snapshot";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { getOrthoProblemSources, appendOrthoProblemSource } from "../../lib/ortho-problem-source-store";
import { ProtectedOrthoProblemHistoryError } from "../../lib/clinic-reset";
import type { ProblemSourceCandidate, ProblemSourceCommand } from "../../lib/ortho-problem-sources";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>, n = 0;
beforeAll(async () => { vi.stubEnv("SESSION_SECRET", "synthetic-problem-source-secret-at-least-32-characters"); f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema(); });
afterAll(async () => { try { await f?.close(); } finally { vi.unstubAllEnvs(); } });
async function setup() {
 const seq=++n,password="Synthetic source credential";
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic linked problem patient') RETURNING id",[`SYN-PROBLEM-${seq}`])).rows[0].id;
 const userId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic specialist',$2,'admin') RETURNING id",[`synthetic-problem-${seq}`,password])).rows[0].id;
 const session:SessionPayload={userId,username:`synthetic-problem-${seq}`,role:"admin",credentialVersion:sessionCredentialVersion(password),expiresAt:Date.now()+600000};request.token=createSessionToken(session);
 const orthoCaseId=(await f.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'active','synthetic') RETURNING id",[patientId])).rows[0].id;
 const clinicalCaseId=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic source bridge',$2,'synthetic') RETURNING id",[patientId,orthoCaseId])).rows[0].id;
 await f.pool.query("INSERT INTO patient_diagnoses(patient_id,ortho_case_id,version,content,created_by) VALUES($1,$2,1,$3::jsonb,'Synthetic specialist')",[patientId,orthoCaseId,JSON.stringify({skeletal:"Synthetic clinician finding",dental:"Synthetic dental finding",crowding:null,overjet:null,bite:null,note:null})]);
 return {patientId,orthoCaseId,clinicalCaseId,session};
}
const review=(source:ProblemSourceCandidate,overrides:Partial<ProblemSourceCommand>={}):ProblemSourceCommand=>({schemaVersion:1,commandId:randomUUID(),source:source.ref,expectedReviewId:null,action:"create",problemId:null,label:"Synthetic reviewed problem",reason:"Explicit synthetic clinical review",clinicianReviewed:true,...overrides});
async function read(scope:Awaited<ReturnType<typeof setup>>){const r=await getOrthoProblemSources(scope);if(!r.ok)throw Error(r.code);return r;}
it("reads without mutation and creates/links only after explicit review; exact concurrent replay",async()=>{
 const scope=await setup(),initial=await read(scope);expect(initial.problems).toEqual([]);expect(initial.reviews).toEqual([]);
 const command=review(initial.candidates[0]);const [saved,retry]=await Promise.all([appendOrthoProblemSource({...scope,command}),appendOrthoProblemSource({...scope,command})]);
 expect(saved.ok&&retry.ok).toBe(true);if(!saved.ok||!retry.ok)throw Error("save failed");expect(saved.reviewId).toBe(retry.reviewId);expect([saved.replayed,retry.replayed].sort()).toEqual([false,true]);
 expect(await appendOrthoProblemSource({...scope,command:{...command,reason:"Changed intent"}})).toMatchObject({ok:false,code:"request_key_conflict"});
 expect(await appendOrthoProblemSource({...scope,command:review(initial.candidates[1],{action:"link",problemId:saved.problemId,label:null})})).toMatchObject({ok:true,problemId:saved.problemId});
 const after=await read(scope);expect(after.problems).toHaveLength(1);expect(after.reviews).toHaveLength(2);
 expect((await f.pool.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM treatment_plans WHERE patient_id=$1) plans",[scope.patientId])).rows[0]).toEqual({invoices:0,plans:0});
});
it("rejects stale source and foreign problem; preserves saved history under source revision",async()=>{
 const scope=await setup(),initial=await read(scope),command=review(initial.candidates[0]);const saved=await appendOrthoProblemSource({...scope,command});if(!saved.ok)throw Error(saved.code);
 await f.pool.query("INSERT INTO patient_diagnoses(patient_id,ortho_case_id,version,content,created_by) VALUES($1,$2,2,$3::jsonb,'Synthetic review')",[scope.patientId,scope.orthoCaseId,JSON.stringify({skeletal:"New explicit finding"})]);
 expect(await appendOrthoProblemSource({...scope,command:review(initial.candidates[1])})).toMatchObject({ok:false,code:"problem_source_changed"});
 const next=await read(scope);expect(next.reviews[0].currentSourceState).toBe("newer_version");
 const candidate=next.candidates[0];expect(await appendOrthoProblemSource({...scope,command:review(candidate,{expectedReviewId:saved.reviewId,action:"link",problemId:2147483647,label:null})})).toMatchObject({ok:false,code:"problem_not_active_in_case"});
 expect(await appendOrthoProblemSource({...scope,command:review(candidate,{expectedReviewId:saved.reviewId,action:"link",problemId:saved.problemId,label:null})})).toMatchObject({ok:true,problemId:saved.problemId});
 expect(await appendOrthoProblemSource({...scope,command})).toEqual({...saved,replayed:true});
});
it("checks current user authority even for exact replay",async()=>{
 const scope=await setup(),command=review((await read(scope)).candidates[0]);expect((await appendOrthoProblemSource({...scope,command})).ok).toBe(true);
 await f.pool.query("UPDATE users SET is_active=false WHERE id=$1",[scope.session.userId]);
 expect(await appendOrthoProblemSource({...scope,command})).toMatchObject({ok:false,status:401});expect(await getOrthoProblemSources(scope)).toMatchObject({ok:false,status:401});
});
it("rejects mutation/truncate and parent specialty changes, reset before backup, merge before transfer",async()=>{
 const scope=await setup(),command=review((await read(scope)).candidates[0]);const saved=await appendOrthoProblemSource({...scope,command});if(!saved.ok)throw Error(saved.code);
 for(const sql of ["UPDATE ortho_problem_source_reviews SET patient_id=patient_id", "DELETE FROM ortho_problem_source_reviews", "TRUNCATE ortho_problem_source_reviews, ortho_problem_source_submissions", "UPDATE ortho_problem_source_reviews SET reason='changed'"])await expect(f.pool.query(sql)).rejects.toMatchObject({code:"55000"});
 await expect(f.pool.query("UPDATE clinical_cases SET specialty='general' WHERE id=$1",[scope.clinicalCaseId])).rejects.toMatchObject({code:"23514"});
 await expect(f.pool.query("UPDATE patient_problems SET specialty='general' WHERE id=$1",[saved.problemId])).rejects.toMatchObject({code:"23514"});
 let backed=false;await expect(f.db.resetClinicData({actor:'synthetic',actorRole:'admin'},async()=>{backed=true;return {ok:false,failure:'must not run'};})).rejects.toBeInstanceOf(ProtectedOrthoProblemHistoryError);expect(backed).toBe(false);
 const target=await setup();expect(await f.db.mergeDuplicatePatient(scope.patientId,target.patientId,{actor:'synthetic',actorRole:'admin'})).toMatchObject({ok:false,reason:'source_has_clinical_command_history'});
 expect((await f.pool.query("SELECT patient_id FROM ortho_problem_source_reviews WHERE id=$1",[saved.reviewId])).rows[0].patient_id).toBe(scope.patientId);
});
it("rolls problem creation and review back if audit insertion fails",async()=>{
 const scope=await setup(),command=review((await read(scope)).candidates[0]);
 await f.pool.query("CREATE FUNCTION synthetic_problem_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.problem_source.review' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_problem_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_problem_audit_failure()");
 try {await expect(appendOrthoProblemSource({...scope,command})).rejects.toThrow('synthetic audit failure');expect((await read(scope)).problems).toEqual([]);expect((await read(scope)).reviews).toEqual([]);}
 finally{await f.pool.query("DROP TRIGGER synthetic_problem_audit_failure ON audit_log; DROP FUNCTION synthetic_problem_audit_failure()");}
});
it("never promotes draft or unversioned completed ceph diagnoses",async()=>{
 const scope=await setup();const doc=(await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'Synthetic image','image/png',1,$3,'synthetic/problem.png','synthetic') RETURNING id",[scope.patientId,scope.orthoCaseId,'a'.repeat(64)])).rows[0].id;
 const study=(await f.pool.query("INSERT INTO ceph_analyses(patient_id,ortho_case_id,document_id,created_by) VALUES($1,$2,$3,'synthetic') RETURNING id",[scope.patientId,scope.orthoCaseId,doc])).rows[0].id;
 await f.pool.query("INSERT INTO ceph_diagnoses(analysis_id,final_dx,created_by) VALUES($1,'Legacy unverified interpretation','synthetic')",[study]);
 expect((await read(scope)).candidates.some(c=>c.ref.kind==='ceph_diagnosis')).toBe(false);
 await f.pool.query("UPDATE ceph_analyses SET status='completed',completed_by='synthetic',completed_at=now() WHERE id=$1",[study]);
 expect((await read(scope)).candidates.some(c=>c.ref.kind==='ceph_diagnosis')).toBe(false);
});
it("rejects the problem-list boundary without stranding an existing replay",async()=>{
 const scope=await setup(),initial=await read(scope),command=review(initial.candidates[0]);const saved=await appendOrthoProblemSource({...scope,command});if(!saved.ok)throw Error(saved.code);
 await f.pool.query("INSERT INTO patient_problems(patient_id,case_id,specialty,label,noted_by) SELECT $1,$2,'orthodontics','Synthetic capacity '||n,'synthetic' FROM generate_series(1,499) n",[scope.patientId,scope.clinicalCaseId]);
 expect(await appendOrthoProblemSource({...scope,command:review(initial.candidates[1],{label:'One too many'})})).toMatchObject({ok:false,code:'problem_list_budget'});
 expect(await appendOrthoProblemSource({...scope,command})).toEqual({...saved,replayed:true});expect((await read(scope)).problems).toHaveLength(500);
});
it("rejects review501 before insertion while replay at capacity remains valid",async()=>{
 const scope=await setup(),initial=await read(scope),command=review(initial.candidates[0]);const saved=await appendOrthoProblemSource({...scope,command});if(!saved.ok)throw Error(saved.code);
 await f.pool.query(`INSERT INTO ortho_problem_source_reviews(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,problem_id,actor_user_id,created_by,source_identity,source_version,source_snapshot,problem_label,reason,command_id,request_fingerprint)
 SELECT patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,problem_id,actor_user_id,created_by,'clinical_diagnosis:capacity_'||n,source_version,
 jsonb_set(jsonb_set(source_snapshot,'{identity}',to_jsonb('clinical_diagnosis:capacity_'||n)),'{ref,member}',to_jsonb('capacity_'||n)),problem_label,reason,'synthetic_capacity_'||n,request_fingerprint
 FROM ortho_problem_source_reviews CROSS JOIN generate_series(1,499) n WHERE id=$1`,[saved.reviewId]);
 expect(await appendOrthoProblemSource({...scope,command:review(initial.candidates[1],{action:'link',problemId:saved.problemId,label:null})})).toMatchObject({ok:false,code:'problem_history_budget'});
 expect(await appendOrthoProblemSource({...scope,command})).toEqual({...saved,replayed:true});expect((await read(scope)).reviews).toHaveLength(500);
});

const VALID = {
  S: { x: 100, y: 100 }, N: { x: 169, y: 92 }, A: { x: 167.57, y: 151.98 },
  B: { x: 163.84, y: 179.85 }, Pog: { x: 164.03, y: 186.87 }, Me: { x: 160, y: 205 },
  Go: { x: 82.97, y: 169.08 }, Or: { x: 160, y: 125 }, Po: { x: 100, y: 125 },
  U1A: { x: 160, y: 134 }, U1: { x: 174.08, y: 171.44 },
  L1A: { x: 149, y: 199.2 }, L1: { x: 168, y: 164 },
  OcclA: { x: 170, y: 148 }, OcclP: { x: 100, y: 135.3 }, Gn: { x: 161.5, y: 195.5 },
};
async function cephFixture() {
 const scope=await setup(),pool=f.pool,username=scope.session.username,session=scope.session,patient={id:scope.patientId};
  const sha = createHash("sha256").update(`synthetic-image-${n}`).digest("hex");
  const document = (await pool.query<{id:number}>(`INSERT INTO patient_documents
    (patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
    VALUES($1,'imaging','Synthetic image','image/jpeg',123,$2,$3,$4) RETURNING id`,
    [patient.id, sha, `synthetic/no-file-${n}.jpg`, username])).rows[0];
  const refKey = `synthetic_ref_${n}`;
  const reference = (await pool.query<{id:number}>(`INSERT INTO ceph_reference_sets(key,name,population,version,created_by)
    VALUES($1,'Synthetic reference','synthetic population','synthetic-v1',$2) RETURNING id`, [refKey, username])).rows[0];
  for (const def of MEASUREMENTS) if (def.mean != null && def.tol != null && def.tol > 0) {
    await pool.query("INSERT INTO ceph_reference_values(set_id,code,mean,sd) VALUES($1,$2,$3,$4)", [reference.id, def.code, def.mean, def.tol]);
  }
  const analysis = (await pool.query<{id:number}>(`INSERT INTO ceph_analyses
    (patient_id,document_id,created_by,ref_set,mm_per_pixel,cal_x1,cal_y1,cal_x2,cal_y2,cal_mm)
    VALUES($1,$2,$3,$4,1,0,0,100,0,100) RETURNING id`, [patient.id, document.id, username, refKey])).rows[0];
  for (const [code, point] of Object.entries(VALID)) await pool.query(
    "INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,$2,$3,$4,'manual',$5)", [analysis.id, code, point.x, point.y, username]);
  const diagnosis = { skeletal: "Synthetic skeletal", dental: null, softTissue: null, note: null, finalDx: "Synthetic reviewed diagnosis" };
  await pool.query("INSERT INTO ceph_diagnoses(analysis_id,skeletal,final_dx,created_by) VALUES($1,$2,$3,$4)",
    [analysis.id, diagnosis.skeletal, diagnosis.finalDx, username]);
  const snapshot: CephCompletionSnapshot = { patientId: patient.id, documentId: document.id, refSet: refKey,
    calibration: { x1:0,y1:0,x2:100,y2:0,mm:100 }, mmPerPixel: 1,
    landmarks: Object.entries(VALID).map(([code, point]) => ({code:code as LandmarkCode, ...point, source: "manual"})), diagnosis };
  const analysisId = Number(analysis.id);
  if (!Number.isSafeInteger(analysisId) || analysisId <= 0) throw new Error("Unsafe synthetic analysis ID");
  const sources = (await f.db.getCephStudy(analysisId))?.completionSources;
  if (sources?.state !== "available") throw new Error("Synthetic completion source identity unavailable");
  await pool.query("UPDATE ceph_analyses SET ortho_case_id=$1 WHERE id=$2",[scope.orthoCaseId,analysisId]);
  return { scope, expectedSources: sources.identity, id: analysisId, patientId: patient.id, documentId: document.id, referenceId: reference.id, session, snapshot, sha };
}
it("links only source-witnessed v2 ceph completion and refuses removed image on a new command",async()=>{
 const x=await cephFixture();expect(await f.db.completeCephAnalysis(x.id,x.session.username,x.snapshot,x.session,x.expectedSources)).toMatchObject({ok:true});
 const candidates=(await read(x.scope)).candidates.filter(c=>c.ref.kind==='ceph_diagnosis');expect(candidates.length).toBeGreaterThan(0);
 const command=review(candidates[0]);const saved=await appendOrthoProblemSource({...x.scope,command});expect(saved.ok).toBe(true);
 await f.pool.query("UPDATE patient_documents SET removed_at=now() WHERE id=$1",[x.documentId]);
 expect((await read(x.scope)).reviews[0].currentSourceState).toBe('unavailable');
 expect(await appendOrthoProblemSource({...x.scope,command:review(candidates[1])})).toMatchObject({ok:false,code:'problem_source_changed'});
 // A receipt confirms a historical outcome, never a renewed clinical endorsement.
 expect(await appendOrthoProblemSource({...x.scope,command})).toEqual({...saved,replayed:true});
});
it("denies image-history read and replay after the same doctor's image permission is revoked",async()=>{
 const x=await cephFixture();expect(await f.db.completeCephAnalysis(x.id,x.session.username,x.snapshot,x.session,x.expectedSources)).toMatchObject({ok:true});
 await f.pool.query("UPDATE users SET role='doctor',permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewXrays:true}),x.session.userId]);
 x.scope.session={...x.session,role:'doctor'};request.token=createSessionToken(x.scope.session);
 const command=review((await read(x.scope)).candidates.find(c=>c.ref.kind==='ceph_diagnosis')!);expect((await appendOrthoProblemSource({...x.scope,command})).ok).toBe(true);
 await f.pool.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewXrays:false}),x.session.userId]);
 expect(await getOrthoProblemSources(x.scope)).toMatchObject({ok:false,status:403,code:'problem_images_restricted'});
 expect(await appendOrthoProblemSource({...x.scope,command})).toMatchObject({ok:false,status:403,code:'problem_images_restricted'});
});
it("rejects projected aggregate jsonb bytes without stranding reads or exact replay",async()=>{
 const scope=await setup(),initial=await read(scope),command=review(initial.candidates[0]);const saved=await appendOrthoProblemSource({...scope,command});if(!saved.ok)throw Error(saved.code);
 // Synthetic historical canaries remain individually below262144 bytes.
 // Arrange the current history one byte short of the new candidate's required room.
 const base=(await f.pool.query("SELECT *,octet_length(source_snapshot::text) bytes FROM ortho_problem_source_reviews WHERE id=$1",[saved.reviewId])).rows[0];
 const incoming=(await f.pool.query("SELECT octet_length($1::jsonb::text) bytes",[JSON.stringify(initial.candidates[1])])).rows[0].bytes;
 let remaining=2097152-incoming+1-base.bytes;
 for(let i=0;i<9;i++){
  const source={...base.source_snapshot,identity:`clinical_diagnosis:bytes_${i}`,ref:{...base.source_snapshot.ref,member:`bytes_${i}`},summary:''};
  const bytes=(await f.pool.query("SELECT octet_length($1::jsonb::text) bytes",[JSON.stringify(source)])).rows[0].bytes;
  const allocation=Math.floor(remaining/(9-i));source.summary='x'.repeat(allocation-bytes);remaining-=allocation;
  await f.pool.query(`INSERT INTO ortho_problem_source_reviews(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,problem_id,actor_user_id,created_by,source_identity,source_version,source_snapshot,problem_label,reason,command_id,request_fingerprint)
    VALUES($1,$1,$2,$3,$4,$5,'synthetic',$6,$7,$8::jsonb,'Synthetic bytes','Synthetic review',$9,$10)`,[scope.patientId,scope.orthoCaseId,scope.clinicalCaseId,saved.problemId,scope.session.userId,source.identity,source.ref.version,JSON.stringify(source),`synthetic_bytes_${i}`,base.request_fingerprint]);
 }
 expect(await appendOrthoProblemSource({...scope,command:review(initial.candidates[1],{action:'link',problemId:saved.problemId,label:null})})).toMatchObject({ok:false,code:'problem_history_budget'});
 expect(await appendOrthoProblemSource({...scope,command})).toEqual({...saved,replayed:true});expect((await read(scope)).reviews).toHaveLength(10);
});
it("does not offer a completed interpretation whose current diagnosis differs from its witness",async()=>{
 const x=await cephFixture();expect(await f.db.completeCephAnalysis(x.id,x.session.username,x.snapshot,x.session,x.expectedSources)).toMatchObject({ok:true});
 expect((await read(x.scope)).candidates.some(c=>c.ref.kind==='ceph_diagnosis')).toBe(true);
 await f.pool.query("UPDATE ceph_diagnoses SET final_dx='Synthetic inconsistent diagnosis' WHERE analysis_id=$1",[x.id]);
 expect((await read(x.scope)).candidates.some(c=>c.ref.kind==='ceph_diagnosis')).toBe(false);
});

it("excludes valid v1 historical completion lacking an explicitly reviewed source identity",async()=>{
 const x=await cephFixture(),client=await f.pool.connect();
 try{
  const sources=await readCephCompletionSources(client,{patientId:x.patientId,documentId:x.documentId,refSet:x.snapshot.refSet});if(sources.state!=='available')throw Error('Synthetic source missing');
  const measurements=computeAll(VALID,1).filter(m=>m.value!==null).map(m=>({code:m.code,value:m.value!}));
  const reviews=(await client.query<{code:string;confirmedBy:string;confirmedAt:string}>(`SELECT code,confirmed_by AS "confirmedBy",to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "confirmedAt" FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code`,[x.id])).rows;
  const sealedAt=new Date().toISOString();const witness=buildCephCompletionWitness({analysisId:x.id,actor:{userId:x.session.userId,username:x.session.username},sealedAt,snapshot:x.snapshot,image:{documentId:x.documentId,sha256:x.sha,width:null,height:null},landmarkReviews:reviews,referenceSet:sources.referenceSet,measurements});
  await client.query('BEGIN');
  await client.query("UPDATE ceph_analyses SET status='completed',completed_by=$2,completed_at=$3 WHERE id=$1",[x.id,x.session.username,sealedAt]);
  for(const m of measurements)await client.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,$2,$3)",[x.id,m.code,m.value]);
  await client.query("INSERT INTO ceph_completion_provenance(analysis_id,schema_version,witness,witness_sha256,actor_user_id,sealed_by,sealed_at) VALUES($1,1,$2::jsonb,$3,$4,$5,$6)",[x.id,JSON.stringify(witness),cephProvenanceHash(witness),x.session.userId,x.session.username,sealedAt]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 expect((await read(x.scope)).candidates.some(c=>c.ref.kind==='ceph_diagnosis')).toBe(false);
});
it("waits for the diagnosis writer then rejects the newly stale source",async()=>{
 const scope=await setup(),initial=await read(scope),command=review(initial.candidates[0]),writer=await f.pool.connect();
 let settled=false;
 try{
  await writer.query('BEGIN');await writer.query('SELECT pg_advisory_xact_lock(73127,$1::int)',[scope.patientId]);
  await writer.query("INSERT INTO patient_diagnoses(patient_id,ortho_case_id,version,content,created_by) VALUES($1,$2,2,$3::jsonb,'Synthetic concurrent author')",[scope.patientId,scope.orthoCaseId,JSON.stringify({skeletal:'Concurrent explicit finding'})]);
  const pending=appendOrthoProblemSource({...scope,command}).then(r=>{settled=true;return r;});
  await new Promise(resolve=>setTimeout(resolve,50));expect(settled).toBe(false);
  await writer.query('COMMIT');expect(await pending).toMatchObject({ok:false,code:'problem_source_changed'});
  expect((await read(scope)).problems).toEqual([]);
 }finally{await writer.query('ROLLBACK');writer.release();}
});
it("refuses a real active problem owned by another patient and case",async()=>{
 const scope=await setup(),initial=await read(scope),foreign=await setup();
 const problem=(await f.pool.query("INSERT INTO patient_problems(patient_id,case_id,specialty,label,noted_by) VALUES($1,$2,'orthodontics','Synthetic foreign problem','synthetic') RETURNING id",[foreign.patientId,foreign.clinicalCaseId])).rows[0].id;
 request.token=createSessionToken(scope.session);
 expect(await appendOrthoProblemSource({...scope,command:review(initial.candidates[0],{action:'link',problemId:problem,label:null})})).toMatchObject({ok:false,code:'problem_not_active_in_case'});
});
