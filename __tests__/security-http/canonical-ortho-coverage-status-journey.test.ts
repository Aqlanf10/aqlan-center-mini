import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { seedCanonicalCoverage } from "../fixtures/canonical-ortho-coverage";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import type { FollowupCoverageCommand } from "../../lib/ortho-followup-coverage";
const GRANTS={"finance.agreements.manage":true,"finance.patient-ledger.view":true};
const ACCOUNTS={
 owner:{username:"canon-cstatus-owner",password:"Canon#StatusOwner1",role:"admin",display:"مالك تجريبي"},
 own:{username:"canon-cstatus-own",password:"Canon#StatusOwn1",role:"doctor",doctor:true,display:"طبيب تجريبي",patientScope:"own",grants:GRANTS},
 all:{username:"canon-cstatus-all",password:"Canon#StatusAll1",role:"reception",display:"مفوّض تجريبي",patientScope:"all",grants:GRANTS},
 none:{username:"canon-cstatus-none",password:"Canon#StatusNone1",role:"admin",display:"بلا نطاق",patientScope:"none",grants:GRANTS},
 read:{username:"canon-cstatus-read",password:"Canon#StatusRead1",role:"admin",display:"قارئ تجريبي",patientScope:"all",grants:{"clinical.ortho.view":true}},
}as const;
let journey:CanonicalJourney<keyof typeof ACCOUNTS>,patientId:number,caseId:number,command:FollowupCoverageCommand,sourceSnapshot:unknown,sequence=0;
beforeAll(async()=>{journey=await openCanonicalJourney({portOffset:95,secret:"canonical-coverage-status-0123456789abcdef",accounts:ACCOUNTS,ownerKey:"owner",async seed(){}});},300000);
beforeEach(async()=>{
 patientId=(await journey.db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'مريض تجريبي',$2) RETURNING id",["SYN-CSTATUS-"+(++sequence),journey.parties.own])).rows[0].id;
 const observed={query:async(sql:string,values?:unknown[])=>{const result=await journey.db.query(sql,values);if(sql.startsWith("WITH candidates AS MATERIALIZED"))sourceSnapshot=result.rows[0]?.sources?.[0]?.snapshot;return result;}};
 const seeded=await seedCanonicalCoverage(observed as Parameters<typeof seedCanonicalCoverage>[0],{patientId,actorId:journey.ids.own,doctorId:journey.parties.own!,save:false});caseId=seeded.ortho;
 const {fingerprint,invoiceNumber:_invoice,serviceName:_service,...source}=seeded.source;
 command={schemaVersion:1,commandId:randomUUID(),expectedRevisionId:null,source,expectedSourceFingerprint:fingerprint,scope:"routine_adjustments",decision:"included",reason:"SYN explicit synthetic coverage"};
});
afterAll(async()=>{await journey?.close();},60000);
const path=()=>`/api/ortho/${caseId}/followup-coverage?patientId=${patientId}`;
it("HTTP: exact scoped status read is unresolved, never a rejection or a new financial decision",async()=>{
 const cookie=(await journey.login("own")).cookie;expect((await journey.api(path(),cookie)).status).toBe(200);
 const response=await journey.api(path(),cookie,{method:"PUT",body:JSON.stringify(command)});expect(response.status).toBe(200);expect(await response.json()).toEqual({state:"unresolved"});expect(await journey.ddlLog()).toEqual([]);
});

const fingerprint=()=>createHash("sha256").update(JSON.stringify({patientId,orthoCaseId:caseId,actorUserId:journey.ids.own,command})).digest("hex");
async function saved(){const s=command.source;return(await journey.db.query(`INSERT INTO ortho_followup_coverage_revisions(patient_id,ortho_case_id,clinical_case_id,plan_id,plan_item_id,invoice_id,version,scope,decision,source_fingerprint,source_snapshot,reason,actor_user_id,created_by,command_id,request_fingerprint)
 VALUES($1,$2,$3,$4,$5,$6,1,'routine_adjustments',$7,$8,$9::jsonb,$10,$11,$12,$13,$14) RETURNING id::text`,[patientId,caseId,s.clinicalCaseId,s.planId,s.planItemId,s.invoiceId,command.decision,command.expectedSourceFingerprint,JSON.stringify(sourceSnapshot),command.reason,journey.ids.own,ACCOUNTS.own.username,command.commandId,fingerprint()])).rows[0].id;}
