import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { seedCanonicalCoverage } from "../fixtures/canonical-ortho-coverage";
import { applyRuntimeMigrationFiles, loadMigrationFiles } from "../../lib/migrations";
import { readVerifiedDurableSession } from "../../lib/staff-durable-session";
import { commandCanonicalFollowupCoverage as historicAuthor } from "../postgres/_historical-canonical-coverage-command";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import type { FollowupCoverageCommand } from "../../lib/ortho-followup-coverage";
import { followupCoverageJournal } from "../../lib/ortho-followup-coverage-recovery";
const GRANTS={"finance.agreements.manage":true,"finance.patient-ledger.view":true,"finance.invoices.view":true,"clinical.plans.view":true,"clinical.ortho.view":true};
const ACCOUNTS={
 owner:{username:"canon-ceditor-owner",password:"Canon#AppendOwner1",role:"admin",display:"مالك تجريبي"},
 own:{username:"canon-ceditor-own",password:"Canon#AppendOwn1",role:"doctor",doctor:true,display:"طبيب تجريبي",patientScope:"own",grants:GRANTS},
 all:{username:"canon-ceditor-all",password:"Canon#AppendAll1",role:"reception",display:"مفوّض تجريبي",patientScope:"all",grants:GRANTS},
 none:{username:"canon-ceditor-none",password:"Canon#AppendNone1",role:"admin",display:"بلا نطاق",patientScope:"none",grants:GRANTS},
 read:{username:"canon-ceditor-read",password:"Canon#AppendRead1",role:"admin",display:"قارئ تجريبي",patientScope:"all",grants:{"clinical.ortho.view":true}},
}as const;
let journey:CanonicalJourney<keyof typeof ACCOUNTS>,patientId:number,caseId:number,command:FollowupCoverageCommand,sequence=0;
const SECRET="canonical-coverage-editor-0123456789abcdef";
let previousSecret:string|undefined;
beforeAll(async()=>{
 previousSecret=process.env.SESSION_SECRET;process.env.SESSION_SECRET=SECRET;
 journey=await openCanonicalJourney({portOffset:99,secret:SECRET,accounts:ACCOUNTS,ownerKey:"owner",async seed(pool){
  const historical=(await loadMigrationFiles()).find(file=>file.version==="0079");
  if(!historical)throw new Error("Synthetic historical 0079 source missing");
  await applyRuntimeMigrationFiles(pool,[historical]);
  expect((await pool.query("SELECT version,name,checksum,adopted FROM schema_migrations WHERE version='0079'")).rows).toEqual([{version:historical.version,name:historical.name,checksum:historical.checksum,adopted:false}]);
 }});
},300000);
beforeEach(async()=>{
 patientId=(await journey.db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'مريض تجريبي',$2) RETURNING id",["SYN-CAPPEND-"+(++sequence),journey.parties.own])).rows[0].id;
 const seeded=await seedCanonicalCoverage(journey.db,{patientId,actorId:journey.ids.own,doctorId:journey.parties.own!,save:false});caseId=seeded.ortho;await journey.db.query("UPDATE ortho_cases SET status='active' WHERE id=$1",[caseId]);
 const {fingerprint,invoiceNumber:_invoice,serviceName:_service,...source}=seeded.source;
 command={schemaVersion:1,commandId:randomUUID(),expectedRevisionId:null,source,expectedSourceFingerprint:fingerprint,scope:"routine_adjustments",decision:"included",reason:"SYN explicit synthetic coverage"};
});
afterAll(async()=>{try{await journey?.close();}finally{if(previousSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=previousSecret;}},60000);
const path=()=>`/api/ortho/${caseId}/followup-coverage?patientId=${patientId}`;
it("HTTP: explicitly admitted historical source context stays read-only and separate from the minimal saved-decision read",async()=>{
 const cookie=(await journey.login("own")).cookie;expect((await journey.api(path(),cookie)).status).toBe(200);const response=await journey.api(path()+"&edit=1",cookie);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({projection:"ortho-followup-coverage-editor",canEdit:false,sources:[{patientId,orthoCaseId:caseId}]});
});
const editPath=()=>path()+"&edit=1";
const facts=async()=>(await journey.db.query("SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoice_items i) lines,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) payments,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM treatment_plans p) plans,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM plan_items p) items")).rows;
const counts=async()=>(await journey.db.query("SELECT (SELECT count(*)::int FROM ortho_followup_coverage_revisions WHERE ortho_case_id=$1) revisions,(SELECT count(*)::int FROM ortho_followup_coverage_rejections WHERE ortho_case_id=$1) rejections,(SELECT count(*)::int FROM audit_log WHERE entity='ortho_case' AND entity_id=$1::text AND action='ortho.followup_coverage.append') audits",[caseId])).rows[0];
it.each(["finance.invoices.view","clinical.plans.view","clinical.ortho.view"]as const)("HTTP: editor source %s is independent; minimal decision reading survives",async grant=>{
 const original=(await journey.db.query("SELECT permissions FROM users WHERE id=$1",[journey.ids.all])).rows[0].permissions,stale=(await journey.login("all")).cookie;
 try{await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),ARRAY['grants',$1],'false')::text WHERE id=$2",[grant,journey.ids.all]);expect((await journey.api(editPath(),stale)).status).toBe(401);const cookie=(await journey.login("all")).cookie;expect((await journey.api(editPath(),cookie)).status).toBe(403);expect((await journey.api(path(),cookie)).status).toBe(200);expect(await counts()).toEqual({revisions:0,rejections:0,audits:0});}finally{await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2",[original,journey.ids.all]);}
});
it("HTTP: genuine historical decision stays readable while new authoring is retired",async()=>{
 const login=await journey.login("own");expect(login.status).toBe(200);
 const session=readVerifiedDurableSession(decodeURIComponent(login.cookie.slice(login.cookie.indexOf("=")+1)));
 if(!session)throw new Error("Synthetic durable login unavailable");
 const authored=await historicAuthor(session,patientId,caseId,command,journey.db);
 expect(authored).toMatchObject({ok:true,replayed:false,revision:{commandId:command.commandId,decision:"included",createdBy:ACCOUNTS.own.username}});
 const before=await facts(),beforeCounts=await counts();expect(beforeCounts).toEqual({revisions:1,rejections:0,audits:1});
 const editor=await journey.api(editPath(),login.cookie);expect(editor.status).toBe(200);
 const view=await editor.json();expect(view).toMatchObject({projection:"ortho-followup-coverage-editor",enabled:true,canEdit:false,current:{id:authored.revision.id,decision:"included"},sources:[{patientId,orthoCaseId:caseId}]});
 expect(view.current).not.toHaveProperty("commandId");expect(JSON.stringify(view)).not.toMatch(/250000|source_snapshot|request_fingerprint/);
 const fresh={...command,commandId:randomUUID(),expectedRevisionId:authored.revision.id,decision:"excluded"};
 const blocked=await journey.api(path(),login.cookie,{method:"POST",body:JSON.stringify(fresh)});expect(blocked.status).toBe(409);expect(await blocked.json()).toMatchObject({code:"coverage_authoring_retired"});
 const status=await journey.api(path(),login.cookie,{method:"PUT",body:JSON.stringify(fresh)});expect(status.status).toBe(200);expect(await status.json()).toEqual({state:"unresolved"});
 expect(await facts()).toEqual(before);expect(await counts()).toEqual(beforeCounts);expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: explicit source context rejects unknown/duplicate queries, command query widening and out-of-scope patients",async()=>{
 const cookie=(await journey.login("own")).cookie;for(const suffix of["&edit=0","&edit=1&edit=1","&edit=1&force=1"])expect((await journey.api(path()+suffix,cookie)).status).toBe(400);for(const method of["POST","PUT"])expect((await journey.api(editPath(),cookie,{method,body:JSON.stringify(command)})).status).toBe(400);await journey.db.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[patientId]);expect((await journey.api(editPath(),cookie)).status).toBe(404);expect(await counts()).toEqual({revisions:0,rejections:0,audits:0});
});
const region=(page:import("playwright").Page)=>page.getByRole("region",{name:"نطاق المتابعات الروتينية للتقويم",exact:true});
async function navigate(page:import("playwright").Page,key:keyof typeof ACCOUNTS="own",login=true){if(login)await journey.browserLogin(page,key);await page.goto(`${journey.baseUrl}/patients/${patientId}`);await page.getByRole("button",{name:"عرض حالات التقويم",exact:true}).click();await page.getByRole("button",{name:"عرض تفاصيل الحالة",exact:true}).click();await region(page).waitFor();}
async function open(page:import("playwright").Page,key:keyof typeof ACCOUNTS="own",login=true){await navigate(page,key,login);await region(page).getByRole("button",{name:/^نطاق المتابعات الروتينية ضمن الاتفاق/}).click();await region(page).getByText("السجل للقراءة والتحقق من الطلبات السابقة؛ تسجيل قرارات جديدة متوقف.",{exact:true}).waitFor();}
it.each(["committed","unresolved"] as const)("browser: retained %s command uses only exact status and honors the historical result",async state=>{
 const login=await journey.login("own");expect(login.status).toBe(200);
 const session=readVerifiedDurableSession(decodeURIComponent(login.cookie.slice(login.cookie.indexOf("=")+1)));
 if(!session)throw new Error("Synthetic durable login unavailable");
 if(state==="committed")expect(await historicAuthor(session,patientId,caseId,command,journey.db)).toMatchObject({ok:true,replayed:false});
 // Compile and authenticate the real reads before the interactive journey; no
 // timeout or response is altered by this synthetic dev warm-up.
 for(const p of [`/api/ortho?patientId=${patientId}`,`/api/ortho/${caseId}`,`${path()}&edit=1`])expect((await journey.api(p,login.cookie)).status).toBe(200);
 const actor=ACCOUNTS.own.username,scope=JSON.stringify([actor,patientId]);
 const pending=followupCoverageJournal({actor,patientId,orthoCaseId:caseId,command});
 const context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"});
 const requests:{method:string;body:string|null}[]=[];
 try{
  const page=await context.newPage();page.on("request",r=>{if(r.url().includes(`/api/ortho/${caseId}/followup-coverage`)&&["POST","PUT"].includes(r.method()))requests.push({method:r.method(),body:r.postData()});});
  await journey.browserLogin(page,"own");
  await page.evaluate(async ({scope,pending})=>{
   const db=await new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open("aqlan-financial-command-recovery",1);req.onupgradeneeded=()=>req.result.createObjectStore("patient-commands",{keyPath:"scope"});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
   await new Promise<void>((resolve,reject)=>{const tx=db.transaction("patient-commands","readwrite");tx.objectStore("patient-commands").put({scope,revision:0,command:pending});tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});db.close();
  },{scope,pending});
  const readJournal=()=>page.evaluate(async scope=>{
   const db=await new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open("aqlan-financial-command-recovery",1);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
   const value=await new Promise<unknown>((resolve,reject)=>{const req=db.transaction("patient-commands","readonly").objectStore("patient-commands").get(scope);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});db.close();return value;
  },scope);
  const beforeJournal=await readJournal();expect(beforeJournal).toEqual({scope,revision:0,command:pending});
  const beforeFacts=await facts(),beforeCounts=await counts();
  const history=async()=>(await journey.db.query("SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ortho_followup_coverage_revisions r) revisions,(SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM ortho_followup_coverage_rejections r) rejections,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a WHERE action='ortho.followup_coverage.append') audits")).rows;
  const beforeHistory=await history();
  await navigate(page,"own",false);const panel=region(page);
  const check=panel.getByRole("button",{name:"تحقق من نتيجة الطلب نفسه",exact:true});await check.waitFor();
  await panel.getByText("السجل للقراءة والتحقق من الطلبات السابقة؛ تسجيل قرارات جديدة متوقف.",{exact:true}).waitFor();
  expect(await panel.getByRole("button",{name:"اعتماد نطاق المتابعات القادمة",exact:true}).count()).toBe(0);
  const reply=page.waitForResponse(r=>r.request().method()==="PUT"&&r.url().includes(`/api/ortho/${caseId}/followup-coverage`));
  await check.click();const response=await reply;expect(response.status()).toBe(200);expect(await response.json()).toMatchObject({state});
  if(state==="unresolved"){
   await panel.getByText(/لم تُحسم نتيجة الحفظ/).waitFor();expect(await readJournal()).toEqual(beforeJournal);
  }else{
   const hash=createHash("sha256").update(pending.original).digest("hex");
   await expect.poll(readJournal).toEqual({scope,revision:1,command:null,acknowledged:{key:command.commandId,kind:"ortho-followup-coverage",originalHash:hash}});
  }
  expect(requests).toEqual([{method:"PUT",body:JSON.stringify(command)}]);
  expect(await facts()).toEqual(beforeFacts);expect(await counts()).toEqual(beforeCounts);expect(await history()).toEqual(beforeHistory);expect(await journey.ddlLog()).toEqual([]);
 }finally{await context.close();}
},180000);
/*
 * Governance candidate (2026-11-19): 0079 authoring is retired, so the nine
 * former browser cases that drove the authoring form (source/decision choice,
 * lost POST, cross-tab arbitration, unavailable storage, source cancellation,
 * grant-withdrawal draft, periodic refresh, changed source) no longer have a
 * product surface. They are replaced by read-only witnesses of the retired
 * contract below; the HTTP refusal (`coverage_authoring_retired`) and the two
 * exact-status journal witnesses above keep the recovery guarantees. See
 * docs/review/governance-candidate-separation-20261119.md.
 */
