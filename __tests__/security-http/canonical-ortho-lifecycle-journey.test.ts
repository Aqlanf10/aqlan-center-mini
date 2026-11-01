import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
const ANALYZE = { "clinical.ortho.view": true, "clinical.ortho.edit": true };
const ACCOUNTS = {
  owner: { username: "canon-lifecycle-owner", password: "Canon#LifecycleOwner1", role: "admin", display: "المالك التجريبي" },
  own: { username: "canon-lifecycle-own", password: "Canon#LifecycleOwn1", role: "doctor", doctor: true, display: "محلل تجريبي", patientScope: "own", grants: ANALYZE },
  all: { username: "canon-lifecycle-all", password: "Canon#LifecycleAll1", role: "reception", display: "محلل شامل تجريبي", patientScope: "all", grants: ANALYZE },
  read: { username: "canon-lifecycle-read", password: "Canon#LifecycleRead1", role: "admin", display: "قارئ تجريبي", patientScope: "all", grants: { "clinical.ortho.view": true } },
  none: { username: "canon-lifecycle-none", password: "Canon#LifecycleNone1", role: "doctor", doctor: true, display: "بلا نطاق", patientScope: "none", grants: ANALYZE },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>, sequence = 0, patientId: number, caseId: number;
beforeAll(async () => { journey = await openCanonicalJourney({ portOffset: 70, secret: "canonical-ortho-lifecycle-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed() {} }); }, 300000);
afterAll(async () => { await journey?.close(); }, 60000);
beforeEach(async () => {
  patientId = (await journey.db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'SYN case lifecycle patient',$2) RETURNING id", [`SYN-ORTHO-LIFECYCLE-${++sequence}`, journey.parties.own])).rows[0].id;
  caseId=(await journey.db.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id",[patientId])).rows[0].id;

});
const mutate = (cookie: string, id: number, body: unknown) => journey.api(`/api/ortho/${id}`, cookie, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function version(cookie: string, id = caseId) { const response = await journey.api(`/api/ortho/${id}`, cookie); expect(response.status).toBe(200); return (await response.json()).editVersion as string; }
it("HTTP: scoped orthodontic editor changes phase and audits without funding authority",async()=>{
 const cookie=(await journey.login("own")).cookie,response=await mutate(cookie,caseId,{expectedVersion:await version(cookie),phase:"finishing"});expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,caseId,status:"active"});expect((await journey.db.query("SELECT phase,status FROM ortho_cases WHERE id=$1",[caseId])).rows).toEqual([{phase:"finishing",status:"active"}]);expect(await audits()).toBe(1);
});
const audits = async () => Number((await journey.db.query("SELECT count(*)::int n FROM audit_log WHERE action='ortho.case_update' AND entity_id=$1", [String(caseId)])).rows[0].n);
it.each(["owner", "all"] as const)("HTTP: %s updates one observed native case with minimal no-store acknowledgment", async key => {
  const cookie = (await journey.login(key)).cookie, response = await mutate(cookie, caseId, { expectedVersion: await version(cookie), phase: "finishing" });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store"); expect(Object.keys(await response.json()).sort()).toEqual(["caseId", "ok", "status"]); expect(await audits()).toBe(1); expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: anonymous, reader, none and foreign patients refuse without effects", async () => {
  const owner = (await journey.login("owner")).cookie, input = { expectedVersion: await version(owner), phase: "finishing" };
  expect((await mutate("", caseId, input)).status).toBe(401);
  for (const key of ["read", "none"] as const) expect((await mutate((await journey.login(key)).cookie, caseId, input)).status).toBe(403);
  await journey.db.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [patientId]); const own = (await journey.login("own")).cookie;
  const foreign = await mutate(own, caseId, input), absent = await mutate(own, 2147483647, input); expect(foreign.status).toBe(404); expect(absent.status).toBe(404); expect(await foreign.json()).toEqual(await absent.json()); expect(await audits()).toBe(0);
});
it("HTTP: strict single clinical operation and independent plan authority",async()=>{
 const cookie=(await journey.login("own")).cookie,expectedVersion=await version(cookie);
 for(const body of [null,[],{},{expectedVersion,phase:["working"]},{expectedVersion,phase:"working",force:true},{expectedVersion,phase:"working",retainer:"none"}])expect((await mutate(cookie,caseId,body)).status).toBe(400);
 const funding=await mutate(cookie,caseId,{expectedVersion,planId:null});expect(funding.status).toBe(403);expect((await funding.json()).code).toBe("STAFF_OPERATION_CAPABILITY_DENIED");
 expect((await journey.api(`/api/ortho/${caseId}?force=1`,cookie,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedVersion,phase:"working"})})).status).toBe(400);expect(await audits()).toBe(0);
});
it("HTTP: retainer and terminal state keep explicit none and no-reopen rules",async()=>{
 const cookie=(await journey.login("own")).cookie,input={expectedVersion:await version(cookie),status:"completed",note:null};expect((await mutate(cookie,caseId,input)).status).toBe(409);expect(await audits()).toBe(0);
 expect((await mutate(cookie,caseId,{expectedVersion:await version(cookie),retainer:"none"})).status).toBe(200);
 const close={expectedVersion:await version(cookie),status:"completed",note:"SYN done"};expect((await mutate(cookie,caseId,close)).status).toBe(200);expect((await mutate(cookie,caseId,close)).status).toBe(409);expect(await audits()).toBe(2);
});
async function openEditor(page: import("playwright").Page, key: keyof typeof ACCOUNTS = "own", signed = false, arm = true) {
  page.setDefaultTimeout(10000); if (!signed) await journey.browserLogin(page, key); await page.goto(`${journey.baseUrl}/patients/${patientId}`);
  await page.getByRole("button", { name: "عرض حالات التقويم", exact: true }).click(); await page.getByRole("button", { name: "عرض تفاصيل الحالة", exact: true }).click();
  const editor = page.getByTestId("canonical-ortho-lifecycle"); await editor.waitFor();
  if (arm) { await editor.getByRole("button", { name: "تحديث مرحلة أو مثبت أو إقفال الحالة", exact: true }).click(); await editor.getByLabel("المرحلة الجديدة",{exact:true}).selectOption("finishing"); }
  return editor;
}
it("browser: 390px explicit phase update sends once and refreshes the summary", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try { const page = await context.newPage(), editor = await openEditor(page); let sends = 0; page.on("request", r => { if (r.method() === "PATCH" && new URL(r.url()).pathname === `/api/ortho/${caseId}`) sends++; });
    if (process.env.HR_EVIDENCE_DIR) { const { mkdirSync } = await import("node:fs"), { join } = await import("node:path"); mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await editor.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "ortho-lifecycle-390.png") }); }
    await editor.getByRole("button", { name: "تأكيد تحديث حالة التقويم", exact: true }).evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
    await page.getByText("حُفظ تحديث حالة التقويم وسُجّل أثره.", { exact: true }).waitFor(); expect(sends).toBe(1); expect(await audits()).toBe(1);
    await page.getByTestId("canonical-ortho-cases").getByText("الإنهاء",{exact:true}).waitFor();
    expect((await journey.db.query("SELECT phase,status FROM ortho_cases WHERE id=$1",[caseId])).rows).toEqual([{phase:"finishing",status:"active"}]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toMatch(/SYN|ANB|finalDx|landmarks/);
  } finally { await context.close(); }
});
it("browser: retainer delivery then explicit completion refreshes the visible terminal summary", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try {
    const page = await context.newPage(); let editor = await openEditor(page);
    await editor.getByLabel("الإجراء", { exact: true }).selectOption("retainer");
    await editor.getByLabel("نوع المثبت", { exact: true }).selectOption("essix");
    await editor.getByLabel("تاريخ التسليم (اختياري)", { exact: true }).fill("2026-10-31");
    await editor.getByRole("button", { name: "تأكيد تحديث حالة التقويم", exact: true }).click();
    await page.getByText("حُفظ تحديث حالة التقويم وسُجّل أثره.", { exact: true }).waitFor();
    expect((await journey.db.query("SELECT status,retainer,retainer_on::text FROM ortho_cases WHERE id=$1", [caseId])).rows).toEqual([{ status: "retention", retainer: "essix", retainer_on: "2026-10-31" }]);
    editor = await openEditor(page, "own", true);
    await editor.getByLabel("الإجراء", { exact: true }).selectOption("completed");
    await editor.getByLabel("ملاحظة الإقفال (اختيارية)", { exact: true }).fill("SYN reviewed completion");
    await editor.getByRole("button", { name: "تأكيد تحديث حالة التقويم", exact: true }).click();
    await page.getByTestId("canonical-ortho-cases").getByText("مكتملة", { exact: true }).waitFor();
    await page.getByRole("button", { name: "عرض تفاصيل الحالة", exact: true }).click();
    await page.getByTestId("canonical-ortho-detail").getByText("السجل السريري للتقويم", { exact: true }).waitFor();
    expect(await page.getByTestId("canonical-ortho-lifecycle").count()).toBe(0);
    expect((await journey.db.query("SELECT status,closed_by,closed_note FROM ortho_cases WHERE id=$1", [caseId])).rows).toEqual([{ status: "completed", closed_by: ACCOUNTS.own.username, closed_note: "SYN reviewed completion" }]);
    expect(await audits()).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally { await context.close(); }
});
it("browser: orthodontic reader sees the native case but has no edit control", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(); await journey.browserLogin(page, "read"); await page.goto(`${journey.baseUrl}/patients/${patientId}`); await page.getByRole("button", { name: "عرض حالات التقويم", exact: true }).click(); await page.getByRole("button", { name: "عرض تفاصيل الحالة", exact: true }).click(); await page.getByTestId("canonical-ortho-detail").waitFor(); expect(await page.getByTestId("canonical-ortho-lifecycle").count()).toBe(0); } finally { await context.close(); }
});
it("browser: committed lost reply survives reload without resend or claiming a request receipt", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(), editor = await openEditor(page); let sends = 0;
    await page.route(`**/api/ortho/${caseId}`, async route => { if (route.request().method() !== "PATCH") return route.continue(); sends++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort("failed"); });
    await editor.getByRole("button", { name: "تأكيد تحديث حالة التقويم", exact: true }).click(); await editor.getByText("تحديث حالة سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    const recovered = await openEditor(page, "own", true, false); await recovered.getByText("تحديث حالة سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    await recovered.getByRole("button", { name: "التحقق من حالة التقويم الحالية", exact: true }).click(); await recovered.getByText(/القراءة ليست إيصالًا لطلب بعينه/).waitFor();
    expect(sends).toBe(1); expect(await audits()).toBe(1); expect(await recovered.getByText("حُفظ تحديث حالة التقويم وسُجّل أثره.", { exact: true }).count()).toBe(0);
    await recovered.getByRole("button", { name: "راجعت الحالة، إنهاء المتابعة", exact: true }).click(); expect(sends).toBe(1);
  } finally { await context.close(); }
});
it("browser: a refreshed or changed case retires an old prepared intent without silently replacing saved data", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(), editor = await openEditor(page);
    await journey.db.query("UPDATE ortho_cases SET phase='working' WHERE id=$1", [caseId]);
    await page.getByRole("button", { name: "تحديث التفاصيل", exact: true }).click(); await editor.getByText("تغيّرت الحالة. راجع بياناتها قبل طلب جديد.", { exact: true }).waitFor();
    expect(await editor.getByRole("button",{name:"تأكيد تحديث حالة التقويم",exact:true}).count()).toBe(0); expect(await audits()).toBe(0);
  } finally { await context.close(); }
});
it("browser: unavailable session storage warns and never retries a failed request", async () => {
  const context = await journey.browser.newContext(); try {
    await context.addInitScript(() => { const get = Storage.prototype.getItem, set = Storage.prototype.setItem; Storage.prototype.getItem = function (key: string) { if (key.startsWith("aqlan.ortho-lifecycle.pending:")) throw new DOMException("SYN unavailable", "SecurityError"); return get.call(this, key); }; Storage.prototype.setItem = function (key: string, value: string) { if (key.startsWith("aqlan.ortho-lifecycle.pending:")) throw new DOMException("SYN unavailable", "SecurityError"); return set.call(this, key, value); }; });
    const page = await context.newPage(), editor = await openEditor(page); await editor.getByText(/الاستعادة بعد إعادة التحميل غير مضمونة/).waitFor(); let sends = 0;
    await page.route(`**/api/ortho/${caseId}`, route => { if (route.request().method() !== "PATCH") return route.continue(); sends++; return route.abort("failed"); });
    await editor.getByRole("button", { name: "تأكيد تحديث حالة التقويم", exact: true }).click(); await editor.getByText("تحديث حالة سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    await editor.getByRole("button", { name: "التحقق من حالة التقويم الحالية", exact: true }).click(); await editor.getByText(/القراءة ليست إيصالًا لطلب بعينه/).waitFor(); expect(sends).toBe(1); expect(await audits()).toBe(0);
  } finally { await context.close(); }
});
it("HTTP/browser: withdrawing clinical editing rejects a prepared edit and fresh login without a write", async () => {
  const cookie = (await journey.login("own")).cookie, input = { expectedVersion: await version(cookie), phase: "finishing" }, original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.own])).rows[0].permissions, context = await journey.browser.newContext();
  try { const page = await context.newPage(), editor = await openEditor(page);
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ortho.edit}','false')::text WHERE id=$1", [journey.ids.own]);
    expect((await mutate(cookie, caseId, input)).status).toBe(401); await editor.getByRole("button", { name: "تأكيد تحديث حالة التقويم", exact: true }).click(); await editor.getByText("انتهت الجلسة أو تغيّرت صلاحياتك. سجّل الدخول من جديد.", { exact: true }).waitFor(); expect(await editor.getByRole("button",{name:"تأكيد تحديث حالة التقويم",exact:true}).count()).toBe(0);
    expect((await mutate((await journey.login("own")).cookie, caseId, input)).status).toBe(403); expect(await audits()).toBe(0);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.own]); }
});
it("browser: malformed success after a real commit stays uncertain and never resends", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(), editor = await openEditor(page); let sends = 0;
    await page.route(`**/api/ortho/${caseId}`, async route => { if (route.request().method() !== "PATCH") return route.continue(); sends++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); });
    await editor.getByRole("button", { name: "تأكيد تحديث حالة التقويم", exact: true }).click(); await editor.getByText("تحديث حالة سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor(); expect(sends).toBe(1); expect(await audits()).toBe(1);
  } finally { await context.close(); }
});
it("HTTP: canceled durable session refuses mutation without fallback; a newly admitted session retains legitimate authority",async()=>{
 const cookie=(await journey.login("own")).cookie,input={expectedVersion:await version(cookie),phase:"finishing"};
 const epoch=(await journey.db.query("SELECT authorization_epoch::text epoch FROM users WHERE id=$1",[journey.ids.own])).rows[0].epoch;
 await journey.db.query("UPDATE users SET is_active=false WHERE id=$1",[journey.ids.own]);
 expect((await journey.db.query("SELECT authorization_epoch::text epoch FROM users WHERE id=$1",[journey.ids.own])).rows[0].epoch).not.toBe(epoch);
 const denied=await mutate(cookie,caseId,input);expect(denied.status).toBe(401);expect(await audits()).toBe(0);
 await journey.db.query("UPDATE users SET is_active=true WHERE id=$1",[journey.ids.own]);
 const fresh=(await journey.login("own")).cookie;expect((await mutate(fresh,caseId,input)).status).toBe(200);expect(await audits()).toBe(1);
});
