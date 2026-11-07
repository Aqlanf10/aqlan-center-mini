import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import { tanakaCommandV2 } from "../fixtures/ortho-assessment-tanaka";
import { appendOrthoAssessment } from "../../lib/ortho-assessment-store";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>, n = 0;
beforeAll(async () => { vi.stubEnv("SESSION_SECRET", "synthetic-tanaka-review-secret-at-least32characters"); f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema(); });
afterAll(async () => { try { await f?.close(); } finally { vi.unstubAllEnvs(); } });
async function setup() {
  const seq = ++n, password = "Synthetic credential";
  const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic mixed analysis') RETURNING id", [`SYN-TANAKA-${seq}`])).rows[0].id;
  const userId = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic examiner',$2,'admin') RETURNING id", [`synthetic-tanaka-${seq}`, password])).rows[0].id;
  const session: SessionPayload = { userId, username: `synthetic-tanaka-${seq}`, role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 600000 };
  request.token = createSessionToken(session);
  const orthoCaseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,appliance,arches,slot,start_date,planned_months,created_by) VALUES($1,'assessment','assessment',NULL,NULL,NULL,NULL,NULL,'synthetic') RETURNING id", [patientId])).rows[0].id;
  const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic mixed analysis bridge',$2,'synthetic') RETURNING id", [patientId, orthoCaseId])).rows[0].id;
  return { patientId, orthoCaseId, clinicalCaseId, session };
}
import { authorizeJourney, discoverJourneyOwner, journeyTransaction, lockJourneyOwner } from "../../lib/ortho-case-journey-authority";
import { createStudyAssessmentAccess, lockStudySourceUnion } from "../../lib/ortho-case-study-assessment-access";
import { prepareSpaceAssessmentSources, requireSpaceBaseline, spaceBaselineChoices } from "../../lib/ortho-space-baselines";
import type { ProblemSourceRef } from "../../lib/ortho-problem-sources";
async function read(scope:Awaited<ReturnType<typeof setup>>,refs:ProblemSourceRef[]=[],resolve?:{ref:ProblemSourceRef;arch:"upper"|"lower";current:boolean},includeLatest=true){
 return journeyTransaction(false,async client=>{
  const actor=await authorizeJourney(client,scope,false),owner=await discoverJourneyOwner(client,scope),cache=createStudyAssessmentAccess();
  const prepared=await prepareSpaceAssessmentSources(client,owner,actor,refs,cache,{includeLatest});
  await lockStudySourceUnion(client,owner,actor,cache);await lockJourneyOwner(client,scope,false);
  const selected=resolve?requireSpaceBaseline(prepared,resolve.ref,resolve.arch,actor,{requireLatest:resolve.current,exactCurrentSources:resolve.current}):null;
  return {ok:true as const,choices:spaceBaselineChoices(prepared,actor),selected};
 });
}
async function save(scope:Awaited<ReturnType<typeof setup>>,command=assessmentCommandV2()){
 const saved=await appendOrthoAssessment({...scope,command:{...command,commandId:randomUUID()}});if(!saved.ok)throw Error(saved.code);return saved.revision;
}
it("reads only saved calculated arch-space results, excluding Bolton and unsaved input",async()=>{
 const scope=await setup();expect(await read(scope)).toMatchObject({ok:true,choices:[]});await save(scope);
 const r=await read(scope);expect(r).toMatchObject({ok:true,choices:[{arch:"upper",estimated:false,discrepancyMm:0},{arch:"lower",estimated:false,discrepancyMm:0}]});
 expect((await f.pool.query("SELECT count(*)::int n FROM patient_problems WHERE patient_id=$1",[scope.patientId])).rows[0].n).toBe(0);
});
it("preserves Tanaka estimates and exact versioned saved values",async()=>{
 const scope=await setup(),saved=await save(scope,tanakaCommandV2()),r=await read(scope);if(!r.ok)throw Error(r.code);
 expect(r.choices.map(x=>[x.arch,x.estimated,x.discrepancyMm])).toEqual([["upper",true,-2],["lower",true,-2]]);
 expect(r.choices.every(x=>x.ref.version===`sha256:${saved.contentHash}`)).toBe(true);
});
it("requires latest for a new plan but preserves an explicitly selected old baseline",async()=>{
 const scope=await setup(),first=await save(scope),before=await read(scope);if(!before.ok)throw Error(before.code);const ref=before.choices[0].ref;
 const next=assessmentCommandV2();next.expectedRevisionId=first.id;next.content.observations.observations.find(o=>o.id==='available_upper')!.value={state:"measured",value:71.123456};await save(scope,next);
 expect(await read(scope,[ref],{ref,arch:"upper",current:true})).toMatchObject({ok:false,code:"space_baseline_changed"});
 const historical=await read(scope,[ref],{ref,arch:"upper",current:false});expect(historical).toMatchObject({ok:true,selected:{discrepancyMm:0,ref}});
 if(!historical.ok)throw Error(historical.code);expect(historical.choices[0].discrepancyMm).toBe(71.123456-70);
});
it("never falls back to a prior result when the newest assessment is incomplete",async()=>{
 const scope=await setup(),first=await save(scope),next=assessmentCommandV2();next.expectedRevisionId=first.id;
 next.content.observations.observations.find(o=>o.id==='available_upper')!.value={state:"not_measured",reason:"Synthetic unavailable measurement"};await save(scope,next);
 const r=await read(scope);if(!r.ok)throw Error(r.code);expect(r.choices.map(b=>b.arch)).toEqual(["lower"]);
});
it("rejects foreign patient, different arch, non-space member and changed ref hash",async()=>{
 const a=await setup();await save(a);const ar=await read(a);if(!ar.ok)throw Error(ar.code);const ref=ar.choices[0].ref;
 const b=await setup();expect(await read(b,[ref])).toMatchObject({ok:false,code:"space_baseline_unavailable"});
 request.token=createSessionToken(a.session);
 expect(await read(a,[ref],{ref,arch:"lower",current:true})).toMatchObject({ok:false,code:"space_baseline_changed"});
 expect(await read(a,[{...ref,member:"bolton_anterior"}])).toMatchObject({ok:false,code:"space_baseline_changed"});
 expect(await read(a,[{...ref,version:`sha256:${"f".repeat(64)}`}])).toMatchObject({ok:false,code:"space_baseline_changed"});
});
async function withDocument(){
 const scope=await setup(),sha='a'.repeat(64),id=(await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'Synthetic basis','image/png',123,$3,'synthetic-unused-image-key','synthetic') RETURNING id",[scope.patientId,scope.orthoCaseId,sha])).rows[0].id;
 const command=assessmentCommandV2();command.content.observations.observations.find(o=>o.id==='available_upper')!.provenance!.sources=[{kind:"document",id,version:`sha256:${sha}`}];await save(scope,command);
 const r=await read(scope);if(!r.ok)throw Error(r.code);return {scope,id,ref:r.choices[0].ref};
}
it("changed source is not a fresh baseline while historical evidence remains unchanged",async()=>{
 const {scope,id,ref}=await withDocument();await f.pool.query("UPDATE patient_documents SET sha256=$1 WHERE id=$2",['b'.repeat(64),id]);
 expect(await read(scope,[ref],{ref,arch:"upper",current:true})).toMatchObject({ok:false,code:"study_assessment_sources_changed"});
 expect(await read(scope,[ref],{ref,arch:"upper",current:false})).toMatchObject({ok:true,choices:[],selected:{discrepancyMm:0,ref}});
 await f.pool.query("UPDATE patient_documents SET removed_at=NOW() WHERE id=$1",[id]);
 expect(await read(scope,[ref],{ref,arch:"upper",current:false})).toMatchObject({ok:false,code:"study_assessment_sources_changed"});
});
it("revoked image permission blocks source content even for historical admission",async()=>{
 const {scope,ref}=await withDocument();await f.pool.query("UPDATE users SET role='doctor',permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewPlans:true,canViewXrays:false}),scope.session.userId]);
 scope.session={...scope.session,role:"doctor"};request.token=createSessionToken(scope.session);
 const r=await read(scope,[ref],{ref,arch:"upper",current:false});expect(r).toMatchObject({ok:false,status:403,code:"study_assessment_sources_restricted"});expect(JSON.stringify(r)).not.toContain('Synthetic examiner');
});
it("refuses source projection before locking the prepared union",async()=>{
 const scope=await setup();await save(scope);
 expect(await journeyTransaction(false,async client=>{const actor=await authorizeJourney(client,scope,false),owner=await discoverJourneyOwner(client,scope),prepared=await prepareSpaceAssessmentSources(client,owner,actor,[],createStudyAssessmentAccess());return {ok:true as const,choices:spaceBaselineChoices(prepared,actor)};})).toMatchObject({ok:false,code:"study_assessment_access_not_prepared"});
});
import { historicalTanakaPayload } from "../fixtures/ortho-assessment-historical-tanaka";
import { assessmentJsonHash, type PersistedAssessmentContentV2 } from "../../lib/ortho-assessment-persisted-v2";
async function insertHistorical(scope:Awaited<ReturnType<typeof setup>>,content:PersistedAssessmentContentV2){
 return (await f.pool.query(`INSERT INTO ortho_assessment_revisions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,schema_version,version,supersedes_revision_id,actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,content_sha256,content)
 VALUES($1,$1,$2,$3,2,1,NULL,$4,'Synthetic examiner','Synthetic pinned historical witness','current',$5,$6,$7,$8::jsonb) RETURNING id`,[scope.patientId,scope.orthoCaseId,scope.clinicalCaseId,scope.session.userId,randomUUID(),'a'.repeat(64),assessmentJsonHash(content),JSON.stringify(content)])).rows[0].id;
}
it("retains historical2.2.0 admission rather than silently recalculating with2.2.1",async()=>{
 const scope=await setup(),draft=tanakaCommandV2().content;
 const widths=[4,4.06,5.97,6.47];['width_31','width_32','width_41','width_42'].forEach((id,i)=>{draft.observations.observations.find(o=>o.id===id)!.value={state:'measured',value:widths[i]};});
 const payload=historicalTanakaPayload(draft);await insertHistorical(scope,payload);
 // Old binary-summation admission refuses this exact-decimal20.5 endpoint.
 // The current2.2.1 correction must not turn its historical refusal into a value.
 expect(await read(scope)).toMatchObject({ok:true,choices:[]});
 const revision=(await f.pool.query("SELECT content FROM ortho_assessment_revisions WHERE ortho_case_id=$1",[scope.orthoCaseId])).rows[0].content;expect(revision).toEqual(payload);
});
it("refuses self-consistent hashes when the stored result contradicts its pinned engine",async()=>{
 const scope=await setup(),payload=historicalTanakaPayload(tanakaCommandV2().content),entry=payload.results[0];
 if(entry.result.state!=="ready"||entry.result.witness.result.state!=="calculated"||entry.result.witness.result.method!=="tanaka_johnston_1974_approximation_v1")throw Error("fixture");
 entry.result.witness.result.availableMinusEstimatedRequiredMm=999;entry.resultHash=assessmentJsonHash(entry.result);await insertHistorical(scope,payload);
 expect(await read(scope)).toMatchObject({ok:false,code:"result_reconstruction_mismatch"});
});
it("historical-only admission need not expose a separately restricted latest assessment",async()=>{
 const scope=await setup(),first=await save(scope),prior=await read(scope);if(!prior.ok)throw Error(prior.code);const ref=prior.choices[0].ref;
 const sha='c'.repeat(64),doc=(await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'Restricted newest synthetic basis','image/png',123,$3,'synthetic-unused-newest-image','synthetic') RETURNING id",[scope.patientId,scope.orthoCaseId,sha])).rows[0].id;
 const next=assessmentCommandV2();next.expectedRevisionId=first.id;next.content.observations.observations.find(o=>o.id==='available_upper')!.provenance!.sources=[{kind:"document",id:doc,version:`sha256:${sha}`}];await save(scope,next);
 await f.pool.query("UPDATE users SET role='doctor',permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewPlans:true,canViewXrays:false}),scope.session.userId]);scope.session={...scope.session,role:'doctor'};request.token=createSessionToken(scope.session);
 expect(await read(scope,[ref],{ref,arch:"upper",current:false})).toMatchObject({ok:false,code:"study_assessment_sources_restricted"});
 expect(await read(scope,[ref],{ref,arch:"upper",current:false},false)).toMatchObject({ok:true,choices:[],selected:{ref,discrepancyMm:0}});
 expect(await read(scope,[ref],{ref,arch:"upper",current:true},false)).toMatchObject({ok:false,code:"space_baseline_changed"});
});
it("holds baseline selection stable while a canonical assessment correction waits",async()=>{
 const scope=await setup(),first=await save(scope),initial=await read(scope);if(!initial.ok)throw Error(initial.code);const ref=initial.choices[0].ref;
 const client=await f.pool.connect();let writer:ReturnType<typeof appendOrthoAssessment>|null=null;
 try{
  await client.query('BEGIN');const pid=Number((await client.query('SELECT pg_backend_pid() pid')).rows[0].pid);
  const actor=await authorizeJourney(client,scope,false),owner=await discoverJourneyOwner(client,scope),cache=createStudyAssessmentAccess(),prepared=await prepareSpaceAssessmentSources(client,owner,actor,[ref],cache);
  await lockStudySourceUnion(client,owner,actor,cache);await lockJourneyOwner(client,scope,false);
  const command=assessmentCommandV2();command.commandId=randomUUID();command.expectedRevisionId=first.id;command.content.observations.observations.find(o=>o.id==='available_upper')!.value={state:'measured',value:71};
  writer=appendOrthoAssessment({...scope,command});
  let blocked=false;
  for(let attempt=0;attempt<100;attempt++){
   blocked=(await f.pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) blocked',[pid])).rows[0].blocked;
   if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect(blocked).toBe(true);expect(requireSpaceBaseline(prepared,ref,'upper',actor,{requireLatest:true,exactCurrentSources:true}).discrepancyMm).toBe(0);
  await client.query('COMMIT');expect(await writer).toMatchObject({ok:true});writer=null;
 }finally{await client.query('ROLLBACK');client.release();if(writer)await writer;}
 expect(await read(scope,[ref],{ref,arch:'upper',current:true})).toMatchObject({ok:false,code:'space_baseline_changed'});
});
