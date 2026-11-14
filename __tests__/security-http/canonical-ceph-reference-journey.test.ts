import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { seedCanonicalCephReferences } from "../fixtures/canonical-ceph-reference";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const VIEW = { "clinical.xrays.view": true };
const ACCOUNTS = {
  owner: { username: "canon-cr-owner", password: "Canon#ReferenceOwner1", role: "admin", display: "مالك تجريبي" },
  own: { username: "canon-cr-own", password: "Canon#ReferenceOwn1", role: "doctor", doctor: true, display: "قارئ صور تجريبي", patientScope: "own", grants: VIEW },
  none: { username: "canon-cr-none", password: "Canon#ReferenceNone1", role: "reception", display: "قارئ مراجع بلا مرضى", patientScope: "none", grants: VIEW },
  all: { username: "canon-cr-all", password: "Canon#ReferenceAll1", role: "reception", display: "قارئ صور عام", patientScope: "all", grants: VIEW },
  denied: { username: "canon-cr-denied", password: "Canon#ReferenceDenied1", role: "admin", display: "مدير بلا صور", patientScope: "all", grants: { "clinical.ortho.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { patient: 0 };
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 48, secret: "canonical-ceph-reference-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed(q, _users, parties) {
    await seedCanonicalCephReferences(q);
    ids.patient = (await q.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-CR','SYN private reference patient',$1) RETURNING id", [parties.own!])).rows[0].id;
  } });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: imaging grant reads the reference catalogue without a legacy session or patient scope", async () => {
  const session = await journey.login("none");
  expect(session.status).toBe(200);
  const response = await journey.api("/api/ceph-reference-sets", session.cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ projection: "ceph-reference-catalog", sets: [{ key: "SYN-reference", values: { ANB: { mean: 2.125, sd: 1.75 } } }] });
  expect((await journey.api(`/api/patients/${ids.patient}/ceph`, session.cookie)).status).toBe(403);
  expect(await journey.ddlLog()).toEqual([]);
});

