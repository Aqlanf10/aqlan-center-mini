import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
const GRANTS = { "clinical.plans.edit": true, "clinical.plans.view": true };
const ACCOUNTS = {
  owner: { username: "canon-proposal-owner", password: "Canon#ProposalOwner1", role: "admin", display: "المالك التجريبي" },
  own: { username: "canon-proposal-own", password: "Canon#ProposalOwn1", role: "doctor", doctor: true, patientScope: "own", grants: GRANTS, display: "متابعة خططي" },
  all: { username: "canon-proposal-all", password: "Canon#ProposalAll1", role: "reception", patientScope: "all", grants: GRANTS, display: "متابعة العروض" },
  money: { username: "canon-proposal-money", password: "Canon#ProposalMoney1", role: "reception", patientScope: "all", grants: { ...GRANTS, "finance.patient-ledger.view": true }, display: "متابعة وحساب" },
  none: { username: "canon-proposal-none", password: "Canon#ProposalNone1", role: "admin", patientScope: "none", grants: GRANTS, display: "بلا نطاق" },
  viewer: { username: "canon-proposal-viewer", password: "Canon#ProposalViewer1", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true }, display: "قارئ الخطط" },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
const ids = { patient: 0, outside: 0, plan: 0 };
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 64, secret: "canonical-proposal-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner", async seed(db, _users, parties) {
    ids.patient = (await db.query("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-PROP-own','مريض عرض تجريبي','770000111',$1) RETURNING id", [parties.own!])).rows[0].id;
    ids.outside = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-PROP-outside','SYN outside proposal') RETURNING id")).rows[0].id;
    ids.plan = (await db.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,created_at) VALUES($1,'SYN عرض علاج',123456,'YER','2026-10-01 09:00+03') RETURNING id", [ids.patient])).rows[0].id;
    await db.query("INSERT INTO plan_items(plan_id,service_name,status) VALUES($1,'SYN private item','planned')", [ids.plan]);
    await db.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_at) VALUES($1,'SYN outside title',654321,'2026-09-01 09:00+03')", [ids.outside]);
  } });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