const snapshot=async()=>(await journey.db.query("SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ortho_followup_coverage_revisions r) revisions,(SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM ortho_followup_coverage_rejections r) rejections,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM treatment_plans p) plans,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a) audit")).rows;
it("HTTP: anonymous, none and adjacent role cannot read even a known receipt",async()=>{
 await saved();const cookies={none:(await journey.login("none")).cookie,read:(await journey.login("read")).cookie},before=await snapshot();expect((await journey.api(path(),"",{method:"PUT",body:JSON.stringify(command)})).status).toBe(401);for(const key of["none","read"]as const){const response=await journey.api(path(),cookies[key],{method:"PUT",body:JSON.stringify(command)});expect(response.status).toBe(403);expect(await response.text()).not.toContain("SYN");}expect(await snapshot()).toEqual(before);
});
it("HTTP: exact committed receipt does not expose its financial source snapshot or another actor's result",async()=>{
 const id=await saved(),cookie=(await journey.login("own")).cookie,cookies={owner:(await journey.login("owner")).cookie,all:(await journey.login("all")).cookie},before=await snapshot(),response=await journey.api(path(),cookie,{method:"PUT",body:JSON.stringify(command)});expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toContain("no-store");const body=await response.json();expect(body).toMatchObject({state:"committed",revision:{id,commandId:command.commandId,createdBy:ACCOUNTS.own.username}});expect(JSON.stringify(body)).not.toMatch(/250000|SYN-COV-INVOICE|private plan|invoice service|source_snapshot/);
 for(const key of["owner","all"]as const){const denied=await journey.api(path(),cookies[key],{method:"PUT",body:JSON.stringify(command)});expect(denied.status).toBe(409);expect(await denied.json()).toMatchObject({code:"command_conflict"});}
 const changed=await journey.api(path(),cookie,{method:"PUT",body:JSON.stringify({...command,decision:"excluded"})});expect(changed.status).toBe(409);expect(await snapshot()).toEqual(before);expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: durable rejection is exact while a missing command is unresolved",async()=>{
 await journey.db.query(`INSERT INTO ortho_followup_coverage_rejections(command_id,request_fingerprint,patient_id,ortho_case_id,actor_user_id,command,code,message,actor) VALUES($1,$2,$3,$4,$5,$6::jsonb,'source_changed','SYN source changed',$7)`,[command.commandId,fingerprint(),patientId,caseId,journey.ids.own,JSON.stringify(command),ACCOUNTS.own.username]);const cookie=(await journey.login("own")).cookie,before=await snapshot(),response=await journey.api(path(),cookie,{method:"PUT",body:JSON.stringify(command)});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({state:"rejected",rejection:{terminal:true,command,actorUserId:journey.ids.own}});const missing=await journey.api(path(),cookie,{method:"PUT",body:JSON.stringify({...command,commandId:randomUUID()})});expect(await missing.json()).toEqual({state:"unresolved"});expect(await snapshot()).toEqual(before);
});
it("HTTP: strict URL/body scope, malformed data and bounded bodies cannot widen status access",async()=>{
 const cookie=(await journey.login("own")).cookie,before=await snapshot();for(const suffix of["",`?patientId=${patientId}&patientId=${patientId}`,`?patientId=${patientId}&sources=all`])expect((await journey.api(`/api/ortho/${caseId}/followup-coverage${suffix}`,cookie,{method:"PUT",body:JSON.stringify(command)})).status).toBe(400);
 for(const body of[{},[],{...command,force:true},{...command,source:{...command.source,patientId:2147483647}}])expect((await journey.api(path(),cookie,{method:"PUT",body:JSON.stringify(body)})).status).toBe(400);
 expect((await journey.api(path(),cookie,{method:"PUT",body:"{"})).status).toBe(400);expect((await journey.api(path(),cookie,{method:"PUT",body:JSON.stringify({reason:"x".repeat(2*1024*1024)})})).status).toBe(413);expect(await snapshot()).toEqual(before);
});
it("HTTP: removed current patient access blocks historical receipt reads and command replay",async()=>{
 await saved();const cookie=(await journey.login("own")).cookie;await journey.db.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[patientId]);const response=await journey.api(path(),cookie,{method:"PUT",body:JSON.stringify(command)});expect(response.status).toBe(404);expect(await response.text()).not.toContain("SYN");expect((await journey.api(path(),cookie,{method:"POST",body:JSON.stringify(command)})).status).toBe(404);
});
it("HTTP: grant withdrawal denies stale and fresh sessions before returning saved results",async()=>{
 await saved();const original=(await journey.db.query("SELECT permissions FROM users WHERE id=$1",[journey.ids.own])).rows[0].permissions,stale=(await journey.login("own")).cookie;try{await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,finance.agreements.manage}','false')::text WHERE id=$1",[journey.ids.own]);expect((await journey.api(path(),stale,{method:"PUT",body:JSON.stringify(command)})).status).toBe(401);expect((await journey.api(path(),(await journey.login("own")).cookie,{method:"PUT",body:JSON.stringify(command)})).status).toBe(403);}finally{await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2",[original,journey.ids.own]);}
});
it("browser: an authenticated scoped browser can explicitly check the exact outcome without a create request",async()=>{
 await saved();const context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"});try{const page=await context.newPage();await journey.browserLogin(page,"own");await page.goto(`${journey.baseUrl}/patients/${patientId}`);const before=await snapshot();const result=await page.evaluate(async({path,command})=>{const response=await fetch(path,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(command)});return{status:response.status,body:await response.json()};},{path:path(),command});expect(result).toMatchObject({status:200,body:{state:"committed",revision:{commandId:command.commandId}}});expect(await snapshot()).toEqual(before);}finally{await context.close();}
});
