/**
 * M2 slice 77 — canonical endodontics, built application, owned database and server.
 * Synthetic data only.
 *
 * - HTTP: the clinician opens an episode (201, audit) and records a visit; a documenting
 *   account without the clinician link is refused (403, Arabic); outside the scope answers
 *   like missing; the reader with a clinical grant reads, without plan items.
 * - Browser: the canonical patient file reads nothing until the endodontics section is
 *   opened, then shows the episode at 390px; no failed API call; no DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-endo-owner", password: "Canon#EndoOwner1", role: "admin", display: "المالك التجريبي" },
  doctor: { username: "canon-endo-doc", password: "Canon#EndoDoc1", role: "doctor", display: "د. جذور تجريبي", doctor: true, patientScope: "own",
    grants: { "clinical.visits.document": true } },
  nurse: { username: "canon-endo-nurse", password: "Canon#EndoNurse1", role: "assistant", display: "مساعدة تجريبية", patientScope: "all",
    grants: { "clinical.visits.document": true } },
  viewer: { username: "canon-endo-view", password: "Canon#EndoView1", role: "reception", display: "مطّلع", patientScope: "all",
    grants: { "clinical.xrays.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { mine: 0, other: 0, caseMine: 0, caseOther: 0, visit: 0, treatment: 0 };

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 130, secret: "canonical-endo-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      ids.mine = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ('SYN-EJ-1','مريض الجذور التجريبي','0500000991',$1) RETURNING id", [parties.doctor!])).rows[0].id;
      ids.other = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES ('SYN-EJ-2','مريض بعيد','0500000992') RETURNING id")).rows[0].id;
      const endoCase = async (patientId: number) => (await db.query<{ id: number }>(
        "INSERT INTO clinical_cases (patient_id, specialty, title, status, created_by) VALUES ($1,'endodontics','حالة جذور اصطناعية','active','SYN') RETURNING id", [patientId])).rows[0].id;
      ids.caseMine = await endoCase(ids.mine);
      ids.caseOther = await endoCase(ids.other);
      ids.visit = (await db.query<{ id: number }>("INSERT INTO visits (patient_name, patient_id, doctor_id) VALUES ('SYN EJ visit', $1, $2) RETURNING id", [ids.mine, parties.doctor!])).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: the clinician opens and records; others are refused in Arabic; the reader reads", async () => {
  const doctor = await journey.login("doctor");
  const opened = await journey.api(`/api/patients/${ids.mine}/endo`, doctor.cookie, { method: "POST", body: JSON.stringify({ caseId: ids.caseMine, toothCode: 36, kind: "initial" }) });
  expect(opened.status).toBe(201);
  expect(opened.headers.get("cache-control")).toContain("no-store");
  ids.treatment = (await opened.json()).id;
  const saved = await journey.api(`/api/patients/${ids.mine}/endo/${ids.treatment}/visits`, doctor.cookie, { method: "PUT",
    body: JSON.stringify({ visitId: ids.visit, stage: "assessment", canalsFound: 3, canals: [{ label: "MB" }, { label: "ML" }, { label: "D" }] }) });
  expect(saved.status).toBe(201);
  expect((await journey.db.query("SELECT action, actor FROM audit_log WHERE action LIKE 'endo.%' AND entity_id=$1::text ORDER BY id", [ids.mine])).rows)
    .toEqual([{ action: "endo.open", actor: "canon-endo-doc" }, { action: "endo.visit_save", actor: "canon-endo-doc" }]);

  const outside = await journey.api(`/api/patients/${ids.other}/endo`, doctor.cookie, { method: "POST", body: JSON.stringify({ caseId: ids.caseOther, toothCode: 36 }) });
  expect(outside.status).toBe(404);
  expect((await outside.json()).message).toMatch(ARABIC);

  const nurse = await journey.login("nurse");
  const refused = await journey.api(`/api/patients/${ids.mine}/endo/${ids.treatment}`, nurse.cookie, { method: "PATCH", body: JSON.stringify({ status: "abandoned" }) });
  expect(refused.status).toBe(403);
  expect((await refused.json()).message).toMatch(ARABIC);

  const viewer = await journey.login("viewer");
  const read = await journey.api(`/api/patients/${ids.mine}/endo`, viewer.cookie);
  expect(read.status).toBe(200);
  const treatments = (await read.json()).treatments;
  expect(treatments.map((row: { id: number }) => row.id)).toEqual([ids.treatment]);
  expect(treatments[0].crownPlanItem).toBeNull();
  const viewerWrite = await journey.api(`/api/patients/${ids.mine}/endo`, viewer.cookie, { method: "POST", body: JSON.stringify({ caseId: ids.caseMine, toothCode: 46 }) });
  expect(viewerWrite.status).toBe(403);
  expect((await viewerWrite.json()).message).toMatch(ARABIC);

  expect((await journey.db.query("SELECT status FROM endo_treatments WHERE id=$1", [ids.treatment])).rows[0].status).toBe("in_progress");
  expect((await journey.db.query("SELECT count(*)::int AS n FROM endo_treatments WHERE patient_id=$1", [ids.other])).rows[0].n).toBe(0);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: nothing is read until the section opens, then the episode shows at 390px", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  await journey.browserLogin(page, "viewer");
  const failures: string[] = [];
  const endoCalls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.includes("/endo")) endoCalls.push(`${request.method()} ${path}`); });
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await page.goto(`${journey.baseUrl}/patients/${ids.mine}`);
  const section = page.getByTestId("canonical-endo");
  await section.waitFor();
  expect(endoCalls).toEqual([]);
  await section.locator("summary").click();
  await section.getByText(/سنّ 36/).first().waitFor();
  expect(endoCalls).toEqual([`GET /api/patients/${ids.mine}/endo`]);
  expect(await section.getByTestId("endo-new").count()).toBe(0);
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});
