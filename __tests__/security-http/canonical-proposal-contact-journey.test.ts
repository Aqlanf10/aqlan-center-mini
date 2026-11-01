import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
const GRANTS = { "clinical.plans.edit": true, "clinical.plans.view": true };
const ACCOUNTS = {
  owner: { username: "canon-contact-owner", password: "Canon#ProposalOwner1", role: "admin", display: "المالك التجريبي" },
  own: { username: "canon-contact-own", password: "Canon#ProposalOwn1", role: "doctor", doctor: true, patientScope: "own", grants: GRANTS, display: "متابعة خططي" },
  all: { username: "canon-contact-all", password: "Canon#ProposalAll1", role: "reception", patientScope: "all", grants: GRANTS, display: "متابعة العروض" },
  money: { username: "canon-contact-money", password: "Canon#ProposalMoney1", role: "reception", patientScope: "all", grants: { ...GRANTS, "finance.patient-ledger.view": true }, display: "متابعة وحساب" },
  none: { username: "canon-contact-none", password: "Canon#ProposalNone1", role: "admin", patientScope: "none", grants: GRANTS, display: "بلا نطاق" },
  viewer: { username: "canon-contact-viewer", password: "Canon#ProposalViewer1", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true }, display: "قارئ الخطط" },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
const ids = { patient: 0, outside: 0, plan: 0 };
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 65, secret: "canonical-proposal-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner", async seed(db, _users, parties) {
    ids.patient = (await db.query("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-PROP-own','مريض عرض تجريبي','770000111',$1) RETURNING id", [parties.own!])).rows[0].id;
    ids.outside = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-PROP-outside','SYN outside proposal') RETURNING id")).rows[0].id;
    ids.plan = (await db.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,created_at) VALUES($1,'SYN عرض علاج',123456,'YER','2026-10-01 09:00+03') RETURNING id", [ids.patient])).rows[0].id;
    await db.query("INSERT INTO plan_items(plan_id,service_name,status) VALUES($1,'SYN private item','planned')", [ids.plan]);
    await db.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_at) VALUES($1,'SYN outside title',654321,'2026-09-01 09:00+03')", [ids.outside]);
  } });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