it("HTTP: a canonical plan editor reads scoped proposals without a legacy session", async () => {
  const session = await journey.login("own"); expect(session.status).toBe(200);
  const response = await journey.api("/api/plans/proposals", session.cookie); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ projection: "pending-plan-proposals", proposals: [{ planId: ids.plan, patientId: ids.patient }] });
});
it("HTTP: anonymous, view-only and none scopes are refused without legacy role grants", async () => {
  expect((await journey.api("/api/plans/proposals", "")).status).toBe(401);
  for (const key of ["none", "viewer"] as const) { const session = await journey.login(key), r = await journey.api("/api/plans/proposals", session.cookie); expect(r.status).toBe(403); expect(r.headers.get("cache-control")).toContain("no-store"); }
});
it("HTTP: money and scope are independent and no source notes or dispatch grant are exposed", async () => {
  for (const key of ["own", "all", "money", "owner"] as const) {
    const session = await journey.login(key), r = await journey.api("/api/plans/proposals", session.cookie); expect(r.status).toBe(200); const body = await r.json();
    expect(body.proposals).toHaveLength(key === "own" ? 1 : 2); expect(body.canSeeMoney).toBe(key === "money" || key === "owner");
    expect(JSON.stringify(body)).not.toMatch(/SYN private item|whatsappAllowed|note|invoice|planXmin|planTid/);
    if (key === "own" || key === "all") expect(JSON.stringify(body)).not.toMatch(/123456|654321|totalMinor|currency/);
    else expect(body.proposals.find((p:{planId:number}) => p.planId === ids.plan).money).toEqual({ totalMinor: 123456, currency: "YER" });
    expect(r.headers.get("cache-control")).toContain("no-store");
  }
  const own = await journey.login("own");
  for (const query of ["?scope=all", "?money=1", `?patientId=${ids.outside}`]) expect((await journey.api(`/api/plans/proposals${query}`, own.cookie)).status).toBe(400);
  expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: read and invalid canonical POST preserve plans, money and audit", async () => {
  const session = await journey.login("owner"), sql = "SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM treatment_plans t) plans,(SELECT count(*) FROM audit_log)::int audits", before = (await journey.db.query(sql)).rows;
  expect((await journey.api("/api/plans/proposals", session.cookie)).status).toBe(200);
  expect((await journey.api("/api/plans/proposals", session.cookie, { method: "POST", body: JSON.stringify({ planId: ids.plan, note: "SYN held" }) })).status).toBe(400);
  expect((await journey.db.query(sql)).rows).toEqual(before);
});
async function openProposals(page: import("playwright").Page, key: keyof typeof ACCOUNTS = "own") {
  await journey.browserLogin(page, key); await page.goto(`${journey.baseUrl}/recall`);
  const panel = page.getByTestId("canonical-proposals"); await panel.getByTestId("proposal-summary").waitFor(); return panel;
}
it("browser: 390px scoped proposals keep the current identity with no hidden money or message dispatch", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try {
    const page = await context.newPage(), calls: string[] = []; page.on("request", r => { if (new URL(r.url()).pathname.startsWith("/api/")) calls.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    const panel = await openProposals(page); await panel.getByText("SYN عرض علاج — 1 بند", { exact: true }).waitFor();
    expect(await panel.textContent()).not.toMatch(/123456|654321|SYN outside|SYN private item/); expect(await panel.locator('a[href^="https://wa.me"],a[href^="tel:"]').count()).toBe(0);
    expect(await panel.getByRole("button", { name: /تواصلت|حفظ|موافقة|إرسال/ }).count()).toBe(0);
    expect(calls.some(c => /^(POST|PUT|PATCH) \/api\/(plans|messages)/.test(c))).toBe(false); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (process.env.HR_EVIDENCE_DIR) { const { mkdirSync } = await import("node:fs"), { join } = await import("node:path"); mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "proposals-390.png"), fullPage: true }); }
  } finally { await context.close(); }
});
it("browser: view-only grant never mounts the editor-authorized proposal list", async () => {
  const context = await journey.browser.newContext(); try {
    const page = await context.newPage(), calls: string[] = []; page.on("request", r => calls.push(r.url())); await journey.browserLogin(page, "viewer"); await page.goto(`${journey.baseUrl}/recall`); await page.getByRole("heading", { name: /المتابعة/ }).first().waitFor();
    expect(await page.getByTestId("canonical-proposals").count()).toBe(0); expect(calls.some(c => new URL(c).pathname === "/api/plans/proposals")).toBe(false);
  } finally { await context.close(); }
});
it("browser: malformed or failed refresh clears the prior proposal list", async () => {
  const context = await journey.browser.newContext(); try {
    const page = await context.newPage(), panel = await openProposals(page);
    await page.route("**/api/plans/proposals", async route => { const response = await route.fetch(), body = await response.json(); body.projection = "legacy"; await route.fulfill({ response, json: body }); });
    await panel.getByRole("button", { name: "تحديث عروض العلاج" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("proposal-summary").count()).toBe(0);
    await page.unroute("**/api/plans/proposals"); await page.route("**/api/plans/proposals", route => route.abort());
    await panel.getByRole("button", { name: "تحديث عروض العلاج" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("proposal-summary").count()).toBe(0);
  } finally { await context.close(); }
});
it("browser and HTTP: grant withdrawal clears old content and denies old and newly authenticated sessions", async () => {
  const context = await journey.browser.newContext(), original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.all])).rows[0].permissions;
  try {
    const stale = await journey.login("all"), page = await context.newPage(), panel = await openProposals(page, "all");
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.plans.edit}','false')::text WHERE id=$1", [journey.ids.all]);
    await panel.getByRole("button", { name: "تحديث عروض العلاج" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("proposal-summary").count()).toBe(0);
    expect((await journey.api("/api/plans/proposals", stale.cookie)).status).toBe(401); const fresh = await journey.login("all"); expect((await journey.api("/api/plans/proposals", fresh.cookie)).status).toBe(403);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.all]); }
});
it("browser: a late successful refresh cannot repopulate a hidden proposal pane", async () => {
  const context = await journey.browser.newContext(); let release: (() => void) | undefined;
  try {
    const page = await context.newPage(), panel = await openProposals(page);
    let reached!: () => void; const intercepted = new Promise<void>(resolve => { reached = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/plans/proposals", async route => { const response = await route.fetch(); reached(); await held; await route.fulfill({ response }).catch(() => {}); });
    await panel.getByRole("button", { name: "تحديث عروض العلاج" }).click(); await intercepted;
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    release!(); await page.waitForTimeout(100);
    expect(await panel.getByTestId("proposal-summary").count()).toBe(0); expect(await panel.textContent()).not.toContain("مريض عرض تجريبي");
    await page.unroute("**/api/plans/proposals");
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
    await panel.getByTestId("proposal-summary").waitFor();
  } finally { release?.(); await context.close(); }
});