const readOnlyWitness=async(key:"owner"|"own",withHistory:boolean)=>{
 if(withHistory){
  const login=await journey.login("own");expect(login.status).toBe(200);
  const session=readVerifiedDurableSession(decodeURIComponent(login.cookie.slice(login.cookie.indexOf("=")+1)));
  if(!session)throw new Error("Synthetic durable login unavailable");
  expect(await historicAuthor(session,patientId,caseId,command,journey.db)).toMatchObject({ok:true,replayed:false});
 }
 const before=await facts(),beforeCounts=await counts();
 const context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"});let writes=0;
 try{
  const page=await context.newPage();page.on("request",r=>{if(r.url().includes("/followup-coverage")&&["POST","PUT","PATCH","DELETE"].includes(r.method()))writes++;});
  await open(page,key);const r=region(page);
  if(withHistory)await r.getByText(/^آخر قرار: مشمولة · المراجعة 1/).waitFor();
  else await r.getByText("لم يُسجل نطاق صريح للمتابعات بعد.",{exact:true}).waitFor();
  expect(await r.getByLabel("مصدر تغطية المتابعات",{exact:true}).count()).toBe(0);
  expect(await r.getByLabel("قرار نطاق المتابعات",{exact:true}).count()).toBe(0);
  expect(await r.getByRole("button",{name:"اعتماد نطاق المتابعات القادمة",exact:true}).count()).toBe(0);
  expect(writes).toBe(0);expect(await facts()).toEqual(before);expect(await counts()).toEqual(beforeCounts);expect(await journey.ddlLog()).toEqual([]);
 }finally{await context.close();}
};
it.each(["owner","own"]as const)("browser: %s sees the retired editor read-only at 390px, with no authoring control or write",async key=>{await readOnlyWitness(key,false);},180000);
it("browser: a historical decision stays visible read-only and cannot be re-authored from the editor",async()=>{await readOnlyWitness("own",true);},180000);
