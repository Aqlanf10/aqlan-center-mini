/** Actual built-app HTTP + isolated native PostgreSQL journey. No production data,
 * no browser mock, no receipt deletion: global harness teardown owns the test DB. */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { authedGet, authedMutation, baseUrl, harness, loginStaff, TEST_USERS } from "./_server";
const KEY = "clinical.radiology_centers";
let h: Awaited<ReturnType<typeof harness>>, db: Client;
beforeAll(async () => { h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect(); }, 240_000);
afterAll(async () => { await db?.end(); });
type Actor = "doctorA" | "doctorB" | "admin" | "reception";
const read = (path: string, actor: Actor = "doctorA") => authedGet(path, h.sessions[actor]);
const post = (path: string, body: unknown, actor: Actor = "doctorA") => authedMutation(path, h.sessions[actor], "POST", JSON.stringify(body));
async function settings() {
  const response = await read("/api/settings", "admin"); expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, string> & { __versions: Record<string, string | null> }>;
}
async function saveSettings(values: Record<string, string>) {
  const current = await settings();
  return authedMutation("/api/settings", h.sessions.admin, "PATCH", JSON.stringify({ ...values, ...(KEY in values ? {__expectedActor:"secadmin"}:{}), __versions: Object.fromEntries(Object.keys(values).map(key => [key, current.__versions[key] ?? null])) }));
}
it("retains issued radiology snapshots and rechecks settings, clinical scope and reception print grant over real HTTP", async () => {
  const original = await settings();
  const { rows: doctors } = await db.query<{ id: number; username: string; party_id: number }>("SELECT id,username,party_id FROM users WHERE username=ANY($1::text[])", [["secdoctora", "secdoctorb"]]);
  const doctorA = doctors.find(row => row.username === "secdoctora")!.party_id;
  const doctorB = doctors.find(row => row.username === "secdoctorb")!.party_id;
  const { rows: [reception] } = await db.query<{ id: number; permissions: Record<string, unknown> | null }>("SELECT id,permissions FROM users WHERE username='secreception'");
  const patientName = `SYN-RAD-PATIENT-${randomUUID()}`;
  const { rows: [patient] } = await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id", [`RAD-${randomUUID()}`, patientName, doctorA]);
  const { rows: [other] } = await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'SYN-RAD-OTHER',$2) RETURNING id", [`RAD-${randomUUID()}`, doctorB]);
  const { rows: [visit] } = await db.query<{ id: number }>("INSERT INTO visits(patient_id,patient_name,doctor_id) VALUES($1,$2,$3) RETURNING id", [patient.id, patientName, doctorA]);
  const { rows: [wrongVisit] } = await db.query<{ id: number }>("INSERT INTO visits(patient_id,patient_name,doctor_id) VALUES($1,'SYN-RAD-OTHER',$2) RETURNING id", [other.id, doctorB]);
  const center = { id: randomUUID(), name: "SYN-RAD-CENTER", address: "SYN-RAD-ADDRESS شارع اصطناعي", active: true };
  const commandKey = randomUUID();
  const body = { __expectedActor:'secdoctora', __expectedUserId:doctors.find(row=>row.username==='secdoctora')!.id, commandKey, patientId: patient.id, visitId: visit.id, centerId: center.id, examination: "SYN-RAD-EXAM", region: "SYN-RAD-REGION", notes: "SYN-RAD-NOTES" };
  const history = `/api/patients/${patient.id}/radiology-requests?visitId=${visit.id}`;
  const recovery = `/api/radiology-requests/commands/${commandKey}?patientId=${patient.id}&visitId=${visit.id}`;
  const printPath = `/print/radiology-request/${commandKey}?patientId=${patient.id}`;
  const auditCount = async (action: string) => Number((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action=$1 AND entity_id=$2", [action, commandKey])).rows[0].n);
  const grant = async (enabled: boolean) => {
    const result = await authedMutation(`/api/users/${reception.id}`, h.sessions.admin, "PATCH", JSON.stringify({ permissions: { ...(reception.permissions ?? {}), canPrintRadiologyRequests: enabled } }));
    expect(result.status, await result.text()).toBe(200);
  };
  try {
    await grant(false);
    const before = await settings();
    for (const actor of ["doctorA", "reception"] as const) {
      const denied = await authedMutation("/api/settings", h.sessions[actor], "PATCH", JSON.stringify({ [KEY]: JSON.stringify([center]), __expectedActor: actor === "doctorA" ? "secdoctora" : "secreception", __versions: { [KEY]: before.__versions[KEY] ?? null } }));
      expect(denied.status).toBe(403);
    }
    expect((await saveSettings({ [KEY]: JSON.stringify([center]), "clinic.name": "SYN-RAD-CLINIC" })).status).toBe(200);
    const stale = await authedMutation("/api/settings", h.sessions.admin, "PATCH", JSON.stringify({ [KEY]: "[]", __expectedActor:"secadmin", __versions: { [KEY]: before.__versions[KEY] ?? null } })); expect(stale.status).toBe(409);
    expect((await read(history, "reception")).status).toBe(403);
    const options = await read(`${history}&mode=options`); expect(options.status).toBe(200); expect((await options.json()).centers).toEqual([center]);
    expect((await post("/api/radiology-requests", { ...body, visitId: wrongVisit.id })).status).toBe(404);
    expect((await post("/api/radiology-requests", {...body,__expectedActor:"secdoctorb",__expectedUserId:doctors.find(row=>row.username==="secdoctorb")!.id}, "doctorB")).status).toBe(403);
    const beforeOwnerRefusal=await db.query("SELECT command_key FROM radiology_requests WHERE command_key=$1",[commandKey]);
    expect((await post("/api/radiology-requests", body, "doctorB")).status).toBe(409);
    const {__expectedActor:_omitted,...withoutOwner}=body;
    expect((await post("/api/radiology-requests", withoutOwner)).status).toBe(409);
    expect((await db.query("SELECT command_key FROM radiology_requests WHERE command_key=$1",[commandKey])).rows).toEqual(beforeOwnerRefusal.rows);
    expect(await auditCount("radiology_request.create")).toBe(0);
    const issued = await post("/api/radiology-requests", body); expect(issued.status).toBe(200);
    const saved = await issued.json(); expect(saved).toMatchObject({ id: commandKey, patientId: patient.id, visitId: visit.id, replayed: false, snapshot: { version: 1, patientName, centerName: center.name, centerAddress: center.address, doctorId: doctorA } });
    const replay = await post("/api/radiology-requests", body); expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ ...saved, replayed: true });
    expect((await post("/api/radiology-requests", { ...body, notes: "DIFFERENT" })).status).toBe(409);
    const recovered = await read(recovery); expect(recovered.status).toBe(200); expect(recovered.headers.get("cache-control")).toContain("no-store"); expect(await recovered.json()).toMatchObject({ state: "completed", id: commandKey });
    const unknown = await read(`/api/radiology-requests/commands/${randomUUID()}?patientId=${patient.id}&visitId=${visit.id}`); expect(unknown.status).toBe(200); expect(await unknown.json()).toEqual({ state: "unknown" });
    expect((await read(recovery, "doctorB")).status).toBe(403);
    const listed = await read(history); expect(listed.status).toBe(200); expect(await listed.json()).toMatchObject({ canIssue: true, requests: [{ id: commandKey }], nextCursor: null });
    expect((await read(`/api/patients/${patient.id}/radiology-requests?visitId=${wrongVisit.id}`)).status).toBe(404);
    const immutable = (await db.query("SELECT to_jsonb(r)::text AS row FROM radiology_requests r WHERE command_key=$1", [commandKey])).rows[0].row;
    expect((await saveSettings({ [KEY]: JSON.stringify([{ ...center, name: "CHANGED-CENTER", address: "CHANGED-ADDRESS", active: false }]) })).status).toBe(200);
    // In the focused workflow this is the first HTML request: do not prewarm or retry.
    const html = await read(printPath); expect(html.status).toBe(200); const source = await html.text();
    for (const marker of ["radiology-a6", patientName, center.name, center.address, body.examination, body.notes, commandKey]) expect(source).toContain(marker);
    expect(source).not.toContain("CHANGED-CENTER");
    expect((await db.query("SELECT to_jsonb(r)::text AS row FROM radiology_requests r WHERE command_key=$1", [commandKey])).rows).toEqual([{ row: immutable }]);
    expect((await read(`/print/radiology-request/${randomUUID()}?patientId=${patient.id}`)).status).toBe(404);
    expect((await read(`/print/radiology-request/${commandKey}?patientId=${other.id}`)).status).toBe(404);
    expect((await post("/api/radiology-requests", { ...body, commandKey: randomUUID() })).status).toBe(409);
    await grant(true);
    const receptionList = await read(history, "reception"); expect(receptionList.status).toBe(200); expect(await receptionList.json()).toMatchObject({ canIssue: false, requests: [{ id: commandKey }] });
    expect((await read(printPath, "reception")).status).toBe(200);
    expect((await post("/api/radiology-requests", { ...body, commandKey: randomUUID() }, "reception")).status).toBe(403);
    expect((await read(`${history}&mode=options`, "reception")).status).toBe(403);
    expect((await read(recovery, "reception")).status).toBe(403);
    expect((await post(`/api/radiology-requests/${commandKey}/print`, { patientId: other.id }, "reception")).status).toBe(404);
    expect(await auditCount("radiology_request.print")).toBe(0);
    const authorized = await post(`/api/radiology-requests/${commandKey}/print`, { patientId: patient.id }, "reception"); expect(authorized.status).toBe(200); expect(await authorized.json()).toEqual({ allowed: true, id: commandKey, patientId: patient.id });
    expect(await auditCount("radiology_request.print")).toBe(1);
    await grant(false);
    expect((await post(`/api/radiology-requests/${commandKey}/print`, { patientId: patient.id }, "reception")).status).toBe(403);
    expect((await read(history, "reception")).status).toBe(403); expect((await read(printPath, "reception")).status).toBe(404);
    expect(await auditCount("radiology_request.print")).toBe(1); expect(await auditCount("radiology_request.create")).toBe(1);
    expect((await db.query("SELECT to_jsonb(r)::text AS row FROM radiology_requests r WHERE command_key=$1", [commandKey])).rows).toEqual([{ row: immutable }]);
    expect(Number((await db.query("SELECT count(*)::int AS n FROM radiology_requests WHERE patient_id=$1", [patient.id])).rows[0].n)).toBe(1);
  } finally {
    // Restore only mutable isolated-harness settings/grants; never erase issued history.
    try { const restored = await saveSettings({ [KEY]: original[KEY], "clinic.name": original["clinic.name"] }); expect(restored.status).toBe(200); }
    finally { await db.query("UPDATE users SET permissions=$1 WHERE id=$2", [reception.permissions, reception.id]); }
  }
}, 120_000);

