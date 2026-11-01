/** Synthetic assessment append contract, independently scoped from saved reads. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
const ACCOUNTS = {
  reader: { username: "canon-oaw-reader", password: "Canon#OAWReader1", role: "admin", display: "قارئ اصطناعي", patientScope: "all", grants: { "clinical.ortho.view": true } },
  none: { username: "canon-oaw-none", password: "Canon#OAWNone1", role: "doctor", doctor: true, display: "بلا نطاق", patientScope: "none", grants: { "clinical.ortho.view": true, "clinical.ortho.edit": true } },
  owner: { username: "canon-oaw-owner", password: "Canon#OAWOwner1", role: "admin", display: "مالك اصطناعي" },
  doctor: { username: "canon-oaw-doctor", password: "Canon#OAWDoctor1", role: "doctor", doctor: true, display: "طبيب اصطناعي", patientScope: "own", grants: { "clinical.ortho.view": true, "clinical.ortho.edit": true } },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
let caseId = 0, patientId = 0, outsideCase = 0;
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 101, secret: "canonical-assessment-write-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _accounts, parties) {
      const patient = (await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-OAW-1','مريض اصطناعي',$1) RETURNING id", [parties.doctor!])).rows[0].id;
      patientId = patient;
      caseId = (await db.query("INSERT INTO ortho_cases(patient_id,status,created_by,responsible_doctor_id) VALUES($1,'active','SYN',$2) RETURNING id", [patient,parties.doctor!])).rows[0].id;
      const outside = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-OAW-OUTSIDE','مريض خارجي اصطناعي') RETURNING id")).rows[0].id;
      outsideCase = (await db.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id",[outside])).rows[0].id;
      await db.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN explicit bridge',$2,'SYN')", [patient,caseId]);
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
it("HTTP: a scoped canonical editor appends its valid schema2 assessment and retries the exact receipt", async () => {
  const session = await journey.login("doctor"); expect(session.status).toBe(200);
  const path = `/api/ortho/${caseId}/assessment`;
  expect((await journey.api(`${path}?acceptSchema=2`,session.cookie)).status).toBe(200);
  const body = JSON.stringify(assessmentCommandV2());
  const response = await journey.api(path,session.cookie,{method:"POST",body});
  expect(response.status).toBe(201);
  const saved = await response.json(); expect(saved).toMatchObject({ok:true,replayed:false,revision:{version:1,schemaVersion:2}});
  const again = await journey.api(path,session.cookie,{method:"POST",body}); expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ok:true,replayed:true,revision:{id:saved.revision.id,version:1}});
  expect(await journey.ddlLog()).toEqual([]);
});

async function openAssessment(page: import("playwright").Page, key: keyof typeof ACCOUNTS = "doctor", loggedIn = false) {
  if (!loggedIn) await journey.browserLogin(page,key);
  await page.goto(`${journey.baseUrl}/patients/${patientId}`);
  await page.getByRole("button", {name:"عرض حالات التقويم",exact:true}).click();
  await page.getByRole("button", {name:"عرض تفاصيل الحالة",exact:true}).click();
  await page.getByRole("button", {name:"عرض التقييم والقياسات",exact:true}).click();
  const panel=page.getByTestId("canonical-ortho-assessment");
  await panel.getByTestId("assessment-v2-saved").waitFor(); return panel;
}
it("HTTP: anonymous, read-only and none refuse; outside equals missing with no legacy fallback",async()=>{
  const path=`/api/ortho/${caseId}/assessment`,body=JSON.stringify(assessmentCommandV2());
  expect((await journey.api(path,"",{method:"POST",body})).status).toBe(401);
  for(const key of["reader","none"]as const){const login=await journey.login(key),r=await journey.api(path,login.cookie,{method:"POST",body});expect(r.status).toBe(403);expect(r.headers.get("cache-control")).toContain("no-store");}
  const login=await journey.login("doctor"),responses=[];
  for(const id of[outsideCase,2147483647]){const r=await journey.api(`/api/ortho/${id}/assessment`,login.cookie,{method:"POST",body});expect(r.status).toBe(404);responses.push(await r.json());}
  expect(responses[0]).toEqual(responses[1]);expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: malformed commands, ambiguous query and unsupported schema do not alter the saved head",async()=>{
  const login=await journey.login("doctor"),before=(await journey.db.query("SELECT id,content_sha256 FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY id",[caseId])).rows;
  for(const body of[{...assessmentCommandV2(),schemaVersion:1},{...assessmentCommandV2(),force:true},{...assessmentCommandV2(),reason:["SYN"]}]){
    const r=await journey.api(`/api/ortho/${caseId}/assessment`,login.cookie,{method:"POST",body:JSON.stringify(body)});expect(r.status).toBe(400);expect(r.headers.get("cache-control")).toContain("no-store");
  }
  expect((await journey.api(`/api/ortho/${caseId}/assessment?force=1`,login.cookie,{method:"POST",body:JSON.stringify(assessmentCommandV2())})).status).toBe(400);
  expect((await journey.db.query("SELECT id,content_sha256 FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY id",[caseId])).rows).toEqual(before);
});
it("browser: the existing editor survives parent refresh and reconciles a lost response with the exact receipt at 390px",async()=>{
  const context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar",timezoneId:"America/Los_Angeles"});
  try{
    const page=await context.newPage();await journey.browserLogin(page,"doctor");const calls:string[]=[];
    page.on("request",request=>{const path=new URL(request.url()).pathname;if(path.startsWith("/api/"))calls.push(`${request.method()} ${path}`);});
    let panel=await openAssessment(page,"doctor",true);
    await panel.getByRole("button",{name:"فتح مراجعة تصحيحية من النسخة الحالية",exact:true}).click();
    await panel.getByLabel("سبب إنشاء هذه المراجعة").fill("SYN retained canonical clinical draft");
    await panel.getByLabel("قيمة السن 11 (mm)",{exact:true}).fill("7.5");
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await page.getByRole("button",{name:"عرض تفاصيل الحالة",exact:true}).click();
    await page.getByRole("button",{name:"عرض التقييم والقياسات",exact:true}).click();
    panel=page.getByTestId("canonical-ortho-assessment");
    expect(await panel.getByLabel("سبب إنشاء هذه المراجعة").inputValue()).toBe("SYN retained canonical clinical draft");
    expect(await panel.getByLabel("قيمة السن 11 (mm)",{exact:true}).inputValue()).toBe("7.5");
    const path=`**/api/ortho/${caseId}/assessment`;let posts=0;
    await page.route(path,async route=>{if(route.request().method()!=="POST")return route.continue();posts++;const response=await route.fetch();expect(response.status()).toBe(201);await route.abort("failed");});
    await panel.getByRole("button",{name:"حفظ مراجعة تقييم جديدة",exact:true}).click();
    await panel.getByRole("button",{name:"التحقق بإعادة نفس طلب الحفظ",exact:true}).waitFor();
    expect(posts).toBe(1);
    const committed=(await journey.db.query("SELECT id,version,content_sha256,content FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version",[caseId])).rows;expect(committed).toHaveLength(2);
    expect(await panel.getByLabel("سبب إنشاء هذه المراجعة").isDisabled()).toBe(true);
    await page.unroute(path);
    await panel.getByRole("button",{name:"التحقق بإعادة نفس طلب الحفظ",exact:true}).click();
    await panel.getByText("السجل المحفوظ: نسخة 2",{exact:true}).waitFor();
    expect(await panel.getByTestId("assessment-v2-draft").count()).toBe(0);
    expect((await journey.db.query("SELECT id,version,content_sha256,content FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version",[caseId])).rows).toEqual(committed);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    expect(calls.filter(call=>!new RegExp(`^(GET /api/(auth/me|patients/${patientId}(/(contact|timeline))?|ortho(/${caseId}(/assessment)?)?)|POST /api/(auth/login|ortho/${caseId}/assessment))$`).test(call))).toEqual([]);
  }finally{await context.close();}
  expect(await journey.ddlLog()).toEqual([]);
});
it("browser: view-only authority never mounts an assessment editor",async()=>{
  const context=await journey.browser.newContext();try{const panel=await openAssessment(await context.newPage(),"reader");expect(await panel.getByRole("button",{name:/فتح مراجعة|بدء تقييم|حفظ/}).count()).toBe(0);expect(await panel.locator("textarea,input").count()).toBe(0);}finally{await context.close();}
});
it("browser and HTTP: revoked edit authority clears the draft and cannot be recovered by an old cookie or fresh reader",async()=>{
  const original=(await journey.db.query("SELECT permissions FROM users WHERE id=$1",[journey.ids.doctor])).rows[0].permissions,context=await journey.browser.newContext();
  try{
    const stale=await journey.login("doctor"),page=await context.newPage(),panel=await openAssessment(page);
    await panel.getByRole("button",{name:"فتح مراجعة تصحيحية من النسخة الحالية",exact:true}).click();await panel.getByLabel("سبب إنشاء هذه المراجعة").fill("SYN denied private draft");
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ortho.edit}','false')::text WHERE id=$1",[journey.ids.doctor]);
    await panel.getByRole("button",{name:"تحديث سجل التقييم",exact:true}).click();
    await page.getByText("انتهت صلاحية التوثيق. أعد التحقق من الجلسة قبل فتح أي مسودة.",{exact:true}).waitFor();
    expect(await page.getByTestId("assessment-v2-draft").count()).toBe(0);expect(await page.locator("body").textContent()).not.toContain("SYN denied private draft");
    const body=JSON.stringify(assessmentCommandV2()),path=`/api/ortho/${caseId}/assessment`;
    expect((await journey.api(path,stale.cookie,{method:"POST",body})).status).toBe(401);
    const fresh=await journey.login("doctor");expect((await journey.api(path,fresh.cookie,{method:"POST",body})).status).toBe(403);
  }finally{await context.close();await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2",[original,journey.ids.doctor]);}
});

it("browser: a committed reply arriving after parent refresh cannot settle a retired view or duplicate its revision", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  let release!: () => void, reached!: () => void, finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const done = new Promise<void>(resolve => { finished = resolve; });
  let intercepted = false;
  try {
    const page = await context.newPage();
    let panel = await openAssessment(page);
    await panel.getByRole("button", { name: "فتح مراجعة تصحيحية من النسخة الحالية", exact: true }).click();
    await panel.getByLabel("سبب إنشاء هذه المراجعة").fill("SYN parent refresh during committed append");
    const requests: string[] = [], path = `**/api/ortho/${caseId}/assessment`;
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === `/api/ortho/${caseId}/assessment`) requests.push(request.postData()!); });
    await page.route(path, async route => {
      if (route.request().method() !== "POST") return route.continue();
      intercepted = true;
      try {
        const response = await route.fetch(); expect(response.status()).toBe(201);
        reached(); await held; await route.fulfill({ response });
      } finally { finished(); }
    });
    await panel.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click();
    await ready;
    await page.getByRole("button", { name: "تحديث الحالات", exact: true }).click();
    await page.getByRole("button", { name: "عرض تفاصيل الحالة", exact: true }).click();
    await page.getByRole("button", { name: "عرض التقييم والقياسات", exact: true }).click();
    panel = page.getByTestId("canonical-ortho-assessment");
    await panel.getByText("السجل المحفوظ: نسخة 3", { exact: true }).waitFor();
    expect(await panel.getByLabel("سبب إنشاء هذه المراجعة").inputValue()).toBe("SYN parent refresh during committed append");
    expect(await panel.getByRole("button", { name: "التحقق بإعادة نفس طلب الحفظ", exact: true }).isDisabled()).toBe(true);
    release(); await done;
    const retry = panel.getByRole("button", { name: "التحقق بإعادة نفس طلب الحفظ", exact: true });
    await expect.poll(() => retry.isEnabled()).toBe(true);
    await page.getByRole("button", { name: "إغلاق الحالات", exact: true }).click();
    expect(await page.getByTestId("canonical-ortho-cases").count()).toBe(1);
    expect(requests).toHaveLength(1);
    const before = (await journey.db.query("SELECT id,version,content_sha256,content FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version", [caseId])).rows;
    await page.unroute(path); await retry.click();
    await expect.poll(() => panel.getByTestId("assessment-v2-draft").count()).toBe(0);
    expect(requests).toHaveLength(2); expect(requests[1]).toBe(requests[0]);
    expect((await journey.db.query("SELECT id,version,content_sha256,content FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version", [caseId])).rows).toEqual(before);
  } finally { release(); if (intercepted) await done; await context.close(); }
});

it("browser: an explicitly linked empty case starts an unfilled assessment without fabricated measurements or financial effects", async () => {
  const patient = (await journey.db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-OAW-EMPTY','تقييم اصطناعي غير معبأ',$1) RETURNING id", [journey.parties.doctor])).rows[0].id;
  const ortho = (await journey.db.query("INSERT INTO ortho_cases(patient_id,status,created_by,responsible_doctor_id) VALUES($1,'active','SYN',$2) RETURNING id", [patient, journey.parties.doctor])).rows[0].id;
  await journey.db.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN empty bridge',$2,'SYN')", [patient, ortho]);
  const effects = async () => (await journey.db.query("SELECT (SELECT count(*) FROM invoices)::int invoices,(SELECT count(*) FROM treatment_plans)::int plans,(SELECT count(*) FROM patient_medical_history)::int medical")).rows;
  const before = await effects(), context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try {
    const page = await context.newPage(); await journey.browserLogin(page, "doctor");
    await page.goto(`${journey.baseUrl}/patients/${patient}`);
    await page.getByRole("button", { name: "عرض حالات التقويم", exact: true }).click();
    await page.getByRole("button", { name: "عرض تفاصيل الحالة", exact: true }).click();
    await page.getByRole("button", { name: "عرض التقييم والقياسات", exact: true }).click();
    const panel = page.getByTestId("canonical-ortho-assessment");
    await panel.getByRole("button", { name: "بدء تقييم غير معبأ", exact: true }).click();
    await panel.getByLabel("سبب إنشاء هذه المراجعة").fill("SYN explicit unfilled record; findings not measured");
    await panel.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click();
    await panel.getByText("السجل المحفوظ: نسخة 1", { exact: true }).waitFor();
    expect(await panel.getByTestId("assessment-v2-draft").count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const rows = (await journey.db.query("SELECT content FROM ortho_assessment_revisions WHERE ortho_case_id=$1", [ortho])).rows;
    expect(rows).toHaveLength(1);
    const observations = rows[0].content.draft.observations.observations;
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((row: { value: { state: string } }) => row.value.state === "not_recorded")).toBe(true);
    expect(await effects()).toEqual(before);
    if (process.env.HR_EVIDENCE_DIR) {
      mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "canonical-assessment-empty-saved-390.png"), fullPage: true });
    }
  } finally { await context.close(); }
  expect(await journey.ddlLog()).toEqual([]);
});
it("browser: detail-only unmount keeps an unacknowledged assessment receipt until explicit identical replay",async()=>{
  const context=await journey.browser.newContext();let release!:()=>void,reached!:()=>void,finished!:()=>void,intercepted=false,responseStatus=0;
  const held=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{reached=r;}),done=new Promise<void>(r=>{finished=r;});
  try{const page=await context.newPage();let panel=await openAssessment(page);await panel.getByRole("button",{name:"فتح مراجعة تصحيحية من النسخة الحالية",exact:true}).click();await panel.getByLabel("سبب إنشاء هذه المراجعة").fill("SYN assessment detail-only retired reply");
    const path=`**/api/ortho/${caseId}/assessment`,requests:string[]=[];page.on("request",r=>{if(r.method()==="POST"&&new URL(r.url()).pathname===`/api/ortho/${caseId}/assessment`)requests.push(r.postData()!);});
    await page.route(path,async route=>{if(route.request().method()!=="POST")return route.continue();intercepted=true;try{const response=await route.fetch({timeout:15000});responseStatus=response.status();if(responseStatus!==201)console.log("assessment detail witness refusal",responseStatus,await response.text());reached();await held;await route.fulfill({response});}finally{reached();finished();}});
    await panel.getByRole("button",{name:"حفظ مراجعة تقييم جديدة",exact:true}).click();await ready;expect(responseStatus).toBe(201);await page.getByRole("button",{name:"تحديث التفاصيل",exact:true}).click();await page.getByRole("button",{name:"عرض التقييم والقياسات",exact:true}).waitFor();
    const returned=page.waitForResponse(r=>r.request().method()==="POST"&&new URL(r.url()).pathname===`/api/ortho/${caseId}/assessment`);release();await done;await returned;await page.waitForTimeout(200);
    await page.getByRole("button",{name:"عرض التقييم والقياسات",exact:true}).click();panel=page.getByTestId("canonical-ortho-assessment");const retry=panel.getByRole("button",{name:"التحقق بإعادة نفس طلب الحفظ",exact:true});await retry.waitFor({timeout:2500});await expect.poll(()=>retry.isEnabled()).toBe(true);
    expect(await panel.getByLabel("سبب إنشاء هذه المراجعة").inputValue()).toBe("SYN assessment detail-only retired reply");expect(requests).toHaveLength(1);
    const committed=(await journey.db.query("SELECT id,version,content_sha256,content FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version",[caseId])).rows;await page.unroute(path);await retry.click();await expect.poll(()=>panel.getByTestId("assessment-v2-draft").count()).toBe(0);expect(requests[1]).toBe(requests[0]);
    expect((await journey.db.query("SELECT id,version,content_sha256,content FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version",[caseId])).rows).toEqual(committed);
  }finally{release();if(intercepted)await done;await context.close();}
});
