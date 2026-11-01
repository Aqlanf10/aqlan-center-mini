import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
const VIEW = { "clinical.ortho.view": true };
const ACCOUNTS = {
  owner: { username: "canon-od-owner", password: "Canon#DecisionOwner1", role: "admin", display: "المالك التجريبي" },
  own: { username: "canon-od-own", password: "Canon#DecisionOwn1", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "none", grants: VIEW, display: "متابعة مراجعة التقويم" },
  all: { username: "canon-od-all", password: "Canon#DecisionAll1", role: "reception", patientScope: "all", appointmentScope: "none", grants: VIEW, display: "قارئ المراجعة" },
  none: { username: "canon-od-none", password: "Canon#DecisionNone1", role: "admin", patientScope: "none", grants: VIEW, display: "بلا نطاق" },
  adjacent: { username: "canon-od-adjacent", password: "Canon#DecisionAdjacent1", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true }, display: "قارئ الخطط" },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
const ids = { patient: 0, outside: 0, caseId: 0, adjustmentId: 0 };
beforeAll(async () => { journey = await openCanonicalJourney({ portOffset: 66, secret: "canonical-ortho-decisions-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed(db, _users, parties) {
  for (const key of ["patient", "outside"] as const) {
    ids[key] = (await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id", [`SYN-OD-${key}`, key === "patient" ? "مريض مراجعة اصطناعي" : "SYN outside decision", key === "patient" ? parties.own : null])).rows[0].id;
    const caseId = (await db.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [ids[key]])).rows[0].id;
    const adjustmentId = (await db.query("INSERT INTO ortho_adjustments(case_id,done_on,recorded_by,billing_class,note) VALUES($1,'2026-10-01','SYN','REVIEW_REQUIRED','SYN private adjustment note') RETURNING id", [caseId])).rows[0].id;
    if (key === "patient") { ids.caseId = caseId; ids.adjustmentId = adjustmentId; }
  }
} }); }, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
it("HTTP: canonical ortho viewer reads only their pending review queue", async () => {
  const session = await journey.login("own"), response = await journey.api("/api/ortho/billing-decisions", session.cookie);
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ projection: "ortho-pending-decisions", pending: [{ adjustmentId: ids.adjustmentId, patientId: ids.patient }] });
});
it("HTTP: anonymous, none and adjacent grants refuse; all and owner keep the same minimal projection", async () => {
  expect((await journey.api("/api/ortho/billing-decisions", "")).status).toBe(401);
  for (const key of ["none", "adjacent"] as const) { const session = await journey.login(key); expect((await journey.api("/api/ortho/billing-decisions", session.cookie)).status).toBe(403); }
  for (const key of ["all", "owner"] as const) {
    const session = await journey.login(key), response = await journey.api("/api/ortho/billing-decisions", session.cookie), body = await response.json(); expect(response.status).toBe(200); expect(body.pending).toHaveLength(2); expect(response.headers.get("cache-control")).toContain("no-store");
    for (const row of body.pending) expect(Object.keys(row).sort()).toEqual(["adjustmentId", "doctorName", "doneOn", "legacy", "patientId", "patientName"]);
    expect(JSON.stringify(body)).not.toMatch(/SYN private|visitId|invoice|currency|Minor|note|patientPhone/);
  }
});
it("HTTP: no caller query can expand scope, and read grants never authorize a decision", async () => {
  const session = await journey.login("owner"), snapshot = async () => (await journey.db.query("SELECT (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ortho_adjustments a) adjustments,(SELECT count(*) FROM audit_log)::int audits")).rows, before = await snapshot();
  for (const query of ["?scope=all", "?money=1", `?patientId=${ids.outside}`, "?visitId=1"]) expect((await journey.api(`/api/ortho/billing-decisions${query}`, session.cookie)).status).toBe(400);
  expect((await journey.api(`/api/ortho/adjustments/${ids.adjustmentId}/billing-decision`, session.cookie, { method: "POST", body: JSON.stringify({ decision: "no_charge", reason: "SYN held decision" }) })).status).toBe(401);
  expect((await journey.api("/api/ortho/billing-decisions", session.cookie)).status).toBe(200); expect(await snapshot()).toEqual(before); expect(await journey.ddlLog()).toEqual([]);
});
async function openQueue(page: import("playwright").Page, key: keyof typeof ACCOUNTS = "own") { await journey.browserLogin(page, key); await page.goto(`${journey.baseUrl}/ortho`); const panel = page.getByTestId("canonical-ortho-decisions"); await panel.getByTestId("ortho-decision-summary").waitFor(); return panel; }
it("HTTP/browser: a legacy visit without patient ownership fails closed and clears stale queue data", async () => {
  const context = await journey.browser.newContext();
  try {
    const page = await context.newPage(), panel = await openQueue(page), session = await journey.login("own");
    const doctor = (await journey.db.query("INSERT INTO parties(kind,name) VALUES('doctor','SYN private unlinked clinician') RETURNING id")).rows[0].id;
    const visit = (await journey.db.query("INSERT INTO visits(patient_name,doctor_id) VALUES('SYN unlinked visit',$1) RETURNING id", [doctor])).rows[0].id;
    await journey.db.query("UPDATE ortho_adjustments SET visit_id=$1 WHERE id=$2", [visit, ids.adjustmentId]);
    const response = await journey.api("/api/ortho/billing-decisions", session.cookie);
    expect(response.status).toBe(500); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ message: "تعذّر التحقق من قائمة المراجعة؛ لم تُعتبر فارغة." });
    await panel.getByRole("button", { name: "تحديث قائمة المراجعة" }).click(); await panel.getByRole("alert").waitFor();
    expect(await panel.getByTestId("ortho-decision-summary").count()).toBe(0);
    expect(await panel.textContent()).not.toMatch(/مريض مراجعة اصطناعي|SYN private|SYN unlinked/);
    expect((await journey.db.query("SELECT patient_id FROM visits WHERE id=$1", [visit])).rows[0].patient_id).toBeNull();
    expect((await journey.db.query("SELECT visit_id FROM ortho_adjustments WHERE id=$1", [ids.adjustmentId])).rows[0].visit_id).toBe(visit);
  } finally { await journey.db.query("UPDATE ortho_adjustments SET visit_id=NULL WHERE id=$1", [ids.adjustmentId]); await context.close(); }
});
it("browser: 390px scoped queue preserves identity without decision buttons, financial data or visit access", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try { const page = await context.newPage(), calls: string[] = []; page.on("request", r => { if (new URL(r.url()).pathname.startsWith("/api/")) calls.push(`${r.method()} ${new URL(r.url()).pathname}`); }); const panel = await openQueue(page);
    expect(await panel.textContent()).toContain("مريض مراجعة اصطناعي"); expect(await panel.textContent()).not.toMatch(/SYN outside|SYN private/); expect(await panel.getByRole("button", { name: /فوتِرت|بلا رسوم|حفظ|إرسال/ }).count()).toBe(0); expect(calls.some(c => /^POST \/api\/ortho/.test(c))).toBe(false); expect(await panel.locator('a[href^="/visits/"]').count()).toBe(0); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (process.env.HR_EVIDENCE_DIR) { const { mkdirSync } = await import("node:fs"), { join } = await import("node:path"); mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "ortho-decisions-390.png"), fullPage: true }); }
  } finally { await context.close(); }
});
it("browser: malformed and failed refresh clear the saved review list", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(), panel = await openQueue(page);
    await page.route("**/api/ortho/billing-decisions", async route => { const response = await route.fetch(), body = await response.json(); delete body.projection; await route.fulfill({ response, json: body }); }); await panel.getByRole("button", { name: "تحديث قائمة المراجعة" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("ortho-decision-summary").count()).toBe(0);
    await page.unroute("**/api/ortho/billing-decisions"); await page.route("**/api/ortho/billing-decisions", route => route.abort()); await panel.getByRole("button", { name: "تحديث قائمة المراجعة" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.textContent()).not.toContain("مريض مراجعة اصطناعي");
  } finally { await context.close(); }
});
it("browser: a late valid response cannot repopulate the hidden queue", async () => {
  const context = await journey.browser.newContext(); let release: (() => void) | undefined;
  try { const page = await context.newPage(), panel = await openQueue(page); let reached!: () => void; const intercepted = new Promise<void>(r => { reached = r; }), held = new Promise<void>(r => { release = r; });
    await page.route("**/api/ortho/billing-decisions", async route => { const response = await route.fetch(); reached(); await held; await route.fulfill({ response }).catch(() => {}); }); await panel.getByRole("button", { name: "تحديث قائمة المراجعة" }).click(); await intercepted;
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); }); release!(); await page.waitForTimeout(100); expect(await panel.getByTestId("ortho-decision-summary").count()).toBe(0);
    await page.unroute("**/api/ortho/billing-decisions"); await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); }); await panel.getByTestId("ortho-decision-summary").waitFor();
  } finally { release?.(); await context.close(); }
});
it("browser and HTTP: withdrawing ortho visibility clears content and denies old/fresh sessions", async () => {
  const context = await journey.browser.newContext(), original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.all])).rows[0].permissions;
  try { const old = await journey.login("all"), page = await context.newPage(), panel = await openQueue(page, "all"); await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ortho.view}','false')::text WHERE id=$1", [journey.ids.all]); await panel.getByRole("button", { name: "تحديث قائمة المراجعة" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("ortho-decision-summary").count()).toBe(0); expect((await journey.api("/api/ortho/billing-decisions", old.cookie)).status).toBe(401); const fresh = await journey.login("all"); expect((await journey.api("/api/ortho/billing-decisions", fresh.cookie)).status).toBe(403);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.all]); }
});
it("browser: an adjacent grant never mounts or fetches the review queue", async () => {
  const context = await journey.browser.newContext(); try { const page = await context.newPage(); await journey.browserLogin(page, "adjacent"); const calls: string[] = []; page.on("request", r => calls.push(new URL(r.url()).pathname)); await page.goto(`${journey.baseUrl}/ortho`); await page.waitForLoadState("networkidle"); expect(await page.getByTestId("canonical-ortho-decisions").count()).toBe(0); expect(calls.filter(p => p === "/api/ortho/billing-decisions")).toEqual([]); }
  finally { await context.close(); }
});