it("rejects disallowed reception before malformed clinical fields while retaining admitted validation", async () => {
  expect((await post('/api/radiology-requests', {}, 'reception')).status).toBe(403);
  expect((await read('/api/radiology-requests/commands/invalid', 'reception')).status).toBe(403);
  expect((await post('/api/radiology-requests', {__expectedActor:'secdoctora',__expectedUserId:(await db.query("SELECT id FROM users WHERE username='secdoctora'")).rows[0].id}, 'doctorA')).status).toBe(400);
  expect((await read('/api/radiology-requests/commands/invalid', 'doctorA')).status).toBe(400);
  expect((await post('/api/radiology-requests/invalid/print', {}, 'doctorA')).status).toBe(400);
  expect((await read('/api/patients/invalid/radiology-requests', 'doctorA')).status).toBe(400);
});


it("keeps the real account page inert and restores a pending radiology key only after explicit entry", async () => {
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  try {
    const [name,...value]=h.sessions.doctorA.cookie.split('=');
    await context.addCookies([{name,value:value.join('='),url:baseUrl}]);
    const pendingKey=randomUUID(),storageKey=`radiology-request:v1:${JSON.stringify(['secdoctora',h.seeded.patientAId,null])}`;
    await context.addInitScript(({storageKey,pendingKey})=>{
      sessionStorage.setItem(storageKey,pendingKey);
      const reads:string[]=[];Object.assign(window,{__radiologyStorageReads:reads});
      const get=Storage.prototype.getItem;
      Storage.prototype.getItem=function(key:string){if(this===sessionStorage&&key.startsWith('radiology-request:'))reads.push(key);return get.call(this,key);};
    },{storageKey,pendingKey});
    const page=await context.newPage(),writes:string[]=[];
    page.on('request',request=>{if(request.url().includes('/api/radiology-requests')&&request.method()==='POST')writes.push(request.method());});
    const response=await page.goto(`${baseUrl}/patients/${h.seeded.patientAId}?tab=account`,{waitUntil:'domcontentloaded'});
    expect(response?.status()).toBe(200);
    const entry=page.getByRole('button',{name:'فتح طلبات الأشعة',exact:true});
    await entry.waitFor({state:'visible'});
    await expect.poll(()=>entry.isEnabled()).toBe(true);
    const reads=()=>page.evaluate(()=>((window as unknown as {__radiologyStorageReads:string[]}).__radiologyStorageReads));
    expect(await reads()).toEqual([]);
    expect(writes).toEqual([]);
    await entry.click();
    await expect.poll(reads).toEqual([storageKey]);
    await expect.poll(()=>page.getByRole('status').allTextContents()).toContain('يوجد طلب سابق؛ تحقق من نتيجته قبل إصدار طلب آخر.');
    expect(await page.getByRole('button',{name:'إعادة نفس الطلب بأمان',exact:true}).isDisabled()).toBe(true);
    expect(writes).toEqual([]);
  } finally {await context.close();await browser.close();}
},60_000);

