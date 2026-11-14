import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { seedCanonicalPatientCases } from "../fixtures/canonical-patient-cases";
const ACCOUNTS = {
  owner: { username: "canon-problem-status-owner", password: "Canon#ProblemStatusOwner1", role: "admin", display: "مالك تجريبي" },
  own: { username: "canon-problem-status-own", password: "Canon#ProblemStatusOwn1", role: "doctor", doctor: true, display: "طبيب تجريبي", patientScope: "own", grants: { "clinical.visits.document": true } },
  all: { username: "canon-problem-status-all", password: "Canon#ProblemStatusAll1", role: "reception", display: "موثق تجريبي", patientScope: "all", grants: { "clinical.visits.document": true } },
  plan: { username: "canon-problem-status-plan", password: "Canon#ProblemStatusPlan1", role: "admin", display: "محرر خطط", patientScope: "all", grants: { "clinical.plans.view": true, "clinical.plans.edit": true } },
  none: { username: "canon-problem-status-none", password: "Canon#ProblemStatusNone1", role: "doctor", doctor: true, display: "بلا نطاق", patientScope: "none", grants: { "clinical.visits.document": true } },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
const ids = { patient: 0, problemId: 0, outside: 0 }; let seq=0;
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 61, secret: "canonical-problem-status-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed(q, _users, parties) {
    ids.patient = Number((await q.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-PROBLEM-STATUS','SYN problem status patient',$1) RETURNING id", [parties.own])).rows[0].id);
    Object.assign(ids, await seedCanonicalPatientCases(q, ids.patient, parties.own));
    const other=Number((await q.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-PROBLEM-STATUS-OUT','SYN outside problem') RETURNING id")).rows[0].id);ids.outside=(await seedCanonicalPatientCases(q,other)).problemId;
  } });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
it("HTTP: a scoped documenter changes a clinical problem without legacy authority", async () => {
  const session = await journey.login("own"); expect(session.status).toBe(200);
  const read = await journey.api(`/api/patients/${ids.patient}/cases`,session.cookie); expect(read.status).toBe(200);
  const problem = (await read.json()).problems.find((p:{id:number})=>p.id===ids.problemId);
  const response=await journey.api(`/api/problems/${ids.problemId}`,session.cookie,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"resolved",expectedVersion:problem.version})});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,problemId:ids.problemId,status:"resolved"});expect(await journey.ddlLog()).toEqual([]);
});

