/**
 * M2 slice 8 — canonical patient edit and contact consent, built application, owned
 * database and server.
 *
 * UI → HTTP → DB with password logins: `patients.edit` admits, field groups follow the
 * read projection (reception never writes clinical text), a patient outside the scope
 * answers exactly like a missing one, refusals carry an Arabic `message`, the audit row
 * names the canonical actor, and no request runs DDL. Synthetic data only.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const EDIT = { "patients.edit": true } as const;
const ACCOUNTS = {
  owner: { username: "canon-w-owner", password: "Canon#WOwner1", role: "admin", display: "المالك التجريبي" },
  reception: { username: "canon-w-reception", password: "Canon#WReception1", role: "reception", display: "استقبال يعدّل الملفات", patientScope: "all", grants: EDIT },
  viewer: { username: "canon-w-viewer", password: "Canon#WViewer1", role: "reception", display: "استقبال للاطلاع فقط", patientScope: "all" },
  doctor: { username: "canon-w-doctor", password: "Canon#WDoctor1", role: "doctor", display: "طبيب تجريبي", doctor: true, patientScope: "own", grants: { ...EDIT, "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
let mine = 0, other = 0;

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 11, secret: "canonical-patient-writes-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      const insert = async (number: string, name: string, doctor: number | null) =>
        (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id,medical_alert) VALUES($1,$2,'0500000000',$3,'حساسية تجريبية') RETURNING id", [number, name, doctor])).rows[0].id;
      mine = await insert("SYN-WJ-1", "مريض الطبيب التجريبي", parties.doctor!);
      other = await insert("SYN-WJ-2", "مريض الاستقبال التجريبي", null);
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

const patch = (cookie: string, id: number, body: unknown) => journey.api(`/api/patients/${id}`, cookie, { method: "PATCH", body: JSON.stringify(body) });
const consent = (cookie: string, id: number, body: unknown) => journey.api(`/api/patients/${id}/contact`, cookie, { method: "POST", body: JSON.stringify(body) });

it("HTTP: patients.edit admits; clinical fields refuse for reception; outside the scope equals missing", async () => {
  const viewer = await journey.login("viewer");
  const denied = await patch(viewer.cookie, other, { phone: "0511111111" });
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);

  const reception = await journey.login("reception");
  const clinical = await patch(reception.cookie, other, { medicalAlert: "" });
  expect(clinical.status).toBe(403);
  const clinicalBody = await clinical.json();
  expect(clinicalBody).toMatchObject({ code: "patient_field_not_granted", field: "medicalAlert" });
  expect(clinicalBody.message).toMatch(ARABIC);

  const saved = await patch(reception.cookie, other, { phone: "0511111111" });
  expect(saved.status).toBe(200);
  const savedBody = await saved.json();
  expect(savedBody).toMatchObject({ id: other, phone: "0511111111" });
  expect(savedBody).not.toHaveProperty("medicalAlert");

  const doctor = await journey.login("doctor");
  const outside = await patch(doctor.cookie, other, { address: "x" });
  const missing = await patch(doctor.cookie, 999_999, { address: "x" });
  expect([outside.status, missing.status]).toEqual([404, 404]);
  expect(await outside.json()).toEqual(await missing.json());
  const own = await patch(doctor.cookie, mine, { medicalAlert: "حساسية لاتكس تجريبية" });
  expect(own.status).toBe(200);
  expect(await own.json()).toMatchObject({ medicalAlert: "حساسية لاتكس تجريبية" });

  const unknown = await patch(reception.cookie, other, { isOwner: true });
  expect(unknown.status).toBe(400);
  expect((await unknown.json()).message).toMatch(ARABIC);
  expect(await journey.ddlLog()).toEqual([]);
});

it("HTTP: consent records with the canonical actor; scope and capability enforced", async () => {
  const viewer = await journey.login("viewer");
  const denied = await consent(viewer.cookie, other, { channel: "sms", granted: true, source: "in_person" });
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);

  const doctor = await journey.login("doctor");
  expect((await consent(doctor.cookie, other, { channel: "sms", granted: true, source: "in_person" })).status).toBe(404);

  const reception = await journey.login("reception");
  const invalid = await consent(reception.cookie, other, { channel: "fax", granted: true, source: "in_person" });
  expect(invalid.status).toBe(400);
  expect((await invalid.json()).message).toMatch(ARABIC);
  const recorded = await consent(reception.cookie, other, { channel: "sms", granted: true, source: "in_person" });
  expect(recorded.status).toBe(201);
  expect(await recorded.json()).toMatchObject({ channel: "sms", granted: true, recordedBy: "canon-w-reception" });
  const { rows } = await journey.db.query("SELECT actor FROM audit_log WHERE entity='patient' AND entity_id=$1::text AND action='patient.contact_consent'", [other]);
  expect(rows.map(row => row.actor)).toEqual(["canon-w-reception"]);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: reception edits the phone and records a consent from the canonical profile, never seeing clinical fields", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  const page = await context.newPage();
  const failures: string[] = [];
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`);
  });
  await journey.browserLogin(page, "reception");
  failures.length = 0;
  await page.goto(`${journey.baseUrl}/patients/${other}`);
  await page.getByText("مريض الاستقبال التجريبي").first().waitFor();
  await page.getByRole("button", { name: "تعديل البيانات" }).click();
  const form = page.getByTestId("patient-edit-form");
  await form.waitFor();
  expect(await form.getByLabel("التنبيه الطبي").count()).toBe(0);
  await form.getByLabel("الجوال", { exact: true }).fill("0522222222");
  const saved = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/patients/${other}`);
  await form.getByRole("button", { name: "حفظ التعديل" }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  expect(Object.keys(JSON.parse(response.request().postData() ?? "{}"))).toEqual(["phone"]);
  await page.getByTestId("patient-edit-form").waitFor({ state: "detached" });

  const consentForm = page.getByTestId("consent-record-form");
  await consentForm.waitFor();
  await consentForm.getByRole("button", { name: "تسجيل الموافقة" }).click();
  await consentForm.getByRole("status").filter({ hasText: "سُجّلت الموافقة." }).waitFor();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(failures).toEqual([]);
  await context.close();

  const { rows: [row] } = await journey.db.query("SELECT phone, medical_alert FROM patients WHERE id=$1", [other]);
  expect(row).toEqual({ phone: "0522222222", medical_alert: "حساسية تجريبية" });
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: an account without patients.edit sees no edit or consent controls", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  const page = await context.newPage();
  await journey.browserLogin(page, "viewer");
  await page.goto(`${journey.baseUrl}/patients/${other}`);
  await page.getByText("مريض الاستقبال التجريبي").first().waitFor();
  expect(await page.getByRole("button", { name: "تعديل البيانات" }).count()).toBe(0);
  expect(await page.getByTestId("consent-record-form").count()).toBe(0);
  await context.close();
});