it("refuses an admin A centers draft after real cookie switch to B, then accepts B's newly loaded draft", async()=>{
 const original=await settings(),username=`rad-admin-b-${randomUUID()}`;
 await db.query("INSERT INTO users(username,display_name,password_hash,role,is_active) SELECT $1,'Synthetic admin B',password_hash,'admin',true FROM users WHERE username='secadmin'",[username]);
 const adminB=await loginStaff(username,TEST_USERS.admin.password);
 const center={id:randomUUID(),name:'SYN-CENTERS-OWNER',address:'SYN-ORIGINAL-ADDRESS',active:true};
 const snapshot=async()=>({setting:(await db.query('SELECT value,updated_at::text FROM settings WHERE key=$1',[KEY])).rows,audits:(await db.query("SELECT id,actor FROM audit_log WHERE entity='clinic_setting' AND entity_id=$1 ORDER BY id",[KEY])).rows});
 let browser:Browser|undefined,context:BrowserContext|undefined;
 const cookie=async(context:BrowserContext,value:string)=>{const[name,...parts]=value.split('=');await context.addCookies([{name,value:parts.join('='),url:baseUrl}]);};
 try{
  expect((await saveSettings({[KEY]:JSON.stringify([center])})).status).toBe(200);
  const before=await snapshot();
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
  context=await browser.newContext({viewport:{width:1280,height:900}});
  await cookie(context,h.sessions.admin.cookie);const page=await context.newPage();expect((await page.goto(`${baseUrl}/settings/radiology`,{waitUntil:'domcontentloaded'}))?.status()).toBe(200);
  await page.getByRole('button',{name:'تعديل مراكز الأشعة',exact:true}).click();await page.getByLabel('العنوان 1',{exact:true}).fill('SYN-STALE-A-DRAFT');
  // Cookie changes without page reload: the visible old owner must not acquire B authority.
  await cookie(context,adminB.cookie);
  const refused=page.waitForResponse(r=>r.url()===`${baseUrl}/api/settings`&&r.request().method()==='PATCH');
  await page.getByRole('button',{name:'حفظ المراكز',exact:true}).click();expect((await refused).status()).toBe(409);
  expect(await snapshot()).toEqual(before);expect(await page.getByLabel('العنوان 1',{exact:true}).inputValue()).toBe('SYN-STALE-A-DRAFT');
  await expect.poll(()=>page.getByRole('button',{name:'حفظ المراكز',exact:true}).isDisabled()).toBe(true);
  await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'تعديل مراكز الأشعة',exact:true}).click();
  expect(await page.getByLabel('العنوان 1',{exact:true}).inputValue()).toBe(center.address);
  await page.getByLabel('العنوان 1',{exact:true}).fill('SYN-FRESH-B-DRAFT');
  const accepted=page.waitForResponse(r=>r.url()===`${baseUrl}/api/settings`&&r.request().method()==='PATCH');
  await page.getByRole('button',{name:'حفظ المراكز',exact:true}).click();expect((await accepted).status()).toBe(200);
  expect((await db.query("SELECT actor FROM audit_log WHERE entity='clinic_setting' AND entity_id=$1 AND actor=$2",[KEY,username])).rows).toEqual([{actor:username}]);
  expect(JSON.parse((await db.query('SELECT value FROM settings WHERE key=$1',[KEY])).rows[0].value)).toEqual([{...center,address:'SYN-FRESH-B-DRAFT'}]);
 }finally{
  try{await context?.close();}finally{try{await browser?.close();}finally{expect((await saveSettings({[KEY]:original[KEY]})).status).toBe(200);}}
 }
},90_000);

