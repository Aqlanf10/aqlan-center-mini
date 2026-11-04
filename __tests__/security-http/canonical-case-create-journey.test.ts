/**
 * M2 slice 80 — canonical case opening, built application, owned database and server.
 * Synthetic data only.
 *
 * - HTTP: the clinician opens a case (201, audit); the same request key replays (200, one
 *   case); a planner without the clinician link is refused (403, Arabic); outside the
 *   scope reads as missing.
 * - Browser: the clinician opens a case from the canonical patient file at 390px; the case
 *   appears in the list; no failed API call; no DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const EDIT = { "clinical.plans.view": true, "clinical.plans.edit": true } as const;
const ACCOUNTS = {
  owner: { username: "canon-case-owner", password: "Canon#CaseOwner1", role: "admin", display: "المالك التجريبي" },
  doctor: { username: "canon-case-doc", password: "Canon#CaseDoc1", role: "doctor", display: "د. حالات تجريبي", doctor: true, patientScope: "own", grants: { ...EDIT } },
  planner: { username: "canon-case-plan", password: "Canon#CasePlan1", role: "reception", display: "منسق الخطط", patientScope: "all", grants: { ...EDIT } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { mine: 0, other: 0 };
const create = (patientId: number, cookie: string, body: Record<string, unknown>) =>
  journey.api(`/api/patients/${patientId}/cases`, cookie, { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 136, secret: "canonical-case-create-journey-secret-0123456789ab", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      ids.mine = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ('SYN-CJ-1','مريض الحالات التجريبي','0500000981',$1) RETURNING id", [parties.doctor!])).rows[0].id;
      ids.other = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES ('SYN-CJ-2','مريض بعيد','0500000982') RETURNING id")).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: open with audit, replay by key, clinician link and scope", async () => {
  const doctor = await journey.login("doctor");
  const body = { requestKey: "journey-case-create-key-0001", specialty: "endodontics", title: "علاج عصب اصطناعي", site: "36" };
  const first = await create(ids.mine, doctor.cookie, body);
  expect(first.status).toBe(201);
  expect(first.headers.get("cache-control")).toContain("no-store");
  const created = await first.json();
  const again = await create(ids.mine, doctor.cookie, body);
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ caseId: created.caseId, replayed: true });
  expect((await journey.db.query("SELECT count(*)::int AS n FROM clinical_cases WHERE patient_id=$1", [ids.mine])).rows[0].n).toBe(1);
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='case.create' AND entity_id=$1::text", [ids.mine])).rows.map(row => row.actor)).toEqual(["canon-case-doc"]);

  const outside = await create(ids.other, doctor.cookie, { ...body, requestKey: "journey-case-create-key-0002" });
  expect(outside.status).toBe(404);
  expect((await outside.json()).message).toMatch(ARABIC);

  const planner = await journey.login("planner");
  const refused = await create(ids.mine, planner.cookie, { ...body, requestKey: "journey-case-create-key-0003" });
  expect(refused.status).toBe(403);
  expect((await refused.json()).message).toMatch(ARABIC);
  expect((await journey.db.query("SELECT count(*)::int AS n FROM clinical_cases WHERE patient_id = ANY($1::int[])", [[ids.mine, ids.other]])).rows[0].n).toBe(1);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the clinician opens a case from the canonical file at 390px", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  await journey.browserLogin(page, "doctor");
  const failures: string[] = [];
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await page.goto(`${journey.baseUrl}/patients/${ids.mine}`);
  await page.getByRole("button", { name: "عرض الحالات وترتيب الخطة" }).click();
  const editor = page.getByTestId("canonical-case-create-editor");
  await editor.getByRole("button", { name: "فتح حالة تخصصية" }).click();
  await editor.getByLabel("تخصص الحالة").selectOption("periodontics");
  await editor.getByLabel("عنوان الحالة").fill("علاج لثة اصطناعي من المتصفح");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await editor.getByRole("button", { name: "حفظ الحالة" }).click();
  await editor.getByText("فُتحت الحالة وسُجّل الأثر.").waitFor();
  await page.getByTestId("canonical-patient-cases").getByText("علاج لثة اصطناعي من المتصفح").first().waitFor();
  expect(failures).toEqual([]);
  expect((await journey.db.query("SELECT count(*)::int AS n FROM clinical_cases WHERE patient_id=$1", [ids.mine])).rows[0].n).toBe(2);
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});
