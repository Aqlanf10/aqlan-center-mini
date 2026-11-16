import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { seedCanonicalPatientCases } from "../fixtures/canonical-patient-cases";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ACCOUNTS = {
  owner: { username: "canon-case-owner", password: "Canon#CaseOwner1", role: "admin", display: "مالك تجريبي" },
  own: { username: "canon-case-own", password: "Canon#CaseOwn1", role: "doctor", doctor: true, display: "طبيب حالات تجريبي", patientScope: "own", grants: { "clinical.plans.view": true, "clinical.plans.edit": true } },
  all: { username: "canon-case-all", password: "Canon#CaseAll1", role: "reception", display: "قارئ خطط تجريبي", patientScope: "all", grants: { "clinical.plans.view": true } },
  care: { username: "canon-case-care", password: "Canon#CaseCare1", role: "assistant", display: "قارئ حالات تجريبي", patientScope: "all", grants: { "clinical.visits.document": true } },
  none: { username: "canon-case-none", password: "Canon#CaseNone1", role: "doctor", doctor: true, display: "بلا نطاق مرضى", patientScope: "none", grants: { "clinical.plans.view": true } },
  adjacent: { username: "canon-case-denied", password: "Canon#CaseDenied1", role: "admin", display: "مدير بلا صلاحية سريرية", patientScope: "all", grants: { "appointments.create": true, "finance.patient-ledger.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { patient: 0, outside: 0, plan: 0, item: 0, caseId: 0, prerequisite: 0, problemId: 0, ortho: 0 };
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 55, secret: "canonical-patient-cases-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed(q, _users, parties) {
    ids.patient = Number((await q.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-CASE','SYN case patient',$1) RETURNING id", [parties.own])).rows[0].id);
    Object.assign(ids, await seedCanonicalPatientCases(q, ids.patient, parties.own));
    ids.outside = Number((await q.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-CASE-OUT','SYN private outside patient') RETURNING id")).rows[0].id);
    await seedCanonicalPatientCases(q, ids.outside);
    ids.ortho = Number((await q.query("INSERT INTO ortho_cases(patient_id,created_by,closed_note) VALUES($1,'SYN','SYN private ortho outcome') RETURNING id", [ids.patient])).rows[0].id);
  } });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
it("HTTP: an authorized canonical reader receives the patient's scoped cases and dependencies", async () => {
  const session = await journey.login("own"); expect(session.status).toBe(200);
  const response = await journey.api(`/api/patients/${ids.patient}/cases`, session.cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ projection: "patient-cases-clinical", clinicTimeZone: "Asia/Aden", patientId: ids.patient, cases: [{ id: ids.caseId, title: "SYN root case" }], items: expect.arrayContaining([expect.objectContaining({ id: ids.item })]) });
  expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: exact projection, scope, independent plan and ortho grants, and no query expansion", async () => {
  const path = `/api/patients/${ids.patient}/cases`;
  expect((await journey.api(path, "")).status).toBe(401);
  for (const key of ["none", "adjacent"] as const) expect((await journey.api(path, (await journey.login(key)).cookie)).status).toBe(403);
  for (const key of ["own", "all", "care", "owner"] as const) {
    const session = await journey.login(key), response = await journey.api(path, session.cookie), body = await response.json();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.clinicTimeZone).toBe("Asia/Aden"); expect(Object.keys(body).sort()).toEqual(["cases", "clinicTimeZone", "dependencies", "items", "orthoVisible", "patientId", "planVisible", "problems", "projection"]);
    expect(body.planVisible).toBe(key !== "care"); expect(body.items).toHaveLength(key === "care" ? 0 : 2);
    expect(body.cases).toHaveLength(key === "owner" ? 2 : 1); expect(body.orthoVisible).toBe(key === "owner");
    expect(JSON.stringify(body)).not.toMatch(/9900123|Minor|price|currency|billing|invoice|payment|patientName|patientPhone|financial|legacy/i);
    for (const query of ["includeMoney=1", "scope=all", `patientId=${ids.outside}`]) expect((await journey.api(`${path}?${query}`, session.cookie)).status).toBe(400);
  }
  const own = await journey.login("own"), outside = await journey.api(`/api/patients/${ids.outside}/cases`, own.cookie), missing = await journey.api("/api/patients/2147483647/cases", own.cookie);
  expect(outside.status).toBe(404); expect(missing.status).toBe(404); expect(await outside.json()).toEqual(await missing.json());
  for (const id of ["1e0", "-1", "0", "2147483648"]) expect((await journey.api(`/api/patients/${id}/cases`, own.cookie)).status).toBe(400);
});
// M2 slice 80 made the case POST canonical (clinical.plans.edit + clinician/owner, requestKey
// required). A canonical session never reaches the legacy writer: without a request key the
// canonical command refuses (400) and nothing is written.
it("HTTP: the legacy case writer is never reached by a canonical session; a keyless create writes nothing", async () => {
  const before = (await journey.db.query("SELECT (SELECT count(*) FROM clinical_cases)::int cases,(SELECT count(*) FROM audit_log)::int audit")).rows;
  const response = await journey.api(`/api/patients/${ids.patient}/cases`, (await journey.login("owner")).cookie, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ specialty: "general", title: "SYN must not write" }) });
  expect(response.status).toBe(400);
  expect((await response.json()).message).toMatch(/[؀-ۿ]/);
  // Login itself can audit; compare the domain state rather than login rows.
  expect((await journey.db.query("SELECT count(*)::int cases FROM clinical_cases")).rows[0].cases).toBe(before[0].cases);
  expect((await journey.db.query("SELECT count(*)::int n FROM audit_log WHERE action='case.create' AND summary LIKE '%SYN must not write%'")).rows[0].n).toBe(0);
});
it("HTTP: invalid historical references fail with a bounded code and no partial clinical text", async () => {
  const session = await journey.login("owner");
  await journey.db.query("UPDATE plan_items SET status='SYN-invalid' WHERE id=$1", [ids.item]);
  try { const response = await journey.api(`/api/patients/${ids.patient}/cases`, session.cookie); expect(response.status).toBe(409); const body = await response.json();
    expect(body.code).toBe("case_stored_data_invalid"); expect(JSON.stringify(body)).not.toMatch(/SELECT|SYN-invalid|SYN root|SYN recorded|9900123/);
  } finally { await journey.db.query("UPDATE plan_items SET status='planned' WHERE id=$1", [ids.item]); }
  expect(await journey.ddlLog()).toEqual([]);
});
async function openCases(page: import("playwright").Page, key: Key = "own", signed = false) {
  if (!signed) await journey.browserLogin(page, key);
  await page.goto(`${journey.baseUrl}/patients/${ids.patient}`);
  await page.getByRole("button", { name: "عرض الحالات وترتيب الخطة", exact: true }).click();
  const panel = page.getByTestId("canonical-patient-cases"); await panel.getByText("SYN root case", { exact: true }).first().waitFor(); return panel;
}
it("browser: readable case and dependency facts at 390px without financial data or legacy commands", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try { const page = await context.newPage(), calls: string[] = []; await journey.browserLogin(page, "own");
    page.on("request", req => { const path = new URL(req.url()).pathname; if (path.startsWith("/api/")) calls.push(`${req.method()} ${path}`); });
    const panel = await openCases(page, "own", true); await panel.getByText("SYN dependency note", { exact: true }).waitFor();
    expect(await panel.getByTestId("canonical-case-item").count()).toBe(2); expect(await panel.getByTestId("canonical-patient-case").count()).toBe(1);
    expect(await panel.textContent()).not.toMatch(/9900123|SYN private ortho|SYN private outside/);
    expect(await panel.locator("input,textarea,select,canvas,img").count()).toBe(0); expect(calls.some(c => /^(POST|PUT|PATCH|DELETE) /.test(c))).toBe(false);
    expect(calls.filter(c => c.endsWith(`/patients/${ids.patient}/cases`))).toEqual([`GET /api/patients/${ids.patient}/cases`]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (process.env.HR_EVIDENCE_DIR) { mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "patient-cases-390.png"), fullPage: true }); }
  } finally { await context.close(); }
});
it("browser: care without plans displays cases with an explicit plan permission boundary", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(), panel = await openCases(page, "care"); expect(await panel.getByTestId("canonical-case-item").count()).toBe(0);
    await panel.getByText("عرض بنود الخطط يحتاج صلاحية عرض الخطط المستقلة.", { exact: true }).waitFor(); expect(await panel.textContent()).not.toContain("SYN dependency note");
  } finally { await context.close(); }
});
it("browser: finance and appointment grants do not expose the clinical case entrance", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(); await journey.browserLogin(page, "adjacent"); await page.goto(`${journey.baseUrl}/patients/${ids.patient}`); await page.getByText("SYN case patient", { exact: true }).first().waitFor();
    expect(await page.getByRole("button", { name: "عرض الحالات وترتيب الخطة", exact: true }).count()).toBe(0);
  } finally { await context.close(); }
});
it("browser: failed refresh clears old cases, items and dependencies without inventing an empty record", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(), panel = await openCases(page);
    await page.route(`**/api/patients/${ids.patient}/cases`, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "SYN temporarily unavailable" }) }));
    await panel.getByRole("button", { name: "تحديث الحالات وترتيب الخطة" }).click(); await panel.getByRole("alert").waitFor();
    expect(await panel.getByTestId("canonical-patient-case").count()).toBe(0); expect(await panel.getByTestId("canonical-case-item").count()).toBe(0); expect(await panel.textContent()).not.toMatch(/SYN dependency|لا توجد حالات/);
  } finally { await context.close(); }
});
it("browser: a payload with an extra private field is rejected, not rendered", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(), panel = await openCases(page);
    await page.route(`**/api/patients/${ids.patient}/cases`, async route => { const response = await route.fetch(), body = await response.json(); body.items[0].invoiceId = 9900123; await route.fulfill({ response, json: body }); });
    await panel.getByRole("button", { name: "تحديث الحالات وترتيب الخطة" }).click(); await panel.getByRole("alert").waitFor();
    expect(await panel.getByTestId("canonical-case-item").count()).toBe(0); expect(await panel.textContent()).not.toMatch(/9900123|SYN recorded/);
  } finally { await context.close(); }
});
it("browser and HTTP: revocation invalidates the old session and clears all previously visible facts", async () => {
  const context = await journey.browser.newContext(), original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.all])).rows[0].permissions;
  try { const stale = await journey.login("all"), page = await context.newPage(), panel = await openCases(page, "all");
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.plans.view}','false')::text WHERE id=$1", [journey.ids.all]);
    await panel.getByRole("button", { name: "تحديث الحالات وترتيب الخطة" }).click(); await panel.getByRole("alert").waitFor();
    expect(await panel.getByTestId("canonical-patient-case").count()).toBe(0); expect(await panel.getByTestId("canonical-case-item").count()).toBe(0);
    expect((await journey.api(`/api/patients/${ids.patient}/cases`, stale.cookie)).status).toBe(401);
    expect((await journey.api(`/api/patients/${ids.patient}/cases`, (await journey.login("all")).cookie)).status).toBe(403);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.all]); }
});
it("browser: a delayed response cannot restore a closed case workspace", async () => {
  const context = await journey.browser.newContext(); let release!: () => void, reached!: () => void, finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { reached = resolve; }), done = new Promise<void>(resolve => { finished = resolve; });
  try { const page = await context.newPage(), panel = await openCases(page); let first = true;
    await page.route(`**/api/patients/${ids.patient}/cases`, async route => { if (!first) { await route.continue(); return; } first = false;
      try { const response = await route.fetch(); reached(); await held; await route.fulfill({ response }).catch(() => undefined); } finally { finished(); } });
    await panel.getByRole("button", { name: "تحديث الحالات وترتيب الخطة" }).click(); await ready; await page.getByRole("button", { name: "إغلاق الحالات وترتيب الخطة", exact: true }).click(); release(); await done;
    expect(await page.getByTestId("canonical-patient-cases").count()).toBe(0); await page.getByRole("button", { name: "عرض الحالات وترتيب الخطة", exact: true }).click(); await panel.getByText("SYN root case", { exact: true }).first().waitFor();
  } finally { release(); await context.close(); }
});

