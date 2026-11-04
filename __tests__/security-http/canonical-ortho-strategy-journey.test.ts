/** M2 slice 32: the clinical orthodontic case detail, synthetic built-app evidence. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedCanonicalStrategy } from "../fixtures/canonical-ortho-strategy";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ACCOUNTS = {
  owner: { username: "canon-os-owner", password: "Canon#OCOwner1", role: "admin", display: "المالك التجريبي" },
  doctor: { username: "canon-os-doctor", password: "Canon#OCDoctor1", role: "doctor", doctor: true, display: "طبيب التقويم التجريبي", patientScope: "own", grants: { "clinical.ortho.view": true } },
  desk: { username: "canon-os-desk", password: "Canon#OCDesk1", role: "reception", display: "متابعة التقويم", patientScope: "all", grants: { "clinical.ortho.view": true } },
  denied: { username: "canon-os-denied", password: "Canon#OCDenied1", role: "admin", display: "مدير دون منحة التقويم", patientScope: "all", grants: { "clinical.plans.view": true } },
  none: { username: "canon-os-none", password: "Canon#OCNone1", role: "doctor", doctor: true, display: "طبيب بلا نطاق", patientScope: "none", grants: { "clinical.ortho.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { own: 0, outside: 0, empty: 0, active: 0, closed: 0, problem: 0 };
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 45, secret: "canonical-ortho-strategy-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, accounts, parties) {
      for (const [key, name, doctor] of [["own", "مريض تقويم تجريبي", parties.doctor!], ["outside", "مريض خارج النطاق", null], ["empty", "مريض بلا حالة تقويم", parties.doctor!]] as const) {
        ids[key] = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id", [`SYN-OCJ-${key}`, name, doctor])).rows[0].id;
      }
      ids.closed = (await db.query<{ id: number }>("INSERT INTO ortho_cases(patient_id,status,start_date,created_by,note,responsible_doctor_id) VALUES($1,'completed','2024-01-01','SYN','SYN-hidden-clinical-note',$2) RETURNING id", [ids.own, parties.doctor!])).rows[0].id;
      ids.active = (await db.query<{ id: number }>("INSERT INTO ortho_cases(patient_id,status,start_date,created_by,upper_wire,responsible_doctor_id) VALUES($1,'active','2026-10-01','SYN','0.014 NiTi',$2) RETURNING id", [ids.own, parties.doctor!])).rows[0].id;
      await db.query("INSERT INTO ortho_cases(patient_id,created_by,note) VALUES($1,'SYN','SYN-outside-private')", [ids.outside]);
      const bridgeId=(await db.query<{id:number}>("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN bridge',$2,'SYN') RETURNING id",[ids.own,ids.active])).rows[0].id;
      const problemId = (await db.query("INSERT INTO patient_problems(patient_id,case_id,label,noted_by) VALUES($1,$2,'SYN current problem','SYN') RETURNING id", [ids.own,bridgeId])).rows[0].id;
      ids.problem = problemId;
      const planId = (await db.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_by) VALUES($1,'SYN private funding',9900,'SYN') RETURNING id", [ids.own])).rows[0].id;
      const itemId = (await db.query("INSERT INTO plan_items(plan_id,service_name,case_id) VALUES($1,'SYN current plan',$2) RETURNING id", [planId,bridgeId])).rows[0].id;
      const rows = [{problem:{id:problemId,label:"SYN مشكلة محفوظة",site:null},objective:"SYN هدف محفوظ",strategy:"SYN استراتيجية محفوظة",rationale:null,planItems:[{id:itemId,serviceName:"SYN بند خطة محجوب",toothCode:null,caseSite:null}]}];
      const first=await seedCanonicalStrategy(db,{patientId:ids.own,caseId:ids.active,bridgeId,problemId,actorId:accounts.owner,rows,reason:"SYN محفوظ أول",createdAt:"2026-10-31T22:30:00.000Z"});
      await seedCanonicalStrategy(db,{patientId:ids.own,caseId:ids.active,bridgeId,problemId,actorId:accounts.owner,rows,version:2,previous:first.id,reason:"SYN محفوظ ثان",createdAt:"2026-10-31T22:30:00.000Z"});

    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: canonical ortho view reads the saved strategy without a legacy session", async () => {
 const session=await journey.login("doctor");expect(session.status).toBe(200);
 expect((await journey.api(`/api/ortho/${ids.active}`,session.cookie)).status).toBe(200);
 const response=await journey.api(`/api/ortho/${ids.active}/strategy`,session.cookie);
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({ok:true,state:"ready",clinicalWritable:false,canRevise:false});
 expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: anonymous, no grant and none deny; owner/all read without editors or finance", async () => {
  const path = `/api/ortho/${ids.active}/strategy`;
  expect((await journey.api(path, "")).status).toBe(401);
  for (const key of ["denied", "none"] as const) {
    const session = await journey.login(key), response = await journey.api(path, session.cookie);
    expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toContain("no-store");
  }
  for (const key of ["owner", "desk"] as const) {
    const session = await journey.login(key), response = await journey.api(path, session.cookie);
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.history).toHaveLength(2); expect(body).toMatchObject({clinicalWritable:false,planLinksWritable:false,canRevise:false,choices:{problems:[],planItems:[]}});
    expect(body.revision.rows[0].planLinks.state).toBe(key === "owner" ? "allowed" : "restricted");
    expect(JSON.stringify(body)).not.toMatch(/planId|invoice|funding|totalMinor|storage_key|phone|SYN current/);
    if (key === "desk") expect(JSON.stringify(body)).not.toContain("SYN بند خطة محجوب");
  }
});
it("HTTP: missing/outside are identical and selected history cannot bypass scope or independent plan grants", async () => {
  const session = await journey.login("doctor"), foreign = (await journey.db.query("SELECT id FROM ortho_cases WHERE patient_id=$1", [ids.outside])).rows[0].id, bodies = [];
  for (const id of [foreign, 2147483647]) { const r = await journey.api(`/api/ortho/${id}/strategy`, session.cookie); expect(r.status).toBe(404); bodies.push(await r.json()); }
  expect(bodies[0]).toEqual(bodies[1]);
  for (const [query,status] of [["revisionId=0",400],["revisionId=1&revisionId=2",400],["revisionId=2147483647",404],["photos=1",400]] as const) {
    const r = await journey.api(`/api/ortho/${ids.active}/strategy?${query}`, session.cookie); expect(r.status).toBe(status); expect(r.headers.get("cache-control")).toContain("no-store");
  }
  const current = await (await journey.api(`/api/ortho/${ids.active}/strategy`, session.cookie)).json();
  const older = await (await journey.api(`/api/ortho/${ids.active}/strategy?revisionId=${current.history[1].revisionId}`, session.cookie)).json();
  expect(older.revision).toMatchObject({version:1,reason:"SYN محفوظ أول",rows:[{planLinks:{state:"restricted"}}]});
  expect(JSON.stringify(older)).not.toContain("SYN بند خطة محجوب");
  expect(await (await journey.api(`/api/ortho/${ids.closed}/strategy`, session.cookie)).json()).toMatchObject({state:"bridge_missing",revision:null});
});
it("HTTP: reads and canonical rejected writes preserve strategy history, financing and audit", async () => {
  const session = await journey.login("doctor"), sql = "SELECT (SELECT count(*) FROM ortho_strategy_revisions)::int revisions,(SELECT sum(total_minor)::text FROM treatment_plans) money,(SELECT count(*) FROM audit_log)::int audits", before = (await journey.db.query(sql)).rows;
  expect((await journey.api(`/api/ortho/${ids.active}/strategy`, session.cookie)).status).toBe(200);
  const denied = await journey.api(`/api/ortho/${ids.active}/strategy`, session.cookie, {method:"POST",body:JSON.stringify({schemaVersion:1,commandId:"synthetic_forbidden_strategy_001",expectedRevisionId:null,reason:"SYN forbidden writer",rows:[{problemId:ids.problem,objective:null,strategy:null,rationale:null,planItemIds:[]}]})});
  expect(denied.status).toBe(403); expect((await journey.db.query(sql)).rows).toEqual(before); expect(await journey.ddlLog()).toEqual([]);
});
async function openStrategy(page: import("playwright").Page, key:Key="doctor", alreadyLoggedIn=false) {
  if (!alreadyLoggedIn) await journey.browserLogin(page,key);
  await page.goto(`${journey.baseUrl}/patients/${ids.own}`);
  await page.getByRole("button",{name:"عرض حالات التقويم"}).click();
  const item = page.getByTestId("canonical-ortho-cases").getByRole("listitem").filter({has:page.getByText("0.014 NiTi",{exact:true})});
  await item.getByRole("button",{name:"عرض تفاصيل الحالة"}).click();
  await item.getByRole("button",{name:"عرض الاستراتيجية المحفوظة"}).click();
  const panel = page.getByTestId("canonical-ortho-strategy"); await panel.getByTestId("ortho-strategy-saved").waitFor(); return panel;
}
it("browser: 390px saved clinical document and exact historical selection, no editor/financial/source requests", async () => {
  const context = await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"});
  try {
    const page = await context.newPage(), calls:string[]=[]; await journey.browserLogin(page,"doctor");
    page.on("request", r=>{const path=new URL(r.url()).pathname;if(path.startsWith("/api/"))calls.push(`${r.method()} ${path}`);});
    const panel = await openStrategy(page,"doctor",true); await panel.getByText("سبب النسخة: SYN محفوظ ثان",{exact:true}).waitFor();
    expect(await panel.getByRole("button",{name:/فتح مراجعة|بدء خطة|حفظ/}).count()).toBe(0);
    expect(await panel.getByTestId("ortho-strategy-editor").count()).toBe(0);
    expect(await panel.locator("textarea,input,img").count()).toBe(0);
    expect(await panel.textContent()).not.toContain("SYN بند خطة محجوب");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    if(process.env.HR_EVIDENCE_DIR){mkdirSync(process.env.HR_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.HR_EVIDENCE_DIR,"ortho-strategy-390.png"),fullPage:true});}
    const selector=panel.getByLabel("نسخة خطة الحالة"), options=await selector.locator("option").evaluateAll(nodes=>nodes.map(n=>(n as HTMLOptionElement).value));
    await selector.selectOption(options[1]);await panel.getByText("سبب النسخة: SYN محفوظ أول",{exact:true}).waitFor();
    expect(calls.filter(call=>!new RegExp(`^(GET /api/(auth/me|patients/${ids.own}(/(contact|timeline|family))?|ortho(/${ids.active}(/strategy)?)?)|POST /api/auth/login)$`).test(call))).toEqual([]);
  } finally {await context.close();}
  expect(await journey.ddlLog()).toEqual([]);
});
it("browser: malformed scope and network errors clear the old document without claiming an empty record", async () => {
  const context = await journey.browser.newContext(); try {
    const page=await context.newPage(), panel=await openStrategy(page);
    await page.route(`**/api/ortho/${ids.active}/strategy*`, async route=>{const response=await route.fetch(),body=await response.json();body.patientId=ids.outside;await route.fulfill({response,json:body});});
    await panel.getByRole("button",{name:"تحديث سجل الخطة"}).click();await panel.getByRole("alert").waitFor();expect(await panel.getByTestId("ortho-strategy-saved").count()).toBe(0);
    await page.unroute(`**/api/ortho/${ids.active}/strategy*`);await page.route(`**/api/ortho/${ids.active}/strategy*`,route=>route.abort());
    await panel.getByRole("button",{name:"تحديث سجل الخطة"}).click();await panel.getByRole("alert").waitFor();expect(await panel.getByTestId("ortho-strategy-saved").count()).toBe(0);
  } finally {await context.close();}
});
it("browser and HTTP: revocation removes saved text and denies old and new sessions without legacy fallback", async () => {
  const context=await journey.browser.newContext(),original=(await journey.db.query("SELECT permissions FROM users WHERE id=$1",[journey.ids.desk])).rows[0].permissions;
  try {
    const stale=await journey.login("desk"),page=await context.newPage(),panel=await openStrategy(page,"desk");
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ortho.view}','false')::text WHERE id=$1",[journey.ids.desk]);
    await panel.getByRole("button",{name:"تحديث سجل الخطة"}).click();await panel.getByRole("alert").waitFor();expect(await panel.getByTestId("ortho-strategy-saved").count()).toBe(0);
    expect((await journey.api(`/api/ortho/${ids.active}/strategy`,stale.cookie)).status).toBe(401);
    const fresh=await journey.login("desk");expect((await journey.api(`/api/ortho/${ids.active}/strategy`,fresh.cookie)).status).toBe(403);
  } finally {await context.close();await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2",[original,journey.ids.desk]);}
});
it("browser: delayed response cannot restore a closed document; reopening admits a new read", async () => {
  const context=await journey.browser.newContext();let release!:()=>void,reached!:()=>void,finished!:()=>void;
  const held=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{reached=r;}),done=new Promise<void>(r=>{finished=r;});
  try {
    const page=await context.newPage(),panel=await openStrategy(page);let first=true;
    await page.route(`**/api/ortho/${ids.active}/strategy*`,async route=>{if(!first){await route.continue();return;}first=false;try{const response=await route.fetch();reached();await held;await route.fulfill({response}).catch(()=>undefined);}finally{finished();}});
    await panel.getByRole("button",{name:"تحديث سجل الخطة"}).click();await ready;
    await page.getByRole("button",{name:"إغلاق الاستراتيجية المحفوظة"}).click();release();await done;
    expect(await page.getByTestId("canonical-ortho-strategy").count()).toBe(0);
    await page.getByRole("button",{name:"عرض الاستراتيجية المحفوظة"}).click();await panel.getByTestId("ortho-strategy-saved").waitFor();
  } finally {release();await context.close();}
});

it("browser: strategy revision midnight uses the clinic day after refresh on a different device zone", async () => {
  const context = await journey.browser.newContext({ timezoneId: "America/Los_Angeles", locale: "ar" });
  try {
    const page = await context.newPage(), panel = await openStrategy(page);
    const selector = panel.getByLabel("نسخة خطة الحالة");
    expect(await selector.locator("option").allTextContents()).toEqual([
      "نسخة 2 · الأحد 01/11/2026 · SYN strategy recorder · تصحيح توثيقي",
      "نسخة 1 · الأحد 01/11/2026 · SYN strategy recorder · تصحيح توثيقي",
    ]);
    expect(await panel.locator("time").textContent()).toBe("الأحد 01/11/2026");
    expect(await panel.locator("time").getAttribute("datetime")).toBe("2026-10-31T22:30:00.000Z");
    const older = await selector.locator("option").nth(1).getAttribute("value");
    await selector.selectOption(older!);
    await panel.getByText("سبب النسخة: SYN محفوظ أول", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "تحديث سجل الخطة" }).click();
    await panel.getByText("سبب النسخة: SYN محفوظ أول", { exact: true }).waitFor();
    expect(await panel.locator("time").textContent()).toBe("الأحد 01/11/2026");
    expect(await panel.getByTestId("ortho-strategy-editor").count()).toBe(0);
  } finally { await context.close(); }
});
