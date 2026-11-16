/** Synthetic before/after witness for the existing immutable strategy command. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ACCOUNTS = {
  owner: { username: "canon-osw-owner", password: "Canon#OSWOwner1", role: "admin", display: "مالك اصطناعي" },
  doctor: { username: "canon-osw-doctor", password: "Canon#OSWDoctor1", role: "doctor", doctor: true, display: "طبيب اصطناعي", patientScope: "own", grants: { "clinical.ortho.view": true, "clinical.ortho.edit": true } },
  reader: { username: "canon-osw-reader", password: "Canon#OSWReader1", role: "admin", display: "قارئ اصطناعي", patientScope: "all", grants: { "clinical.ortho.view": true } },
  none: { username: "canon-osw-none", password: "Canon#OSWNone1", role: "doctor", doctor: true, display: "بلا نطاق", patientScope: "none", grants: { "clinical.ortho.view": true, "clinical.ortho.edit": true } },
  planView: { username: "canon-osw-planview", password: "Canon#OSWPlanView1", role: "reception", display: "قارئ خطط اصطناعي", patientScope: "all", grants: { "clinical.ortho.view": true, "clinical.ortho.edit": true, "clinical.plans.view": true } },
  planEdit: { username: "canon-osw-planedit", password: "Canon#OSWPlanEdit1", role: "reception", display: "محرر مخول اصطناعي", patientScope: "all", grants: { "clinical.ortho.view": true, "clinical.ortho.edit": true, "clinical.plans.view": true, "clinical.plans.edit": true } },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
let caseId = 0, problemId = 0, patientId = 0, outsideCase = 0, planItem = 0;
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 104, secret: "canonical-strategy-editor-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _accounts, parties) {
      const patient = (await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-OSW-1','مريض استراتيجية اصطناعي',$1) RETURNING id", [parties.doctor])).rows[0].id;
      patientId = patient;
      caseId = (await db.query("INSERT INTO ortho_cases(patient_id,status,created_by,responsible_doctor_id) VALUES($1,'active','SYN',$2) RETURNING id", [patient, parties.doctor])).rows[0].id;
      const bridge = (await db.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN explicit strategy bridge',$2,'SYN') RETURNING id", [patient, caseId])).rows[0].id;
      problemId = (await db.query("INSERT INTO patient_problems(patient_id,case_id,label,noted_by) VALUES($1,$2,'SYN recorded problem','SYN') RETURNING id", [patient, bridge])).rows[0].id;
      const foreign = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-OSW-FOREIGN','مريض خارجي اصطناعي') RETURNING id")).rows[0].id;
      outsideCase = (await db.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [foreign])).rows[0].id;
      const plan = (await db.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_by) VALUES($1,'SYN private funding',92387,'SYN') RETURNING id", [patient])).rows[0].id;
      planItem = (await db.query("INSERT INTO plan_items(plan_id,service_name,unit_price_minor,quantity,case_id) VALUES($1,'SYN saved service',92387,1,$2) RETURNING id", [plan, bridge])).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: explicit editor read supplies only scoped clinical choices", async () => {
  const session = await journey.login("doctor");
  const response = await journey.api(`/api/ortho/${caseId}/strategy?edit=1`, session.cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toMatchObject({ clinicalWritable: true, canRevise: true,
    planLinksWritable: false, choices: { problems: [{ id: problemId, label: "SYN recorded problem" }], planItems: [] } });
  expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: editor URL cannot bypass login, scope, edit or independent plan authority", async () => {
  const path=`/api/ortho/${caseId}/strategy?edit=1`;
  expect((await journey.api(path,"")).status).toBe(401);
  for(const key of ["reader","none"] as const){const session=await journey.login(key);const response=await journey.api(path,session.cookie);expect(response.status).toBe(403);expect(response.headers.get("cache-control")).toContain("no-store");}
  const own=await journey.login("doctor"),errors=[];
  for(const id of [outsideCase,2147483647]){const response=await journey.api(`/api/ortho/${id}/strategy?edit=1`,own.cookie);expect(response.status).toBe(404);errors.push(await response.json());}expect(errors[0]).toEqual(errors[1]);
  for(const query of ["edit=0","edit=true","edit=1&edit=1","edit=1&force=1"]){expect((await journey.api(`/api/ortho/${caseId}/strategy?${query}`,own.cookie)).status).toBe(400);}
  for(const key of ["planView","planEdit","owner"] as const){const session=await journey.login(key),response=await journey.api(path,session.cookie);expect(response.status).toBe(200);const data=await response.json();expect(data.choices.planItems.length).toBe(key==="planView"?0:1);if(key!=="planView")expect(data.choices.planItems[0].id).toBe(planItem);expect(JSON.stringify(data)).not.toMatch(/92387|private funding|unitPrice|invoice|balance/);}
});
async function openEditor(page:Page,key:keyof typeof ACCOUNTS="doctor"){
  await journey.browserLogin(page,key);await page.goto(`${journey.baseUrl}/patients/${patientId}`);
  await page.getByRole("button",{name:"عرض حالات التقويم",exact:true}).click();await page.getByRole("button",{name:"عرض تفاصيل الحالة",exact:true}).click();
  await page.getByRole("button",{name:"توثيق الاستراتيجية",exact:true}).click();
  const panel=page.getByTestId("canonical-ortho-strategy");await panel.getByTestId("ortho-strategy-editor").waitFor();return panel;
}
const saved=async()=> (await journey.db.query("SELECT id,version,rows,request_fingerprint,command_id FROM ortho_strategy_revisions WHERE ortho_case_id=$1 ORDER BY version",[caseId])).rows;
const financial=async()=> (await journey.db.query("SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM treatment_plans t) plans,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM plan_items i) items,(SELECT count(*) FROM invoices)::int invoices")).rows;
it("browser: empty explicit editor saves the existing native revision without invented clinical text or money",async()=>{
  const before=await financial(),context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"});
  try{const page=await context.newPage(),panel=await openEditor(page);await panel.getByRole("button",{name:"بدء خطة الحالة من نموذج فارغ",exact:true}).click();
    expect(await panel.getByLabel("الهدف (نص الطبيب)",{exact:true}).inputValue()).toBe("");expect(await panel.getByLabel("الاستراتيجية (نص الطبيب)",{exact:true}).inputValue()).toBe("");
    await panel.getByLabel("المشكلة",{exact:true}).selectOption(String(problemId));await panel.getByLabel("الهدف (نص الطبيب)",{exact:true}).fill("SYN clinician objective");await panel.getByLabel("الاستراتيجية (نص الطبيب)",{exact:true}).fill("SYN clinician strategy");await panel.getByLabel("سبب توثيق هذه النسخة (مطلوب)",{exact:true}).fill("SYN explicit editor first revision");
    expect(await panel.getByRole("button",{name:/إنشاء مشكلة|إضافة مشكلة/}).count()).toBe(0);
    await panel.getByRole("button",{name:"حفظ نسخة خطة الحالة",exact:true}).click();await panel.getByTestId("ortho-strategy-saved").getByText("SYN clinician strategy",{exact:true}).waitFor();
    expect(await panel.getByTestId("ortho-strategy-draft").count()).toBe(0);expect(await saved()).toHaveLength(1);expect(await financial()).toEqual(before);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    if(process.env.HR_EVIDENCE_DIR){mkdirSync(process.env.HR_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.HR_EVIDENCE_DIR,"canonical-strategy-editor-saved-390.png"),fullPage:true});}
  }finally{await context.close();}
});
it("browser: parent refresh preserves exact draft; lost committed reply permits only explicit identical receipt replay",async()=>{
  const context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"});
  try{const page=await context.newPage();let panel=await openEditor(page);await panel.getByRole("button",{name:"فتح مراجعة جديدة من النسخة الحالية",exact:true}).click();await panel.getByLabel("سبب توثيق هذه النسخة (مطلوب)").fill("SYN frozen strategy refresh");
    await page.getByRole("button",{name:"تحديث الحالات",exact:true}).click();await page.getByRole("button",{name:"عرض تفاصيل الحالة",exact:true}).click();await page.getByRole("button",{name:"توثيق الاستراتيجية",exact:true}).click();panel=page.getByTestId("canonical-ortho-strategy");
    await expect.poll(()=>panel.getByLabel("سبب توثيق هذه النسخة (مطلوب)").inputValue()).toBe("SYN frozen strategy refresh");
    const requests:string[]=[],path=`**/api/ortho/${caseId}/strategy`;
    page.on("request",r=>{if(r.method()==="POST"&&new URL(r.url()).pathname===`/api/ortho/${caseId}/strategy`)requests.push(r.postData()!);});
    await page.route(path,async route=>{if(route.request().method()!=="POST")return route.continue();const response=await route.fetch();expect(response.status()).toBe(201);await route.abort("failed");});
    await panel.getByRole("button",{name:"حفظ نسخة خطة الحالة",exact:true}).click();const retry=panel.getByRole("button",{name:"التحقق بإعادة نفس طلب الخطة",exact:true});await expect.poll(()=>retry.isEnabled()).toBe(true);
    const committed=await saved();expect(committed).toHaveLength(2);expect(requests).toHaveLength(1);expect(await panel.getByLabel("سبب توثيق هذه النسخة (مطلوب)").isDisabled()).toBe(true);
    await page.getByRole("button",{name:"إغلاق الحالات",exact:true}).click();expect(await page.getByTestId("canonical-ortho-cases").count()).toBe(1);
    await page.unroute(path);await retry.click();await expect.poll(()=>panel.getByTestId("ortho-strategy-draft").count()).toBe(0);
    expect(requests).toHaveLength(2);expect(requests[1]).toBe(requests[0]);expect(await saved()).toEqual(committed);
  }finally{await context.close();}
});
it("browser: committed success arriving after parent refresh cannot acknowledge the retired view",async()=>{
  const context=await journey.browser.newContext();let release!:()=>void,reached!:()=>void,finished!:()=>void,intercepted=false;
  const held=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{reached=r;}),done=new Promise<void>(r=>{finished=r;});
  try{const page=await context.newPage();let panel=await openEditor(page);await panel.getByRole("button",{name:"فتح مراجعة جديدة من النسخة الحالية",exact:true}).click();await panel.getByLabel("سبب توثيق هذه النسخة (مطلوب)").fill("SYN late successful reply");
    const requests:string[]=[],path=`**/api/ortho/${caseId}/strategy`;page.on("request",r=>{if(r.method()==="POST"&&new URL(r.url()).pathname===`/api/ortho/${caseId}/strategy`)requests.push(r.postData()!);});
    await page.route(path,async route=>{if(route.request().method()!=="POST")return route.continue();intercepted=true;try{const response=await route.fetch();expect(response.status()).toBe(201);reached();await held;await route.fulfill({response});}finally{finished();}});
    await panel.getByRole("button",{name:"حفظ نسخة خطة الحالة",exact:true}).click();await ready;
    await page.getByRole("button",{name:"تحديث الحالات",exact:true}).click();await page.getByRole("button",{name:"عرض تفاصيل الحالة",exact:true}).click();await page.getByRole("button",{name:"توثيق الاستراتيجية",exact:true}).click();panel=page.getByTestId("canonical-ortho-strategy");
    const retry=panel.getByRole("button",{name:"التحقق بإعادة نفس طلب الخطة",exact:true});await retry.waitFor();expect(await retry.isDisabled()).toBe(true);release();await done;await expect.poll(()=>retry.isEnabled()).toBe(true);
    expect(await panel.getByLabel("سبب توثيق هذه النسخة (مطلوب)").inputValue()).toBe("SYN late successful reply");expect(requests).toHaveLength(1);const committed=await saved();expect(committed).toHaveLength(3);
    await page.unroute(path);await retry.click();await expect.poll(()=>panel.getByTestId("ortho-strategy-draft").count()).toBe(0);expect(requests[1]).toBe(requests[0]);expect(await saved()).toEqual(committed);
  }finally{release();if(intercepted)await done;await context.close();}
});
it("browser: independent plan edit links existing clinical items; subsequent view-only link authority cannot revise them",async()=>{
  const before=await financial(),context=await journey.browser.newContext();
  try{const page=await context.newPage(),panel=await openEditor(page,"planEdit");await panel.getByRole("button",{name:"فتح مراجعة جديدة من النسخة الحالية",exact:true}).click();
    await panel.getByRole("checkbox",{name:/SYN saved service/}).check();await panel.getByLabel("سبب توثيق هذه النسخة (مطلوب)").fill("SYN authorized plan linkage");await panel.getByRole("button",{name:"حفظ نسخة خطة الحالة",exact:true}).click();await expect.poll(()=>panel.getByTestId("ortho-strategy-draft").count()).toBe(0);
    expect(await financial()).toEqual(before);expect(await saved()).toHaveLength(4);expect(await panel.textContent()).not.toMatch(/92387|private funding/);
  }finally{await context.close();}
  const other=await journey.browser.newContext();try{const panel=await openEditor(await other.newPage(),"planView");const button=panel.getByRole("button",{name:"فتح مراجعة جديدة من النسخة الحالية",exact:true});await button.waitFor();expect(await button.isDisabled()).toBe(true);expect(await panel.getByTestId("ortho-strategy-draft").count()).toBe(0);}finally{await other.close();}
});
it("browser and HTTP: revocation clears private draft and old session; a new reader receives no editor choices",async()=>{
  const original=(await journey.db.query("SELECT permissions FROM users WHERE id=$1",[journey.ids.planEdit])).rows[0].permissions,context=await journey.browser.newContext();
  try{const stale=await journey.login("planEdit"),page=await context.newPage(),panel=await openEditor(page,"planEdit");await panel.getByRole("button",{name:"فتح مراجعة جديدة من النسخة الحالية",exact:true}).click();await panel.getByLabel("سبب توثيق هذه النسخة (مطلوب)").fill("SYN private revoked draft");
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ortho.edit}','false')::text WHERE id=$1",[journey.ids.planEdit]);
    await panel.getByRole("button",{name:"تحديث سجل الخطة",exact:true}).click();await page.getByText("انتهت صلاحية التوثيق. أعد التحقق من الجلسة قبل فتح أي مسودة.",{exact:true}).waitFor();
    expect(await page.getByTestId("ortho-strategy-draft").count()).toBe(0);expect(await page.locator("body").textContent()).not.toContain("SYN private revoked draft");
    const path=`/api/ortho/${caseId}/strategy?edit=1`;expect((await journey.api(path,stale.cookie)).status).toBe(401);const fresh=await journey.login("planEdit");expect((await journey.api(path,fresh.cookie)).status).toBe(403);
  }finally{await context.close();await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2",[original,journey.ids.planEdit]);}
});
it("browser: reference-only authority has no editor; ordinary reference URL sends no editing choices",async()=>{
  const context=await journey.browser.newContext();try{const page=await context.newPage();await journey.browserLogin(page,"reader");await page.goto(`${journey.baseUrl}/patients/${patientId}`);await page.getByRole("button",{name:"عرض حالات التقويم",exact:true}).click();await page.getByRole("button",{name:"عرض تفاصيل الحالة",exact:true}).click();
    expect(await page.getByRole("button",{name:"توثيق الاستراتيجية",exact:true}).count()).toBe(0);await page.getByRole("button",{name:"عرض الاستراتيجية المحفوظة",exact:true}).click();await page.getByTestId("ortho-strategy-saved").waitFor();expect(await page.getByTestId("ortho-strategy-editor").count()).toBe(0);
    const session=await journey.login("owner"),response=await journey.api(`/api/ortho/${caseId}/strategy`,session.cookie);expect(await response.json()).toMatchObject({clinicalWritable:false,choices:{problems:[],planItems:[]}});
  }finally{await context.close();}
});
it("browser: delayed editor data cannot restore choices after a newer denied read",async()=>{
  const original=(await journey.db.query("SELECT permissions FROM users WHERE id=$1",[journey.ids.planEdit])).rows[0].permissions,context=await journey.browser.newContext();
  let release!:()=>void,reached!:()=>void,finished!:()=>void,intercepted=false;const held=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{reached=r;}),done=new Promise<void>(r=>{finished=r;});
  try{const page=await context.newPage(),panel=await openEditor(page,"planEdit");await panel.getByRole("button",{name:"فتح مراجعة جديدة من النسخة الحالية",exact:true}).waitFor();
    const path=`**/api/ortho/${caseId}/strategy?edit=1`;await page.route(path,async route=>{if(intercepted)return route.continue();intercepted=true;try{const response=await route.fetch();expect(response.status()).toBe(200);reached();await held;await route.fulfill({response});}finally{finished();}});
    await panel.getByRole("button",{name:"تحديث سجل الخطة",exact:true}).click();await ready;
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','3'),'{grants,clinical.ortho.edit}','false')::text WHERE id=$1",[journey.ids.planEdit]);
    await panel.getByRole("button",{name:"تحديث سجل الخطة",exact:true}).click();await page.getByText("انتهت صلاحية التوثيق. أعد التحقق من الجلسة قبل فتح أي مسودة.",{exact:true}).waitFor();release();await done;
    expect(await page.getByTestId("ortho-strategy-editor").count()).toBe(0);expect(await page.locator("body").textContent()).not.toContain("SYN saved service");
  }finally{release();if(intercepted)await done;await context.close();await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2",[original,journey.ids.planEdit]);}
});
it("browser: an unanswered write times out into uncertainty without an automatic resend",async()=>{
  const context=await journey.browser.newContext();let release!:()=>void,finished!:()=>void,intercepted=false;const held=new Promise<void>(r=>{release=r;}),done=new Promise<void>(r=>{finished=r;});
  try{const page=await context.newPage(),panel=await openEditor(page,"planEdit");await panel.getByRole("button",{name:"فتح مراجعة جديدة من النسخة الحالية",exact:true}).click();await panel.getByLabel("سبب توثيق هذه النسخة (مطلوب)").fill("SYN timeout exact bytes");const before=await saved(),requests:string[]=[],path=`**/api/ortho/${caseId}/strategy`;
    page.on("request",r=>{if(r.method()==="POST"&&new URL(r.url()).pathname===`/api/ortho/${caseId}/strategy`)requests.push(r.postData()!);});await page.route(path,async route=>{if(route.request().method()!=="POST")return route.continue();intercepted=true;try{await held;await route.abort("failed");}finally{finished();}});
    await panel.getByRole("button",{name:"حفظ نسخة خطة الحالة",exact:true}).click();const retry=panel.getByRole("button",{name:"التحقق بإعادة نفس طلب الخطة",exact:true});await retry.waitFor({timeout:22000});await expect.poll(()=>retry.isEnabled()).toBe(true);
    expect(requests).toHaveLength(1);expect(await saved()).toEqual(before);expect(await panel.getByLabel("سبب توثيق هذه النسخة (مطلوب)").inputValue()).toBe("SYN timeout exact bytes");release();await done;await page.unroute(path);await retry.click();await expect.poll(()=>panel.getByTestId("ortho-strategy-draft").count()).toBe(0);expect(requests[1]).toBe(requests[0]);expect(await saved()).toHaveLength(before.length+1);
  }finally{release();if(intercepted)await done;await context.close();}
});
it("browser: a reply after detail-only unmount cannot erase the frozen draft while its editor is closed",async()=>{
  const context=await journey.browser.newContext();let release!:()=>void,reached!:()=>void,finished!:()=>void,intercepted=false;
  const held=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{reached=r;}),done=new Promise<void>(r=>{finished=r;});
  try{const page=await context.newPage();let panel=await openEditor(page,"planEdit");await panel.getByRole("button",{name:/^(فتح مراجعة جديدة من النسخة الحالية|بدء خطة الحالة من نموذج فارغ)$/}).click();await panel.getByLabel("المشكلة",{exact:true}).selectOption(String(problemId));await panel.getByLabel("سبب توثيق هذه النسخة (مطلوب)").fill("SYN detail-only retired response");
    const path=`**/api/ortho/${caseId}/strategy`,requests:string[]=[];page.on("request",r=>{if(r.method()==="POST"&&new URL(r.url()).pathname===`/api/ortho/${caseId}/strategy`)requests.push(r.postData()!);});
    await page.route(path,async route=>{if(route.request().method()!=="POST")return route.continue();intercepted=true;try{const response=await route.fetch();expect(response.status()).toBe(201);reached();await held;await route.fulfill({response});}finally{finished();}});
    await panel.getByRole("button",{name:"حفظ نسخة خطة الحالة",exact:true}).click();await ready;
    await page.getByRole("button",{name:"تحديث التفاصيل",exact:true}).click();await page.getByRole("button",{name:"توثيق الاستراتيجية",exact:true}).waitFor();
    const returned=page.waitForResponse(r=>r.request().method()==="POST"&&new URL(r.url()).pathname===`/api/ortho/${caseId}/strategy`);release();await done;await returned;
    // Let the closed view's already-returned JSON continuation run; do not reopen
    // and thereby invalidate it before observing the actual unmount boundary.
    await page.waitForTimeout(200);
    await page.getByRole("button",{name:"توثيق الاستراتيجية",exact:true}).click();panel=page.getByTestId("canonical-ortho-strategy");
    const retry=panel.getByRole("button",{name:"التحقق بإعادة نفس طلب الخطة",exact:true});await retry.waitFor({timeout:2500});await expect.poll(()=>retry.isEnabled()).toBe(true);
    expect(await panel.getByLabel("سبب توثيق هذه النسخة (مطلوب)").inputValue()).toBe("SYN detail-only retired response");expect(requests).toHaveLength(1);
    const committed=await saved();await page.unroute(path);await panel.getByRole("button",{name:"التحقق بإعادة نفس طلب الخطة",exact:true}).click();await expect.poll(()=>panel.getByTestId("ortho-strategy-draft").count()).toBe(0);expect(requests[1]).toBe(requests[0]);expect(await saved()).toEqual(committed);
  }finally{release();if(intercepted)await done;await context.close();}
});
