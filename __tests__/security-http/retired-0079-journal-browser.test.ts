import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_synthetic-dev-journey-harness";
import { parseFollowupCoverageCommand } from "../../lib/ortho-followup-coverage";
import { followupCoverageJournal } from "../../lib/ortho-followup-coverage-recovery";

const accounts={owner:{username:"synthetic-journal-owner",password:"Synthetic#Owner123",role:"admin",display:"مالك تجريبي"},
 own:{username:"synthetic-journal-doctor",password:"Synthetic#Doctor123",role:"doctor",doctor:true,display:"طبيب تجريبي",patientScope:"own",grants:{"finance.agreements.manage":true,"finance.patient-ledger.view":true,"finance.invoices.view":true,"clinical.plans.view":true,"clinical.ortho.view":true}}} as const;
let journey:CanonicalJourney<keyof typeof accounts>;
beforeAll(async()=>{journey=await openCanonicalJourney({portOffset:361,secret:"synthetic-browser-journal-secret-only-0123456789",accounts,ownerKey:"owner"});},300000);
afterAll(async()=>{await journey?.close();},60000);
it("real browser preserves old command and sends only exact status read on fresh database with 503",async()=>{
 const db=journey.db;
 const patientId=(await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-JOURNAL-BROWSER','Synthetic Patient',$1) RETURNING id",[journey.parties.own])).rows[0].id;
 const caseId=(await db.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,$2,'active') RETURNING id",[patientId,accounts.own.username])).rows[0].id;
 expect((await db.query("SELECT to_regclass('public.ortho_followup_coverage_revisions') AS revisions,to_regclass('public.ortho_followup_coverage_rejections') AS rejections")).rows[0]).toEqual({revisions:null,rejections:null});
 expect((await db.query("SELECT version FROM schema_migrations WHERE version='0079'")).rows).toEqual([]);
 const command=parseFollowupCoverageCommand({schemaVersion:1,commandId:randomUUID(),expectedRevisionId:null,
  source:{patientId,orthoCaseId:caseId,clinicalCaseId:101,planId:102,planItemId:103,invoiceId:104},expectedSourceFingerprint:"a".repeat(64),scope:"routine_adjustments",decision:"included",reason:"Synthetic retained command"});
 expect(command).not.toBeNull();
 const pending=followupCoverageJournal({actor:accounts.own.username,patientId,orthoCaseId:caseId,command:command!});
 const scope=JSON.stringify([accounts.own.username,patientId]);
 const snapshot=async()=>(await db.query("SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoice_items i) lines,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) payments,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM treatment_plans p) plans,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM plan_items p) items,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a) audit,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ortho_adjustments a) adjustments")).rows;
 const context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"});
 const calls:{method:string;body:string|null}[]=[];
 try{
  const page=await context.newPage();
  const diagnostic={pageErrors:[] as string[],failedRequests:[] as string[],badResponses:[] as {category:string;status:number}[],caseListResponses:[] as number[]};
  const routeCategory=(url:string)=>{const p=new URL(url).pathname;return p==="/api/ortho"?"case-list":p.startsWith("/_next/")?"next-asset":p.startsWith("/api/")?"api":p.startsWith("/patients/")?"patient-page":"other";};
  page.on("pageerror",e=>{
   const hints=["Module not found","Can't resolve","Cannot find module","Module build failed","Module parse failed","Unexpected token","Unexpected character","server-only","node:fs","node:crypto","node:child_process","UnhandledSchemeError","@electric-sql/pglite","node_modules/pg","out of memory","ENOENT","SyntaxError","Export ","is not exported","is not a function","not valid JavaScript","Error evaluating Node.js code"].filter(hint=>e.message.toLowerCase().includes(hint.toLowerCase()));
   diagnostic.pageErrors.push(JSON.stringify({name:e.name,hints}));
  });
  page.on("requestfailed",r=>diagnostic.failedRequests.push(routeCategory(r.url())+":"+(/ERR_ABORTED/.test(r.failure()?.errorText??"")?"aborted":"other")));
  page.on("response",r=>{const category=routeCategory(r.url());if(category==="case-list")diagnostic.caseListResponses.push(r.status());if(r.status()>=400)diagnostic.badResponses.push({category,status:r.status()});});
  page.on("request",r=>{if(r.url().includes(`/api/ortho/${caseId}/followup-coverage`) && ["PUT","POST"].includes(r.method()))calls.push({method:r.method(),body:r.postData()});});
  const warmLogin=await journey.login("own");expect(warmLogin.status).toBe(200);
  const warmList=await journey.api(`/api/ortho?patientId=${patientId}`,warmLogin.cookie);
  const warmDetail=await journey.api(`/api/ortho/${caseId}`,warmLogin.cookie);
  console.log("SYNTHETIC_ROUTE_WARMUP",JSON.stringify({caseListStatus:warmList.status,caseDetailStatus:warmDetail.status}));
  expect(warmList.status).toBe(200);expect(warmDetail.status).toBe(200);
  const warmListShape=await warmList.json();expect(warmListShape.cases.some((item:{id:number})=>item.id===caseId)).toBe(true);
  await journey.browserLogin(page,"own");
  await page.evaluate(async ({scope,pending})=>{const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open("aqlan-financial-command-recovery",1);request.onupgradeneeded=()=>request.result.createObjectStore("patient-commands",{keyPath:"scope"});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});await new Promise<void>((resolve,reject)=>{const tx=db.transaction("patient-commands","readwrite");tx.objectStore("patient-commands").put({scope,revision:0,command:pending});tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});db.close();},{scope,pending});
  const read=()=>page.evaluate(async scope=>{const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open("aqlan-financial-command-recovery",1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const result=await new Promise<unknown>((resolve,reject)=>{const tx=db.transaction("patient-commands","readonly");const r=tx.objectStore("patient-commands").get(scope);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();return result;},scope);
  const initial=await read();expect(initial).toEqual({scope,revision:0,command:pending});
  const navigation=await page.goto(`${journey.baseUrl}/patients/${patientId}`);
  try { await page.getByRole("button",{name:"عرض حالات التقويم",exact:true}).click({timeout:30000}); } catch (error) {
   const dom=await page.evaluate(()=>({readyState:document.readyState,bodyChildren:document.body.children.length,bodyTextLength:document.body.innerText.length,scriptCount:document.scripts.length,htmlLength:document.documentElement.outerHTML.length,hasNextError:!!document.querySelector("nextjs-portal"),visibility:document.visibilityState}));
   console.log("SYNTHETIC_BROWSER_DIAGNOSTIC",JSON.stringify({navigationStatus:navigation?.status(),diagnostic,dom}));throw error;
  }
  const details=page.getByRole("button",{name:"عرض تفاصيل الحالة",exact:true});
  try { await details.waitFor({timeout:12000}); } catch {
   console.log("SYNTHETIC_CASE_LIST_FIRST_WAIT_FAILED",JSON.stringify(diagnostic));
   await page.getByRole("button",{name:"تحديث الحالات",exact:true}).click();
  }
  try { await details.click({timeout:30000}); } catch (error) {
   const dom=await page.evaluate(()=>({bodyTextLength:document.body.innerText.length,alerts:document.querySelectorAll('[role="alert"]').length,caseLists:document.querySelectorAll('[data-testid="canonical-ortho-cases"]').length,listItems:document.querySelectorAll('[data-testid="canonical-ortho-cases"] li').length}));
   console.log("SYNTHETIC_CASE_LIST_DIAGNOSTIC",JSON.stringify({diagnostic,dom}));throw error;
  }
  const region=page.getByRole("region",{name:"نطاق المتابعات الروتينية للتقويم",exact:true});
  const verify=region.getByRole("button",{name:"تحقق من نتيجة الطلب نفسه",exact:true});await verify.waitFor();
  const before=await snapshot();
  const response=page.waitForResponse(r=>r.request().method()==="PUT"&&r.url().includes(`/api/ortho/${caseId}/followup-coverage`));
  await verify.click();const result=await response;expect(result.status()).toBe(503);expect(await result.json()).toMatchObject({code:"coverage_not_ready"});
  await region.getByText(/لم تُحسم نتيجة الحفظ/).waitFor();
  expect(calls).toEqual([{method:"PUT",body:JSON.stringify(command)}]);
  expect(await read()).toEqual(initial);expect(await snapshot()).toEqual(before);expect(await journey.ddlLog()).toEqual([]);
  expect(await region.getByText(/سُجل نطاق المتابعات القادمة/).count()).toBe(0);
  expect(await verify.isEnabled()).toBe(true);
 }finally{await context.close();}
},180000);

it("isolated real React panel/IndexedDB: real 503 preserves original journal and never acknowledges",async()=>{
 const db=journey.db;
 const patientId=(await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-PANEL-0079','Synthetic Patient',$1) RETURNING id",[journey.parties.own])).rows[0].id;
 const caseId=(await db.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,$2,'active') RETURNING id",[patientId,accounts.own.username])).rows[0].id;
 expect((await db.query("SELECT to_regclass('public.ortho_followup_coverage_revisions') AS revisions,to_regclass('public.ortho_followup_coverage_rejections') AS rejections")).rows[0]).toEqual({revisions:null,rejections:null});
 expect((await db.query("SELECT version FROM schema_migrations WHERE version='0079'")).rows).toEqual([]);
 const command=parseFollowupCoverageCommand({schemaVersion:1,commandId:randomUUID(),expectedRevisionId:null,source:{patientId,orthoCaseId:caseId,clinicalCaseId:101,planId:102,planItemId:103,invoiceId:104},expectedSourceFingerprint:"a".repeat(64),scope:"routine_adjustments",decision:"included",reason:"Synthetic retained command"});
 expect(command).not.toBeNull();
 const attempt={actor:accounts.own.username,patientId,orthoCaseId:caseId,command:command!};
 const original=followupCoverageJournal(attempt);
 const journalPath=JSON.stringify(resolve("lib/financial-command-journal.ts"));
 const built=await build({plugins:[{name:"observe-real-journal-ack",setup(builder){
  builder.onResolve({filter:/^@\/lib\/financial-command-journal$/},()=>({path:"journal-observer",namespace:"synthetic-journal"}));
  builder.onLoad({filter:/.*/,namespace:"synthetic-journal"},()=>({loader:"js",resolveDir:process.cwd(),contents:`export * from ${journalPath}; import { acknowledgeFinancialCommand as actual } from ${journalPath}; export function acknowledgeFinancialCommand(...args) { window.dispatchEvent(new Event("synthetic-coverage-acknowledgment")); return actual(...args); }`}));
 }}],entryPoints:["__tests__/fixtures/retired-0079-browser-panel.tsx"],bundle:true,write:false,platform:"browser",format:"iife",jsx:"automatic",tsconfig:"tsconfig.json",metafile:true,define:{"process.env.NODE_ENV":JSON.stringify("development")}});
 for(const name of ["components/OrthoFollowupCoveragePanel.tsx","lib/financial-command-journal.ts"])expect(Object.keys(built.metafile!.inputs)).toContain(name);
 const auth=await journey.login("own");expect(auth.status).toBe(200);
 const context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar",serviceWorkers:"block"});
 const calls:{method:string;body:string|null}[]=[],errors:string[]=[];
 try{
  const [name,...value]=auth.cookie.split("=");await context.addCookies([{name,value:value.join("="),url:journey.baseUrl}]);
  await context.route("**/__synthetic_retired_0079__/**",route=>{const url=new URL(route.request().url());if(url.pathname.endsWith("fixture.js"))return route.fulfill({contentType:"text/javascript",body:built.outputFiles[0].text});return route.fulfill({contentType:"text/html",body:`<!doctype html><html><body><div id="root"></div><script>window.__retired0079Attempt=${JSON.stringify(attempt)}</script><script src="/__synthetic_retired_0079__/fixture.js"></script></body></html>`});});
  const page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(r.url().includes(`/api/ortho/${caseId}/followup-coverage`)&&["PUT","POST"].includes(r.method()))calls.push({method:r.method(),body:r.postData()});});
  const facts=async()=>(await db.query("SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoice_items i) lines,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) payments,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM treatment_plans p) plans,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM plan_items p) items,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a) audit,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ortho_adjustments a) adjustments")).rows;
  await page.goto(`${journey.baseUrl}/__synthetic_retired_0079__/`);
  const region=page.getByRole("region",{name:"نطاق المتابعات الروتينية للتقويم",exact:true});
  const verify=region.getByRole("button",{name:"تحقق من نتيجة الطلب نفسه",exact:true});await verify.waitFor();
  const beforeJournal=await page.evaluate(()=>window.__retired0079.journal());expect(beforeJournal).toEqual({revision:0,command:original});const beforeFacts=await facts();
  const response=page.waitForResponse(r=>r.request().method()==="PUT"&&r.url().includes(`/api/ortho/${caseId}/followup-coverage`));await verify.click();const result=await response;expect(result.status()).toBe(503);expect(await result.json()).toMatchObject({code:"coverage_not_ready"});
  await region.getByText(/لم تُحسم نتيجة الحفظ/).waitFor();expect(await page.evaluate(()=>window.__retired0079.journal())).toEqual(beforeJournal);
  expect(await page.evaluate(()=>({saved:window.__retired0079.saved,acknowledgments:window.__retired0079.acknowledgments}))).toEqual({saved:0,acknowledgments:0});
  expect(calls).toEqual([{method:"PUT",body:JSON.stringify(command)}]);expect(await facts()).toEqual(beforeFacts);expect(await journey.ddlLog()).toEqual([]);expect(errors).toEqual([]);
 }finally{await context.close();}
},180000);
