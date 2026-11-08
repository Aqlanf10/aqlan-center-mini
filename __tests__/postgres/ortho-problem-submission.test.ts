import { MEASUREMENTS, type LandmarkCode } from "../../lib/ceph";
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

import { reserveProblemSubmission, saveJournaledProblemSource, getProblemSubmissionRecovery, transitionProblemSubmission } from "../../lib/ortho-problem-submission-store";
import { journeyContentHash } from "../../lib/ortho-case-journey-hash";
async function prepared() { const scope=await setup();const command=review((await read(scope)).candidates[0]);return {...scope,actorId:scope.session.userId!,command}; }
const transition=(s:Awaited<ReturnType<typeof prepared>>,action:'cancel'|'acknowledge')=>transitionProblemSubmission({...s,action,commandId:s.command.commandId,requestFingerprint:journeyContentHash(s.command)});
it('reserves exact intent durably without clinical mutation, recovers and retries one outcome',async()=>{
 const s=await prepared();const r=await reserveProblemSubmission(s);expect(r.ok).toBe(true);expect((await read(s)).reviews).toHaveLength(0);expect((await read(s)).problems).toHaveLength(0);
 expect(await getProblemSubmissionRecovery(s)).toMatchObject({ok:true,actorId:s.actorId,recovery:{state:'pending',expected:{command:s.command}}});
 const [a,b]=await Promise.all([saveJournaledProblemSource(s),saveJournaledProblemSource(s)]);expect(a.ok&&b.ok).toBe(true);if(!a.ok||!b.ok)throw Error('failed');expect(a.reviewId).toBe(b.reviewId);
 expect((await read(s)).reviews).toHaveLength(1);expect((await read(s)).problems).toHaveLength(1);
 expect(await getProblemSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'committed',expected:{command:s.command}}});
 expect(await transition(s,'cancel')).toMatchObject({ok:false,code:'problem_submission_already_committed'});
 expect(await transition(s,'acknowledge')).toMatchObject({ok:true,state:'committed',acknowledged:true});
 expect(await getProblemSubmissionRecovery(s)).toMatchObject({ok:true,recovery:null});
 expect((await f.pool.query('SELECT command FROM ortho_problem_source_submissions WHERE command_id=$1',[s.command.commandId])).rows[0].command).toBeNull();
 expect(await saveJournaledProblemSource(s)).toMatchObject({ok:true,reviewId:a.reviewId,replayed:true});
});
it('rejects changed intent and another unresolved command or actor/bridge',async()=>{
 const s=await prepared();expect((await reserveProblemSubmission(s)).ok).toBe(true);
 expect(await reserveProblemSubmission({...s,command:{...s.command,reason:'Different reason'}})).toMatchObject({ok:false,code:'request_key_conflict'});
 expect(await reserveProblemSubmission({...s,command:{...s.command,commandId:randomUUID()}})).toMatchObject({ok:false,code:'problem_submission_unacknowledged'});
 expect(await reserveProblemSubmission({...s,actorId:s.actorId+10000})).toMatchObject({ok:false,code:'problem_submission_actor_changed'});
 expect(await saveJournaledProblemSource({...s,clinicalCaseId:s.clinicalCaseId+10000})).toMatchObject({ok:false,code:'problem_submission_context_changed'});
 expect(await transitionProblemSubmission({...s,commandId:s.command.commandId,requestFingerprint:'a'.repeat(64),action:'cancel'})).toMatchObject({ok:false,code:'request_key_conflict'});
});
it('cancels before delayed arrival with permanent tombstone including after acknowledgment',async()=>{
 const s=await prepared();expect(await transition(s,'cancel')).toMatchObject({ok:true,state:'cancelled',acknowledged:false});
 expect(await getProblemSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'cancelled'}});
 expect(await saveJournaledProblemSource(s)).toMatchObject({ok:false,code:'problem_submission_cancelled'});
 expect(await transition(s,'acknowledge')).toMatchObject({ok:true,acknowledged:true});
 expect(await saveJournaledProblemSource(s)).toMatchObject({ok:false,code:'problem_submission_cancelled'});
 expect((await read(s)).reviews).toHaveLength(0);
});
it('blocks changed source recovery without payload and permits pending cancellation',async()=>{
 const s=await prepared();await reserveProblemSubmission(s);
 await f.pool.query("INSERT INTO patient_diagnoses(patient_id,ortho_case_id,version,content,created_by) VALUES($1,$2,2,$3::jsonb,'Synthetic review')",[s.patientId,s.orthoCaseId,JSON.stringify({skeletal:'Changed source'})]);
 expect(await saveJournaledProblemSource(s)).toMatchObject({ok:false,code:'problem_source_changed'});
 const recovery=await getProblemSubmissionRecovery(s);expect(recovery).toMatchObject({ok:true,recovery:{state:'blocked',canCancel:true}});expect(JSON.stringify(recovery)).not.toContain('Explicit synthetic');expect(JSON.stringify(recovery)).not.toContain('Synthetic reviewed');
 expect(await transition(s,'cancel')).toMatchObject({ok:true,state:'cancelled'});expect(await transition(s,'acknowledge')).toMatchObject({ok:true,acknowledged:true});
});
it('does not expose committed payload on changed source while historical exact replay remains stable',async()=>{
 const s=await prepared();const saved=await saveJournaledProblemSource(s);expect(saved.ok).toBe(true);
 await f.pool.query("INSERT INTO patient_diagnoses(patient_id,ortho_case_id,version,content,created_by) VALUES($1,$2,2,$3::jsonb,'Synthetic review')",[s.patientId,s.orthoCaseId,JSON.stringify({skeletal:'Changed source'})]);
 expect(await getProblemSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'blocked',identity:null,canCancel:false}});
 expect(await saveJournaledProblemSource(s)).toMatchObject({...saved,replayed:true});
 expect(await transition(s,'cancel')).toMatchObject({ok:false,code:'problem_submission_already_committed'});
});
it('checks current authority and hides another actor journal identity',async()=>{
 const s=await prepared();await reserveProblemSubmission(s);
 const second=await setup();expect(await getProblemSubmissionRecovery({...s,session:second.session})).toMatchObject({ok:true,actorId:second.session.userId,recovery:{state:'blocked',identity:null,canCancel:false}});
 request.token=createSessionToken(s.session);await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[s.actorId]);
 expect(await getProblemSubmissionRecovery(s)).toMatchObject({ok:false,status:401});
 expect(await saveJournaledProblemSource(s)).toMatchObject({ok:false,status:401});
});
it('pending journal alone prevents reset before backup and either-side merge',async()=>{
 const s=await prepared();await reserveProblemSubmission(s);const other=await setup();let backed=false;
 await expect(f.db.resetClinicData({actor:'synthetic',actorRole:'admin'},async()=>{backed=true;return {ok:false,failure:'must not run'};})).rejects.toBeInstanceOf(ProtectedOrthoProblemHistoryError);expect(backed).toBe(false);
 expect(await f.db.mergeDuplicatePatient(s.patientId,other.patientId,{actor:'synthetic',actorRole:'admin'})).toMatchObject({ok:false,reason:'source_has_clinical_command_history'});
 expect(await f.db.mergeDuplicatePatient(other.patientId,s.patientId,{actor:'synthetic',actorRole:'admin'})).toMatchObject({ok:false,reason:'source_has_clinical_command_history'});
});
it('audit failure rolls back clinical outcome and settlement but retains reservation',async()=>{
 const s=await prepared();await reserveProblemSubmission(s);
 await f.pool.query("CREATE FUNCTION synthetic_journal_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.problem_source.review' THEN RAISE EXCEPTION 'synthetic journal audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_journal_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_journal_audit_failure()");
 try {await expect(saveJournaledProblemSource(s)).rejects.toThrow('synthetic journal audit failure');expect((await read(s)).problems).toEqual([]);expect((await read(s)).reviews).toEqual([]);expect(await getProblemSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'pending'}});}
 finally{await f.pool.query('DROP TRIGGER synthetic_journal_audit_failure ON audit_log; DROP FUNCTION synthetic_journal_audit_failure()');}
 expect((await saveJournaledProblemSource(s)).ok).toBe(true);
});
it('does not manufacture a cancellation tombstone for a legacy accepted command',async()=>{
 const s=await prepared();const result=await appendOrthoProblemSource(s);expect(result.ok).toBe(true);
 expect(await transition(s,'cancel')).toMatchObject({ok:false,code:'problem_submission_already_committed'});
 expect(await saveJournaledProblemSource(s)).toMatchObject({...result,replayed:true});
});
it('preserves exact Unicode whitespace command while matching trimmed clinical label',async()=>{
 const s=await prepared();s.command.label='\n\t\u00a0Synthetic whitespace label\uFEFF\u3000';const result=await saveJournaledProblemSource(s);expect(result.ok).toBe(true);expect((await read(s)).problems[0].label).toBe('Synthetic whitespace label');
 expect(await getProblemSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'committed',expected:{command:s.command}}});
});
it('rejects direct legacy bypass and cross-case identity resurrection',async()=>{
 const s=await prepared();await reserveProblemSubmission(s);
 expect(await appendOrthoProblemSource(s)).toMatchObject({ok:false,code:'problem_submission_requires_journal'});
 expect(await appendOrthoProblemSource({...s,command:{...s.command,commandId:randomUUID()}})).toMatchObject({ok:false,code:'problem_submission_requires_journal'});
 const orthoCaseId=(await f.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'completed','synthetic') RETURNING id",[s.patientId])).rows[0].id;
 const clinicalCaseId=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Other case',$2,'synthetic') RETURNING id",[s.patientId,orthoCaseId])).rows[0].id;
 const other={...s,orthoCaseId,clinicalCaseId};
 expect(await reserveProblemSubmission(other)).toMatchObject({ok:false,code:'problem_submission_context_changed'});
 expect(await transition(other,'cancel')).toMatchObject({ok:false,code:'problem_submission_context_changed'});
 await transition(s,'cancel');await transition(s,'acknowledge');
 expect(await reserveProblemSubmission(other)).toMatchObject({ok:false,code:'problem_submission_context_changed'});
 expect(await appendOrthoProblemSource(s)).toMatchObject({ok:false,code:'problem_submission_requires_journal'});
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

it.each([false,true])('revoked image permission quarantines recovery payload (committed=%s)',async(committed)=>{
 const x=await cephFixture();expect(await f.db.completeCephAnalysis(x.id,x.session.username,x.snapshot,x.session,x.expectedSources)).toMatchObject({ok:true});
 await f.pool.query("UPDATE users SET role='doctor',permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewXrays:true}),x.session.userId]);
 x.scope.session={...x.session,role:'doctor'};request.token=createSessionToken(x.scope.session);
 const s={...x.scope,actorId:x.session.userId!,command:review((await read(x.scope)).candidates.find(c=>c.ref.kind==='ceph_diagnosis')!)};
 expect((await (committed?saveJournaledProblemSource(s):reserveProblemSubmission(s))).ok).toBe(true);
 await f.pool.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewXrays:false}),x.session.userId]);
 const result=await getProblemSubmissionRecovery(s);expect(result).toMatchObject({ok:true,recovery:{state:'blocked',canCancel:!committed}});expect(JSON.stringify(result)).not.toContain('command"');expect(JSON.stringify(result)).not.toContain('Synthetic reviewed');
 expect(await saveJournaledProblemSource(s)).toMatchObject({ok:false});
 if(committed)expect(await transition(s,'cancel')).toMatchObject({ok:false,code:'problem_submission_already_committed'});
 else {expect(await transition(s,'cancel')).toMatchObject({ok:true,state:'cancelled'});expect(await transition(s,'acknowledge')).toMatchObject({ok:true,acknowledged:true});}
});
it('settlement audit failure leaves only durable reservation, never unaudited clinical facts',async()=>{
 const s=await prepared();await reserveProblemSubmission(s);
 await f.pool.query("CREATE FUNCTION synthetic_settlement_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.problem_submission' AND NEW.details->>'event'='committed' THEN RAISE EXCEPTION 'synthetic settlement failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_settlement_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_settlement_audit_failure()");
 try {await expect(saveJournaledProblemSource(s)).rejects.toThrow('synthetic settlement failure');expect((await read(s)).reviews).toHaveLength(0);expect((await read(s)).problems).toHaveLength(0);expect(await getProblemSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'pending'}});}
 finally {await f.pool.query('DROP TRIGGER synthetic_settlement_audit_failure ON audit_log; DROP FUNCTION synthetic_settlement_audit_failure()');}
});
it('concurrent cancellation and save settle one truthful terminal outcome',async()=>{
 const s=await prepared();const [saved,cancelled]=await Promise.all([saveJournaledProblemSource(s),transition(s,'cancel')]);
 const row=(await f.pool.query('SELECT state,review_id FROM ortho_problem_source_submissions WHERE command_id=$1',[s.command.commandId])).rows[0];
 if(row.state==='committed'){expect(saved.ok).toBe(true);expect(cancelled).toMatchObject({ok:false,code:'problem_submission_already_committed'});expect((await read(s)).reviews).toHaveLength(1);}
 else {expect(row.state).toBe('cancelled');expect(row.review_id).toBeNull();expect(cancelled.ok).toBe(true);expect(saved).toMatchObject({ok:false,code:'problem_submission_cancelled'});expect((await read(s)).reviews).toHaveLength(0);}
});
