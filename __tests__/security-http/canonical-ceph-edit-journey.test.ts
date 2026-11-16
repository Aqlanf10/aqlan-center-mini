import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
const ANALYZE = { "clinical.xrays.view": true, "clinical.ceph.analyze": true };
const ACCOUNTS = {
  owner: { username: "canon-edit-owner", password: "Canon#EditOwner1", role: "admin", display: "المالك التجريبي" },
  own: { username: "canon-edit-own", password: "Canon#EditOwn1", role: "doctor", doctor: true, display: "محلل تجريبي", patientScope: "own", grants: ANALYZE },
  all: { username: "canon-edit-all", password: "Canon#EditAll1", role: "reception", display: "محلل شامل تجريبي", patientScope: "all", grants: ANALYZE },
  read: { username: "canon-edit-read", password: "Canon#EditRead1", role: "admin", display: "قارئ تجريبي", patientScope: "all", grants: { "clinical.xrays.view": true } },
  none: { username: "canon-edit-none", password: "Canon#EditNone1", role: "doctor", doctor: true, display: "بلا نطاق", patientScope: "none", grants: ANALYZE },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>, sequence = 0, patientId: number, studyId: number;
beforeAll(async () => { journey = await openCanonicalJourney({ portOffset: 68, secret: "canonical-ceph-edit-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed() {} }); }, 300000);
afterAll(async () => { await journey?.close(); }, 60000);
beforeEach(async () => {
  patientId = (await journey.db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'SYN draft edit patient',$2) RETURNING id", [`SYN-CEPH-EDIT-${++sequence}`, journey.parties.own])).rows[0].id;
  studyId = (await seedCanonicalCeph(journey.db, { patientId, status: "draft" })).id;
});
const diagnosis = { skeletal: null, dental: null, softTissue: null, note: null, finalDx: "SYN structured draft conclusion" };
const patch = (cookie: string, id: number, body: unknown) => journey.api(`/api/ceph/${id}`, cookie, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function version(cookie: string, id = studyId) { const response = await journey.api(`/api/ceph/${id}`, cookie); expect(response.status).toBe(200); return (await response.json()).discardVersion as string; }
it("HTTP: scoped analyst edits an observed draft atomically without completing it", async () => {
  const cookie = (await journey.login("own")).cookie, expectedVersion = await version(cookie);
  const response = await patch(cookie, studyId, { expectedVersion, calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, landmarks: [{ code: "S", x: 20, y: 30, source: "manual" }], diagnosis });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, studyId, status: "draft" });
  expect((await journey.db.query("SELECT status,mm_per_pixel FROM ceph_analyses WHERE id=$1", [studyId])).rows).toEqual([{ status: "draft", mm_per_pixel: 0.1 }]);
  expect((await journey.db.query("SELECT final_dx FROM ceph_diagnoses WHERE analysis_id=$1", [studyId])).rows[0].final_dx).toBe(diagnosis.finalDx);
  expect((await journey.db.query("SELECT count(*)::int n FROM audit_log WHERE action='ceph.update' AND entity_id=$1", [String(studyId)])).rows[0].n).toBe(3);
});
const audits = async () => Number((await journey.db.query("SELECT count(*)::int n FROM audit_log WHERE action='ceph.update' AND entity_id=$1", [String(studyId)])).rows[0].n);
it.each(["owner", "all"] as const)("HTTP: %s edits one explicit group with minimal no-store acknowledgment", async key => {
  const cookie = (await journey.login(key)).cookie, response = await patch(cookie, studyId, { expectedVersion: await version(cookie), diagnosis });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store"); expect(Object.keys(await response.json()).sort()).toEqual(["ok", "status", "studyId"]); expect(await audits()).toBe(1); expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: anonymous, reader, none and foreign patients refuse without effects", async () => {
  const owner = (await journey.login("owner")).cookie, input = { expectedVersion: await version(owner), diagnosis };
  expect((await patch("", studyId, input)).status).toBe(401);
  for (const key of ["read", "none"] as const) expect((await patch((await journey.login(key)).cookie, studyId, input)).status).toBe(403);
  await journey.db.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [patientId]); const own = (await journey.login("own")).cookie;
  const foreign = await patch(own, studyId, input), absent = await patch(own, 2147483647, input); expect(foreign.status).toBe(404); expect(absent.status).toBe(404); expect(await foreign.json()).toEqual(await absent.json()); expect(await audits()).toBe(0);
});
it("HTTP: complete validation precedes all writes and errors contain no private fields", async () => {
  const cookie = (await journey.login("own")).cookie, expectedVersion = await version(cookie);
  for (const input of [null, [], {}, { expectedVersion }, { expectedVersion, diagnosis, force: true }, { expectedVersion, calibration: { x1: "0", y1: 0, x2: 100, y2: 0, mm: 10 }, diagnosis }, { expectedVersion, diagnosis: { ...diagnosis, finalDx: [] } }]) {
    const response = await patch(cookie, studyId, input); expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toContain("no-store"); expect(JSON.stringify(await response.json())).not.toContain(diagnosis.finalDx);
  }
  expect((await journey.api(`/api/ceph/${studyId}?force=1`, cookie, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion, diagnosis }) })).status).toBe(400);
  expect(await audits()).toBe(0); expect((await journey.db.query("SELECT cal_mm FROM ceph_analyses WHERE id=$1", [studyId])).rows[0].cal_mm).toBeNull();
});
it("HTTP: one saved intent cannot be replayed and cannot edit an approved study", async () => {
  const cookie = (await journey.login("own")).cookie, input = { expectedVersion: await version(cookie), diagnosis };
  expect((await patch(cookie, studyId, input)).status).toBe(200); expect((await patch(cookie, studyId, input)).status).toBe(409);
  const latest = await version(cookie); await journey.db.query("UPDATE ceph_analyses SET status='completed',completed_at=NOW(),completed_by='SYN other' WHERE id=$1", [studyId]);
  expect((await patch(cookie, studyId, { expectedVersion: latest, diagnosis: { ...diagnosis, finalDx: "SYN forbidden overwrite" } })).status).toBe(409); expect(await audits()).toBe(1);
});
async function openEditor(page: import("playwright").Page, key: keyof typeof ACCOUNTS = "own", signed = false, arm = true) {
  page.setDefaultTimeout(10000); if (!signed) await journey.browserLogin(page, key); await page.goto(`${journey.baseUrl}/patients/${patientId}`);
  await page.getByRole("button", { name: "عرض دراسات السيفالومتري", exact: true }).click(); await page.getByRole("button", { name: "عرض الدراسة المحفوظة", exact: true }).click();
  const editor = page.getByTestId("canonical-ceph-draft-diagnosis"); await editor.waitFor();
  if (arm) { await editor.getByRole("button", { name: "تعديل تشخيص المسودة", exact: true }).click(); await editor.getByLabel("الاستنتاج السيفالومتري (مطلوب)", { exact: true }).fill("SYN browser draft conclusion"); }
  return editor;
}
it("browser: 390px explicit diagnosis edit leaves calibration, landmarks and measurements intact", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try { const page = await context.newPage(), editor = await openEditor(page); let sends = 0; page.on("request", r => { if (r.method() === "PATCH" && new URL(r.url()).pathname === `/api/ceph/${studyId}`) sends++; });
    if (process.env.HR_EVIDENCE_DIR) { const { mkdirSync } = await import("node:fs"), { join } = await import("node:path"); mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await editor.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "ceph-draft-diagnosis-390.png") }); }
    await editor.getByRole("button", { name: "حفظ تشخيص المسودة", exact: true }).evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
    await editor.getByText("حُفظ التشخيص في المسودة وسُجّل أثره. لم تُعتمد الدراسة أو تُغيّر القياسات.", { exact: true }).waitFor(); expect(sends).toBe(1); expect(await audits()).toBe(1);
    expect((await journey.db.query("SELECT status,cal_mm,(SELECT count(*)::int FROM ceph_measurements WHERE analysis_id=$1) measurements,(SELECT count(*)::int FROM ceph_landmarks WHERE analysis_id=$1) landmarks FROM ceph_analyses WHERE id=$1", [studyId])).rows).toEqual([{ status: "draft", cal_mm: null, measurements: 0, landmarks: 0 }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain("SYN browser draft conclusion");
  } finally { await context.close(); }
});
it("browser: imaging reader sees the saved draft but has no edit control", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(); await journey.browserLogin(page, "read"); await page.goto(`${journey.baseUrl}/patients/${patientId}`); await page.getByRole("button", { name: "عرض دراسات السيفالومتري", exact: true }).click(); await page.getByRole("button", { name: "عرض الدراسة المحفوظة", exact: true }).click(); await page.getByTestId("canonical-ceph-saved").waitFor(); expect(await page.getByTestId("canonical-ceph-draft-diagnosis").count()).toBe(0); } finally { await context.close(); }
});
it("browser: committed lost reply survives reload without resend or claiming a request receipt", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(), editor = await openEditor(page); let sends = 0;
    await page.route(`**/api/ceph/${studyId}`, async route => { if (route.request().method() !== "PATCH") return route.continue(); sends++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort("failed"); });
    await editor.getByRole("button", { name: "حفظ تشخيص المسودة", exact: true }).click(); await editor.getByText("حفظ سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    const recovered = await openEditor(page, "own", true, false); await recovered.getByText("حفظ سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    await recovered.getByRole("button", { name: "التحقق من الدراسة الحالية", exact: true }).click(); await recovered.getByText("راجع التشخيص والحالة الحالية؛ القراءة ليست إيصالًا لطلب بعينه.", { exact: true }).waitFor();
    expect(sends).toBe(1); expect(await audits()).toBe(1); expect(await recovered.getByText("حُفظ التشخيص في المسودة وسُجّل أثره. لم تُعتمد الدراسة أو تُغيّر القياسات.", { exact: true }).count()).toBe(0);
    await recovered.getByRole("button", { name: "راجعت الدراسة، إنهاء المتابعة", exact: true }).click(); expect(sends).toBe(1);
  } finally { await context.close(); }
});
it("browser: a refreshed or changed draft retires an old prepared intent without silently replacing saved data", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(), editor = await openEditor(page);
    await journey.db.query("INSERT INTO ceph_diagnoses(analysis_id,final_dx,created_by) VALUES($1,'SYN newer clinician conclusion','SYN other')", [studyId]);
    await page.getByRole("button", { name: "تحديث الدراسة", exact: true }).click(); await editor.getByText("تغيّرت الدراسة. راجع بياناتها الحالية قبل فتح تعديل جديد.", { exact: true }).waitFor();
    expect(await editor.locator("textarea").count()).toBe(0); expect(await audits()).toBe(0);
  } finally { await context.close(); }
});
it("browser: unavailable session storage warns and never retries a failed request", async () => {
  const context = await journey.browser.newContext(); try {
    await context.addInitScript(() => { const get = Storage.prototype.getItem, set = Storage.prototype.setItem; Storage.prototype.getItem = function (key: string) { if (key.startsWith("aqlan.ceph-edit.pending:")) throw new DOMException("SYN unavailable", "SecurityError"); return get.call(this, key); }; Storage.prototype.setItem = function (key: string, value: string) { if (key.startsWith("aqlan.ceph-edit.pending:")) throw new DOMException("SYN unavailable", "SecurityError"); return set.call(this, key, value); }; });
    const page = await context.newPage(), editor = await openEditor(page); await editor.getByText(/الاستعادة بعد إعادة التحميل غير مضمونة/).waitFor(); let sends = 0;
    await page.route(`**/api/ceph/${studyId}`, route => { if (route.request().method() !== "PATCH") return route.continue(); sends++; return route.abort("failed"); });
    await editor.getByRole("button", { name: "حفظ تشخيص المسودة", exact: true }).click(); await editor.getByText("حفظ سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    await editor.getByRole("button", { name: "التحقق من الدراسة الحالية", exact: true }).click(); await editor.getByText("راجع التشخيص والحالة الحالية؛ القراءة ليست إيصالًا لطلب بعينه.", { exact: true }).waitFor(); expect(sends).toBe(1); expect(await audits()).toBe(0);
  } finally { await context.close(); }
});
it("HTTP/browser: withdrawing analysis rejects a prepared edit and fresh login without a write", async () => {
  const cookie = (await journey.login("own")).cookie, input = { expectedVersion: await version(cookie), diagnosis }, original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.own])).rows[0].permissions, context = await journey.browser.newContext();
  try { const page = await context.newPage(), editor = await openEditor(page);
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ceph.analyze}','false')::text WHERE id=$1", [journey.ids.own]);
    expect((await patch(cookie, studyId, input)).status).toBe(401); await editor.getByRole("button", { name: "حفظ تشخيص المسودة", exact: true }).click(); await editor.getByText("انتهت الجلسة أو تغيّرت صلاحياتك. سجّل الدخول من جديد.", { exact: true }).waitFor(); expect(await editor.locator("textarea").count()).toBe(0);
    expect((await patch((await journey.login("own")).cookie, studyId, input)).status).toBe(403); expect(await audits()).toBe(0);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.own]); }
});
it("browser: malformed success after a real commit stays uncertain and never resends", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(), editor = await openEditor(page); let sends = 0;
    await page.route(`**/api/ceph/${studyId}`, async route => { if (route.request().method() !== "PATCH") return route.continue(); sends++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); });
    await editor.getByRole("button", { name: "حفظ تشخيص المسودة", exact: true }).click(); await editor.getByText("حفظ سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor(); expect(sends).toBe(1); expect(await audits()).toBe(1);
  } finally { await context.close(); }
});
