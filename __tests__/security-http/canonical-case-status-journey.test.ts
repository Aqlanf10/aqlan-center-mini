import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { seedCanonicalPatientCases } from "../fixtures/canonical-patient-cases";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const EDIT = { "clinical.plans.view": true, "clinical.plans.edit": true };
const ACCOUNTS = {
  owner: { username: "canon-case-status-owner", password: "Canon#CaseStatusOwner1", role: "admin", display: "مالك تجريبي" },
  own: { username: "canon-case-status-own", password: "Canon#CaseStatusOwn1", role: "doctor", doctor: true, display: "طبيب تجريبي", patientScope: "own", grants: EDIT },
  all: { username: "canon-case-status-all", password: "Canon#CaseStatusAll1", role: "reception", display: "محرر تجريبي", patientScope: "all", grants: EDIT },
  read: { username: "canon-case-status-read", password: "Canon#CaseStatusRead1", role: "admin", display: "قارئ تجريبي", patientScope: "all", grants: { "clinical.plans.view": true } },
  none: { username: "canon-case-status-none", password: "Canon#CaseStatusNone1", role: "doctor", doctor: true, display: "بلا نطاق", patientScope: "none", grants: EDIT },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
const ids = { patient: 0, caseId: 0, outside: 0 }; let seq=0;
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 60, secret: "canonical-case-status-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed(q, _users, parties) {
    ids.patient = Number((await q.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-CASE-STATUS','SYN case status patient',$1) RETURNING id", [parties.own])).rows[0].id);
    Object.assign(ids, await seedCanonicalPatientCases(q, ids.patient, parties.own));
    const other=Number((await q.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-CASE-STATUS-OUT','SYN outside status patient') RETURNING id")).rows[0].id);
    ids.outside=(await seedCanonicalPatientCases(q,other)).caseId;
  } });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
beforeEach(async()=>{
  ids.caseId=Number((await journey.db.query("INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES($1,'general',$2,'SYN') RETURNING id",[ids.patient,`SYN status case ${++seq}`])).rows[0].id);
});
const readCase=async(cookie:string)=>{const read=await journey.api(`/api/patients/${ids.patient}/cases`,cookie);expect(read.status).toBe(200);return (await read.json()).cases.find((c:{id:number})=>c.id===ids.caseId);};
const patch=(cookie:string,version:string,status="waiting",outcome:string|null=null,id=ids.caseId)=>journey.api(`/api/cases/${id}`,cookie,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status,outcome,expectedVersion:version})});
const auditCount=async()=>Number((await journey.db.query("SELECT count(*)::int n FROM audit_log WHERE action='case.status' AND entity_id=$1",[String(ids.patient)])).rows[0].n);
it("HTTP: a scoped canonical editor changes a general clinical case state without legacy authority", async () => {
  const session = await journey.login("own"); expect(session.status).toBe(200);
  const read = await journey.api(`/api/patients/${ids.patient}/cases`,session.cookie); expect(read.status).toBe(200);
  const row = (await read.json()).cases.find((c:{id:number})=>c.id===ids.caseId);
  expect(row.version).toMatch(/^[a-f0-9]{64}$/);
  const response = await patch(session.cookie,row.version);
  expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,caseId:ids.caseId,status:"waiting"});expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: exact grants and own/all/none scope apply independently of role",async()=>{
  const owner=(await journey.login("owner")).cookie,version=(await readCase(owner)).version,before=await auditCount();expect((await patch("",version)).status).toBe(401);
  for(const key of ["none","read"] as const)expect((await patch((await journey.login(key)).cookie,version)).status).toBe(403);
  const own=(await journey.login("own")).cookie,outside=await patch(own,version,"waiting",null,ids.outside),missing=await patch(own,version,"waiting",null,2147483647);expect(outside.status).toBe(404);expect(missing.status).toBe(404);expect(await outside.json()).toEqual(await missing.json());
  const all=(await journey.login("all")).cookie,response=await patch(all,version);expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toContain("no-store");expect(await auditCount()).toBe(before+1);
});
it("HTTP: exact input refuses actor, assignment, money and query injection",async()=>{
  const cookie=(await journey.login("own")).cookie,version=(await readCase(cookie)).version,before=await auditCount();
  for(const extra of [{actor:"owner"},{responsiblePartyId:1},{amount:1},{outcome:"a".repeat(2001)}]){
    const response=await journey.api(`/api/cases/${ids.caseId}`,cookie,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"waiting",outcome:null,expectedVersion:version,...extra})});expect(response.status).toBe(400);
  }
  const query=await journey.api(`/api/cases/${ids.caseId}?status=closed`,cookie,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"waiting",outcome:null,expectedVersion:version})});expect(query.status).toBe(400);expect(await auditCount()).toBe(before);
});
it("HTTP: a terminal case cannot reopen and an old version cannot replay after active→waiting→active",async()=>{
  const cookie=(await journey.login("own")).cookie,old=(await readCase(cookie)).version;
  expect((await patch(cookie,old)).status).toBe(200);expect((await patch(cookie,(await readCase(cookie)).version,"active")).status).toBe(200);
  const stale=await patch(cookie,old,"closed","SYN stale result");expect(stale.status).toBe(409);expect((await stale.json()).code).toBe("case_status_conflict");
  expect((await patch(cookie,(await readCase(cookie)).version,"cancelled",null)).status).toBe(400);expect((await patch(cookie,(await readCase(cookie)).version,"completed","SYN final result")).status).toBe(200);
  const terminal=await patch(cookie,(await readCase(cookie)).version,"active");expect(terminal.status).toBe(409);expect((await terminal.json()).code).toBe("case_status_transition");
});
async function openEditor(page:import("playwright").Page,key:keyof typeof ACCOUNTS="own"){
  page.setDefaultTimeout(10000);await journey.browserLogin(page,key);await page.goto(`${journey.baseUrl}/patients/${ids.patient}`);await page.getByRole("button",{name:"عرض الحالات وترتيب الخطة",exact:true}).click();const panel=page.getByTestId("canonical-patient-cases");await panel.getByText("SYN root case",{exact:true}).first().waitFor();const editor=page.getByTestId("canonical-case-status-editor");await editor.getByRole("button",{name:"تغيير حالة العلاج",exact:true}).click();await editor.getByLabel("الحالة المراد تحديثها",{exact:true}).selectOption(String(ids.caseId));return{panel,editor};
}
it("browser: 390px clinical state form preserves cancellation reasons and terminal non-reopening",async()=>{
  const context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"});try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();
    await editor.getByLabel("الحالة الجديدة للعلاج",{exact:true}).selectOption("cancelled");await editor.getByRole("button",{name:"حفظ حالة العلاج",exact:true}).click();await editor.getByText("اختر انتقالًا متاحًا، واكتب سببًا عند الإلغاء.",{exact:true}).waitFor();expect(await auditCount()).toBe(before);
    await editor.getByLabel("نتيجة العلاج أو سبب الإلغاء",{exact:true}).fill("SYN clinical cancellation reason");if(process.env.HR_EVIDENCE_DIR){mkdirSync(process.env.HR_EVIDENCE_DIR,{recursive:true});await editor.screenshot({path:join(process.env.HR_EVIDENCE_DIR,"case-status-editor-390.png")});}
    await editor.getByRole("button",{name:"حفظ حالة العلاج",exact:true}).click();await editor.getByText("حُفظت حالة العلاج ونتيجتها وسُجّل الأثر.",{exact:true}).waitFor();await editor.getByRole("button",{name:"تغيير حالة العلاج",exact:true}).click();expect(await editor.locator(`option[value="${ids.caseId}"]`).count()).toBe(0);
    expect((await journey.db.query("SELECT status,outcome FROM clinical_cases WHERE id=$1",[ids.caseId])).rows[0]).toEqual({status:"cancelled",outcome:"SYN clinical cancellation reason"});expect(await auditCount()).toBe(before+1);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(await journey.ddlLog()).toEqual([]);
  }finally{await context.close();}
});
it("browser: a plan reader has no clinical state writer",async()=>{
  const context=await journey.browser.newContext();try{const page=await context.newPage();await journey.browserLogin(page,"read");await page.goto(`${journey.baseUrl}/patients/${ids.patient}`);await page.getByRole("button",{name:"عرض الحالات وترتيب الخطة",exact:true}).click();await page.getByTestId("canonical-patient-cases").getByText("SYN root case",{exact:true}).first().waitFor();expect(await page.getByTestId("canonical-case-status-editor").count()).toBe(0);}finally{await context.close();}
});
it("browser: a committed transition with a lost response cannot replay after reload",async()=>{
  const context=await journey.browser.newContext();try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();let count=0,first=true;
    await editor.getByLabel("نتيجة العلاج أو سبب الإلغاء",{exact:true}).fill("SYN private outcome not stored in browser marker");await page.route(`**/api/cases/${ids.caseId}`,async route=>{count++;if(!first){await route.continue();return;}first=false;const response=await route.fetch();expect(response.status()).toBe(200);await route.abort("failed");});
    await editor.getByRole("button",{name:"حفظ حالة العلاج",exact:true}).click();await editor.getByText("طلب تغيير حالة سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();expect(await page.evaluate(()=>JSON.stringify(sessionStorage))).not.toContain("SYN private outcome");await page.reload();await page.getByRole("button",{name:"عرض الحالات وترتيب الخطة",exact:true}).click();const restored=page.getByTestId("canonical-case-status-editor");await restored.getByText("طلب تغيير حالة سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();
    await restored.getByRole("button",{name:"التحقق من حالة العلاج الحالية",exact:true}).click();await restored.getByRole("button",{name:"راجعت حالة العلاج، بدء تعديل جديد",exact:true}).waitFor();expect(count).toBe(1);expect(await auditCount()).toBe(before+1);
    await restored.getByRole("button",{name:"راجعت حالة العلاج، بدء تعديل جديد",exact:true}).click();await restored.getByLabel("الحالة المراد تحديثها",{exact:true}).selectOption(String(ids.caseId));await restored.getByLabel("الحالة الجديدة للعلاج",{exact:true}).selectOption("active");await restored.getByRole("button",{name:"حفظ حالة العلاج",exact:true}).click();await restored.getByText("حُفظت حالة العلاج ونتيجتها وسُجّل الأثر.",{exact:true}).waitFor();expect(count).toBe(2);expect(await auditCount()).toBe(before+2);
  }finally{await context.close();}
});
it("browser: another writer invalidates the selected clinical version",async()=>{
  const context=await journey.browser.newContext();try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();await journey.db.query("UPDATE clinical_cases SET outcome='SYN concurrent note' WHERE id=$1",[ids.caseId]);await editor.getByRole("button",{name:"حفظ حالة العلاج",exact:true}).click();await editor.getByText("تغيّرت الحالة أو تعذّر تثبيت سياقها. حدّث السجل وراجع النتيجة قبل طلب جديد.",{exact:true}).waitFor();expect(await auditCount()).toBe(before);expect((await journey.db.query("SELECT status,outcome FROM clinical_cases WHERE id=$1",[ids.caseId])).rows[0]).toEqual({status:"active",outcome:"SYN concurrent note"});}finally{await context.close();}
});
it("browser: revocation refuses mutation and clears the stale clinical facts",async()=>{
  const context=await journey.browser.newContext(),original=(await journey.db.query("SELECT permissions FROM users WHERE id=$1",[journey.ids.all])).rows[0].permissions;
  try{const page=await context.newPage(),{editor,panel}=await openEditor(page,"all"),before=await auditCount();await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.plans.edit}','false')::text WHERE id=$1",[journey.ids.all]);await editor.getByRole("button",{name:"حفظ حالة العلاج",exact:true}).click();await panel.getByRole("alert").waitFor();expect(await auditCount()).toBe(before);expect(await editor.locator("select,textarea").count()).toBe(0);expect(await panel.getByTestId("canonical-patient-case").count()).toBe(0);}finally{await context.close();await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2",[original,journey.ids.all]);}
});
it("browser: malformed success after commit stays uncertain",async()=>{
  const context=await journey.browser.newContext();try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();let count=0;await page.route(`**/api/cases/${ids.caseId}`,async route=>{count++;const response=await route.fetch();expect(response.status()).toBe(200);await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})});});await editor.getByRole("button",{name:"حفظ حالة العلاج",exact:true}).click();await editor.getByText("طلب تغيير حالة سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();expect(count).toBe(1);expect(await auditCount()).toBe(before+1);}finally{await context.close();}
});
it("browser: unavailable tab storage is disclosed and an uncertain mutation is held in memory",async()=>{
  const context=await journey.browser.newContext();try{await context.addInitScript(()=>{const get=Storage.prototype.getItem,set=Storage.prototype.setItem;Storage.prototype.getItem=function(key:string){if(key.startsWith("aqlan.case-status.pending:"))throw new DOMException("SYN unavailable","SecurityError");return get.call(this,key);};Storage.prototype.setItem=function(key:string,value:string){if(key.startsWith("aqlan.case-status.pending:"))throw new DOMException("SYN unavailable","SecurityError");return set.call(this,key,value);};});const page=await context.newPage(),{editor}=await openEditor(page);await editor.getByText(/الاستعادة بعد إعادة التحميل غير مضمونة/).waitFor();let count=0;await page.route(`**/api/cases/${ids.caseId}`,async route=>{count++;await route.abort("failed");});await editor.getByRole("button",{name:"حفظ حالة العلاج",exact:true}).click();await editor.getByText("طلب تغيير حالة سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();expect(count).toBe(1);}finally{await context.close();}
});
it("browser: closing a pending state editor preserves recovery and rejects its late response",async()=>{
  const context=await journey.browser.newContext();let release!:()=>void,reached!:()=>void,finished!:()=>void;const held=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{reached=r;}),done=new Promise<void>(r=>{finished=r;});
  try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();let count=0;await page.route(`**/api/cases/${ids.caseId}`,async route=>{count++;try{const response=await route.fetch();expect(response.status()).toBe(200);reached();await held;await route.fulfill({response}).catch(()=>undefined);}finally{finished();}});await editor.getByRole("button",{name:"حفظ حالة العلاج",exact:true}).click();await ready;await page.getByRole("button",{name:"إغلاق الحالات وترتيب الخطة",exact:true}).click();release();await done;expect(await page.getByTestId("canonical-case-status-editor").count()).toBe(0);await page.getByRole("button",{name:"عرض الحالات وترتيب الخطة",exact:true}).click();const restored=page.getByTestId("canonical-case-status-editor");await restored.getByText("طلب تغيير حالة سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();expect(await restored.locator("select,textarea").count()).toBe(0);expect(count).toBe(1);expect(await auditCount()).toBe(before+1);}finally{release();await context.close();}
});