beforeEach(async()=>{ids.problemId=Number((await journey.db.query("INSERT INTO patient_problems(patient_id,label,noted_by) VALUES($1,$2,'SYN') RETURNING id",[ids.patient,`SYN problem ${++seq}`])).rows[0].id);});
const readProblem=async(cookie:string)=>{const read=await journey.api(`/api/patients/${ids.patient}/cases`,cookie);expect(read.status).toBe(200);return(await read.json()).problems.find((p:{id:number})=>p.id===ids.problemId);};
const patch=(cookie:string,version:string,status="resolved",id=ids.problemId)=>journey.api(`/api/problems/${id}`,cookie,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status,expectedVersion:version})});
const auditCount=async()=>Number((await journey.db.query("SELECT count(*)::int n FROM audit_log WHERE action='problem.status' AND entity_id=$1",[String(ids.patient)])).rows[0].n);
it("HTTP: document capability is independent from role and plan edit, with own/all/none and indistinguishable outside",async()=>{
  const owner=(await journey.login("owner")).cookie,v=(await readProblem(owner)).version,before=await auditCount();expect((await patch("",v)).status).toBe(401);
  for(const key of ["plan","none"] as const)expect((await patch((await journey.login(key)).cookie,v)).status).toBe(403);
  const own=(await journey.login("own")).cookie,a=await patch(own,v,"resolved",ids.outside),b=await patch(own,v,"resolved",2147483647);expect(a.status).toBe(404);expect(b.status).toBe(404);expect(await a.json()).toEqual(await b.json());
  const response=await patch((await journey.login("all")).cookie,v);expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toContain("no-store");expect(await auditCount()).toBe(before+1);
});
it("HTTP: strict status-only input and stale ABA refuse without an extra audit",async()=>{
  const cookie=(await journey.login("own")).cookie,v=(await readProblem(cookie)).version,before=await auditCount();
  for(const extra of [{actor:"owner"},{caseId:1},{amount:1},{label:"changed"},{status:"closed"}])expect((await journey.api(`/api/problems/${ids.problemId}`,cookie,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"resolved",expectedVersion:v,...extra})})).status).toBe(400);
  expect((await journey.api(`/api/problems/${ids.problemId}?status=inactive`,cookie,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"resolved",expectedVersion:v})})).status).toBe(400);
  expect((await patch(cookie,v)).status).toBe(200);expect((await patch(cookie,(await readProblem(cookie)).version,"active")).status).toBe(200);expect((await patch(cookie,v,"inactive")).status).toBe(409);expect(await auditCount()).toBe(before+2);
});
async function openEditor(page:import("playwright").Page,key:keyof typeof ACCOUNTS="own"){
  page.setDefaultTimeout(10000);await journey.browserLogin(page,key);await page.goto(`${journey.baseUrl}/patients/${ids.patient}`);await page.getByRole("button",{name:"عرض الحالات وترتيب الخطة",exact:true}).click();const panel=page.getByTestId("canonical-patient-cases");await panel.getByText("SYN root case",{exact:true}).first().waitFor();const editor=page.getByTestId("canonical-problem-status-editor");await editor.getByRole("button",{name:"تغيير حالة المشكلة",exact:true}).click();await editor.getByLabel("المشكلة المراد تحديثها",{exact:true}).selectOption(String(ids.problemId));return{panel,editor};
}
it("browser: 390px documenter can resolve and reactivate without plan-edit controls",async()=>{
  const context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"});try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();expect(await page.getByTestId("canonical-case-status-editor").count()).toBe(0);expect(await page.getByTestId("canonical-plan-dependency-editor").count()).toBe(0);
    await editor.getByLabel("الحالة الجديدة للمشكلة",{exact:true}).selectOption("resolved");if(process.env.HR_EVIDENCE_DIR){mkdirSync(process.env.HR_EVIDENCE_DIR,{recursive:true});await editor.screenshot({path:join(process.env.HR_EVIDENCE_DIR,"problem-status-editor-390.png")});}
    await editor.getByRole("button",{name:"حفظ حالة المشكلة",exact:true}).click();await editor.getByText("حُفظت حالة المشكلة وسُجّل الأثر.",{exact:true}).waitFor();await editor.getByRole("button",{name:"تغيير حالة المشكلة",exact:true}).click();await editor.getByLabel("المشكلة المراد تحديثها",{exact:true}).selectOption(String(ids.problemId));await editor.getByLabel("الحالة الجديدة للمشكلة",{exact:true}).selectOption("active");await editor.getByRole("button",{name:"حفظ حالة المشكلة",exact:true}).click();await editor.getByText("حُفظت حالة المشكلة وسُجّل الأثر.",{exact:true}).waitFor();expect(await auditCount()).toBe(before+2);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(await journey.ddlLog()).toEqual([]);
  }finally{await context.close();}
});
it("browser: plan editor has no problem writer",async()=>{const context=await journey.browser.newContext();try{const page=await context.newPage();await journey.browserLogin(page,"plan");await page.goto(`${journey.baseUrl}/patients/${ids.patient}`);await page.getByRole("button",{name:"عرض الحالات وترتيب الخطة",exact:true}).click();await page.getByTestId("canonical-patient-cases").getByText("SYN root case",{exact:true}).first().waitFor();expect(await page.getByTestId("canonical-problem-status-editor").count()).toBe(0);}finally{await context.close();}});
it("browser: committed response loss and reload never replay the command",async()=>{
  const context=await journey.browser.newContext();try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();let sends=0,first=true;await page.route(`**/api/problems/${ids.problemId}`,async route=>{sends++;if(!first){await route.continue();return;}first=false;const response=await route.fetch();expect(response.status()).toBe(200);await route.abort("failed");});
    await editor.getByRole("button",{name:"حفظ حالة المشكلة",exact:true}).click();await editor.getByText("طلب تغيير حالة سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();expect(await page.evaluate(()=>JSON.stringify(sessionStorage))).not.toContain("SYN problem");await page.reload();await page.getByRole("button",{name:"عرض الحالات وترتيب الخطة",exact:true}).click();const restored=page.getByTestId("canonical-problem-status-editor");await restored.getByText("طلب تغيير حالة سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();expect(sends).toBe(1);expect(await auditCount()).toBe(before+1);
    await restored.getByRole("button",{name:"التحقق من حالة المشكلة الحالية",exact:true}).click();await restored.getByRole("button",{name:"راجعت حالة المشكلة، بدء تعديل جديد",exact:true}).click();await restored.getByLabel("المشكلة المراد تحديثها",{exact:true}).selectOption(String(ids.problemId));await restored.getByLabel("الحالة الجديدة للمشكلة",{exact:true}).selectOption("inactive");await restored.getByRole("button",{name:"حفظ حالة المشكلة",exact:true}).click();await restored.getByText("حُفظت حالة المشكلة وسُجّل الأثر.",{exact:true}).waitFor();expect(sends).toBe(2);expect(await auditCount()).toBe(before+2);
  }finally{await context.close();}
});
it("browser: another writer invalidates the selected clinical version",async()=>{
  const context=await journey.browser.newContext();try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();await journey.db.query("UPDATE patient_problems SET label='SYN concurrent note' WHERE id=$1",[ids.problemId]);await editor.getByRole("button",{name:"حفظ حالة المشكلة",exact:true}).click();await editor.getByText("تغيّرت المشكلة أو تعذّر تثبيت سياقها. حدّث السجل وراجع النتيجة قبل طلب جديد.",{exact:true}).waitFor();expect(await auditCount()).toBe(before);expect((await journey.db.query("SELECT status,label FROM patient_problems WHERE id=$1",[ids.problemId])).rows[0]).toEqual({status:"active",label:"SYN concurrent note"});}finally{await context.close();}
});
it("browser: revocation refuses mutation and clears the stale clinical facts",async()=>{
  const context=await journey.browser.newContext(),original=(await journey.db.query("SELECT permissions FROM users WHERE id=$1",[journey.ids.all])).rows[0].permissions;
  try{const page=await context.newPage(),{editor,panel}=await openEditor(page,"all"),before=await auditCount();await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.visits.document}','false')::text WHERE id=$1",[journey.ids.all]);await editor.getByRole("button",{name:"حفظ حالة المشكلة",exact:true}).click();await panel.getByRole("alert").waitFor();expect(await auditCount()).toBe(before);expect(await editor.locator("select,textarea").count()).toBe(0);expect(await panel.getByTestId("canonical-patient-case").count()).toBe(0);}finally{await context.close();await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2",[original,journey.ids.all]);}
});
it("browser: malformed success after commit stays uncertain",async()=>{
  const context=await journey.browser.newContext();try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();let count=0;await page.route(`**/api/problems/${ids.problemId}`,async route=>{count++;const response=await route.fetch();expect(response.status()).toBe(200);await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})});});await editor.getByRole("button",{name:"حفظ حالة المشكلة",exact:true}).click();await editor.getByText("طلب تغيير حالة سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();expect(count).toBe(1);expect(await auditCount()).toBe(before+1);}finally{await context.close();}
});
it("browser: unavailable tab storage is disclosed and an uncertain mutation is held in memory",async()=>{
  const context=await journey.browser.newContext();try{await context.addInitScript(()=>{const get=Storage.prototype.getItem,set=Storage.prototype.setItem;Storage.prototype.getItem=function(key:string){if(key.startsWith("aqlan.problem-status.pending:"))throw new DOMException("SYN unavailable","SecurityError");return get.call(this,key);};Storage.prototype.setItem=function(key:string,value:string){if(key.startsWith("aqlan.problem-status.pending:"))throw new DOMException("SYN unavailable","SecurityError");return set.call(this,key,value);};});const page=await context.newPage(),{editor}=await openEditor(page);await editor.getByText(/الاستعادة بعد إعادة التحميل غير مضمونة/).waitFor();let count=0;await page.route(`**/api/problems/${ids.problemId}`,async route=>{count++;await route.abort("failed");});await editor.getByRole("button",{name:"حفظ حالة المشكلة",exact:true}).click();await editor.getByText("طلب تغيير حالة سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();expect(count).toBe(1);}finally{await context.close();}
});
it("browser: closing a pending state editor preserves recovery and rejects its late response",async()=>{
  const context=await journey.browser.newContext();let release!:()=>void,reached!:()=>void,finished!:()=>void;const held=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{reached=r;}),done=new Promise<void>(r=>{finished=r;});
  try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();let count=0;await page.route(`**/api/problems/${ids.problemId}`,async route=>{count++;try{const response=await route.fetch();expect(response.status()).toBe(200);reached();await held;await route.fulfill({response}).catch(()=>undefined);}finally{finished();}});await editor.getByRole("button",{name:"حفظ حالة المشكلة",exact:true}).click();await ready;await page.getByRole("button",{name:"إغلاق الحالات وترتيب الخطة",exact:true}).click();release();await done;expect(await page.getByTestId("canonical-problem-status-editor").count()).toBe(0);await page.getByRole("button",{name:"عرض الحالات وترتيب الخطة",exact:true}).click();const restored=page.getByTestId("canonical-problem-status-editor");await restored.getByText("طلب تغيير حالة سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();expect(await restored.locator("select,textarea").count()).toBe(0);expect(count).toBe(1);expect(await auditCount()).toBe(before+1);}finally{release();await context.close();}
});
