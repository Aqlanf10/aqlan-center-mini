import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
const EDIT = { "clinical.ortho.view": true, "clinical.ortho.edit": true };
const ACCOUNTS = {
  owner: { username: "canon-odw-owner", password: "Canon#DecisionOwner1", role: "admin", display: "المالك التجريبي" },
  own: { username: "canon-odw-own", password: "Canon#DecisionOwn1", role: "doctor", doctor: true, patientScope: "own", grants: EDIT, display: "الطبيب المسؤول التجريبي" },
  manager: { username: "canon-odw-manager", password: "Canon#DecisionManager1", role: "admin", doctor: true, patientScope: "all", grants: EDIT, display: "مدير طبيب غير مسؤول" },
  biller: { username: "canon-odw-biller", password: "Canon#DecisionBiller1", role: "reception", patientScope: "all", grants: { "clinical.ortho.view": true, "finance.invoices.create": true }, display: "رابط فاتورة قائمة" },
  viewer: { username: "canon-odw-viewer", password: "Canon#DecisionViewer1", role: "admin", patientScope: "all", grants: { "clinical.ortho.view": true }, display: "قارئ فقط" },
  none: { username: "canon-odw-none", password: "Canon#DecisionNone1", role: "doctor", doctor: true, patientScope: "none", grants: EDIT, display: "بلا نطاق" },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>, seq = 0;
beforeAll(async () => { journey = await openCanonicalJourney({ portOffset: 67, secret: "canonical-ortho-decision-write-0123456789", accounts: ACCOUNTS, ownerKey: "owner" }); }, 300000);
afterAll(async () => { await journey?.close(); }, 60000);
async function scenario(assigned = true) {
  const patientId = (await journey.db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id", [`SYN-ODW-${++seq}`, `مريض قرار اصطناعي ${seq}`, assigned ? journey.parties.own : null])).rows[0].id as number;
  const caseId = (await journey.db.query("INSERT INTO ortho_cases(patient_id,created_by,responsible_doctor_id) VALUES($1,'SYN',$2) RETURNING id", [patientId, assigned ? journey.parties.own : null])).rows[0].id as number;
  const adjustmentId = (await journey.db.query("INSERT INTO ortho_adjustments(case_id,done_on,recorded_by,billing_class,note) VALUES($1,'2026-10-01','SYN','REVIEW_REQUIRED','SYN private care') RETURNING id", [caseId])).rows[0].id as number;
  return { patientId, caseId, adjustmentId };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const path = (s: Scenario) => `/api/ortho/adjustments/${s.adjustmentId}/billing-decision`;
async function draft(s: Scenario, decision: "no_charge" | "billed" = "no_charge", invoiceNumber: string | null = null) {
  const session = await journey.login("owner"), response = await journey.api("/api/ortho/billing-decisions", session.cookie); expect(response.status).toBe(200);
  const row = (await response.json()).pending.find((r: { adjustmentId: number }) => r.adjustmentId === s.adjustmentId);
  return { patientId: s.patientId, expectedVersion: row.decisionContext.expectedVersion as string, decision, reason: decision === "no_charge" ? "SYN clinical reason" : null, invoiceNumber };
}
const audit = async (s: Scenario) => (await journey.db.query("SELECT actor,details FROM audit_log WHERE action='ortho.billing_decision' AND entity_id=$1 ORDER BY id", [String(s.adjustmentId)])).rows;
async function invoice(s: Scenario) { const number = `SYN-ODW-INV-${++seq}`; await journey.db.query("INSERT INTO invoices(invoice_number,patient_id,status,total_minor,base_currency,created_by) VALUES($1,$2,'open',123456,'USD','SYN')", [number, s.patientId]); return number; }
it("HTTP: responsible doctor and independent invoice creator save only their mapped decision with minimal acknowledgements", async () => {
  for (const key of ["own", "biller"] as const) { const s = await scenario(), number = key === "biller" ? await invoice(s) : null, body = await draft(s, number ? "billed" : "no_charge", number), session = await journey.login(key);
    const before = (await journey.db.query("SELECT jsonb_agg(to_jsonb(i) ORDER BY id) data FROM invoices i")).rows;
    const response = await journey.api(path(s), session.cookie, { method: "POST", body: JSON.stringify(body) }); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store"); expect(await response.json()).toEqual({ ok: true, adjustmentId: s.adjustmentId, decision: body.decision }); expect(await audit(s)).toHaveLength(1); expect((await journey.db.query("SELECT jsonb_agg(to_jsonb(i) ORDER BY id) data FROM invoices i")).rows).toEqual(before);
    expect((await journey.api(path(s), session.cookie, { method: "POST", body: JSON.stringify(body) })).status).toBe(409); expect(await audit(s)).toHaveLength(1);
  }
});
it("HTTP: anonymous, viewer, none and nonresponsible manager refuse without mutations; malformed aliases refuse exactly", async () => {
  const s = await scenario(), body = await draft(s);
  expect((await journey.api(path(s), "", { method: "POST", body: JSON.stringify(body) })).status).toBe(401);
  for (const key of ["viewer", "none", "manager"] as const) { const session = await journey.login(key); expect((await journey.api(path(s), session.cookie, { method: "POST", body: JSON.stringify(body) })).status).toBe(403); }
  const owner = await journey.login("owner"); for (const value of [{ ...body, owner: true }, { ...body, decision: ["no_charge"] }, { ...body, expectedVersion: "wrong" }]) expect((await journey.api(path(s), owner.cookie, { method: "POST", body: JSON.stringify(value) })).status).toBe(400);
  expect(await audit(s)).toEqual([]); expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: outside patient and invoice references stay undisclosed and no clinical grant substitutes for billing", async () => {
  const s = await scenario(false), body = await draft(s), own = await journey.login("own"), biller = await journey.login("biller"); expect((await journey.api(path(s), own.cookie, { method: "POST", body: JSON.stringify(body) })).status).toBe(404);
  const accessible = await scenario(), foreignNumber = await invoice(s), billing = await draft(accessible, "billed", foreignNumber); const refused = await journey.api(path(accessible), biller.cookie, { method: "POST", body: JSON.stringify(billing) }); expect(refused.status).toBe(409); expect(JSON.stringify(await refused.json())).not.toContain(foreignNumber); expect((await journey.api(path(accessible), own.cookie, { method: "POST", body: JSON.stringify(billing) })).status).toBe(403); expect(await audit(accessible)).toEqual([]);
});
async function openEditor(page: import("playwright").Page, s: Scenario, key: Key = "own", decision: "no_charge" | "billed" = "no_charge") {
  await journey.browserLogin(page, key); await page.goto(`${journey.baseUrl}/ortho`); const editor = page.getByTestId("canonical-ortho-decision-editor"); await editor.getByRole("button", { name: "تسجيل قرار شدّة معلّقة" }).click(); await editor.getByLabel("الشدّة من القراءة الحالية").selectOption(String(s.adjustmentId)); await editor.getByLabel("القرار المسموح").selectOption(decision); return editor;
}
it("browser: current branch preview, 390px identity and no-charge save preserve the existing flow", async () => {
  const s = await scenario(), context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try { const page = await context.newPage(), editor = await openEditor(page, s); expect(await editor.getByLabel("القرار المسموح").locator("option").allTextContents()).toEqual(["اختر القرار", "بلا رسوم — سبب مكتوب"]); await editor.getByLabel("سبب بلا رسوم").fill("قرار سريري اصطناعي موثق"); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (process.env.HR_EVIDENCE_DIR) { const { mkdirSync } = await import("node:fs"), { join } = await import("node:path"); mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "ortho-decision-write-390.png"), fullPage: true }); }
    await editor.getByRole("button", { name: "تأكيد قرار الشدّة" }).click(); await editor.getByText("حُفظ قرار الشدّة في التدقيق. لم تُنشأ فاتورة ولم تتغيّر المبالغ أو العملات.").waitFor(); expect(await audit(s)).toHaveLength(1);
  } finally { await context.close(); }
});
it("browser: invoice branch offers only linking and does not reveal stored invoice values", async () => {
  const s = await scenario(), number = await invoice(s), context = await journey.browser.newContext(); try { const page = await context.newPage(), editor = await openEditor(page, s, "biller", "billed"); expect(await editor.getByLabel("القرار المسموح").locator("option").allTextContents()).toEqual(["اختر القرار", "فوتِرت — ربط فاتورة قائمة"]); expect(await editor.textContent()).not.toContain(number); await editor.getByLabel("رقم الفاتورة القائمة").fill(number); await editor.getByRole("button", { name: "تأكيد قرار الشدّة" }).click(); await editor.getByText("حُفظ قرار الشدّة في التدقيق. لم تُنشأ فاتورة ولم تتغيّر المبالغ أو العملات.").waitFor(); expect(await audit(s)).toHaveLength(1); } finally { await context.close(); }
});
it("browser: an obsolete observation refuses and refreshes instead of overwriting a newer case", async () => {
  const s = await scenario(), context = await journey.browser.newContext(); try { const page = await context.newPage(), editor = await openEditor(page, s); await editor.getByLabel("سبب بلا رسوم").fill("SYN old observation"); await journey.db.query("UPDATE ortho_cases SET note='SYN newer case' WHERE id=$1", [s.caseId]); await editor.getByRole("button", { name: "تأكيد قرار الشدّة" }).click(); await editor.getByText("تغيّرت الشدّة أو تعذّر تثبيت مرجعها. راجع الحالة والفاتورة قبل طلب جديد.").waitFor(); expect(await audit(s)).toEqual([]); expect(await editor.getByLabel("سبب بلا رسوم").count()).toBe(0); } finally { await context.close(); }
});
it("browser: lost committed response survives row disappearance and reload without automatic replay", async () => {
  const s = await scenario(), context = await journey.browser.newContext(); try { const page = await context.newPage(), editor = await openEditor(page, s); let requests = 0;
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === path(s)) requests++; });
    await page.route(`**${path(s)}`, async route => { const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort(); });
    await editor.getByLabel("سبب بلا رسوم").fill("SYN committed lost response"); await editor.getByRole("button", { name: "تأكيد قرار الشدّة" }).click(); await editor.getByText("قرار سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.").waitFor(); expect(await audit(s)).toHaveLength(1); expect(requests).toBe(1);
    await page.unroute(`**${path(s)}`); await page.reload(); const recovery = page.getByTestId("canonical-ortho-decision-editor"); await recovery.getByText("قرار سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.").waitFor(); await recovery.getByRole("button", { name: "التحقق من قائمة المراجعة الحالية" }).click(); await recovery.getByText("راجع السجل الحالي. اختفاء الشدّة من القائمة لا يثبت نتيجة طلب بعينه.").waitFor(); expect(requests).toBe(1); expect(await audit(s)).toHaveLength(1);
    const fresh = await scenario(); await page.getByRole("button", { name: "تحديث قائمة المراجعة" }).click(); await recovery.getByRole("button", { name: "راجعت الحالة، بدء قرار جديد" }).click(); await recovery.getByLabel("الشدّة من القراءة الحالية").selectOption(String(fresh.adjustmentId)); await recovery.getByLabel("القرار المسموح").selectOption("no_charge"); await recovery.getByLabel("سبب بلا رسوم").fill("SYN explicit new intent"); await recovery.getByRole("button", { name: "تأكيد قرار الشدّة" }).click(); await recovery.getByText("حُفظ قرار الشدّة في التدقيق. لم تُنشأ فاتورة ولم تتغيّر المبالغ أو العملات.").waitFor(); expect(await audit(fresh)).toHaveLength(1); expect(await audit(s)).toHaveLength(1);
  } finally { await context.close(); }
});
it("browser: a reader receives no decision preview or mutation form", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(); await journey.browserLogin(page, "viewer"); await page.goto(`${journey.baseUrl}/ortho`); await page.getByTestId("ortho-decision-summary").waitFor(); expect(await page.getByTestId("canonical-ortho-decision-editor").count()).toBe(0); } finally { await context.close(); }
});
it("HTTP/browser: withdrawing edit authority rejects a prepared form and fresh login without leaving a decision", async () => {
  const s = await scenario(), body = await draft(s), old = await journey.login("own"), original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.own])).rows[0].permissions, context = await journey.browser.newContext();
  try {
    const page = await context.newPage(), editor = await openEditor(page, s); await editor.getByLabel("سبب بلا رسوم").fill("SYN prepared before withdrawal");
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ortho.edit}','false')::text WHERE id=$1", [journey.ids.own]);
    expect((await journey.api(path(s), old.cookie, { method: "POST", body: JSON.stringify(body) })).status).toBe(401);
    await editor.getByRole("button", { name: "تأكيد قرار الشدّة" }).click(); await page.getByText("انتهت الجلسة أو تغيّرت صلاحياتك. سجّل الدخول من جديد.", { exact: true }).waitFor();
    expect(await editor.getByLabel("سبب بلا رسوم").count()).toBe(0); expect(await audit(s)).toEqual([]);
    const fresh = await journey.login("own"); expect((await journey.api(path(s), fresh.cookie, { method: "POST", body: JSON.stringify(body) })).status).toBe(403);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.own]); }
});
it("browser: unavailable tab storage is explicit and does not claim reload recovery", async () => {
  const s = await scenario(), context = await journey.browser.newContext(); try { await context.addInitScript(() => { const get = Storage.prototype.getItem, set = Storage.prototype.setItem; Storage.prototype.getItem = function(key) { if (key.startsWith("aqlan.ortho-decision.pending:")) throw new Error("SYN storage unavailable"); return get.call(this, key); }; Storage.prototype.setItem = function(key, value) { if (key.startsWith("aqlan.ortho-decision.pending:")) throw new Error("SYN storage unavailable"); return set.call(this, key, value); }; }); const page = await context.newPage(), editor = await openEditor(page, s); expect(await editor.textContent()).toContain("الاستعادة بعد إعادة التحميل غير مضمونة"); await editor.getByRole("button", { name: "إلغاء القرار" }).click(); expect(await audit(s)).toEqual([]); } finally { await context.close(); }
});
