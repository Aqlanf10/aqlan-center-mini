import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { seedCanonicalPatientCases } from "../fixtures/canonical-patient-cases";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const EDIT = { "clinical.plans.view": true, "clinical.plans.edit": true };
const ACCOUNTS = {
  owner: { username: "canon-dep-owner", password: "Canon#DepOwner1", role: "admin", display: "مالك تجريبي" },
  own: { username: "canon-dep-own", password: "Canon#DepOwn1", role: "doctor", doctor: true, display: "طبيب تجريبي", patientScope: "own", grants: EDIT },
  all: { username: "canon-dep-all", password: "Canon#DepAll1", role: "reception", display: "محرر تجريبي", patientScope: "all", grants: EDIT },
  none: { username: "canon-dep-none", password: "Canon#DepNone1", role: "doctor", doctor: true, display: "بلا نطاق", patientScope: "none", grants: EDIT },
  read: { username: "canon-dep-read", password: "Canon#DepRead1", role: "admin", display: "قارئ فقط", patientScope: "all", grants: { "clinical.plans.view": true } },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
const ids = { patient: 0, item: 0, prerequisite: 0, plan: 0, next: 0, outsideItem: 0 };
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 58, secret: "canonical-plan-dependency-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed(q, _users, parties) {
    ids.patient = Number((await q.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-DEP-WRITE','SYN dependency patient',$1) RETURNING id", [parties.own])).rows[0].id);
    Object.assign(ids, await seedCanonicalPatientCases(q, ids.patient, parties.own));
    ids.next = Number((await q.query("INSERT INTO plan_items(plan_id,service_name) VALUES($1,'SYN next treatment') RETURNING id", [ids.plan])).rows[0].id);
    const outside = Number((await q.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-DEP-OUT','SYN outside dependency patient') RETURNING id")).rows[0].id);
    ids.outsideItem = (await seedCanonicalPatientCases(q, outside)).item;
  } });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
afterEach(async () => {
  if (!journey) return;
  await journey.db.query("DELETE FROM plan_item_dependencies WHERE item_id=$1",[ids.next]);
  await journey.db.query("INSERT INTO plan_item_dependencies(item_id,requires_item_id,requirement,note,created_by) VALUES($1,$2,'completed','SYN dependency note','SYN clinician') ON CONFLICT(item_id,requires_item_id) DO UPDATE SET requirement=EXCLUDED.requirement,note=EXCLUDED.note",[ids.item,ids.prerequisite]);
});
const add = (cookie: string, item = ids.next, requires = ids.item, body: unknown = { requiresItemId: requires, requirement: "completed", note: null }) =>
  journey.api(`/api/plan-items/${item}/dependencies`, cookie, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
it("HTTP: a scoped canonical editor can add a same-patient dependency without legacy authority", async () => {
  const session = await journey.login("own"); expect(session.status).toBe(200);
  const response = await add(session.cookie); expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ ok: true, itemId: ids.next, requiresItemId: ids.item });
  expect(await journey.ddlLog()).toEqual([]);
});
const auditCount = async () => Number((await journey.db.query("SELECT count(*)::int n FROM audit_log WHERE action IN ('plan.dependency_add','plan.dependency_remove') AND entity_id=$1",[String(ids.patient)])).rows[0].n);
const graph = async (cookie: string) => { const r=await journey.api(`/api/patients/${ids.patient}/cases`,cookie); expect(r.status).toBe(200); return r.json(); };
const erase = (cookie: string, version: string, item=ids.item, requires=ids.prerequisite) => journey.api(`/api/plan-items/${item}/dependencies`,cookie,{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({requiresItemId:requires,expectedVersion:version})});
it("HTTP: own/all/none and independent edit authority apply to both endpoints without role shortcuts", async () => {
  const owner=(await journey.login("owner")).cookie, version=(await graph(owner)).dependencies[0].version;
  expect((await add("")).status).toBe(401); expect((await erase("",version)).status).toBe(401);
  for(const key of ["none","read"] as const){ const cookie=(await journey.login(key)).cookie; expect((await add(cookie)).status).toBe(403); expect((await erase(cookie,version)).status).toBe(403); }
  const own=(await journey.login("own")).cookie, outside=await add(own,ids.outsideItem,ids.item), missing=await add(own,2147483647,ids.item);
  expect(outside.status).toBe(404); expect(missing.status).toBe(404); expect(await outside.json()).toEqual(await missing.json());
  const all=(await journey.login("all")).cookie; expect((await add(all)).status).toBe(201); const response=await erase(all,version); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
});
it("HTTP: exact input refuses actor/finance fields, query aliases, foreign targets and cycles", async () => {
  const cookie=(await journey.login("own")).cookie,before=await auditCount();
  for(const body of [{requiresItemId:ids.item},{requiresItemId:ids.item,requirement:"paid",note:null},{requiresItemId:ids.item,requirement:"completed",note:null,actor:"owner"},{requiresItemId:ids.item,requirement:"completed",note:null,amount:1}]) expect((await add(cookie,ids.next,ids.item,body)).status).toBe(400);
  const badQuery=await journey.api(`/api/plan-items/${ids.next}/dependencies?requires=${ids.item}`,cookie,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requiresItemId:ids.item,requirement:"completed",note:null})}); expect(badQuery.status).toBe(400);
  const foreign=await add(cookie,ids.next,ids.outsideItem); expect(foreign.status).toBe(404); expect(JSON.stringify(await foreign.json())).not.toMatch(/SYN outside|SELECT/);
  expect((await add(cookie,ids.prerequisite,ids.item)).status).toBe(409); expect(await auditCount()).toBe(before);
});
it("HTTP: deletion requires its observed edge version and stale replay never deletes a recreated edge", async () => {
  const cookie=(await journey.login("own")).cookie,before=await auditCount(),old=(await graph(cookie)).dependencies[0].version;
  expect((await erase(cookie,old)).status).toBe(200); expect((await erase(cookie,old)).status).toBe(404);
  expect((await add(cookie,ids.item,ids.prerequisite)).status).toBe(201); const stale=await erase(cookie,old); expect(stale.status).toBe(409); expect((await stale.json()).code).toBe("plan_dependency_conflict");
  const latest=(await graph(cookie)).dependencies.find((d:{itemId:number})=>d.itemId===ids.item); expect(latest.version).not.toBe(old); expect(await auditCount()).toBe(before+2);
});
async function openEditor(page: import("playwright").Page,key:keyof typeof ACCOUNTS="own",signed=false){
  page.setDefaultTimeout(10000); if(!signed) await journey.browserLogin(page,key); await page.goto(`${journey.baseUrl}/patients/${ids.patient}`);
  await page.getByRole("button",{name:"عرض الحالات وترتيب الخطة",exact:true}).click(); const panel=page.getByTestId("canonical-patient-cases"); await panel.getByText("SYN root case",{exact:true}).first().waitFor();
  const editor=page.getByTestId("canonical-plan-dependency-editor"); await editor.getByRole("button",{name:"إدارة اعتماديات البنود",exact:true}).click(); return {panel,editor};
}
async function choose(editor:import("playwright").Locator,item=ids.next,required=ids.item){await editor.getByLabel("البند الذي يحتاج متطلبًا",{exact:true}).selectOption(String(item));await editor.getByLabel("البند المطلوب قبله",{exact:true}).selectOption(String(required));}
it("browser: 390px editor adds and removes an explicit dependency without changing finance or legacy UI",async()=>{
  const context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"});
  try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();await choose(editor);await editor.getByLabel("شرط المتطلب",{exact:true}).selectOption("clearance");await editor.getByLabel("ملاحظة الاعتماد",{exact:true}).fill("SYN clinical prerequisite note");
    if(process.env.HR_EVIDENCE_DIR){mkdirSync(process.env.HR_EVIDENCE_DIR,{recursive:true});await editor.screenshot({path:join(process.env.HR_EVIDENCE_DIR,"plan-dependency-editor-390.png")});}
    await editor.getByRole("button",{name:"إضافة الاعتماد",exact:true}).click();await editor.getByText("أُضيف الاعتماد وسُجّل أثره.",{exact:true}).waitFor();
    await editor.getByRole("button",{name:"إدارة اعتماديات البنود",exact:true}).click();await choose(editor);await editor.getByRole("button",{name:"إزالة الاعتماد المحدد",exact:true}).click();await editor.getByText("أُزيل الاعتماد وسُجّل أثره.",{exact:true}).waitFor();
    expect(await auditCount()).toBe(before+2);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(await journey.ddlLog()).toEqual([]);
  }finally{await context.close();}
});
it("browser: a reader has no dependency mutation controls",async()=>{
  const context=await journey.browser.newContext();try{const page=await context.newPage();await journey.browserLogin(page,"read");await page.goto(`${journey.baseUrl}/patients/${ids.patient}`);await page.getByRole("button",{name:"عرض الحالات وترتيب الخطة",exact:true}).click();await page.getByTestId("canonical-patient-cases").getByText("SYN root case",{exact:true}).first().waitFor();expect(await page.getByTestId("canonical-plan-dependency-editor").count()).toBe(0);}finally{await context.close();}
});
it.each(["add","remove"] as const)("browser: committed %s with a lost reply is not replayed after reload or refresh",async kind=>{
  const context=await journey.browser.newContext();
  try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();await choose(editor,kind==="add"?ids.next:ids.item,kind==="add"?ids.item:ids.prerequisite);
    if(kind==="add")await editor.getByLabel("ملاحظة الاعتماد",{exact:true}).fill("SYN private note never stored in marker");
    let count=0,first=true;const target=`/api/plan-items/${kind==="add"?ids.next:ids.item}/dependencies`;
    page.on("request",r=>{if(["POST","DELETE"].includes(r.method())&&new URL(r.url()).pathname===target)count++;});
    await page.route(`**${target}`,async route=>{if(!first){await route.continue();return;}first=false;const r=await route.fetch();expect(r.status()).toBe(kind==="add"?201:200);await route.abort("failed");});
    await editor.getByRole("button",{name:kind==="add"?"إضافة الاعتماد":"إزالة الاعتماد المحدد",exact:true}).click();await editor.getByText("طلب اعتماد سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();
    expect(await page.evaluate(()=>JSON.stringify(sessionStorage))).not.toContain("SYN private note");await page.reload();await page.getByRole("button",{name:"عرض الحالات وترتيب الخطة",exact:true}).click();
    const restored=page.getByTestId("canonical-plan-dependency-editor");await restored.getByText("طلب اعتماد سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();
    await restored.getByRole("button",{name:"التحقق من الاعتماد الحالي",exact:true}).click();await restored.getByRole("button",{name:"راجعت الاعتماد الحالي، بدء طلب جديد",exact:true}).waitFor();expect(count).toBe(1);expect(await auditCount()).toBe(before+1);
    await restored.getByRole("button",{name:"راجعت الاعتماد الحالي، بدء طلب جديد",exact:true}).click();await restored.getByLabel("البند الذي يحتاج متطلبًا",{exact:true}).waitFor();expect(count).toBe(1);
  }finally{await context.close();}
});
it("browser: a changed edge version refuses a stale deletion without removing the current edge",async()=>{
  const context=await journey.browser.newContext();try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();await choose(editor,ids.item,ids.prerequisite);
    await journey.db.query("UPDATE plan_item_dependencies SET note='SYN changed edge' WHERE item_id=$1 AND requires_item_id=$2",[ids.item,ids.prerequisite]);
    await editor.getByRole("button",{name:"إزالة الاعتماد المحدد",exact:true}).click();await editor.getByText("تغيّر الاعتماد أو تعذّر تثبيت سياقه. حدّث السجل وراجع الحالة قبل طلب جديد.",{exact:true}).waitFor();expect(await auditCount()).toBe(before);expect((await journey.db.query("SELECT note FROM plan_item_dependencies WHERE item_id=$1 AND requires_item_id=$2",[ids.item,ids.prerequisite])).rows[0].note).toBe("SYN changed edge");
  }finally{await context.close();}
});
it("browser: a malformed success after commit remains uncertain and is never automatically retried",async()=>{
  const context=await journey.browser.newContext();try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();await choose(editor);let count=0;
    await page.route(`**/api/plan-items/${ids.next}/dependencies`,async route=>{count++;const r=await route.fetch();expect(r.status()).toBe(201);await route.fulfill({status:201,contentType:"application/json",body:JSON.stringify({ok:true})});});
    await editor.getByRole("button",{name:"إضافة الاعتماد",exact:true}).click();await editor.getByText("طلب اعتماد سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();expect(count).toBe(1);expect(await auditCount()).toBe(before+1);
  }finally{await context.close();}
});
it("browser: unavailable tab storage is disclosed and a failed reply is held in memory",async()=>{
  const context=await journey.browser.newContext();try{await context.addInitScript(()=>{
    const get=Storage.prototype.getItem,set=Storage.prototype.setItem;
    Storage.prototype.getItem=function(key:string){if(key.startsWith("aqlan.plan-dependency.pending:"))throw new DOMException("SYN storage denied","SecurityError");return get.call(this,key);};
    Storage.prototype.setItem=function(key:string,value:string){if(key.startsWith("aqlan.plan-dependency.pending:"))throw new DOMException("SYN storage denied","SecurityError");return set.call(this,key,value);};
  });const page=await context.newPage(),{editor}=await openEditor(page);await choose(editor);await editor.getByText(/الاستعادة بعد إعادة التحميل غير مضمونة/).waitFor();let count=0;
    await page.route(`**/api/plan-items/${ids.next}/dependencies`,async route=>{count++;await route.abort("failed");});await editor.getByRole("button",{name:"إضافة الاعتماد",exact:true}).click();await editor.getByText("طلب اعتماد سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();expect(count).toBe(1);
  }finally{await context.close();}
});
it("browser: revocation during editing refuses the command and clears the clinical graph",async()=>{
  const context=await journey.browser.newContext(),original=(await journey.db.query("SELECT permissions FROM users WHERE id=$1",[journey.ids.all])).rows[0].permissions;
  try{const page=await context.newPage(),{editor,panel}=await openEditor(page,"all"),before=await auditCount();await choose(editor);
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.plans.edit}','false')::text WHERE id=$1",[journey.ids.all]);
    await editor.getByRole("button",{name:"إضافة الاعتماد",exact:true}).click();await panel.getByRole("alert").waitFor();expect(await auditCount()).toBe(before);expect(await panel.getByTestId("canonical-patient-case").count()).toBe(0);expect(await editor.locator("select,textarea").count()).toBe(0);
  }finally{await context.close();await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2",[original,journey.ids.all]);}
});
it("browser: closing a pending editor preserves recovery and ignores a late committed response",async()=>{
  const context=await journey.browser.newContext();let release!:()=>void,reached!:()=>void,finished!:()=>void;
  const held=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{reached=r;}),done=new Promise<void>(r=>{finished=r;});
  try{const page=await context.newPage(),{editor}=await openEditor(page),before=await auditCount();await choose(editor);let count=0;
    await page.route(`**/api/plan-items/${ids.next}/dependencies`,async route=>{count++;try{const response=await route.fetch();expect(response.status()).toBe(201);reached();await held;await route.fulfill({response}).catch(()=>undefined);}finally{finished();}});
    await editor.getByRole("button",{name:"إضافة الاعتماد",exact:true}).click();await ready;await page.getByRole("button",{name:"إغلاق الحالات وترتيب الخطة",exact:true}).click();release();await done;expect(await page.getByTestId("canonical-plan-dependency-editor").count()).toBe(0);
    await page.getByRole("button",{name:"عرض الحالات وترتيب الخطة",exact:true}).click();const restored=page.getByTestId("canonical-plan-dependency-editor");await restored.getByText("طلب اعتماد سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.",{exact:true}).waitFor();expect(await restored.locator("select,textarea").count()).toBe(0);expect(count).toBe(1);expect(await auditCount()).toBe(before+1);
  }finally{release();await context.close();}
});
