import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { seedCanonicalClinicalPlan } from "../fixtures/canonical-clinical-plans";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ACCOUNTS = {
  owner: { username: "canon-pc-owner", password: "Canon#PlanOwner1", role: "admin", display: "مالك تجريبي" },
  own: { username: "canon-pc-own", password: "Canon#PlanOwn1", role: "doctor", doctor: true, display: "طبيب خطط تجريبي", patientScope: "own", grants: { "clinical.plans.view": true } },
  all: { username: "canon-pc-all", password: "Canon#PlanAll1", role: "reception", display: "قارئ خطط تجريبي", patientScope: "all", grants: { "clinical.plans.view": true } },
  none: { username: "canon-pc-none", password: "Canon#PlanNone1", role: "doctor", doctor: true, display: "بلا نطاق مرضى", patientScope: "none", grants: { "clinical.plans.view": true } },
  adjacent: { username: "canon-pc-denied", password: "Canon#PlanDenied1", role: "admin", display: "مدير بلا خطط", patientScope: "all", grants: { "clinical.xrays.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { patient: 0, outside: 0, plan: 0, item: 0 };
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 50, secret: "canonical-plan-clinical-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed(q, _users, parties) {
    ids.patient = (await q.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-PC','SYN clinical plan patient',$1) RETURNING id", [parties.own])).rows[0].id;
    ids.outside = (await q.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-PC-OUT','SYN outside plan patient') RETURNING id")).rows[0].id;
    Object.assign(ids, await seedCanonicalClinicalPlan(q, ids.patient, parties.own));
    await seedCanonicalClinicalPlan(q, ids.outside);
  } });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: a scoped canonical clinical-plan reader can read the saved plan without a legacy session", async () => {
  const session = await journey.login("own");
  expect(session.status).toBe(200);
  const response = await journey.api(`/api/patients/${ids.patient}/plans`, session.cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ projection: "patient-plan-clinical", patientId: ids.patient, plans: [{ id: ids.plan, title: "SYN clinical treatment plan" }] });
  expect(await journey.ddlLog()).toEqual([]);
});

