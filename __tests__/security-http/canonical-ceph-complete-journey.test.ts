import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { REQUIRED_LANDMARKS } from "../../lib/ceph";
import { validCephPoint } from "../fixtures/ceph-valid-geometry";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
const ANALYZE = { "clinical.xrays.view": true, "clinical.ceph.analyze": true };
const ACCOUNTS = {
  owner: { username: "canon-complete-owner", password: "Canon#CompleteOwner1", role: "admin", display: "المالك التجريبي" },
  own: { username: "canon-complete-own", password: "Canon#CompleteOwn1", role: "doctor", doctor: true, display: "محلل تجريبي", patientScope: "own", grants: ANALYZE },
  all: { username: "canon-complete-all", password: "Canon#CompleteAll1", role: "reception", display: "محلل شامل تجريبي", patientScope: "all", grants: ANALYZE },
  read: { username: "canon-complete-read", password: "Canon#CompleteRead1", role: "admin", display: "قارئ تجريبي", patientScope: "all", grants: { "clinical.xrays.view": true } },
  none: { username: "canon-complete-none", password: "Canon#CompleteNone1", role: "doctor", doctor: true, display: "بلا نطاق", patientScope: "none", grants: ANALYZE },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>, sequence = 0, patientId: number, studyId: number;
beforeAll(async () => { journey = await openCanonicalJourney({ portOffset: 69, secret: "canonical-ceph-complete-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed() {} }); }, 300000);
afterAll(async () => { await journey?.close(); }, 60000);
beforeEach(async () => {
  patientId = (await journey.db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'SYN draft edit patient',$2) RETURNING id", [`SYN-CEPH-COMPLETE-${++sequence}`, journey.parties.own])).rows[0].id;
  studyId = (await seedCanonicalCeph(journey.db, { patientId, status: "draft" })).id;
  await journey.db.query("UPDATE ceph_analyses SET cal_x1=0,cal_y1=0,cal_x2=100,cal_y2=0,cal_mm=50,mm_per_pixel=0.5 WHERE id=$1",[studyId]);
  for(const code of REQUIRED_LANDMARKS)await journey.db.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,$2,$3,$4,'manual','SYN')",[studyId,code,validCephPoint(code).x,validCephPoint(code).y]);
});
const complete = (cookie: string, id: number, body: unknown) => journey.api(`/api/ceph/${id}/complete`, cookie, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function version(cookie: string, id = studyId) { const response = await journey.api(`/api/ceph/${id}`, cookie); expect(response.status).toBe(200); return (await response.json()).discardVersion as string; }
it("HTTP: scoped analyst explicitly seals one observed draft and its audit",async()=>{
 const cookie=(await journey.login("own")).cookie,response=await complete(cookie,studyId,{expectedVersion:await version(cookie)});
 expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,studyId,status:"completed"});
 expect((await journey.db.query("SELECT status,completed_by FROM ceph_analyses WHERE id=$1",[studyId])).rows).toEqual([{status:"completed",completed_by:ACCOUNTS.own.username}]);expect(await audits()).toBe(1);
});
const audits = async () => Number((await journey.db.query("SELECT count(*)::int n FROM audit_log WHERE action='ceph.complete' AND entity_id=$1", [String(studyId)])).rows[0].n);
it.each(["owner", "all"] as const)("HTTP: %s approves one observed draft with minimal no-store acknowledgment", async key => {
  const cookie = (await journey.login(key)).cookie, response = await complete(cookie, studyId, { expectedVersion: await version(cookie) });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store"); expect(Object.keys(await response.json()).sort()).toEqual(["ok", "status", "studyId"]); expect(await audits()).toBe(1); expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: anonymous, reader, none and foreign patients refuse without effects", async () => {
  const owner = (await journey.login("owner")).cookie, input = { expectedVersion: await version(owner) };
  expect((await complete("", studyId, input)).status).toBe(401);
  for (const key of ["read", "none"] as const) expect((await complete((await journey.login(key)).cookie, studyId, input)).status).toBe(403);
  await journey.db.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [patientId]); const own = (await journey.login("own")).cookie;
  const foreign = await complete(own, studyId, input), absent = await complete(own, 2147483647, input); expect(foreign.status).toBe(404); expect(absent.status).toBe(404); expect(await foreign.json()).toEqual(await absent.json()); expect(await audits()).toBe(0);
});
it("HTTP: malformed requests and query parameters cannot select measurements, actor or force",async()=>{
 const cookie=(await journey.login("own")).cookie,expectedVersion=await version(cookie);
 for(const body of [null,[],{},{expectedVersion:[]},{expectedVersion,force:true},{expectedVersion,actor:"owner"},{expectedVersion,measurements:[]}]){const response=await complete(cookie,studyId,body);expect(response.status).toBe(400);expect(response.headers.get("cache-control")).toContain("no-store");}
 expect((await journey.api(`/api/ceph/${studyId}/complete?force=1`,cookie,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedVersion})})).status).toBe(400);expect(await audits()).toBe(0);
});
it("HTTP: committed approval cannot replay and incomplete geometry refuses without writes",async()=>{
 const cookie=(await journey.login("own")).cookie,input={expectedVersion:await version(cookie)};expect((await complete(cookie,studyId,input)).status).toBe(200);expect((await complete(cookie,studyId,input)).status).toBe(409);expect(await audits()).toBe(1);
 const draft=(await seedCanonicalCeph(journey.db,{patientId,status:"draft"})).id;const response=await complete(cookie,draft,{expectedVersion:await version(cookie,draft)});expect(response.status).toBe(409);expect((await response.json()).code).toBe("ceph_complete_conditions");
});
async function openEditor(page: import("playwright").Page, key: keyof typeof ACCOUNTS = "own", signed = false, arm = true) {
  page.setDefaultTimeout(10000); if (!signed) await journey.browserLogin(page, key); await page.goto(`${journey.baseUrl}/patients/${patientId}`);
  await page.getByRole("button", { name: "عرض دراسات السيفالومتري", exact: true }).click(); await page.getByRole("button", { name: "عرض الدراسة المحفوظة", exact: true }).click();
  const editor = page.getByTestId("canonical-ceph-complete"); await editor.waitFor();
  if (arm) { await editor.getByRole("button", { name: "مراجعة اعتماد الدراسة", exact: true }).click(); }
  return editor;
}
it("browser: 390px explicit confirmation seals once and preserves saved geometry", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try { const page = await context.newPage(), editor = await openEditor(page); let sends = 0; page.on("request", r => { if (r.method() === "POST" && new URL(r.url()).pathname === `/api/ceph/${studyId}/complete`) sends++; });
    if (process.env.HR_EVIDENCE_DIR) { const { mkdirSync } = await import("node:fs"), { join } = await import("node:path"); mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await editor.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "ceph-complete-390.png") }); }
    await editor.getByRole("button", { name: "تأكيد اعتماد الدراسة", exact: true }).evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
    await page.getByText("اعتُمدت الدراسة وسُجّلت القياسات وأثر الاعتماد. راجع السجل المحفوظ.", { exact: true }).waitFor(); expect(sends).toBe(1); expect(await audits()).toBe(1);
    await page.getByRole("heading", { name: /^دراسة معتمدة/ }).waitFor();
    expect((await journey.db.query("SELECT status,cal_mm,(SELECT count(*)::int FROM ceph_measurements WHERE analysis_id=$1) measurements,(SELECT count(*)::int FROM ceph_landmarks WHERE analysis_id=$1) landmarks FROM ceph_analyses WHERE id=$1",[studyId])).rows).toEqual([{status:"completed",cal_mm:50,measurements:expect.any(Number),landmarks:REQUIRED_LANDMARKS.length}]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toMatch(/SYN|ANB|finalDx|landmarks/);
  } finally { await context.close(); }
});
it("browser: imaging reader sees the saved draft but has no edit control", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(); await journey.browserLogin(page, "read"); await page.goto(`${journey.baseUrl}/patients/${patientId}`); await page.getByRole("button", { name: "عرض دراسات السيفالومتري", exact: true }).click(); await page.getByRole("button", { name: "عرض الدراسة المحفوظة", exact: true }).click(); await page.getByTestId("canonical-ceph-saved").waitFor(); expect(await page.getByTestId("canonical-ceph-complete").count()).toBe(0); } finally { await context.close(); }
});
it("browser: committed lost reply survives reload without resend or claiming a request receipt", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(), editor = await openEditor(page); let sends = 0;
    await page.route(`**/api/ceph/${studyId}/complete`, async route => { if (route.request().method() !== "POST") return route.continue(); sends++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort("failed"); });
    await editor.getByRole("button", { name: "تأكيد اعتماد الدراسة", exact: true }).click(); await editor.getByText("اعتماد سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    const recovered = await openEditor(page, "own", true, false); await recovered.getByText("اعتماد سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    await recovered.getByRole("button", { name: "التحقق من الدراسة الحالية", exact: true }).click(); await recovered.getByText("راجع الحالة والقياسات الحالية؛ القراءة ليست إيصالًا لطلب بعينه.", { exact: true }).waitFor();
    expect(sends).toBe(1); expect(await audits()).toBe(1); expect(await recovered.getByText("اعتُمدت الدراسة وسُجّلت القياسات وأثر الاعتماد. راجع السجل المحفوظ.", { exact: true }).count()).toBe(0);
    await recovered.getByRole("button", { name: "راجعت الدراسة، إنهاء المتابعة", exact: true }).click(); expect(sends).toBe(1);
  } finally { await context.close(); }
});
it("browser: a refreshed or changed draft retires an old prepared intent without silently replacing saved data", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(), editor = await openEditor(page);
    await journey.db.query("INSERT INTO ceph_diagnoses(analysis_id,final_dx,created_by) VALUES($1,'SYN newer clinician conclusion','SYN other')", [studyId]);
    await page.getByRole("button", { name: "تحديث الدراسة", exact: true }).click(); await editor.getByText("تغيّرت الدراسة. راجع بياناتها الحالية قبل طلب اعتماد جديد.", { exact: true }).waitFor();
    expect(await editor.getByRole("button",{name:"تأكيد اعتماد الدراسة",exact:true}).count()).toBe(0); expect(await audits()).toBe(0);
  } finally { await context.close(); }
});
it("browser: unavailable session storage warns and never retries a failed request", async () => {
  const context = await journey.browser.newContext(); try {
    await context.addInitScript(() => { const get = Storage.prototype.getItem, set = Storage.prototype.setItem; Storage.prototype.getItem = function (key: string) { if (key.startsWith("aqlan.ceph-complete.pending:")) throw new DOMException("SYN unavailable", "SecurityError"); return get.call(this, key); }; Storage.prototype.setItem = function (key: string, value: string) { if (key.startsWith("aqlan.ceph-complete.pending:")) throw new DOMException("SYN unavailable", "SecurityError"); return set.call(this, key, value); }; });
    const page = await context.newPage(), editor = await openEditor(page); await editor.getByText(/الاستعادة بعد إعادة التحميل غير مضمونة/).waitFor(); let sends = 0;
    await page.route(`**/api/ceph/${studyId}/complete`, route => { if (route.request().method() !== "POST") return route.continue(); sends++; return route.abort("failed"); });
    await editor.getByRole("button", { name: "تأكيد اعتماد الدراسة", exact: true }).click(); await editor.getByText("اعتماد سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    await editor.getByRole("button", { name: "التحقق من الدراسة الحالية", exact: true }).click(); await editor.getByText("راجع الحالة والقياسات الحالية؛ القراءة ليست إيصالًا لطلب بعينه.", { exact: true }).waitFor(); expect(sends).toBe(1); expect(await audits()).toBe(0);
  } finally { await context.close(); }
});
it("HTTP/browser: withdrawing analysis rejects a prepared edit and fresh login without a write", async () => {
  const cookie = (await journey.login("own")).cookie, input = { expectedVersion: await version(cookie) }, original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.own])).rows[0].permissions, context = await journey.browser.newContext();
  try { const page = await context.newPage(), editor = await openEditor(page);
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ceph.analyze}','false')::text WHERE id=$1", [journey.ids.own]);
    expect((await complete(cookie, studyId, input)).status).toBe(401); await editor.getByRole("button", { name: "تأكيد اعتماد الدراسة", exact: true }).click(); await editor.getByText("انتهت الجلسة أو تغيّرت صلاحياتك. سجّل الدخول من جديد.", { exact: true }).waitFor(); expect(await editor.getByRole("button",{name:"تأكيد اعتماد الدراسة",exact:true}).count()).toBe(0);
    expect((await complete((await journey.login("own")).cookie, studyId, input)).status).toBe(403); expect(await audits()).toBe(0);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.own]); }
});
it("browser: malformed success after a real commit stays uncertain and never resends", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(), editor = await openEditor(page); let sends = 0;
    await page.route(`**/api/ceph/${studyId}/complete`, async route => { if (route.request().method() !== "POST") return route.continue(); sends++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); });
    await editor.getByRole("button", { name: "تأكيد اعتماد الدراسة", exact: true }).click(); await editor.getByText("اعتماد سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor(); expect(sends).toBe(1); expect(await audits()).toBe(1);
  } finally { await context.close(); }
});
it("HTTP: canceled durable session refuses approval without fallback; a newly admitted session retains legitimate authority",async()=>{
 const cookie=(await journey.login("own")).cookie,input={expectedVersion:await version(cookie)};
 const epoch=(await journey.db.query("SELECT authorization_epoch::text epoch FROM users WHERE id=$1",[journey.ids.own])).rows[0].epoch;
 await journey.db.query("UPDATE users SET is_active=false WHERE id=$1",[journey.ids.own]);
 expect((await journey.db.query("SELECT authorization_epoch::text epoch FROM users WHERE id=$1",[journey.ids.own])).rows[0].epoch).not.toBe(epoch);
 const denied=await complete(cookie,studyId,input);expect(denied.status).toBe(401);expect(await audits()).toBe(0);
 await journey.db.query("UPDATE users SET is_active=true WHERE id=$1",[journey.ids.own]);
 const fresh=(await journey.login("own")).cookie;expect((await complete(fresh,studyId,input)).status).toBe(200);expect(await audits()).toBe(1);
});
