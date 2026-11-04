/**
 * M2 slice 76 — the canonical dental chart, built application, owned database and
 * server. Synthetic data only.
 *
 * - HTTP: the clinician records a tooth event (201, the chart.record audit row), a
 *   documenting account without the clinician link is refused (403, Arabic), outside the
 *   scope answers like missing, a visit of another patient 409; reads by a clinical grant,
 *   none without one.
 * - Browser: the canonical patient file reads nothing until the chart section is opened,
 *   then shows the chart read-only for a viewer at 390px; no failed API call; no DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-chart-owner", password: "Canon#ChartOwner1", role: "admin", display: "المالك التجريبي" },
  doctor: { username: "canon-chart-doc", password: "Canon#ChartDoc1", role: "doctor", display: "د. مخطط تجريبي", doctor: true, patientScope: "own",
    grants: { "clinical.visits.document": true } },
  nurse: { username: "canon-chart-nurse", password: "Canon#ChartNurse1", role: "assistant", display: "مساعدة تجريبية", patientScope: "all",
    grants: { "clinical.visits.document": true } },
  viewer: { username: "canon-chart-view", password: "Canon#ChartView1", role: "reception", display: "مطّلع", patientScope: "all",
    grants: { "clinical.plans.view": true } },
  front: { username: "canon-chart-front", password: "Canon#ChartFront1", role: "reception", display: "استقبال", patientScope: "all",
    grants: { "appointments.create": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { mine: 0, other: 0, otherVisit: 0 };
const post = (patientId: number, cookie: string, body: Record<string, unknown>) =>
  journey.api(`/api/patients/${patientId}/chart`, cookie, { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 140, secret: "canonical-chart-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      ids.mine = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ('SYN-CJ-1','مريض المخطط التجريبي','0500000971',$1) RETURNING id", [parties.doctor!])).rows[0].id;
      ids.other = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES ('SYN-CJ-2','مريض بعيد','0500000972') RETURNING id")).rows[0].id;
      ids.otherVisit = (await db.query<{ id: number }>("INSERT INTO visits (patient_name, patient_id) VALUES ('SYN CJ visit', $1) RETURNING id", [ids.other])).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: the clinician records, others are refused in Arabic, reads follow the clinical grant", async () => {
  const doctor = await journey.login("doctor");
  const created = await post(ids.mine, doctor.cookie, { toothCode: 36, condition: "rct", stage: "existing", surfaces: "O" });
  expect(created.status).toBe(201);
  expect(created.headers.get("cache-control")).toContain("no-store");
  expect(await created.json()).toMatchObject({ toothCode: 36, condition: "rct", recordedBy: "canon-chart-doc", replayed: false });
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='chart.record' AND entity_id=$1::text", [ids.mine])).rows.map(row => row.actor)).toEqual(["canon-chart-doc"]);

  const outside = await post(ids.other, doctor.cookie, { toothCode: 36, condition: "rct" });
  expect(outside.status).toBe(404);
  expect((await outside.json()).message).toMatch(ARABIC);

  const owner = await journey.login("owner");
  const wrongVisit = await post(ids.mine, owner.cookie, { toothCode: 36, condition: "rct", visitId: ids.otherVisit });
  expect(wrongVisit.status).toBe(409);
  expect((await wrongVisit.json()).message).toMatch(ARABIC);

  const nurse = await journey.login("nurse");
  const refused = await post(ids.mine, nurse.cookie, { toothCode: 36, condition: "rct" });
  expect(refused.status).toBe(403);
  expect((await refused.json()).message).toMatch(ARABIC);

  const viewer = await journey.login("viewer");
  const read = await journey.api(`/api/patients/${ids.mine}/chart`, viewer.cookie);
  expect(read.status).toBe(200);
  expect((await read.json()).records.map((row: { toothCode: number }) => row.toothCode)).toEqual([36]);
  const viewerWrite = await post(ids.mine, viewer.cookie, { toothCode: 36, condition: "rct" });
  expect(viewerWrite.status).toBe(403);
  expect((await viewerWrite.json()).message).toMatch(ARABIC);

  const front = await journey.login("front");
  const frontRead = await journey.api(`/api/patients/${ids.mine}/chart`, front.cookie);
  expect(frontRead.status).toBeGreaterThanOrEqual(403);
  expect((await frontRead.json()).message).toMatch(ARABIC);

  expect((await journey.db.query("SELECT count(*)::int AS n FROM tooth_conditions WHERE patient_id=$1", [ids.mine])).rows[0].n).toBe(1);
  expect((await journey.db.query("SELECT count(*)::int AS n FROM tooth_conditions WHERE patient_id=$1", [ids.other])).rows[0].n).toBe(0);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the canonical patient file shows the chart read-only for a viewer at 390px", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  await journey.browserLogin(page, "viewer");
  const failures: string[] = [];
  const writes: string[] = [];
  page.on("request", request => { if (request.method() !== "GET" && new URL(request.url()).pathname.includes("/chart")) writes.push(request.url()); });
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await page.goto(`${journey.baseUrl}/patients/${ids.mine}`);
  const chart = page.getByTestId("canonical-dental-chart");
  const chartReads: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/chart")) chartReads.push(request.method()); });
  await chart.waitFor();
  // Nothing is read until the section is opened.
  expect(chartReads).toEqual([]);
  await chart.locator("summary").click();
  await chart.locator('[data-testid="dental-chart-workspace"][data-read-state="ready"]').waitFor();
  expect(chartReads).toEqual(["GET"]);
  expect(failures).toEqual([]);
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});
