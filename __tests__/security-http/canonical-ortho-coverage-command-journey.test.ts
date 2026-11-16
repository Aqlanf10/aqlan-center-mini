import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { seedCanonicalCoverage } from "../fixtures/canonical-ortho-coverage";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import type { FollowupCoverageCommand } from "../../lib/ortho-followup-coverage";
const GRANTS={"finance.agreements.manage":true,"finance.patient-ledger.view":true};
const ACCOUNTS={
 owner:{username:"canon-cappend-owner",password:"Canon#AppendOwner1",role:"admin",display:"مالك تجريبي"},
 own:{username:"canon-cappend-own",password:"Canon#AppendOwn1",role:"doctor",doctor:true,display:"طبيب تجريبي",patientScope:"own",grants:GRANTS},
 all:{username:"canon-cappend-all",password:"Canon#AppendAll1",role:"reception",display:"مفوّض تجريبي",patientScope:"all",grants:GRANTS},
 none:{username:"canon-cappend-none",password:"Canon#AppendNone1",role:"admin",display:"بلا نطاق",patientScope:"none",grants:GRANTS},
 read:{username:"canon-cappend-read",password:"Canon#AppendRead1",role:"admin",display:"قارئ تجريبي",patientScope:"all",grants:{"clinical.ortho.view":true}},
}as const;
let journey:CanonicalJourney<keyof typeof ACCOUNTS>,patientId:number,caseId:number,command:FollowupCoverageCommand,sequence=0;
beforeAll(async()=>{journey=await openCanonicalJourney({portOffset:97,secret:"canonical-coverage-append-0123456789abcdef",accounts:ACCOUNTS,ownerKey:"owner",async seed(){}});},300000);
beforeEach(async()=>{
 patientId=(await journey.db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'مريض تجريبي',$2) RETURNING id",["SYN-CAPPEND-"+(++sequence),journey.parties.own])).rows[0].id;
 const seeded=await seedCanonicalCoverage(journey.db,{patientId,actorId:journey.ids.own,doctorId:journey.parties.own!,save:false,status:"active"});caseId=seeded.ortho;
 const {fingerprint,invoiceNumber:_invoice,serviceName:_service,...source}=seeded.source;
 command={schemaVersion:1,commandId:randomUUID(),expectedRevisionId:null,source,expectedSourceFingerprint:fingerprint,scope:"routine_adjustments",decision:"included",reason:"SYN explicit synthetic coverage"};
});
afterAll(async()=>{await journey?.close();},60000);
const path=()=>`/api/ortho/${caseId}/followup-coverage?patientId=${patientId}`;
it("HTTP: a scoped agreement manager explicitly records the native routine coverage decision",async()=>{
 const cookie=(await journey.login("own")).cookie;expect((await journey.api(path(),cookie)).status).toBe(200);
 const response=await journey.api(path(),cookie,{method:"POST",body:JSON.stringify(command)});expect(response.status).toBe(201);expect(await response.json()).toMatchObject({ok:true,replayed:false,revision:{decision:"included",commandId:command.commandId,createdBy:ACCOUNTS.own.username}});expect(await journey.ddlLog()).toEqual([]);
});
const facts=async()=>(await journey.db.query("SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoice_items i) lines,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) payments,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM treatment_plans p) plans,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM plan_items p) items,(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM ortho_cases c) cases")).rows;
const receipts=async()=>(await journey.db.query("SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ortho_followup_coverage_revisions r) revisions,(SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM ortho_followup_coverage_rejections r) rejections,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a) audit")).rows;
const counts=async()=>(await journey.db.query("SELECT (SELECT count(*)::int FROM ortho_followup_coverage_revisions WHERE ortho_case_id=$1) revisions,(SELECT count(*)::int FROM ortho_followup_coverage_rejections WHERE ortho_case_id=$1) rejections,(SELECT count(*)::int FROM audit_log WHERE entity='ortho_case' AND entity_id=$1::text AND action='ortho.followup_coverage.append') audits",[caseId])).rows[0];
it.each(["owner","all"]as const)("HTTP: %s needs no fabricated clinician mapping and replays only its own exact receipt",async key=>{
 const cookie=(await journey.login(key)).cookie,before=await facts(),first=await journey.api(path(),cookie,{method:"POST",body:JSON.stringify(command)});expect(first.status).toBe(201);expect(first.headers.get("cache-control")).toContain("no-store");const result=await first.json();expect(result).toMatchObject({ok:true,replayed:false,revision:{createdBy:ACCOUNTS[key].username}});expect(JSON.stringify(result)).not.toMatch(/250000|SYN-COV-INVOICE|invoice service|private plan|source_snapshot|request_fingerprint/);
 const replay=await journey.api(path(),cookie,{method:"POST",body:JSON.stringify(command)});expect(replay.status).toBe(200);expect(await replay.json()).toEqual({...result,replayed:true});expect(await counts()).toEqual({revisions:1,rejections:0,audits:1});expect(await facts()).toEqual(before);
});
it("HTTP: anonymous, none and adjacent capability cannot create a receipt or audit",async()=>{
 const cookies={none:(await journey.login("none")).cookie,read:(await journey.login("read")).cookie},before=await receipts();expect((await journey.api(path(),"",{method:"POST",body:JSON.stringify(command)})).status).toBe(401);
 for(const key of["none","read"]as const){const response=await journey.api(path(),cookies[key],{method:"POST",body:JSON.stringify(command)});expect(response.status).toBe(403);expect(await response.text()).not.toContain("SYN");}expect(await receipts()).toEqual(before);
});
it("HTTP: strict scope, unknown keys, malformed data and body limits fail before any command effect",async()=>{
 const cookie=(await journey.login("own")).cookie,before=await receipts();for(const suffix of["",`?patientId=${patientId}&patientId=${patientId}`,`?patientId=${patientId}&force=true`])expect((await journey.api(`/api/ortho/${caseId}/followup-coverage${suffix}`,cookie,{method:"POST",body:JSON.stringify(command)})).status).toBe(400);
 for(const body of[{},[],{...command,actor:"owner"},{...command,source:{...command.source,patientId:2147483647}}])expect((await journey.api(path(),cookie,{method:"POST",body:JSON.stringify(body)})).status).toBe(400);
 expect((await journey.api(path(),cookie,{method:"POST",body:"{"})).status).toBe(400);expect((await journey.api(path(),cookie,{method:"POST",body:JSON.stringify({reason:"x".repeat(2*1024*1024)})})).status).toBe(413);expect(await receipts()).toEqual(before);
});
it.each(["case_closed","source_changed","stale_coverage"]as const)("HTTP: %s commits a durable refusal and exact PUT status without creating an invoice",async code=>{
 const cookie=(await journey.login("own")).cookie;let saved=0;if(code==="case_closed")await journey.db.query("UPDATE ortho_cases SET status='completed' WHERE id=$1",[caseId]);if(code==="source_changed")command.expectedSourceFingerprint="0".repeat(64);if(code==="stale_coverage"){expect((await journey.api(path(),cookie,{method:"POST",body:JSON.stringify(command)})).status).toBe(201);saved=1;command={...command,commandId:randomUUID(),decision:"excluded"};}
 const before=await facts(),r=await journey.api(path(),cookie,{method:"POST",body:JSON.stringify(command)});expect(r.status).toBe(409);const rejected=await r.json();expect(rejected).toMatchObject({code,rejection:{terminal:true,command,actorUserId:journey.ids.own}});const status=await journey.api(path(),cookie,{method:"PUT",body:JSON.stringify(command)});expect(status.status).toBe(200);expect(await status.json()).toEqual({state:"rejected",rejection:rejected.rejection});expect((await journey.api(path(),cookie,{method:"POST",body:JSON.stringify(command)})).status).toBe(409);expect(await counts()).toEqual({revisions:saved,rejections:1,audits:saved+1});expect(await facts()).toEqual(before);
});
it("HTTP: current scope, exact actor and exact payload remain required for replay",async()=>{
 const cookie=(await journey.login("own")).cookie,owner=(await journey.login("owner")).cookie;expect((await journey.api(path(),cookie,{method:"POST",body:JSON.stringify(command)})).status).toBe(201);const before=await receipts();for(const [c,body]of[[owner,command],[cookie,{...command,decision:"excluded"}]]as const){const r=await journey.api(path(),c,{method:"POST",body:JSON.stringify(body)});expect(r.status).toBe(409);expect(await r.json()).toMatchObject({code:"command_conflict"});}await journey.db.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[patientId]);expect((await journey.api(path(),cookie,{method:"POST",body:JSON.stringify(command)})).status).toBe(404);expect(await receipts()).toEqual(before);
});
it("HTTP: grant withdrawal denies stale and fresh writes before returning historical success",async()=>{
 const original=(await journey.db.query("SELECT permissions FROM users WHERE id=$1",[journey.ids.own])).rows[0].permissions,stale=(await journey.login("own")).cookie;expect((await journey.api(path(),stale,{method:"POST",body:JSON.stringify(command)})).status).toBe(201);try{await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,finance.agreements.manage}','false')::text WHERE id=$1",[journey.ids.own]);expect((await journey.api(path(),stale,{method:"POST",body:JSON.stringify(command)})).status).toBe(401);expect((await journey.api(path(),(await journey.login("own")).cookie,{method:"POST",body:JSON.stringify(command)})).status).toBe(403);expect(await counts()).toEqual({revisions:1,rejections:0,audits:1});}finally{await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2",[original,journey.ids.own]);}
});
it("browser: an explicit command with a lost response is recovered by exact status without an automatic second POST",async()=>{
 const context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"});let posts=0;try{const page=await context.newPage();await journey.browserLogin(page,"own");await page.goto(`${journey.baseUrl}/patients/${patientId}`);const before=await facts();await page.route("**/followup-coverage?*",async route=>{if(route.request().method()==="POST"){posts++;const response=await route.fetch();expect(response.status()).toBe(201);await route.abort("failed");}else await route.continue();});
 const lost=await page.evaluate(async({path,command})=>{try{await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(command)});return false;}catch{return true;}},{path:path(),command});expect(lost).toBe(true);expect(posts).toBe(1);expect(await counts()).toEqual({revisions:1,rejections:0,audits:1});
 const outcome=await page.evaluate(async({path,command})=>{const r=await fetch(path,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(command)});return{status:r.status,body:await r.json()};},{path:path(),command});expect(outcome).toMatchObject({status:200,body:{state:"committed",revision:{commandId:command.commandId}}});expect(posts).toBe(1);expect(await facts()).toEqual(before);expect(await journey.ddlLog()).toEqual([]);
 }finally{await context.close();}
});