it("browser: stored clinical instants use the clinic day on an American device, including refresh", async () => {
  const instant = "2026-10-31T22:30:00.000Z", label = "الأحد 01/11/2026";
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "America/Los_Angeles" });
  const old = (await journey.db.query("SELECT status,completed_at FROM clinical_cases WHERE id=$1", [ids.caseId])).rows[0];
  const problem = (await journey.db.query("SELECT noted_at FROM patient_problems WHERE id=$1", [ids.problemId])).rows[0];
  try {
    await journey.db.query("UPDATE clinical_cases SET status='completed',completed_at=$1 WHERE id=$2", [instant, ids.caseId]);
    await journey.db.query("UPDATE patient_problems SET noted_at=$1 WHERE id=$2", [instant, ids.problemId]);
    const page = await context.newPage(), panel = await openCases(page); expect(await panel.getByText(label, { exact: true }).count()).toBe(2);
    await panel.getByRole("button", { name: "تحديث الحالات وترتيب الخطة", exact: true }).click(); await panel.getByText("SYN root case", { exact: true }).first().waitFor(); expect(await panel.getByText(label, { exact: true }).count()).toBe(2);
  } finally {
    await context.close(); await journey.db.query("UPDATE clinical_cases SET completed_at=$1,status=$2 WHERE id=$3", [old.completed_at, old.status, ids.caseId]);
    await journey.db.query("UPDATE patient_problems SET noted_at=$1 WHERE id=$2", [problem.noted_at, ids.problemId]);
  }
});