it("HTTP: canonical own-scope editor records an already completed manual contact", async () => {
  const session = await journey.login("own"), feed = await (await journey.api("/api/plans/proposals", session.cookie)).json(), row = feed.proposals.find((r: {planId:number}) => r.planId === ids.plan);
  const response = await journey.api("/api/plans/proposals", session.cookie, { method:"POST", body: JSON.stringify({ planId:ids.plan, patientId:ids.patient, expectedVersion:row.contactVersion, note:"SYN contact done" }) });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ok:true,planId:ids.plan});
});
async function observed(cookie: string, planId = ids.plan) { const feed = await (await journey.api("/api/plans/proposals", cookie)).json(), row = feed.proposals.find((r: {planId:number}) => r.planId === planId); return { planId, patientId: row.patientId, expectedVersion: row.contactVersion, note: null }; }
const auditCount = async () => Number((await journey.db.query("SELECT count(*) n FROM audit_log WHERE action='plan.proposal_contact' AND entity_id=$1", [String(ids.plan)])).rows[0].n);
it("HTTP: refusal matrix, strict bodies and query cannot grant a manual contact", async () => {
  const owner = await journey.login("owner"), body = await observed(owner.cookie), before = await auditCount();
  expect((await journey.api("/api/plans/proposals", "", { method: "POST", body: JSON.stringify(body) })).status).toBe(401);
  for (const key of ["viewer", "none"] as const) { const session = await journey.login(key), r = await journey.api("/api/plans/proposals", session.cookie, { method: "POST", body: JSON.stringify(body) }); expect(r.status).toBe(403); expect(r.headers.get("cache-control")).toContain("no-store"); }
  for (const input of [null, [], { ...body, planId: String(body.planId) }, { ...body, note: ["bad"] }, { ...body, note: "ع".repeat(301) }, { ...body, actor: "owner" }, { ...body, expectedVersion: [body.expectedVersion] }]) expect((await journey.api("/api/plans/proposals", owner.cookie, { method: "POST", body: JSON.stringify(input) })).status).toBe(400);
  expect((await journey.api("/api/plans/proposals?scope=all", owner.cookie, { method: "POST", body: JSON.stringify(body) })).status).toBe(400);
  const own = await journey.login("own"), outside = (await journey.db.query("SELECT id FROM treatment_plans WHERE patient_id=$1", [ids.outside])).rows[0].id;
  const statuses = []; for (const planId of [outside, 2147483647]) { const r = await journey.api("/api/plans/proposals", own.cookie, { method: "POST", body: JSON.stringify({ ...body, planId }) }); statuses.push(await r.json()); expect(r.status).toBe(404); }
  expect(statuses[0]).toEqual(statuses[1]); expect(await auditCount()).toBe(before);
});
it("HTTP: a single observed intention cannot record twice, while a newly checked explicit contact can", async () => {
  const own = await journey.login("own"), body = await observed(own.cookie), before = await auditCount(), sql = "SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM treatment_plans t) plans,(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM plan_installments t) installments", state = (await journey.db.query(sql)).rows;
  for (const expected of [200, 409]) { const r = await journey.api("/api/plans/proposals", own.cookie, { method: "POST", body: JSON.stringify(body) }); expect(r.status).toBe(expected); expect(r.headers.get("cache-control")).toContain("no-store"); }
  expect(await auditCount()).toBe(before + 1); expect((await journey.db.query(sql)).rows).toEqual(state);
  const fresh = await observed(own.cookie); expect(fresh.expectedVersion).not.toBe(body.expectedVersion); expect((await journey.api("/api/plans/proposals", own.cookie, { method: "POST", body: JSON.stringify(fresh) })).status).toBe(200); expect(await auditCount()).toBe(before + 2); expect(await journey.ddlLog()).toEqual([]);
});
async function openEditor(page: import("playwright").Page, key: keyof typeof ACCOUNTS = "own") {
  await journey.browserLogin(page, key); await page.goto(`${journey.baseUrl}/recall`); const panel = page.getByTestId("canonical-proposal-contact");
  await panel.getByRole("button", { name: "تسجيل تواصل يدوي تم بالفعل" }).click(); await panel.getByLabel("العرض الذي تم التواصل بشأنه").selectOption(String(ids.plan)); return panel;
}
it("browser: explicit completed contact records once without dispatch, money or consent effects", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 } });
  try { const page = await context.newPage(), calls: string[] = [], before = await auditCount(); page.on("request", r => { if (r.method() === "POST" && new URL(r.url()).pathname.startsWith("/api/")) calls.push(new URL(r.url()).pathname); });
    const panel = await openEditor(page); calls.length = 0; await panel.getByLabel("ملاحظة التواصل الاختيارية").fill("SYN أُنجز الاتصال بالفعل"); await panel.getByRole("button", { name: "تأكيد تسجيل التواصل المنجز" }).click(); await panel.getByText("سُجّل التواصل اليدوي في التدقيق.", { exact: false }).waitFor();
    expect(await auditCount()).toBe(before + 1); expect(calls).toEqual(["/api/plans/proposals"]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await journey.db.query("SELECT consent_at,last_reminder_at,total_minor::text FROM treatment_plans WHERE id=$1", [ids.plan])).rows[0]).toEqual({ consent_at: null, last_reminder_at: null, total_minor: "123456" });
    if (process.env.HR_EVIDENCE_DIR) { const { mkdirSync } = await import("node:fs"), { join } = await import("node:path"); mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "proposal-contact-390.png"), fullPage: true }); }
  } finally { await context.close(); }
});
it("browser: a committed lost reply survives reload and requires a fresh check plus explicit new intent", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(), panel = await openEditor(page), before = await auditCount(); let posts = 0;
    await page.route("**/api/plans/proposals", async route => { if (route.request().method() !== "POST") return route.continue(); posts++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort(); });
    await panel.getByRole("button", { name: "تأكيد تسجيل التواصل المنجز" }).click(); await panel.getByText("لم تتأكد نتيجة تسجيل التواصل. لن نعيد الطلب تلقائيًا.", { exact: true }).waitFor(); expect(await auditCount()).toBe(before + 1);
    await page.reload(); const restored = page.getByTestId("canonical-proposal-contact"); await restored.getByText("تسجيل تواصل سابق يحتاج مراجعة.", { exact: false }).waitFor(); expect(posts).toBe(1);
    await restored.getByRole("button", { name: "التحقق من العروض وسجل التواصل الحالي" }).click(); await restored.getByRole("button", { name: "راجعت الحالة، تسجيل تواصل جديد" }).waitFor(); expect(posts).toBe(1); expect(await auditCount()).toBe(before + 1);
    await page.unroute("**/api/plans/proposals"); await restored.getByRole("button", { name: "راجعت الحالة، تسجيل تواصل جديد" }).click(); await restored.getByLabel("العرض الذي تم التواصل بشأنه").selectOption(String(ids.plan)); await restored.getByRole("button", { name: "تأكيد تسجيل التواصل المنجز" }).click(); await restored.getByText("سُجّل التواصل اليدوي في التدقيق.", { exact: false }).waitFor(); expect(await auditCount()).toBe(before + 2);
  } finally { await context.close(); }
});
it("browser: pending recovery stays at list level if the proposal is later consented and disappears", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(), panel = await openEditor(page), before = await auditCount(); let posts = 0;
    await page.route("**/api/plans/proposals", async route => { if (route.request().method() !== "POST") return route.continue(); posts++; await route.fetch(); await journey.db.query("UPDATE treatment_plans SET consent_at=NOW() WHERE id=$1", [ids.plan]); await route.abort(); });
    await panel.getByRole("button", { name: "تأكيد تسجيل التواصل المنجز" }).click(); await panel.getByText("لم تتأكد نتيجة تسجيل التواصل. لن نعيد الطلب تلقائيًا.", { exact: true }).waitFor(); await page.reload();
    const restored = page.getByTestId("canonical-proposal-contact"); await restored.getByText("تسجيل تواصل سابق يحتاج مراجعة.", { exact: false }).waitFor(); await page.getByTestId("proposal-summary").waitFor(); expect(await page.locator(`[data-plan-id="${ids.plan}"]`).count()).toBe(0); expect(posts).toBe(1); expect(await auditCount()).toBe(before + 1);
    expect(await restored.textContent()).not.toContain("تم تأكيد");
  } finally { await context.close(); await journey.db.query("UPDATE treatment_plans SET consent_at=NULL WHERE id=$1", [ids.plan]); }
});
it("browser: unavailable session storage warns and retains the in-memory uncertain-result gate", async () => {
  const context = await journey.browser.newContext();
  try { await context.addInitScript(() => { const fail = () => { throw new Error("SYN storage unavailable"); }; Object.defineProperty(window, "sessionStorage", { get: fail }); }); const page = await context.newPage(), panel = await openEditor(page); await panel.getByText("تعذّر حفظ متابعة الطلب في التبويب", { exact: false }).waitFor(); let posts = 0;
    await page.route("**/api/plans/proposals", route => { if (route.request().method() !== "POST") return route.continue(); posts++; return route.fulfill({ status: 200, json: { ok: true, planId: -1 } }); });
    await panel.getByRole("button", { name: "تأكيد تسجيل التواصل المنجز" }).click(); await panel.getByText("لم تتأكد نتيجة تسجيل التواصل. لن نعيد الطلب تلقائيًا.", { exact: true }).waitFor(); await panel.getByRole("button", { name: "التحقق من العروض وسجل التواصل الحالي" }).click(); await panel.getByRole("button", { name: "راجعت الحالة، تسجيل تواصل جديد" }).waitFor(); expect(posts).toBe(1); expect(await panel.getByRole("button", { name: "تأكيد تسجيل التواصل المنجز" }).count()).toBe(0);
  } finally { await context.close(); }
});
it("browser and HTTP: withdrawn authority refuses an open draft and stale replay", async () => {
  const context = await journey.browser.newContext(), original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.all])).rows[0].permissions;
  try { const session = await journey.login("all"), body = await observed(session.cookie), page = await context.newPage(), panel = await openEditor(page, "all"), before = await auditCount();
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.plans.edit}','false')::text WHERE id=$1", [journey.ids.all]);
    await panel.getByRole("button", { name: "تأكيد تسجيل التواصل المنجز" }).click(); await page.getByTestId("canonical-proposals").getByRole("alert").waitFor(); expect(await auditCount()).toBe(before); expect(await panel.getByLabel("ملاحظة التواصل الاختيارية").count()).toBe(0);
    expect((await journey.api("/api/plans/proposals", session.cookie, { method: "POST", body: JSON.stringify(body) })).status).toBe(401); const fresh = await journey.login("all"); expect((await journey.api("/api/plans/proposals", fresh.cookie, { method: "POST", body: JSON.stringify(body) })).status).toBe(403);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.all]); }
});
