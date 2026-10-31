/** M2 slice 31: the clinical orthodontic case detail, synthetic built-app evidence. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedCanonicalAssessment } from "../fixtures/canonical-ortho-assessment";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ACCOUNTS = {
  owner: { username: "canon-oa-owner", password: "Canon#OCOwner1", role: "admin", display: "المالك التجريبي" },
  doctor: { username: "canon-oa-doctor", password: "Canon#OCDoctor1", role: "doctor", doctor: true, display: "طبيب التقويم التجريبي", patientScope: "own", grants: { "clinical.ortho.view": true } },
  desk: { username: "canon-oa-desk", password: "Canon#OCDesk1", role: "reception", display: "متابعة التقويم", patientScope: "all", grants: { "clinical.ortho.view": true } },
  denied: { username: "canon-oa-denied", password: "Canon#OCDenied1", role: "admin", display: "مدير دون منحة التقويم", patientScope: "all", grants: { "clinical.plans.view": true } },
  none: { username: "canon-oa-none", password: "Canon#OCNone1", role: "doctor", doctor: true, display: "طبيب بلا نطاق", patientScope: "none", grants: { "clinical.ortho.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { own: 0, outside: 0, empty: 0, active: 0, closed: 0 };
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 43, secret: "canonical-ortho-assessment-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, accounts, parties) {
      for (const [key, name, doctor] of [["own", "مريض تقويم تجريبي", parties.doctor!], ["outside", "مريض خارج النطاق", null], ["empty", "مريض بلا حالة تقويم", parties.doctor!]] as const) {
        ids[key] = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id", [`SYN-OCJ-${key}`, name, doctor])).rows[0].id;
      }
      ids.closed = (await db.query<{ id: number }>("INSERT INTO ortho_cases(patient_id,status,start_date,created_by,note,responsible_doctor_id) VALUES($1,'completed','2024-01-01','SYN','SYN-hidden-clinical-note',$2) RETURNING id", [ids.own, parties.doctor!])).rows[0].id;
      ids.active = (await db.query<{ id: number }>("INSERT INTO ortho_cases(patient_id,status,start_date,created_by,upper_wire,responsible_doctor_id) VALUES($1,'active','2026-10-01','SYN','0.014 NiTi',$2) RETURNING id", [ids.own, parties.doctor!])).rows[0].id;
      await db.query("INSERT INTO ortho_cases(patient_id,created_by,note) VALUES($1,'SYN','SYN-outside-private')", [ids.outside]);
      const bridgeId=(await db.query<{id:number}>("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN bridge',$2,'SYN') RETURNING id",[ids.own,ids.active])).rows[0].id;
      const first=await seedCanonicalAssessment(db,{patientId:ids.own,caseId:ids.active,bridgeId,actorId:accounts.owner,reason:"SYN محفوظ أول"});
      await seedCanonicalAssessment(db,{patientId:ids.own,caseId:ids.active,bridgeId,actorId:accounts.owner,version:2,previous:first.id,reason:"SYN محفوظ ثان"});

    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: a canonical orthodontic viewer reads the assessment state of its case", async () => {
  const session = await journey.login("doctor"); expect(session.status).toBe(200);
  expect((await journey.api(`/api/ortho/${ids.active}`, session.cookie)).status).toBe(200);
  const response = await journey.api(`/api/ortho/${ids.active}/assessment?acceptSchema=1,2`, session.cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toMatchObject({ok:true,representation:2,state:"ready",revision:{version:2,reason:"SYN محفوظ ثان"},clinicalWritable:false});
  expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: no grant, no scope and anonymous deny; owner/all read immutable history with no write authority",async()=>{
  const path=`/api/ortho/${ids.active}/assessment?acceptSchema=2`;
  expect((await journey.api(path,"")).status).toBe(401);
  for(const key of ["denied","none"] as const){const session=await journey.login(key),response=await journey.api(path,session.cookie);expect(response.status).toBe(403);expect(response.headers.get("cache-control")).toContain("no-store");}
  for(const key of ["owner","desk"] as const){const session=await journey.login(key),response=await journey.api(path,session.cookie);expect(response.status).toBe(200);const body=await response.json();expect(body.history).toHaveLength(2);expect(body.clinicalWritable).toBe(false);expect(body.sources.items).toEqual([]);expect(JSON.stringify(body)).not.toMatch(/planId|invoice|legacyFinancialMode|storage_key|mime_type/);}
});
it("HTTP: outside equals missing, revision scope and negotiation are strict, legitimate missing bridge remains explicit",async()=>{
  const session=await journey.login("doctor"),foreign=(await journey.db.query("SELECT id FROM ortho_cases WHERE patient_id=$1",[ids.outside])).rows[0].id,bodies=[];
  for(const id of [foreign,2147483647]){const r=await journey.api(`/api/ortho/${id}/assessment?acceptSchema=2`,session.cookie);expect(r.status).toBe(404);bodies.push(await r.json());}expect(bodies[0]).toEqual(bodies[1]);
  for(const [query,status] of [["",409],["acceptSchema=1",409],["acceptSchema=2&acceptSchema=2",400],["acceptSchema=2&revisionId=2147483647",404],["acceptSchema=2&photos=1",400]] as const){const r=await journey.api(`/api/ortho/${ids.active}/assessment?${query}`,session.cookie);expect(r.status).toBe(status);expect(r.headers.get("cache-control")).toContain("no-store");}
  const absent=await journey.api(`/api/ortho/${ids.closed}/assessment?acceptSchema=2`,session.cookie);expect(await absent.json()).toMatchObject({state:"bridge_missing",revision:null});
});
it("HTTP: independent imaging sources cannot be exposed by ortho view, URL revision selection or a role label",async()=>{
  const caseId=(await journey.db.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'completed','SYN') RETURNING id",[ids.own])).rows[0].id;
  const bridgeId=(await journey.db.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN source bridge',$2,'SYN') RETURNING id",[ids.own,caseId])).rows[0].id;
  const documentId=(await journey.db.query("INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,ortho_case_id) VALUES($1,'imaging','SYN restricted title','image/png',1,$2,'SYN/private.png','SYN',$3) RETURNING id",[ids.own,"a".repeat(64),caseId])).rows[0].id;
  const first=await seedCanonicalAssessment(journey.db,{patientId:ids.own,caseId,bridgeId,actorId:journey.ids.owner,sources:[{kind:"document",id:documentId,version:`sha256:${"a".repeat(64)}`}],reason:"SYN restricted clinical reason"});
  for(const key of ["doctor","desk"] as const){const session=await journey.login(key),r=await journey.api(`/api/ortho/${caseId}/assessment?acceptSchema=2&revisionId=${first.id}`,session.cookie);expect(r.status).toBe(403);expect(JSON.stringify(await r.json())).not.toMatch(/restricted clinical reason|restricted title|private.png|contentHash|sourceStates/);}
  const owner=await journey.login("owner"),r=await journey.api(`/api/ortho/${caseId}/assessment?acceptSchema=2`,owner.cookie);expect(r.status).toBe(200);const body=await r.json();expect(body.revision.contentHash).toBe(first.hash);expect(JSON.stringify(body)).not.toMatch(/restricted title|private.png|storage_key/);
});
it("HTTP: assessment reads and denied POST preserve revisions, money and audit",async()=>{
  const session=await journey.login("doctor"),sql="SELECT (SELECT count(*) FROM ortho_assessment_revisions)::int revisions,(SELECT count(*) FROM invoices)::int invoices,(SELECT count(*) FROM audit_log)::int audits",before=(await journey.db.query(sql)).rows;
  expect((await journey.api(`/api/ortho/${ids.active}/assessment?acceptSchema=2`,session.cookie)).status).toBe(200);
  const r=await journey.api(`/api/ortho/${ids.active}/assessment`,session.cookie,{method:"POST",body:JSON.stringify({schemaVersion:2,reason:"SYN denied"})});expect([401,403]).toContain(r.status);
  expect((await journey.db.query(sql)).rows).toEqual(before);expect(await journey.ddlLog()).toEqual([]);
});
async function openAssessment(page: import("playwright").Page,key:Key="doctor",alreadyLoggedIn=false) {
  if(!alreadyLoggedIn)await journey.browserLogin(page,key);await page.goto(`${journey.baseUrl}/patients/${ids.own}`);
  await page.getByRole("button",{name:"عرض حالات التقويم"}).click();
  // The active case is identified by its recorded wire; later tests add closed cases.
  const item=page.getByTestId("canonical-ortho-cases").getByRole("listitem").filter({has:page.getByText("0.014 NiTi",{exact:true})});
  await item.getByRole("button",{name:"عرض تفاصيل الحالة"}).click();
  await item.getByRole("button",{name:"عرض التقييم والقياسات"}).click();
  const panel=page.getByTestId("canonical-ortho-assessment");await panel.getByTestId("assessment-v2-saved").waitFor();return panel;
}
it("browser: reuses the verified clinical record at 390px, opens older revisions and makes no editing/source-picker requests",async()=>{
  const context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"});
  try{
    const page=await context.newPage(),calls:string[]=[];await journey.browserLogin(page,"doctor");
    page.on("request",r=>{const path=new URL(r.url()).pathname;if(path.startsWith("/api/"))calls.push(`${r.method()} ${path}`);});
    const panel=await openAssessment(page,"doctor",true);await panel.getByText("السجل المحفوظ: نسخة 2",{exact:true}).waitFor();
    expect(await panel.getByRole("button",{name:/فتح مراجعة|بدء تقييم|حفظ/}).count()).toBe(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    if(process.env.HR_EVIDENCE_DIR){mkdirSync(process.env.HR_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.HR_EVIDENCE_DIR,"ortho-assessment-390.png"),fullPage:true});}
    const selector=panel.getByLabel("نسخة التقييم"),options=await selector.locator("option").evaluateAll(nodes=>nodes.map(n=>(n as HTMLOptionElement).value));
    await selector.selectOption(options[1]);await panel.getByText("السجل المحفوظ: نسخة 1",{exact:true}).waitFor();
    await panel.getByTestId("assessment-v2-saved").locator("summary").click();await panel.getByText(/SYN محفوظ أول/).waitFor();
    expect(calls.filter(call=>call.includes("/api/")&&!new RegExp(`^(GET /api/(auth/me|patients/${ids.own}(/(contact|timeline))?|ortho(/${ids.active}(/assessment)?)?)|POST /api/auth/login)$`).test(call))).toEqual([]);
    expect(await panel.locator("img").count()).toBe(0);
  }finally{await context.close();}
  expect(await journey.ddlLog()).toEqual([]);
});
it("browser: failure and invalid historical hashes clear old results instead of claiming an empty assessment",async()=>{
  const context=await journey.browser.newContext();try{
    const page=await context.newPage(),panel=await openAssessment(page);
    await page.route(`**/api/ortho/${ids.active}/assessment?*`,async route=>{const response=await route.fetch(),body=await response.json();body.revision.contentHash="0".repeat(64);await route.fulfill({response,json:body});});
    await panel.getByRole("button",{name:"تحديث سجل التقييم"}).click();await panel.getByRole("alert").waitFor();expect(await panel.getByTestId("assessment-v2-saved").count()).toBe(0);
    await page.unroute(`**/api/ortho/${ids.active}/assessment?*`);await page.route(`**/api/ortho/${ids.active}/assessment?*`,route=>route.abort());
    await panel.getByRole("button",{name:"تحديث سجل التقييم"}).click();await panel.getByRole("alert").waitFor();expect(await panel.getByTestId("assessment-v2-saved").count()).toBe(0);
  }finally{await context.close();}
});
it("browser and HTTP: revocation clears the assessment and fresh sessions cannot recover a removed grant",async()=>{
  const context=await journey.browser.newContext(),original=(await journey.db.query("SELECT permissions FROM users WHERE id=$1",[journey.ids.desk])).rows[0].permissions;
  try{
    const stale=await journey.login("desk"),page=await context.newPage(),panel=await openAssessment(page,"desk");
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ortho.view}','false')::text WHERE id=$1",[journey.ids.desk]);
    await panel.getByRole("button",{name:"تحديث سجل التقييم"}).click();await panel.getByRole("alert").waitFor();expect(await panel.getByTestId("assessment-v2-saved").count()).toBe(0);
    expect((await journey.api(`/api/ortho/${ids.active}/assessment?acceptSchema=2`,stale.cookie)).status).toBe(401);
    const fresh=await journey.login("desk");expect((await journey.api(`/api/ortho/${ids.active}/assessment?acceptSchema=2`,fresh.cookie)).status).toBe(403);
  }finally{await context.close();await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2",[original,journey.ids.desk]);}
});
it("browser: a delayed response cannot restore a closed assessment; older revisions remain readable",async()=>{
  const context=await journey.browser.newContext();let release!:()=>void,reached!:()=>void,finished!:()=>void;
  const held=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{reached=r;}),done=new Promise<void>(r=>{finished=r;});
  try{
    const page=await context.newPage(),panel=await openAssessment(page);let first=true;
    await page.route(`**/api/ortho/${ids.active}/assessment?*`,async route=>{if(!first){await route.continue();return;}first=false;try{const response=await route.fetch();reached();await held;await route.fulfill({response}).catch(()=>undefined);}finally{finished();}});
    await panel.getByRole("button",{name:"تحديث سجل التقييم"}).click();await ready;
    // Closing the read invalidates both transport and asynchronous payload decoder.
    await page.getByRole("button",{name:"إغلاق التقييم والقياسات"}).click();release();await done;
    expect(await page.getByTestId("canonical-ortho-assessment").count()).toBe(0);
    await page.getByRole("button",{name:"عرض التقييم والقياسات"}).click();await panel.getByTestId("assessment-v2-saved").waitFor();
    const selector=panel.getByLabel("نسخة التقييم"),options=await selector.locator("option").evaluateAll(nodes=>nodes.map(n=>(n as HTMLOptionElement).value));
    await selector.selectOption(options[1]);await panel.getByText("السجل المحفوظ: نسخة 1",{exact:true}).waitFor();
  }finally{release();await context.close();}
});
