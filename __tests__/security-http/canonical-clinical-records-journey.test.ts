/**
 * M2 slice 74 — canonical clinical record writes, built application, owned database and
 * server. Synthetic data only.
 *
 * - HTTP: vitals by request key (a repeat returns the same reading), outside the scope 404,
 *   a diagnosis without a clinician link 403, a grant without documentation 403.
 * - Browser: the doctor saves a new medical history version from the canonical patient
 *   file; one version, one audit row; no failed API call; no request runs DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-cr-owner", password: "Canon#CROwner1", role: "admin", display: "المالك التجريبي" },
  doctor: { username: "canon-cr-doc", password: "Canon#CRDoc1", role: "doctor", display: "د. توثيق تجريبي", doctor: true, patientScope: "own",
    grants: { "clinical.visits.document": true, "clinical.plans.view": true } },
  nurse: { username: "canon-cr-nurse", password: "Canon#CRNurse1", role: "assistant", display: "ممرضة تجريبية", patientScope: "all",
    grants: { "clinical.visits.document": true } },
  viewer: { username: "canon-cr-view", password: "Canon#CRView1", role: "reception", display: "مطّلع", patientScope: "all",
    grants: { "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { mine: 0, other: 0 };
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 124, secret: "canonical-clinical-records-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      ids.mine = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ('SYN-CRJ-1','مريض التوثيق التجريبي','0500000961',$1) RETURNING id", [parties.doctor!])).rows[0].id;
      ids.other = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES ('SYN-CRJ-2','مريض بعيد','0500000962') RETURNING id")).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: request key, scope, clinician link and the documentation grant", async () => {
  const doctor = await journey.login("doctor");
  const body = { requestKey: "journey-vitals-key-000001", bpSystolic: 118, bpDiastolic: 76, pulse: 72 };
  const first = await journey.api(`/api/patients/${ids.mine}/vitals`, doctor.cookie, post(body));
  expect(first.status).toBe(201);
  expect(first.headers.get("cache-control")).toContain("no-store");
  const reading = await first.json();
  expect(await (await journey.api(`/api/patients/${ids.mine}/vitals`, doctor.cookie, post(body))).json()).toMatchObject({ id: reading.id, replayed: true });
  expect((await journey.db.query("SELECT count(*)::int AS n FROM patient_vitals WHERE patient_id=$1", [ids.mine])).rows[0].n).toBe(1);
  const outside = await journey.api(`/api/patients/${ids.other}/vitals`, doctor.cookie, post({ ...body, requestKey: "journey-vitals-key-000002" }));
  expect(outside.status).toBe(404);
  const nurse = await journey.login("nurse");
  const diagnosis = await journey.api(`/api/patients/${ids.mine}/diagnoses`, nurse.cookie, post({ requestKey: "journey-diagnosis-key-0001", content: { crowding: "خفيف" } }));
  expect(diagnosis.status).toBe(403);
  expect((await diagnosis.json()).message).toMatch(ARABIC);
  const viewer = await journey.login("viewer");
  expect((await journey.api(`/api/patients/${ids.mine}/intake-history`, viewer.cookie, post({ requestKey: "journey-intake-key-000001", conditions: [] }))).status).toBe(403);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the doctor saves a medical history version from the canonical file", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  await journey.browserLogin(page, "doctor");
  const failures: string[] = [];
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await page.goto(`${journey.baseUrl}/patients/${ids.mine}`);
  const documentation = page.getByTestId("clinical-documentation");
  await documentation.getByRole("button", { name: /تعبئة الاستبيان الطبي|تحديث التاريخ الطبي/ }).click();
  const dialog = page.getByRole("dialog", { name: "الاستبيان الطبي" });
  await dialog.getByLabel("ملاحظات طبية").fill("لا شيء يُذكر — اصطناعي");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "حفظ نسخة جديدة" }).click();
  await expect.poll(async () => (await journey.db.query("SELECT count(*)::int AS n FROM patient_medical_history WHERE patient_id=$1", [ids.mine])).rows[0].n).toBe(1);
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='patient.medical_history' AND entity_id=$1::text", [String(ids.mine)])).rows).toEqual([{ actor: "canon-cr-doc" }]);
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});
