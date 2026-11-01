/** Slice 48: synthetic canonical coverage read, never admission to its writers. */
import { seedCanonicalCoverage } from "../fixtures/canonical-ortho-coverage";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
const GRANTS = { "finance.agreements.manage": true, "finance.patient-ledger.view": true };
const ACCOUNTS = {
  owner: { username: "canon-cov-owner", password: "Canon#CoverageOwner1", role: "admin", display: "المالك التجريبي" },
  own: { username: "canon-cov-own", password: "Canon#CoverageOwn1", role: "doctor", doctor: true, display: "طبيب تجريبي", patientScope: "own", grants: GRANTS },
  all: { username: "canon-cov-all", password: "Canon#CoverageAll1", role: "reception", display: "متابعة الاتفاق", patientScope: "all", grants: GRANTS },
  ui: { username: "canon-cov-ui", password: "Canon#CoverageUI1", role: "reception", display: "متابعة سريرية واتفاق", patientScope: "all", grants: { ...GRANTS, "clinical.ortho.view": true } },
  invoice: { username: "canon-cov-invoice", password: "Canon#CoverageInvoice1", role: "reception", display: "متابعة الفواتير", patientScope: "all", grants: { ...GRANTS, "finance.invoices.view": true } },
  none: { username: "canon-cov-none", password: "Canon#CoverageNone1", role: "admin", display: "بلا نطاق", patientScope: "none", grants: GRANTS },
  adjacent: { username: "canon-cov-adjacent", password: "Canon#CoverageAdjacent1", role: "admin", display: "منحة مجاورة", patientScope: "all", grants: { "clinical.ortho.view": true } },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
const ids = { patient: 0, ortho: 0, outside: 0 };
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 63, secret: "canonical-coverage-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner", async seed(db, _users, parties) {
    ids.patient = (await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-COVJ-own','مريض تجريبي',$1) RETURNING id", [parties.own!])).rows[0].id;
    ids.outside = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-COVJ-outside','مريض خارج النطاق') RETURNING id")).rows[0].id;
    ids.ortho = (await db.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [ids.patient])).rows[0].id;
    await seedCanonicalCoverage(db, { patientId: ids.patient, caseId: ids.ortho, actorId: _users.owner, doctorId: parties.own! });
  } });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