it("HTTP: exact independent permission and public-query rejection with a minimal reference projection", async () => {
  expect((await journey.api("/api/ceph-reference-sets", "")).status).toBe(401);
  const denied = await journey.login("denied"); expect((await journey.api("/api/ceph-reference-sets", denied.cookie)).status).toBe(403);
  for (const key of ["owner", "own", "all", "none"] as const) {
    const session = await journey.login(key), response = await journey.api("/api/ceph-reference-sets", session.cookie);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json(); expect(Object.keys(body).sort()).toEqual(["projection", "sets"]);
    expect(Object.keys(body.sets[0]).sort()).toEqual(["ageMax", "ageMin", "key", "name", "population", "sex", "values", "version"]);
    expect(Object.keys(body.sets[0].values.ANB).sort()).toEqual(["mean", "sd"]);
    expect(JSON.stringify(body)).not.toMatch(/patient|invoice|document|storage|private author|inactive/);
    for (const query of ["patientId=1", "active=false", "includePatients=1", "key=SYN-inactive"]) {
      expect((await journey.api(`/api/ceph-reference-sets?${query}`, session.cookie)).status).toBe(400);
    }
  }
});
it("HTTP: catalogue reads are immutable and corrupt active values fail without private error details", async () => {
  const session = await journey.login("owner"), sql = "SELECT (SELECT count(*) FROM audit_log)::int audits,(SELECT count(*) FROM invoices)::int invoices,(SELECT count(*) FROM ceph_reference_sets)::int refs";
  const before = (await journey.db.query(sql)).rows;
  expect((await journey.api("/api/ceph-reference-sets", session.cookie)).status).toBe(200);
  expect((await journey.db.query(sql)).rows).toEqual(before);
  await journey.db.query("UPDATE ceph_reference_values SET mean='NaN' WHERE code='ANB' AND set_id=(SELECT id FROM ceph_reference_sets WHERE key='SYN-reference')");
  try {
    const response = await journey.api("/api/ceph-reference-sets", session.cookie); expect(response.status).toBe(409);
    const body = await response.json(); expect(body.code).toBe("ceph_reference_invalid");
    expect(JSON.stringify(body)).not.toMatch(/SELECT|patient|private author|SYN-reference|NaN/);
  } finally { await journey.db.query("UPDATE ceph_reference_values SET mean=2.125 WHERE code='ANB' AND set_id=(SELECT id FROM ceph_reference_sets WHERE key='SYN-reference')"); }
  expect(await journey.ddlLog()).toEqual([]);
});
async function openReferences(page: import("playwright").Page, key: Key = "own", signed = false) {
  if (!signed) await journey.browserLogin(page, key);
  await page.goto(`${journey.baseUrl}/patients/${ids.patient}`);
  await page.getByRole("button", { name: "عرض دراسات السيفالومتري" }).click();
  await page.getByRole("button", { name: "عرض المراجع الحالية" }).click();
  const panel = page.getByTestId("canonical-ceph-references");
  await panel.getByText("123.123456", { exact: true }).waitFor();
  return panel;
}
it("browser: current reference facts preserve precision and do not apply defaults or call clinical writers", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try {
    const page = await context.newPage(), calls: string[] = [];
    await journey.browserLogin(page, "own"); page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) calls.push(`${request.method()} ${path}`); });
    const panel = await openReferences(page, "own", true);
    expect(await panel.getByTestId("canonical-ceph-reference-set").count()).toBe(1);
    await panel.getByText("SYN_OLD_CODE", { exact: true }).waitFor();
    await panel.getByText("العمر الأدنى", { exact: true }).locator("..").getByText("10", { exact: true }).waitFor();
    await panel.getByText("العمر الأعلى", { exact: true }).locator("..").getByText("18", { exact: true }).waitFor();
    expect(await panel.textContent()).toContain("لا يغيّر القياسات أو التشخيص المحفوظ");
    expect(await panel.locator("input,select,textarea,img,canvas").count()).toBe(0);
    expect(calls.filter(call => call.includes("/ceph-reference-sets"))).toEqual(["GET /api/ceph-reference-sets"]);
    expect(calls.some(call => /^(POST|PUT|PATCH|DELETE) /.test(call) || /\/api\/(documents|plans|invoices|ceph)\//.test(call))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (process.env.HR_EVIDENCE_DIR) { mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "ceph-references-390.png"), fullPage: true }); }
  } finally { await context.close(); }
});
it("browser: admin label without imaging grant has no reference entrance", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(); await journey.browserLogin(page, "denied"); await page.goto(`${journey.baseUrl}/patients/${ids.patient}`); await page.getByRole("button", { name: "عرض حالات التقويم" }).waitFor(); expect(await page.getByRole("button", { name: "عرض المراجع الحالية" }).count()).toBe(0); }
  finally { await context.close(); }
});
it("browser: corrupt payload and failed refresh clear prior values without claiming an empty catalogue", async () => {
  const context = await journey.browser.newContext();
  try {
    const page = await context.newPage(), panel = await openReferences(page);
    await page.route("**/api/ceph-reference-sets", async route => { const response = await route.fetch(), body = await response.json(); body.sets[0].values.ANB.sd = 0; await route.fulfill({ response, json: body }); });
    await panel.getByRole("button", { name: "تحديث المراجع" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("canonical-ceph-reference-set").count()).toBe(0);
    await page.unroute("**/api/ceph-reference-sets"); await page.route("**/api/ceph-reference-sets", route => route.abort());
    await panel.getByRole("button", { name: "تحديث المراجع" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.textContent()).not.toContain("لا توجد مجموعات مرجعية مفعلة");
  } finally { await context.close(); }
});
it("browser and HTTP: revoked imaging permission clears catalogue values and rejects fresh logins too", async () => {
  const context = await journey.browser.newContext(), original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.all])).rows[0].permissions;
  try {
    const stale = await journey.login("all"), page = await context.newPage(), panel = await openReferences(page, "all");
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.xrays.view}','false')::text WHERE id=$1", [journey.ids.all]);
    await panel.getByRole("button", { name: "تحديث المراجع" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("canonical-ceph-reference-set").count()).toBe(0);
    expect((await journey.api("/api/ceph-reference-sets", stale.cookie)).status).toBe(401);
    const fresh = await journey.login("all"); expect((await journey.api("/api/ceph-reference-sets", fresh.cookie)).status).toBe(403);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.all]); }
});
it("browser: delayed catalogue replies cannot restore a closed panel", async () => {
  const context = await journey.browser.newContext(); let release!: () => void, reached!: () => void, finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { reached = resolve; }), done = new Promise<void>(resolve => { finished = resolve; });
  try {
    const page = await context.newPage(), panel = await openReferences(page); let first = true;
    await page.route("**/api/ceph-reference-sets", async route => { if (!first) { await route.continue(); return; } first = false; try { const response = await route.fetch(); reached(); await held; await route.fulfill({ response }).catch(() => undefined); } finally { finished(); } });
    await panel.getByRole("button", { name: "تحديث المراجع" }).click(); await ready;
    await page.getByRole("button", { name: "إغلاق المراجع الحالية" }).click(); release(); await done;
    expect(await page.getByTestId("canonical-ceph-references").count()).toBe(0);
    await page.getByRole("button", { name: "عرض المراجع الحالية" }).click(); await panel.getByText("123.123456", { exact: true }).waitFor();
  } finally { release(); await context.close(); }
});
