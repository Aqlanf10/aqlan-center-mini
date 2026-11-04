/**
 * M2 slice 78 — the canonical patient file number, built application, owned database and
 * server. Synthetic data only.
 *
 * - HTTP: the number manager reads and changes the number (audit, old number retired);
 *   an editor without the grant is refused (403, Arabic); outside the scope answers like
 *   missing; a stale change is 409.
 * - Browser: the canonical patient file offers the dedicated number editor to the manager
 *   only, loads the number on demand, at 390px; no failed API call; no DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const MANAGE = { "patients.edit": true, "patients.number.manage": true } as const;
const ACCOUNTS = {
  owner: { username: "canon-num-owner", password: "Canon#NumOwner1", role: "admin", display: "المالك التجريبي" },
  clerk: { username: "canon-num-clerk", password: "Canon#NumClerk1", role: "reception", display: "مسؤول الترقيم", patientScope: "all", grants: { ...MANAGE } },
  doctor: { username: "canon-num-doc", password: "Canon#NumDoc1", role: "doctor", display: "د. ترقيم تجريبي", doctor: true, patientScope: "own", grants: { ...MANAGE } },
  editor: { username: "canon-num-edit", password: "Canon#NumEdit1", role: "reception", display: "محرر البيانات", patientScope: "all", grants: { "patients.edit": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { mine: 0, other: 0 };

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 132, secret: "canonical-patient-number-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      ids.mine = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ('P-91001','مريض الترقيم التجريبي','0500000961',$1) RETURNING id", [parties.doctor!])).rows[0].id;
      ids.other = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES ('P-91002','مريض بعيد','0500000962') RETURNING id")).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: the manager reads and changes; others are refused in Arabic; stale is 409", async () => {
  const clerk = await journey.login("clerk");
  const read = await journey.api(`/api/patients/${ids.mine}/number`, clerk.cookie);
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toContain("no-store");
  const before = await read.json();
  expect(before).toMatchObject({ patientId: ids.mine, patientNumber: "P-91001" });
  const changed = await journey.api(`/api/patients/${ids.mine}/number`, clerk.cookie, { method: "PATCH",
    body: JSON.stringify({ patientNumber: "91011", expectedPatientNumber: "P-91001", expectedVersion: before.version, reason: "تصحيح اصطناعي" }) });
  expect(changed.status).toBe(200);
  expect(await changed.json()).toMatchObject({ patientNumber: "P-91011" });
  const stale = await journey.api(`/api/patients/${ids.mine}/number`, clerk.cookie, { method: "PATCH",
    body: JSON.stringify({ patientNumber: "91012", expectedPatientNumber: "P-91001", expectedVersion: before.version, reason: "قديم" }) });
  expect(stale.status).toBe(409);
  expect((await stale.json()).message).toMatch(ARABIC);
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='patient.number.change' AND entity_id=$1::text", [ids.mine])).rows.map(row => row.actor)).toEqual(["canon-num-clerk"]);

  const editor = await journey.login("editor");
  const refused = await journey.api(`/api/patients/${ids.mine}/number`, editor.cookie);
  expect(refused.status).toBe(403);
  expect((await refused.json()).message).toMatch(ARABIC);

  const doctor = await journey.login("doctor");
  const outside = await journey.api(`/api/patients/${ids.other}/number`, doctor.cookie, { method: "PATCH",
    body: JSON.stringify({ patientNumber: "91021", expectedPatientNumber: "P-91002", expectedVersion: "1", reason: "خارج النطاق" }) });
  expect(outside.status).toBe(404);
  expect((await outside.json()).message).toMatch(ARABIC);
  expect((await journey.db.query("SELECT patient_number FROM patients WHERE id=$1", [ids.other])).rows[0].patient_number).toBe("P-91002");
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the editor is offered to the manager only and loads on demand at 390px", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  try {
    const editorPage = await context.newPage();
    await journey.browserLogin(editorPage, "editor");
    await editorPage.goto(`${journey.baseUrl}/patients/${ids.mine}`);
    await editorPage.getByRole("heading", { name: "البيانات الأساسية" }).waitFor();
    expect(await editorPage.getByTestId("canonical-patient-number").count()).toBe(0);
    await editorPage.close();
  } finally { await context.close(); }

  const managerContext = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await managerContext.newPage();
  await journey.browserLogin(page, "clerk");
  const failures: string[] = [];
  const numberCalls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.endsWith("/number")) numberCalls.push(`${request.method()} ${path}`); });
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await page.goto(`${journey.baseUrl}/patients/${ids.mine}`);
  const section = page.getByTestId("canonical-patient-number");
  await section.getByRole("button", { name: "تعديل رقم الملف" }).waitFor();
  expect(numberCalls).toEqual([]);
  await section.getByRole("button", { name: "تعديل رقم الملف" }).click();
  await section.getByText("P-91011").waitFor();
  expect(numberCalls).toEqual([`GET /api/patients/${ids.mine}/number`]);
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await managerContext.close();
  expect(await journey.ddlLog()).toEqual([]);
});