it("HTTP: current agreement grant reads scoped coverage without a legacy session", async () => {
  const session = await journey.login("own"); expect(session.status).toBe(200);
  const response = await journey.api(`/api/ortho/${ids.ortho}/followup-coverage?patientId=${ids.patient}`, session.cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ projection: "ortho-followup-coverage", patientId: ids.patient, orthoCaseId: ids.ortho });
});
const path = () => `/api/ortho/${ids.ortho}/followup-coverage?patientId=${ids.patient}`;
it("HTTP: anonymous, none and adjacent roles cannot acquire agreement authority", async () => {
  expect((await journey.api(path(), "")).status).toBe(401);
  for (const key of ["none", "adjacent"] as const) { const session = await journey.login(key), r = await journey.api(path(), session.cookie); expect(r.status).toBe(403); expect(r.headers.get("cache-control")).toContain("no-store"); }
});
it("HTTP: source invoice projection is independently granted and the owner remains complete", async () => {
  for (const key of ["own", "all", "invoice", "owner"] as const) {
    const session = await journey.login(key), r = await journey.api(path(), session.cookie); expect(r.status).toBe(200); const body = await r.json();
    expect(body).toMatchObject({ enabled: true, applicable: true, current: { decision: "included" } });
    expect(JSON.stringify(body)).not.toMatch(/sourceFingerprint|snapshot|commandId|250000|clinicalCaseId|planItemId|tooth|canEdit|private clinical|private plan/);
    if (key === "own" || key === "all") { expect(body.invoiceSources).toEqual({ state: "restricted" }); expect(JSON.stringify(body)).not.toMatch(/SYN-COV-INVOICE|SYN invoice service/); }
    else expect(body.invoiceSources).toMatchObject({ state: "allowed", items: [{ serviceName: "SYN invoice service" }] });
    expect(r.headers.get("cache-control")).toContain("no-store");
  }
  expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: foreign patient aliases and URL expansions cannot disclose invoice or clinical data", async () => {
  const session = await journey.login("own"), bodies = [];
  for (const patient of [ids.outside, 2147483647]) { const r = await journey.api(`/api/ortho/${ids.ortho}/followup-coverage?patientId=${patient}`, session.cookie); expect(r.status).toBe(404); bodies.push(await r.json()); }
  expect(bodies[0]).toEqual(bodies[1]);
  for (const query of ["", "patientId=01", `patientId=${ids.patient}&patientId=${ids.patient}`, `patientId=${ids.patient}&sources=all`]) {
    const r = await journey.api(`/api/ortho/${ids.ortho}/followup-coverage?${query}`, session.cookie); expect(r.status).toBe(400); expect(await r.text()).not.toContain("SYN");
  }
});
it("HTTP: GET and refused command/status writes preserve money, signed proof, history and audit", async () => {
  const sql = "SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ortho_followup_coverage_revisions r) revisions,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT count(*) FROM audit_log)::int audits,(SELECT count(*) FROM ortho_followup_coverage_rejections)::int refusals";
  const session = await journey.login("owner"), before = (await journey.db.query(sql)).rows;
  expect((await journey.api(path(), session.cookie)).status).toBe(200);
  for (const method of ["POST", "PUT"]) expect((await journey.api(path(), session.cookie, { method, body: "{}" })).status).toBe(401);
  expect((await journey.db.query(sql)).rows).toEqual(before); expect(await journey.ddlLog()).toEqual([]);
});
async function openCoverage(page: import("playwright").Page, key: keyof typeof ACCOUNTS = "ui") {
  await journey.browserLogin(page, key); await page.goto(`${journey.baseUrl}/patients/${ids.patient}`);
  await page.getByRole("button", { name: "عرض حالات التقويم" }).click(); await page.getByRole("button", { name: "عرض تفاصيل الحالة" }).click();
  await page.getByRole("button", { name: "عرض نطاق المتابعات المحفوظ" }).click();
  const panel = page.getByTestId("canonical-ortho-coverage"); await panel.getByTestId("ortho-coverage-saved").waitFor(); return panel;
}
it("browser: 390px RTL read-only decision, no hidden invoice text, editors or source endpoint", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try {
    const page = await context.newPage(), calls: string[] = []; page.on("request", r => { if (new URL(r.url()).pathname.startsWith("/api/")) calls.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    const panel = await openCoverage(page); await panel.getByText("سبب القرار: SYN سبب الاتفاق المحفوظ", { exact: true }).waitFor();
    expect(await panel.locator("input,textarea,select,img").count()).toBe(0); expect(await panel.textContent()).not.toMatch(/SYN-COV-INVOICE|SYN invoice service/);
    expect(calls.some(c => /\/api\/(invoices|plans|documents|ceph)|^(POST|PUT) .*followup-coverage/.test(c))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (process.env.HR_EVIDENCE_DIR) { mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "ortho-coverage-390.png"), fullPage: true }); }
  } finally { await context.close(); }
});
it("browser: a clinical-only user gets no financial control and makes no coverage request", async () => {
  const context = await journey.browser.newContext(); try {
    const page = await context.newPage(), calls: string[] = []; page.on("request", r => calls.push(r.url()));
    await journey.browserLogin(page, "adjacent"); await page.goto(`${journey.baseUrl}/patients/${ids.patient}`); await page.getByRole("button", { name: "عرض حالات التقويم" }).click(); await page.getByRole("button", { name: "عرض تفاصيل الحالة" }).click(); await page.getByTestId("canonical-ortho-detail").getByText("السجل السريري للتقويم", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "عرض نطاق المتابعات المحفوظ" }).count()).toBe(0); expect(calls.some(c => c.includes("followup-coverage"))).toBe(false);
  } finally { await context.close(); }
});
it("browser: malformed and failed refresh clears old decisions without inventing a saved exclusion", async () => {
  const context = await journey.browser.newContext(); try {
    const page = await context.newPage(), panel = await openCoverage(page);
    await page.route("**/followup-coverage?*", async route => { const response = await route.fetch(), body = await response.json(); body.patientId = ids.outside; await route.fulfill({ response, json: body }); });
    await panel.getByRole("button", { name: "تحديث نطاق المتابعات" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("ortho-coverage-saved").count()).toBe(0);
    await page.unroute("**/followup-coverage?*"); await page.route("**/followup-coverage?*", route => route.abort());
    await panel.getByRole("button", { name: "تحديث نطاق المتابعات" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("ortho-coverage-saved").count()).toBe(0);
  } finally { await context.close(); }
});
it("browser and HTTP: revocation clears a visible decision and denies stale/fresh sessions", async () => {
  const context = await journey.browser.newContext(), original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.ui])).rows[0].permissions;
  try {
    const stale = await journey.login("ui"), page = await context.newPage(), panel = await openCoverage(page);
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,finance.agreements.manage}','false')::text WHERE id=$1", [journey.ids.ui]);
    await panel.getByRole("button", { name: "تحديث نطاق المتابعات" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("ortho-coverage-saved").count()).toBe(0);
    expect((await journey.api(path(), stale.cookie)).status).toBe(401); const fresh = await journey.login("ui"); expect((await journey.api(path(), fresh.cookie)).status).toBe(403);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.ui]); }
});
it("browser: a delayed prior response cannot restore a closed decision", async () => {
  const context = await journey.browser.newContext(); let release!: () => void, reached!: () => void, finished!: () => void;
  const held = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { reached = r; }), done = new Promise<void>(r => { finished = r; });
  try {
    const page = await context.newPage(), panel = await openCoverage(page); let first = true;
    await page.route("**/followup-coverage?*", async route => { if (!first) { await route.continue(); return; } first = false; try { const response = await route.fetch(); reached(); await held; await route.fulfill({ response }).catch(() => undefined); } finally { finished(); } });
    await panel.getByRole("button", { name: "تحديث نطاق المتابعات" }).click(); await ready;
    await page.getByRole("button", { name: "إغلاق نطاق المتابعات" }).click(); release(); await done;
    expect(await page.getByTestId("canonical-ortho-coverage").count()).toBe(0);
    await page.getByRole("button", { name: "عرض نطاق المتابعات المحفوظ" }).click(); await panel.getByTestId("ortho-coverage-saved").waitFor();
  } finally { release(); await context.close(); }
});