it('refuses a clinician draft after a real cookie switch and issues the same command only after its original actor returns',async()=>{
 const original=await settings();
 const center={id:randomUUID(),name:'SYN-DRAFT-OWNER-CENTER',address:'SYN-DRAFT-OWNER-ADDRESS',active:true};
 const examination=`SYN-DRAFT-OWNER-${randomUUID()}`;
 let browser:Browser|undefined,context:BrowserContext|undefined;
 const cookie=async(value:string)=>{const[name,...parts]=value.split('=');await context!.addCookies([{name,value:parts.join('='),url:baseUrl}]);};
 const issued=async()=> (await db.query("SELECT command_key,actor_username,snapshot FROM radiology_requests WHERE patient_id=$1 AND snapshot->>'examination'=$2",[h.seeded.patientAId,examination])).rows;
 try{
  expect((await saveSettings({[KEY]:JSON.stringify([center])})).status).toBe(200);
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
  context=await browser.newContext({viewport:{width:1280,height:900}});await cookie(h.sessions.doctorA.cookie);
  const page=await context.newPage();expect((await page.goto(`${baseUrl}/patients/${h.seeded.patientAId}?tab=account`,{waitUntil:'domcontentloaded'}))?.status()).toBe(200);
  await page.getByRole('button',{name:'فتح طلبات الأشعة',exact:true}).click();
  await page.getByRole('button',{name:'عرض / تحديث السجل',exact:true}).click();
  await page.getByRole('button',{name:'طلب أشعة جديد',exact:true}).click();
  await page.getByLabel('مركز الأشعة',{exact:true}).selectOption(center.id);
  await page.getByLabel('نوع الأشعة المطلوبة',{exact:true}).fill(examination);
  await page.getByLabel('المنطقة / الأسنان المطلوبة',{exact:true}).fill('SYN-DRAFT-OWNER-REGION');
  await cookie(h.sessions.doctorB.cookie);
  const refused=page.waitForResponse(r=>r.url()===`${baseUrl}/api/radiology-requests`&&r.request().method()==='POST');
  await page.getByRole('button',{name:'إصدار وحفظ الطلب',exact:true}).click();
  const rejected=await refused;expect(rejected.status()).toBe(409);
  const originalCommand=rejected.request().postDataJSON();expect(originalCommand.__expectedActor).toBe('secdoctora');expect(originalCommand.__expectedUserId).toBe((await db.query("SELECT id FROM users WHERE username='secdoctora'")).rows[0].id);
  expect(await issued()).toEqual([]);
  expect((await db.query("SELECT id FROM audit_log WHERE action='radiology_request.create' AND entity_id=$1",[originalCommand.commandKey])).rows).toEqual([]);
  expect(await page.getByRole('link',{name:'طباعة الطلب المحفوظ — ربع ورقة A6',exact:true}).count()).toBe(0);
  await cookie(h.sessions.doctorA.cookie);
  const accepted=page.waitForResponse(r=>r.url()===`${baseUrl}/api/radiology-requests`&&r.request().method()==='POST');
  await page.getByRole('button',{name:'إعادة نفس الطلب بأمان',exact:true}).click();
  const saved=await accepted;expect(saved.status()).toBe(200);expect(saved.request().postDataJSON()).toEqual(originalCommand);
  const records=await issued();expect(records).toHaveLength(1);expect(records[0]).toMatchObject({command_key:originalCommand.commandKey,actor_username:'secdoctora',snapshot:{centerName:center.name,centerAddress:center.address,examination}});
  const printLink=page.getByRole('link',{name:'طباعة الطلب المحفوظ — ربع ورقة A6',exact:true});await printLink.waitFor({state:'visible'});
  expect(await printLink.getAttribute('href')).toBe(`/print/radiology-request/${originalCommand.commandKey}?patientId=${h.seeded.patientAId}`);
  expect((await db.query("SELECT actor FROM audit_log WHERE action='radiology_request.create' AND entity_id=$1",[originalCommand.commandKey])).rows).toEqual([{actor:'secdoctora'}]);
 }finally{
  try{await context?.close();}finally{try{await browser?.close();}finally{expect((await saveSettings({[KEY]:original[KEY]})).status).toBe(200);}}
 }
},90_000);
