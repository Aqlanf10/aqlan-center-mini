/** Stage compatibility: admitted reads remain scoped; neither numbering write is active.
 * This built-app fixture owns its database and uses only synthetic records.
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

it("keeps scoped reads, but rejects renumbering and floor changes for every authority", async () => {
  const clerk = await journey.login("clerk");
  const path = `/api/patients/${ids.mine}/number`;
  const read = await journey.api(path, clerk.cookie);
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toContain("no-store");
  const before = await read.json();
  expect(before).toMatchObject({ patientId: ids.mine, patientNumber: "P-91001" });

  const doctor = await journey.login("doctor");
  const editor = await journey.login("editor");
  const owner = await journey.login("owner");
  const forbidden = await journey.api(path, editor.cookie);
  expect(forbidden.status).toBe(403);
  expect((await forbidden.json()).message).toMatch(ARABIC);
  const outside = await journey.api(`/api/patients/${ids.other}/number`, doctor.cookie);
  expect(outside.status).toBe(404);

  for (const cookie of [clerk.cookie, editor.cookie, doctor.cookie, owner.cookie]) {
    for (const endpoint of [path, "/api/settings/patient-numbering"]) {
      const response = await journey.api(endpoint, cookie, { method: "PATCH",
        body: JSON.stringify({ patientNumber: "91011", expectedPatientNumber: "P-91001",
          minimumNext: "92000", expectedVersion: before.version, reason: "تعديل اصطناعي" }) });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
      expect((await response.json()).message).toMatch(ARABIC);
    }
  }
  expect((await (await journey.api(path, clerk.cookie)).json()).patientNumber).toBe("P-91001");
  expect((await journey.db.query("SELECT patient_number FROM patients WHERE id=$1", [ids.other])).rows[0].patient_number).toBe("P-91002");
  const unchanged = await journey.db.query(`SELECT
    (SELECT count(*)::int FROM retired_patient_numbers) AS retired,
    (SELECT count(*)::int FROM patient_numbering_policy) AS policy,
    (SELECT count(*)::int FROM audit_log WHERE action LIKE 'patient.number.%') AS audit`);
  expect(unchanged.rows).toEqual([{ retired: 0, policy: 0, audit: 0 }]);
  expect(await journey.ddlLog()).toEqual([]);
});

it("the mobile patient file shows the stored number but offers no number editor", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  try {
    for (const user of ["editor", "clerk", "owner"] as const) {
      const page = await context.newPage();
      await journey.browserLogin(page, user);
      const numberCalls: string[] = [];
      page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/number")) numberCalls.push(request.method()); });
      await page.goto(`${journey.baseUrl}/patients/${ids.mine}`);
      await page.getByRole("heading", { name: "البيانات الأساسية" }).waitFor();
      await page.getByText("P-91001", { exact: true }).first().waitFor();
      expect(await page.getByRole("button", { name: "تعديل رقم الملف" }).count()).toBe(0);
      expect(numberCalls).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.close();
    }
  } finally { await context.close(); }
  expect(await journey.ddlLog()).toEqual([]);
});