it("HTTP: independent permission, patient scope, exact projection and no query expansion", async () => {
  const path = `/api/patients/${ids.patient}/plans`;
  expect((await journey.api(path, "")).status).toBe(401);
  for (const key of ["none", "adjacent"] as const) expect((await journey.api(path, (await journey.login(key)).cookie)).status).toBe(403);
  for (const key of ["own", "all", "owner"] as const) {
    const session = await journey.login(key), response = await journey.api(path, session.cookie), body = await response.json();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(Object.keys(body).sort()).toEqual(["hasMore", "patientId", "plans", "projection"]);
    expect(Object.keys(body.plans[0].items[0]).sort()).toEqual(["caseSite", "category", "doctorName", "doneAt", "id", "note", "plannedVisitNumber", "quantity", "serviceName", "sessionCount", "sessionsCompleted", "status", "surfaces", "toothCode"]);
    expect(JSON.stringify(body)).not.toMatch(/9900123|Minor|price|currency|billing|installment|invoice|payment|patientName|patientPhone/i);
    for (const query of ["includeMoney=1", "scope=all", `patientId=${ids.outside}`]) expect((await journey.api(`${path}?${query}`, session.cookie)).status).toBe(400);
  }
  const own = await journey.login("own"), outside = await journey.api(`/api/patients/${ids.outside}/plans`, own.cookie), missing = await journey.api("/api/patients/2147483647/plans", own.cookie);
  expect(outside.status).toBe(404); expect(missing.status).toBe(404); expect(await outside.json()).toEqual(await missing.json());
});
it("HTTP: malformed historical references fail without private details or partial plans", async () => {
  const session = await journey.login("owner");
  await journey.db.query("UPDATE plan_items SET status='SYN-invalid' WHERE id=$1", [ids.item]);
  try {
    const response = await journey.api(`/api/patients/${ids.patient}/plans`, session.cookie); expect(response.status).toBe(409);
    const body = await response.json(); expect(body.code).toBe("plan_stored_data_invalid"); expect(JSON.stringify(body)).not.toMatch(/SELECT|SYN-invalid|SYN saved|9900123/);
  } finally { await journey.db.query("UPDATE plan_items SET status='planned' WHERE id=$1", [ids.item]); }
  expect(await journey.ddlLog()).toEqual([]);
});
async function openPlans(page: import("playwright").Page, key: Key = "own", signed = false) {
  if (!signed) await journey.browserLogin(page, key);
  await page.goto(`${journey.baseUrl}/patients/${ids.patient}`);
  await page.getByRole("button", { name: "عرض الخطط السريرية", exact: true }).click();
  const panel = page.getByTestId("canonical-clinical-plans");
  await panel.getByText("SYN recorded service", { exact: true }).waitFor();
  return panel;
}
it("browser: clinical facts at 390px, actual completed sessions, no financial numbers or writer", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try {
    const page = await context.newPage(), calls: string[] = [];
    await journey.browserLogin(page, "own"); page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) calls.push(`${request.method()} ${path}`); });
    const panel = await openPlans(page, "own", true);
    await panel.getByText("الجلسات المنجزة", { exact: true }).locator("..").getByText("1", { exact: true }).waitFor();
    await panel.getByText("الجلسات المطلوبة المسجلة", { exact: true }).locator("..").getByText("3", { exact: true }).waitFor();
    expect(await panel.textContent()).not.toMatch(/9900123|99|SYN outside/);
    expect(await panel.locator("input,textarea,select,canvas,img").count()).toBe(0);
    expect(calls.filter(call => call.endsWith(`/patients/${ids.patient}/plans`))).toEqual([`GET /api/patients/${ids.patient}/plans`]);
    expect(calls.some(call => /^(POST|PUT|PATCH|DELETE) /.test(call))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (process.env.HR_EVIDENCE_DIR) { mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "clinical-plans-390.png"), fullPage: true }); }
  } finally { await context.close(); }
});
it("browser: an adjacent imaging grant and admin role do not expose the plan entrance", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(); await journey.browserLogin(page, "adjacent"); await page.goto(`${journey.baseUrl}/patients/${ids.patient}`); await page.getByRole("button", { name: "عرض دراسات السيفالومتري" }).waitFor(); expect(await page.getByRole("button", { name: "عرض الخطط السريرية" }).count()).toBe(0); }
  finally { await context.close(); }
});
it("browser: failed refresh clears old clinical values without claiming an empty patient", async () => {
  const context = await journey.browser.newContext();
  try {
    const page = await context.newPage(), panel = await openPlans(page);
    await page.route(`**/api/patients/${ids.patient}/plans`, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "SYN temporarily unavailable" }) }));
    await panel.getByRole("button", { name: "تحديث الخطط السريرية" }).click(); await panel.getByRole("alert").waitFor();
    expect(await panel.getByTestId("canonical-clinical-plan").count()).toBe(0); expect(await panel.textContent()).not.toContain("لا توجد خطط مسجلة");
  } finally { await context.close(); }
});
it("browser and HTTP: revoked permission removes clinical values and denies a fresh login", async () => {
  const context = await journey.browser.newContext(), original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.all])).rows[0].permissions;
  try {
    const stale = await journey.login("all"), page = await context.newPage(), panel = await openPlans(page, "all");
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.plans.view}','false')::text WHERE id=$1", [journey.ids.all]);
    await panel.getByRole("button", { name: "تحديث الخطط السريرية" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("canonical-clinical-plan").count()).toBe(0);
    expect((await journey.api(`/api/patients/${ids.patient}/plans`, stale.cookie)).status).toBe(401);
    expect((await journey.api(`/api/patients/${ids.patient}/plans`, (await journey.login("all")).cookie)).status).toBe(403);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.all]); }
});
it("browser: a delayed response cannot restore the closed panel", async () => {
  const context = await journey.browser.newContext(); let release!: () => void, reached!: () => void, finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { reached = resolve; }), done = new Promise<void>(resolve => { finished = resolve; });
  try {
    const page = await context.newPage(), panel = await openPlans(page); let first = true;
    await page.route(`**/api/patients/${ids.patient}/plans`, async route => { if (!first) { await route.continue(); return; } first = false;
      try { const response = await route.fetch(); reached(); await held; await route.fulfill({ response }).catch(() => undefined); } finally { finished(); } });
    await panel.getByRole("button", { name: "تحديث الخطط السريرية" }).click(); await ready;
    await page.getByRole("button", { name: "إغلاق الخطط السريرية" }).click(); release(); await done;
    expect(await page.getByTestId("canonical-clinical-plans").count()).toBe(0);
    await page.getByRole("button", { name: "عرض الخطط السريرية", exact: true }).click(); await panel.getByText("SYN recorded service", { exact: true }).waitFor();
  } finally { release(); await context.close(); }
});
