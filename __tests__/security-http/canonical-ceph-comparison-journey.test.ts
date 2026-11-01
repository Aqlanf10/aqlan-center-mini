import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { seedCanonicalCephComparison } from "../fixtures/canonical-ceph-comparison";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ACCOUNTS = {
  owner: { username: "canon-cc-owner", password: "Canon#CephPairOwner1", role: "admin", display: "مالك تجريبي" },
  own: { username: "canon-cc-own", password: "Canon#CephPairOwn1", role: "doctor", doctor: true, display: "طبيب مقارنة تجريبي", patientScope: "own", grants: { "clinical.xrays.view": true } },
  all: { username: "canon-cc-all", password: "Canon#CephPairAll1", role: "reception", display: "قارئ مقارنة تجريبي", patientScope: "all", grants: { "clinical.xrays.view": true } },
  none: { username: "canon-cc-none", password: "Canon#CephPairNone1", role: "doctor", doctor: true, display: "بلا نطاق", patientScope: "none", grants: { "clinical.xrays.view": true } },
  unlinked: { username: "canon-cc-unlinked", password: "Canon#CephPairUnlinked1", role: "doctor", display: "بلا ارتباط", patientScope: "own", grants: { "clinical.xrays.view": true } },
  adjacent: { username: "canon-cc-adjacent", password: "Canon#CephPairAdjacent1", role: "admin", display: "مدير بلا أشعة", patientScope: "all", grants: { "clinical.ortho.view": true } },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
let ids: Awaited<ReturnType<typeof seedCanonicalCephComparison>>;
let outside: Awaited<ReturnType<typeof seedCanonicalCephComparison>>, discarded = 0;
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 55, secret: "canonical-ceph-pair-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed(q, _users, parties) {
    const patient = (await q.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-CC-PATIENT','SYN ceph pair patient',$1) RETURNING id", [parties.own])).rows[0].id;
    ids = await seedCanonicalCephComparison(q, patient);
    const other = (await q.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-CC-OUTSIDE','SYN private outside pair') RETURNING id")).rows[0].id;
    outside = await seedCanonicalCephComparison(q, other);
    discarded = (await seedCanonicalCeph(q, { patientId: patient, status: "discarded" })).id;
  } });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
