import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { seedCanonicalPatientCases } from "../fixtures/canonical-patient-cases";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ACCOUNTS = {
  owner: { username: "canon-case-write-owner", password: "Canon#CaseWriteOwner1", role: "admin", display: "مالك تجريبي" },
  own: { username: "canon-case-write-own", password: "Canon#CaseWriteOwn1", role: "doctor", doctor: true, display: "طبيب حالات تجريبي", patientScope: "own", grants: { "clinical.plans.view": true, "clinical.plans.edit": true } },
  all: { username: "canon-case-write-all", password: "Canon#CaseWriteAll1", role: "reception", display: "محرر خطط تجريبي", patientScope: "all", grants: { "clinical.plans.view": true, "clinical.plans.edit": true } },
  read: { username: "canon-case-write-read", password: "Canon#CaseWriteRead1", role: "admin", display: "قارئ فقط", patientScope: "all", grants: { "clinical.plans.view": true } },
  none: { username: "canon-case-write-none", password: "Canon#CaseWriteNone1", role: "doctor", doctor: true, display: "بلا نطاق", patientScope: "none", grants: { "clinical.plans.view": true, "clinical.plans.edit": true } },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
const ids = { patient: 0, plan: 0, item: 0, caseId: 0, newCase: 0, prerequisite: 0, problemId: 0, outside: 0, outsideItem: 0, outsideCase: 0 };
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 56, secret: "canonical-plan-case-write-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed(q, _users, parties) {
    ids.patient = Number((await q.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-CASE-WRITE','SYN case command patient',$1) RETURNING id", [parties.own])).rows[0].id);
    Object.assign(ids, await seedCanonicalPatientCases(q, ids.patient, parties.own));
    ids.newCase = Number((await q.query("INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES($1,'general','SYN new case','SYN') RETURNING id", [ids.patient])).rows[0].id);
    ids.outside = Number((await q.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-CASE-WRITE-OUT','SYN outside command patient') RETURNING id")).rows[0].id);
    const other = await seedCanonicalPatientCases(q, ids.outside); ids.outsideItem = other.item; ids.outsideCase = other.caseId;
  } });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
afterEach(async () => { if (journey) await journey.db.query("UPDATE plan_items SET case_id=$1,priority=3 WHERE id=$2", [ids.caseId, ids.item]); });
const draft = () => ({ caseId: ids.newCase, priority: 4, expectedCaseId: ids.caseId, expectedPriority: 3 });
const put = (cookie: string, body: unknown = draft(), itemId = ids.item) => journey.api(`/api/plan-items/${itemId}/case`, cookie, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const auditCount = async () => Number((await journey.db.query("SELECT count(*)::int n FROM audit_log WHERE action='plan.item_case' AND entity_id=$1", [String(ids.patient)])).rows[0].n);
it("HTTP: a scoped canonical plan editor can link an unbilled item without legacy authority", async () => {
  const session = await journey.login("own"); expect(session.status).toBe(200);
  const response = await journey.api(`/api/plan-items/${ids.item}/case`, session.cookie, { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caseId: ids.newCase, priority: 4, expectedCaseId: ids.caseId, expectedPriority: 3 }) });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, changed: true, itemId: ids.item, caseId: ids.newCase, priority: 4 });
  expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: explicit edit capability, own/all/none scopes and no role-based authority", async () => {
  expect((await put("")).status).toBe(401);
  for (const key of ["none", "read"] as const) expect((await put((await journey.login(key)).cookie)).status).toBe(403);
  const own = (await journey.login("own")).cookie;
  const outside = await put(own, { ...draft(), expectedCaseId: ids.outsideCase }, ids.outsideItem), missing = await put(own, draft(), 2147483647);
  expect(outside.status).toBe(404); expect(missing.status).toBe(404); expect(await outside.json()).toEqual(await missing.json());
  const before = await auditCount(), response = await put((await journey.login("all")).cookie); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store"); expect(await auditCount()).toBe(before + 1);
});
it("HTTP: rejects incomplete comparisons, actor/finance injection and foreign cases", async () => {
  const cookie = (await journey.login("own")).cookie, before = await auditCount();
  for (const body of [{ caseId: null, priority: null }, { ...draft(), actor: "owner" }, { ...draft(), price: 1 }, { ...draft(), priority: 1000 }, { ...draft(), expectedCaseId: "1" }]) {
    const response = await put(cookie, body); expect(response.status).toBe(400); expect((await response.json()).code).toBe("invalid_plan_case");
  }
  const response = await put(cookie, { ...draft(), caseId: ids.outsideCase }); expect(response.status).toBe(404); expect(JSON.stringify(await response.json())).not.toMatch(/SYN outside|SELECT/);
  expect(await auditCount()).toBe(before);
});
it("HTTP: comparison rejects a repeated stale request and a verified no-op emits no extra audit", async () => {
  const cookie = (await journey.login("own")).cookie, before = await auditCount();
  expect((await put(cookie)).status).toBe(200); const stale = await put(cookie); expect(stale.status).toBe(409); expect((await stale.json()).code).toBe("plan_case_conflict");
  const noChange = await put(cookie, { ...draft(), expectedCaseId: ids.newCase, expectedPriority: 4 }); expect(noChange.status).toBe(200); expect(await noChange.json()).toMatchObject({ changed: false }); expect(await auditCount()).toBe(before + 1);
});
it("HTTP: a retained invoice freezes the case while priority-only updates preserve money", async () => {
  const item = Number((await journey.db.query("INSERT INTO plan_items(plan_id,service_name,case_id,priority) VALUES($1,'SYN billed item',$2,3) RETURNING id", [ids.plan, ids.caseId])).rows[0].id);
  const invoice = Number((await journey.db.query("INSERT INTO invoices(invoice_number,patient_id,status) VALUES('SYN-CASE-CANCELLED',$1,'cancelled') RETURNING id", [ids.patient])).rows[0].id);
  await journey.db.query("INSERT INTO invoice_items(invoice_id,description,plan_item_id) VALUES($1,'SYN retained zero source',$2)", [invoice, item]);
  const snapshot = async () => (await journey.db.query("SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoice_items i) items")).rows;
  const before = await snapshot(), cookie = (await journey.login("owner")).cookie;
  const refused = await put(cookie, draft(), item); expect(refused.status).toBe(409); expect((await refused.json()).code).toBe("plan_case_billed_lock");
  expect((await put(cookie, { ...draft(), caseId: ids.caseId }, item)).status).toBe(200); expect(await snapshot()).toEqual(before);
});
async function openEditor(page: import("playwright").Page, key: keyof typeof ACCOUNTS = "own", signed = false) {
  page.setDefaultTimeout(10_000);
  if (!signed) await journey.browserLogin(page, key);
  await page.goto(`${journey.baseUrl}/patients/${ids.patient}`); await page.getByRole("button", { name: "عرض الحالات وترتيب الخطة", exact: true }).click();
  const panel = page.getByTestId("canonical-patient-cases"), editor = panel.getByTestId("canonical-plan-case-editor"); await panel.getByText("SYN root case", { exact: true }).first().waitFor();
  await editor.getByRole("button", { name: "تعديل ربط بند وأولويته", exact: true }).click();
  try { await editor.getByLabel("بند الخطة", { exact: true }).selectOption(String(ids.item)); }
  catch (error) {
    if (process.env.HR_EVIDENCE_DIR) { mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); writeFileSync(join(process.env.HR_EVIDENCE_DIR, "case-editor-label-diagnostic.json"), JSON.stringify({ labels: await editor.locator("label").allTextContents(), html: await editor.innerHTML() }, null, 2)); }
    throw error;
  }
  return { panel, editor };
}
it("browser: explicit case/priority edit uses canonical authority and preserves the patient workflow", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try { const page = await context.newPage(), { editor } = await openEditor(page); const before = await auditCount();
    await editor.getByLabel("الحالة المرتبطة", { exact: true }).selectOption(String(ids.newCase)); await editor.getByLabel("أولوية البند", { exact: true }).fill("4");
    if (process.env.HR_EVIDENCE_DIR) { mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await editor.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "plan-case-editor-390.png") }); }
    await editor.getByRole("button", { name: "حفظ الربط والأولوية", exact: true }).click(); await editor.getByText("حُفظ ربط البند وأولويته.", { exact: true }).waitFor();
    expect((await journey.db.query("SELECT case_id,priority FROM plan_items WHERE id=$1", [ids.item])).rows[0]).toEqual({ case_id: ids.newCase, priority: 4 }); expect(await auditCount()).toBe(before + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(await journey.ddlLog()).toEqual([]);
  } finally { await context.close(); }
});
it("browser: a plan reader cannot mount the writer controls", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(); await journey.browserLogin(page, "read"); await page.goto(`${journey.baseUrl}/patients/${ids.patient}`);
    await page.getByRole("button", { name: "عرض الحالات وترتيب الخطة", exact: true }).click(); await page.getByTestId("canonical-patient-cases").getByText("SYN root case", { exact: true }).first().waitFor();
    expect(await page.getByTestId("canonical-plan-case-editor").count()).toBe(0);
  } finally { await context.close(); }
});
it("browser: a concurrent change refuses the stale draft without overwriting it", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(), { editor } = await openEditor(page), before = await auditCount();
    await editor.getByLabel("الحالة المرتبطة", { exact: true }).selectOption(String(ids.newCase)); await editor.getByLabel("أولوية البند", { exact: true }).fill("4");
    await journey.db.query("UPDATE plan_items SET priority=8 WHERE id=$1", [ids.item]); await editor.getByRole("button", { name: "حفظ الربط والأولوية", exact: true }).click();
    await editor.getByText("تغيّر البند أو تعذّر تثبيت سياقه. حدّث الحالات وراجع الربط قبل محاولة جديدة.", { exact: true }).waitFor();
    expect((await journey.db.query("SELECT case_id,priority FROM plan_items WHERE id=$1", [ids.item])).rows[0]).toEqual({ case_id: ids.caseId, priority: 8 }); expect(await auditCount()).toBe(before);
  } finally { await context.close(); }
});
it("browser: a committed command with a lost reply is never replayed on reload; a new edit needs new intent", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(), { editor } = await openEditor(page), before = await auditCount(); let writes = 0, first = true;
    page.on("request", r => { if (r.method() === "PUT" && new URL(r.url()).pathname === `/api/plan-items/${ids.item}/case`) writes++; });
    await page.route(`**/api/plan-items/${ids.item}/case`, async route => { if (!first) { await route.continue(); return; } first = false; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort("failed"); });
    await editor.getByLabel("الحالة المرتبطة", { exact: true }).selectOption(String(ids.newCase)); await editor.getByLabel("أولوية البند", { exact: true }).fill("4");
    await editor.getByRole("button", { name: "حفظ الربط والأولوية", exact: true }).click(); await editor.getByText("طلب حفظ سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    expect(await auditCount()).toBe(before + 1); expect(writes).toBe(1);
    const stored = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith("aqlan.plan-case.pending:")));
    expect(stored).toHaveLength(1); expect(stored[0][1]).not.toMatch(/SYN|password|cookie|token|patientName/i);
    page.once("dialog", dialog => { void dialog.accept(); });
    await page.reload(); await page.getByRole("button", { name: "عرض الحالات وترتيب الخطة", exact: true }).click();
    const restored = page.getByTestId("canonical-plan-case-editor"); await restored.getByText("طلب حفظ سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    await restored.getByRole("button", { name: "التحقق من الحالة الحالية", exact: true }).click(); await restored.getByRole("button", { name: "راجعت الحالة الحالية، بدء تعديل جديد", exact: true }).waitFor(); expect(writes).toBe(1);
    await restored.getByRole("button", { name: "راجعت الحالة الحالية، بدء تعديل جديد", exact: true }).click(); expect(writes).toBe(1);
    await restored.getByLabel("بند الخطة", { exact: true }).selectOption(String(ids.item)); await restored.getByLabel("أولوية البند", { exact: true }).fill("6");
    await restored.getByRole("button", { name: "حفظ الربط والأولوية", exact: true }).click(); await restored.getByText("حُفظ ربط البند وأولويته.", { exact: true }).waitFor(); expect(writes).toBe(2); expect(await auditCount()).toBe(before + 2);
  } finally { await context.close(); }
});
it("browser: revocation during editing refuses the mutation and clears stale case facts", async () => {
  const context = await journey.browser.newContext(), original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.all])).rows[0].permissions;
  try { const page = await context.newPage(), { editor, panel } = await openEditor(page, "all"), before = await auditCount();
    await editor.getByLabel("الحالة المرتبطة", { exact: true }).selectOption(String(ids.newCase));
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.plans.edit}','false')::text WHERE id=$1", [journey.ids.all]);
    await editor.getByRole("button", { name: "حفظ الربط والأولوية", exact: true }).click(); await panel.getByRole("alert").waitFor(); expect(await auditCount()).toBe(before);
    expect(await panel.getByTestId("canonical-patient-case").count()).toBe(0); expect(await editor.locator("select,input").count()).toBe(0);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.all]); }
});
it("browser: unavailable tab storage is disclosed and an uncertain command still has no automatic retry", async () => {
  const context = await journey.browser.newContext();
  await context.addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key: string) { if (key.startsWith("aqlan.plan-case.pending:")) throw new DOMException("SYN storage unavailable", "SecurityError"); return get.call(this, key); };
    Storage.prototype.setItem = function(key: string, value: string) { if (key.startsWith("aqlan.plan-case.pending:")) throw new DOMException("SYN storage unavailable", "SecurityError"); return set.call(this, key, value); };
  });
  try { const page = await context.newPage(), { editor } = await openEditor(page); let writes = 0;
    await editor.getByText("تعذّر حفظ متابعة الطلب في هذا التبويب. تجنب إغلاق الصفحة قبل التأكد من نتيجة الحفظ؛ الاستعادة بعد إعادة التحميل غير مضمونة.", { exact: true }).waitFor();
    await page.route(`**/api/plan-items/${ids.item}/case`, async route => { writes++; await route.fetch(); await route.abort("failed"); });
    await editor.getByLabel("أولوية البند", { exact: true }).fill("4"); await editor.getByRole("button", { name: "حفظ الربط والأولوية", exact: true }).click();
    await editor.getByText("طلب حفظ سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    await editor.getByRole("button", { name: "التحقق من الحالة الحالية", exact: true }).click(); await editor.getByRole("button", { name: "راجعت الحالة الحالية، بدء تعديل جديد", exact: true }).waitFor(); expect(writes).toBe(1);
  } finally { await context.close(); }
});
it("browser: an unverified success body is treated as uncertain after the real commit", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(), { editor } = await openEditor(page), before = await auditCount(); let writes = 0;
    await page.route(`**/api/plan-items/${ids.item}/case`, async route => { writes++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.fulfill({ response, json: { ok: true } }); });
    await editor.getByLabel("أولوية البند", { exact: true }).fill("4"); await editor.getByRole("button", { name: "حفظ الربط والأولوية", exact: true }).click();
    await editor.getByText("طلب حفظ سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    await editor.getByRole("button", { name: "التحقق من الحالة الحالية", exact: true }).click(); await editor.getByRole("button", { name: "راجعت الحالة الحالية، بدء تعديل جديد", exact: true }).waitFor();
    expect(writes).toBe(1); expect(await auditCount()).toBe(before + 1);
  } finally { await context.close(); }
});
it("browser: closing a pending editor keeps recovery and a late reply cannot restore the old form", async () => {
  const context = await journey.browser.newContext(); let release!: () => void, reached!: () => void, finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { reached = resolve; }), done = new Promise<void>(resolve => { finished = resolve; });
  try { const page = await context.newPage(), { editor } = await openEditor(page), before = await auditCount(); let writes = 0;
    await page.route(`**/api/plan-items/${ids.item}/case`, async route => { writes++; try { const response = await route.fetch(); reached(); await held; await route.fulfill({ response }).catch(() => undefined); } finally { finished(); } });
    await editor.getByLabel("أولوية البند", { exact: true }).fill("4"); await editor.getByRole("button", { name: "حفظ الربط والأولوية", exact: true }).click(); await ready;
    await page.getByRole("button", { name: "إغلاق الحالات وترتيب الخطة", exact: true }).click(); release(); await done;
    expect(await page.getByTestId("canonical-plan-case-editor").count()).toBe(0);
    await page.getByRole("button", { name: "عرض الحالات وترتيب الخطة", exact: true }).click(); const restored = page.getByTestId("canonical-plan-case-editor");
    await restored.getByText("طلب حفظ سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor(); expect(await restored.locator("select,input").count()).toBe(0); expect(writes).toBe(1); expect(await auditCount()).toBe(before + 1);
  } finally { release(); await context.close(); }
});