it.each(["compare", "superimpose"])("HTTP: a scoped canonical imaging reader can read the saved-study %s contract", async endpoint => {
  const session = await journey.login("own"); expect(session.status).toBe(200);
  const response = await journey.api(`/api/ceph/${endpoint}?first=${ids.before}&second=${ids.after}`, session.cookie);
  expect(response.status).toBe(200);
});
const pairUrl = (mode: string, first = ids.before, second = ids.after) => `/api/ceph/${mode}?first=${first}&second=${second}`;
it("HTTP: anonymous, none, unlinked and adjacent grants cannot use either contract", async () => {
  for (const mode of ["compare", "superimpose"]) {
    expect((await journey.api(pairUrl(mode), "")).status).toBe(401);
    for (const key of ["none", "unlinked", "adjacent"] as const) {
      const response = await journey.api(pairUrl(mode), (await journey.login(key)).cookie);
      expect(response.status).toBe(403); expect(await response.text()).not.toMatch(/SYN private|SYN_OLD|xrayDate|cranialBase/);
    }
  }
});
it("HTTP: own/all/owner receive explicit minimal projections with correct saved date order", async () => {
  for (const key of ["own", "all", "owner"] as const) for (const mode of ["compare", "superimpose"]) {
    const response = await journey.api(pairUrl(mode, ids.after, ids.before), (await journey.login(key)).cookie), body = await response.json();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.before.id).toBe(ids.before); expect(body.after.id).toBe(ids.after);
    expect(body.before.xrayDate).toBe("2024-01-15"); expect(body.after.xrayDate).toBe("2025-01-15");
    expect(Object.keys(body).sort()).toEqual(mode === "compare" ? ["after", "before", "normSource", "onlyAfter", "onlyBefore", "patientId", "projection", "rows"] : ["after", "before", "cranialBaseAfter", "cranialBaseBefore", "geometrySource", "patientId", "projection", "rotationDegrees", "viewBox"]);
    if (mode === "compare") expect(body.rows).toContainEqual({ code: "SYN_OLD_MEASURE", before: 10.125, after: 12.125, delta: 2 });
    else expect(body).toMatchObject({ cranialBaseBefore: 10, cranialBaseAfter: 20, rotationDegrees: 0 });
    expect(JSON.stringify(body)).not.toMatch(/SYN saved clinical note|SYN machine|SYN recorder|private.png|documentId|storage_key|diagnosis|phone|invoice|price|improved|worsened/);
  }
  expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: each side is scoped; hidden/missing/discarded results match and mixed admitted patients refuse", async () => {
  const own = await journey.login("own"), all = await journey.login("all");
  for (const mode of ["compare", "superimpose"]) {
    const bodies = [];
    for (const hidden of [outside.before, discarded, 2147483647]) for (const [first, second] of [[ids.before, hidden], [hidden, ids.after]]) {
      const response = await journey.api(pairUrl(mode, first, second), own.cookie); expect(response.status).toBe(404); bodies.push(await response.json());
    }
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect((await journey.api(pairUrl(mode, ids.before, outside.after), all.cookie)).status).toBe(400);
  }
});
it("HTTP: duplicate, unsafe or expanding URL parameters never select images, notes or another scope", async () => {
  const session = await journey.login("own");
  for (const mode of ["compare", "superimpose"]) for (const query of [`first=${ids.before}&second=${ids.before}`, `first=01&second=${ids.after}`, `first=9007199254740992&second=${ids.after}`, `first=${ids.before}&second=${ids.after}&first=${outside.before}`, `first=${ids.before}&second=${ids.after}&scope=all`, `first=${ids.before}&second=${ids.after}&image=true`, `first=${ids.before}&second=${ids.after}&patient=${outside.patientId}`]) {
    expect((await journey.api(`/api/ceph/${mode}?${query}`, session.cookie)).status).toBe(400);
  }
});
async function openPair(page: Page) {
  await journey.browserLogin(page, "own"); await page.goto(`${journey.baseUrl}/patients/${ids.patientId}`);
  await page.getByRole("button", { name: "عرض دراسات السيفالومتري", exact: true }).click();
  await page.getByRole("button", { name: "مقارنة دراستين محفوظتين", exact: true }).click();
  const panel = page.getByTestId("canonical-ceph-comparison");
  await panel.getByLabel("الدراسة الأولى", { exact: true }).selectOption(String(ids.after));
  await panel.getByLabel("الدراسة الثانية", { exact: true }).selectOption(String(ids.before));
  await panel.getByRole("button", { name: "مقارنة القيم المحفوظة", exact: true }).click(); await panel.getByTestId("canonical-ceph-pair-result").waitFor(); return panel;
}
it("browser: 390px saved comparison and derived geometry show no hidden data or image/writer requests", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try {
    const page = await context.newPage(), calls: string[] = [];
    page.on("request", request => { const p = new URL(request.url()).pathname; if (p.startsWith("/api/ceph/") || /\/api\/(media|documents)/.test(p)) calls.push(`${request.method()} ${p}`); });
    const panel = await openPair(page); expect(await panel.textContent()).toContain("SYN_OLD_MEASURE"); expect(await panel.textContent()).toContain("-1.875");
    expect(await panel.getByTestId("canonical-ceph-pair-result").textContent()).not.toMatch(/SYN saved clinical note|SYN machine|SYN recorder|private.png/);
    expect(await panel.locator("img,canvas,textarea,input[type=file],a").count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (process.env.HR_EVIDENCE_DIR) { mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "ceph-saved-comparison-390.png"), fullPage: true }); }
    await panel.getByRole("button", { name: "تراكب المعالم المحفوظة", exact: true }).click(); await panel.getByRole("img", { name: "تراكب الخطوط المرجعية المحفوظة دون صورة الأشعة" }).waitFor();
    expect(await panel.locator("img,canvas,image").count()).toBe(0); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(calls).toEqual(["GET /api/ceph/compare", "GET /api/ceph/superimpose"]);
    if (process.env.HR_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "ceph-saved-superimposition-390.png"), fullPage: true });
  } finally { await context.close(); }
});
it("browser: a missing geometric anchor fails without restoring an old or legacy image view", async () => {
  const context = await journey.browser.newContext();
  try {
    const page = await context.newPage(), panel = await openPair(page); await journey.db.query("UPDATE ceph_landmarks SET code='SYN_RETIRED_S' WHERE analysis_id=$1 AND code='S'", [ids.after]);
    await panel.getByRole("button", { name: "تراكب المعالم المحفوظة", exact: true }).click(); await panel.getByRole("alert").waitFor();
    expect(await panel.getByTestId("canonical-ceph-pair-result").count()).toBe(0); expect(await panel.locator("img,svg,image").count()).toBe(0);
  } finally { await journey.db.query("UPDATE ceph_landmarks SET code='S' WHERE analysis_id=$1 AND code='SYN_RETIRED_S'", [ids.after]); await context.close(); }
});
it("browser and HTTP: permission withdrawal clears previous results and prevents fallback", async () => {
  const context = await journey.browser.newContext(), original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.own])).rows[0].permissions;
  try {
    const page = await context.newPage(), panel = await openPair(page), old = await journey.login("own");
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.xrays.view}','false')::text WHERE id=$1", [journey.ids.own]);
    await panel.getByRole("button", { name: "مقارنة القيم المحفوظة", exact: true }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("canonical-ceph-pair-result").count()).toBe(0);
    for (const mode of ["compare", "superimpose"]) expect([401, 403]).toContain((await journey.api(pairUrl(mode), old.cookie)).status);
    const fresh = await journey.login("own"); for (const mode of ["compare", "superimpose"]) expect((await journey.api(pairUrl(mode), fresh.cookie)).status).toBe(403);
  } finally { await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.own]); await context.close(); }
});
it("browser: a late response cannot restore an earlier selection after a newer read fails", async () => {
  const context = await journey.browser.newContext(); let release: (() => void) | undefined;
  try {
    const page = await context.newPage(), panel = await openPair(page), payload = await (await journey.api(pairUrl("compare"), (await journey.login("own")).cookie)).json();
    let mark: (() => void) | undefined, first = true; const entered = new Promise<void>(resolve => { mark = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/ceph/compare?*", async route => { if (first) { first = false; mark!(); await held; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) }).catch(() => undefined); } else await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "فشل التحديث التجريبي" }) }); });
    await panel.getByRole("button", { name: "مقارنة القيم المحفوظة", exact: true }).click(); await entered;
    await panel.getByLabel("الدراسة الأولى", { exact: true }).selectOption(String(ids.before)); await panel.getByLabel("الدراسة الثانية", { exact: true }).selectOption(String(ids.after));
    await panel.getByRole("button", { name: "مقارنة القيم المحفوظة", exact: true }).click(); await panel.getByRole("alert").waitFor(); release!(); await page.waitForTimeout(200);
    expect(await panel.getByTestId("canonical-ceph-pair-result").count()).toBe(0);
  } finally { release?.(); await context.close(); }
});
