/**
 * M2 slices 1 and 1b — canonical patient list and creation, built application, owned
 * database and server.
 *
 * UI → HTTP → DB with password logins: the patient scope filters rows, current grants
 * decide the projected column groups, refusals carry an Arabic `message`, the screen
 * shows only what the server projected, and no request runs DDL. Synthetic data only.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-p-owner", password: "Canon#POwner1", role: "admin", display: "المالك التجريبي" },
  doctor: { username: "canon-p-doctor", password: "Canon#PDoctor1", role: "doctor", display: "طبيب تقويم تجريبي", doctor: true, patientScope: "own", grants: { "clinical.plans.view": true } },
  other: { username: "canon-p-other", password: "Canon#POther1", role: "doctor", display: "طبيب آخر تجريبي", doctor: true, patientScope: "own", grants: { "clinical.plans.view": true } },
  reception: { username: "canon-p-reception", password: "Canon#PReception1", role: "reception", display: "استقبال تجريبي", patientScope: "all" },
  noScope: { username: "canon-p-noscope", password: "Canon#PNoScope1", role: "admin", display: "حساب بلا نطاق", grants: { "clinical.plans.view": true, "finance.patient-ledger.view": true } },
  creator: { username: "canon-p-creator", password: "Canon#PCreator1", role: "reception", display: "استقبال ينشئ الملفات", patientScope: "all", grants: { "patients.create": true } },
  creatorOwn: { username: "canon-p-creator-own", password: "Canon#PCreatorOwn1", role: "doctor", display: "طبيب ينشئ الملفات", doctor: true, patientScope: "own", grants: { "patients.create": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 5, secret: "canonical-patients-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      const insert = (number: string, name: string, doctor: number | null, alert: string | null) =>
        db.query("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id,medical_alert) VALUES($1,$2,'0500000000',$3,$4) RETURNING id", [number, name, doctor, alert]);
      await insert("SYN-J-1", "مريض تجريبي أول", parties.doctor!, "حساسية بنسلين تجريبية");
      await insert("SYN-J-2", "مريض تجريبي ثانٍ", parties.other!, null);
      const { rows: [third] } = await insert("SYN-J-3", "مريض تجريبي ثالث", null, null);
      await db.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by) VALUES('SYN-J-INV',$1,5000,0,'YER','open','synthetic')", [third.id]);
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: own scope sees only the linked clinician's patients; all scope sees every patient, identity only", async () => {
  const doctor = await journey.login("doctor");
  expect(doctor.status).toBe(200);
  const search = await journey.api(`/api/patients?q=${encodeURIComponent("مريض تجريبي")}`, doctor.cookie);
  expect(search.status).toBe(200);
  expect(search.headers.get("cache-control")).toMatch(/no-store/);
  const found = await search.json() as { fullName: string; medicalAlert?: string }[];
  expect(found.map(row => row.fullName)).toEqual(["مريض تجريبي أول"]);
  expect(found[0].medicalAlert).toContain("حساسية");
  const page = await (await journey.api("/api/patients?page=0&filter=all&sort=name", doctor.cookie)).json();
  expect(page).toMatchObject({ total: 1, projection: { care: true, schedule: false, balances: false } });
  expect(page.rows[0]).not.toHaveProperty("balances");

  const reception = await journey.login("reception");
  const all = await (await journey.api("/api/patients?page=0&filter=all&sort=name", reception.cookie)).json();
  expect(all).toMatchObject({ total: 3, projection: { care: false, schedule: false, balances: false } });
  for (const row of all.rows) expect(Object.keys(row).sort()).toEqual(["age", "fullName", "gender", "id", "patientNumber", "phone"]);
  expect(await journey.ddlLog()).toEqual([]);
});

it("HTTP: refusals are bounded, Arabic and never fall back to the legacy session", async () => {
  const noScope = await journey.login("noScope");
  const refused = await journey.api("/api/patients?q=SYN", noScope.cookie);
  expect(refused.status).toBe(403);
  const body = await refused.json();
  expect(body).toMatchObject({ code: "STAFF_OPERATION_RECORD_SCOPE_DENIED" });
  expect(body.message).toMatch(ARABIC);

  const reception = await journey.login("reception");
  const debt = await journey.api("/api/patients?page=0&filter=debt", reception.cookie);
  expect(debt.status).toBe(403);
  const debtBody = await debt.json();
  expect(debtBody.code).toBe("patient_filter_not_granted");
  expect(debtBody.message).toMatch(ARABIC);

  const forged = await journey.api("/api/patients?q=SYN", `${reception.cookie.slice(0, -2)}xx`);
  expect(forged.status).toBe(401);
  expect((await forged.json()).message).toMatch(ARABIC);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the doctor opens the patient list from the shell and sees exactly the projected rows", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) apiCalls.push(path);
  });
  const failures: string[] = [];
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`);
  });
  await journey.browserLogin(page, "doctor");
  // The login page's anonymous auth/me probe is not part of the journey.
  apiCalls.length = 0; failures.length = 0;
  await page.getByRole("link", { name: "المرضى" }).first().click();
  await page.waitForURL(/\/patients$/);
  await page.getByText("مريض تجريبي أول").waitFor();
  await page.getByText("⚠ حساسية بنسلين تجريبية").waitFor();
  expect(await page.getByText("مريض تجريبي ثانٍ").count()).toBe(0);
  // Only the filters inside the projection; no create form or profile link yet.
  expect(await page.getByRole("button", { name: "تنبيه طبي" }).count()).toBe(1);
  expect(await page.getByRole("button", { name: "عليهم مبالغ" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "+ مريض جديد" }).count()).toBe(0);
  expect(await page.locator('a[href^="/patients/"]').count()).toBe(1);
  // Searching narrows within the same scope.
  await page.getByLabel("بحث عن مريض").fill("SYN-J-2");
  await page.getByText("لا توجد نتائج مطابقة لخيارات البحث أو الفلتر.").waitFor();
  expect(new Set(apiCalls.filter(path => !/^\/api\/auth\/(login|me)$/.test(path)))).toEqual(new Set(["/api/patients"]));
  expect(failures).toEqual([]);
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: an account without patient scope never sees the list entry and gets the workspace notice", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  const page = await context.newPage();
  await journey.browserLogin(page, "noScope");
  expect(await page.getByRole("link", { name: "المرضى" }).count()).toBe(0);
  await page.goto(`${journey.baseUrl}/patients`);
  await page.getByTestId("canonical-workspace").waitFor();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await context.close();
});

it("HTTP: creation needs patients.create, refuses the not-yet-canonical previous balance, and discloses duplicates by scope", async () => {
  const reception = await journey.login("reception");
  const denied = await journey.api("/api/patients", reception.cookie, { method: "POST", body: JSON.stringify({ fullName: "مريض مرفوض تجريبي" }) });
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);

  const creator = await journey.login("creator");
  const opening = await journey.api("/api/patients", creator.cookie, { method: "POST", body: JSON.stringify({ fullName: "مريض برصيد تجريبي", openingBalance: { amount: "1000", currency: "YER", asOfDate: "2026-10-01" } }) });
  expect(opening.status).toBe(409);
  const openingBody = await opening.json();
  expect(openingBody.code).toBe("opening_balance_not_canonical");
  expect(openingBody.message).toMatch(ARABIC);

  const invalid = await journey.api("/api/patients", creator.cookie, { method: "POST", body: JSON.stringify({ fullName: "" }) });
  expect(invalid.status).toBe(400);
  expect((await invalid.json()).message).toMatch(ARABIC);

  const duplicateAll = await journey.api("/api/patients", creator.cookie, { method: "POST", body: JSON.stringify({ fullName: "شخص آخر تجريبي", phone: "0500000000" }) });
  expect(duplicateAll.status).toBe(409);
  const allBody = await duplicateAll.json();
  expect(allBody.disclosed).toBe(true);
  expect(allBody.duplicates.length).toBeGreaterThan(0);

  const creatorOwn = await journey.login("creatorOwn");
  const duplicateOwn = await journey.api("/api/patients", creatorOwn.cookie, { method: "POST", body: JSON.stringify({ fullName: "شخص آخر تجريبي", phone: "0500000000" }) });
  expect(duplicateOwn.status).toBe(409);
  const ownBody = await duplicateOwn.json();
  expect(ownBody).toMatchObject({ disclosed: false, duplicates: [] });
  expect(ownBody.message).toMatch(ARABIC);
  const { rows } = await journey.db.query("SELECT count(*)::int AS n FROM patients WHERE full_name='شخص آخر تجريبي'");
  expect(rows[0].n).toBe(0);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: a reception account creates a patient, confirms a duplicate warning, and sees both in the list", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  const page = await context.newPage();
  const failures: string[] = [];
  await journey.browserLogin(page, "creator");
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/api/") && response.status() >= 400 && !(path === "/api/patients" && response.status() === 409)) failures.push(`${response.status()} ${path}`);
  });
  await page.getByRole("link", { name: "المرضى" }).first().click();
  await page.waitForURL(/\/patients$/);
  await page.getByRole("button", { name: "+ مريض جديد" }).click();
  // The previous-balance and family-link steps are not canonical yet and are not offered.
  expect(await page.getByText("مريض سابق: لديه مبلغ متبقٍ").count()).toBe(0);
  await page.getByLabel("الاسم الكامل").fill("مريضة جديدة تجريبية");
  await page.getByLabel("رقم الجوال").fill("0577777777");
  await page.getByRole("button", { name: "احفظ الملف" }).click();
  await expect.poll(() => page.getByRole("status").first().textContent()).toMatch(/أُنشئ ملف مريضة جديدة تجريبية/);
  await page.getByText("مريضة جديدة تجريبية").first().waitFor();
  // Same phone again: the warning names the existing file (all-patient scope); confirm creates.
  await page.getByRole("button", { name: "+ مريض جديد" }).click();
  await page.getByLabel("الاسم الكامل").fill("مريضة ثانية تجريبية");
  await page.getByLabel("رقم الجوال").fill("0577777777");
  await page.getByRole("button", { name: "احفظ الملف" }).click();
  const warning = page.getByTestId("duplicate-warning");
  await warning.getByText("مريضة جديدة تجريبية").waitFor();
  expect(await warning.locator("a").count()).toBe(0);
  await warning.getByRole("button", { name: "ليس أحدهم — أضف مريضًا جديدًا" }).click();
  await expect.poll(() => page.getByRole("status").first().textContent()).toMatch(/أُنشئ ملف مريضة ثانية تجريبية/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(failures).toEqual([]);
  await context.close();
  const { rows } = await journey.db.query("SELECT actor, details->>'تأكيد_رغم_التكرار' AS confirmed FROM audit_log WHERE action='patient.create' ORDER BY id");
  expect(rows).toEqual([{ actor: ACCOUNTS.creator.username, confirmed: "false" }, { actor: ACCOUNTS.creator.username, confirmed: "true" }]);
  expect(await journey.ddlLog()).toEqual([]);
});

it("HTTP: one patient's file is admitted by scope; outside and missing read the same", async () => {
  const { rows } = await journey.db.query<{ id: number; patient_number: string }>("SELECT id, patient_number FROM patients WHERE patient_number IN ('SYN-J-1','SYN-J-2') ORDER BY patient_number");
  const [own, other] = rows;
  const doctor = await journey.login("doctor");
  const file = await journey.api(`/api/patients/${own.id}`, doctor.cookie);
  expect(file.status).toBe(200);
  expect(file.headers.get("cache-control")).toMatch(/no-store/);
  const body = await file.json();
  expect(body.patient).toMatchObject({ fullName: "مريض تجريبي أول", medicalAlert: "حساسية بنسلين تجريبية" });
  expect(body.projection).toMatchObject({ care: true, appointments: "none" });
  expect(body).not.toHaveProperty("appointments");
  const outside = await journey.api(`/api/patients/${other.id}`, doctor.cookie);
  const missing = await journey.api("/api/patients/987654", doctor.cookie);
  expect([outside.status, missing.status]).toEqual([404, 404]);
  const [outsideBody, missingBody] = [await outside.json(), await missing.json()];
  expect(outsideBody).toEqual(missingBody);
  expect(outsideBody.message).toMatch(ARABIC);
  const reception = await journey.login("reception");
  const identityOnly = await (await journey.api(`/api/patients/${own.id}`, reception.cookie)).json();
  expect(identityOnly.patient).not.toHaveProperty("medicalAlert");
  expect(identityOnly).not.toHaveProperty("visits");
  const projection = await journey.api(`/api/patients/${own.id}?projection=appointments`, doctor.cookie);
  expect(projection.status).toBe(409);
  expect((await projection.json()).message).toMatch(ARABIC);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the doctor opens a patient's file from the list; only the canonical file read is called", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  const page = await context.newPage();
  await journey.browserLogin(page, "doctor");
  const apiCalls: string[] = [];
  const failures: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(path); });
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await page.getByRole("link", { name: "المرضى" }).first().click();
  await page.getByText("مريض تجريبي أول").first().click();
  await page.waitForURL(/\/patients\/\d+$/);
  const profile = page.getByTestId("canonical-patient-profile");
  await profile.getByRole("heading", { name: "مريض تجريبي أول" }).waitFor();
  await profile.getByText("⚠ حساسية بنسلين تجريبية").waitFor();
  await profile.getByRole("heading", { name: "الزيارات الأخيرة" }).waitFor();
  expect(await profile.getByRole("heading", { name: /المواعيد/ }).count()).toBe(0);
  await profile.getByRole("heading", { name: "التاريخ الطبي والعلامات الحيوية" }).waitFor();
  await profile.getByRole("heading", { name: "قائمة المشاكل" }).waitFor();
  await profile.getByRole("heading", { name: "الإحالات" }).waitFor();
  await profile.getByRole("heading", { name: "موافقات التواصل" }).waitFor();
  await profile.getByText("لا أحداث ضمن ما تملك عرضه.").or(profile.locator("ol li").first()).waitFor();
  expect(new Set(apiCalls.filter(path => !/^\/api\/auth\/me$/.test(path)).map(path => path.replace(/\/\d+(\/|$)/, "/:id$1"))))
    .toEqual(new Set(["/api/patients", "/api/patients/:id", "/api/patients/:id/medical-history", "/api/patients/:id/problems",
      "/api/patients/:id/referrals", "/api/patients/:id/contact", "/api/patients/:id/timeline"]));
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  // A file outside the scope shows the bounded Arabic refusal, not the legacy file.
  const { rows: [other] } = await journey.db.query<{ id: number }>("SELECT id FROM patients WHERE patient_number='SYN-J-2'");
  await page.goto(`${journey.baseUrl}/patients/${other.id}`);
  await page.getByRole("alert").filter({ hasText: "لا يوجد مريض بهذا الرقم ضمن مرضاك" }).waitFor();
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: without a clinical grant the file never calls clinical reads; the timeline shows only allowed groups", async () => {
  const { rows: [own] } = await journey.db.query<{ id: number }>("SELECT id FROM patients WHERE patient_number='SYN-J-1'");
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  const page = await context.newPage();
  await journey.browserLogin(page, "reception");
  const apiCalls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(path); });
  await page.goto(`${journey.baseUrl}/patients/${own.id}`);
  const profile = page.getByTestId("canonical-patient-profile");
  await profile.getByRole("heading", { name: "الخط الزمني" }).waitFor();
  await profile.getByText("لا أحداث ضمن ما تملك عرضه.").waitFor();
  expect(await profile.getByRole("heading", { name: "التاريخ الطبي والعلامات الحيوية" }).count()).toBe(0);
  await profile.getByRole("heading", { name: "موافقات التواصل" }).waitFor();
  expect(apiCalls.some(path => /medical-history|problems|vitals|referrals|diagnoses|intake-history/.test(path))).toBe(false);
  // Direct calls are refused server-side, whatever the screen shows.
  const reception = await journey.login("reception");
  for (const section of ["medical-history", "vitals", "problems", "referrals", "diagnoses", "intake-history"]) {
    const response = await journey.api(`/api/patients/${own.id}/${section}`, reception.cookie);
    expect(response.status).toBe(403);
    expect((await response.json()).message).toMatch(ARABIC);
  }
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});


it("HTTP: the arrival panel follows grants and scope, never the role label", async () => {
  const { rows: [own] } = await journey.db.query<{ id: number }>("SELECT id FROM patients WHERE patient_number='SYN-J-3'");
  const reception = await journey.login("reception"); // patient scope all, no grants
  const panel = await journey.api(`/api/patients/${own.id}/arrival-panel`, reception.cookie);
  expect(panel.status).toBe(200);
  expect(panel.headers.get("cache-control")).toMatch(/no-store/);
  const body = await panel.json();
  for (const key of ["money", "cases", "ortho", "appointments"]) expect(body).not.toHaveProperty(key);
  expect(body.canCollect).toBe(false);
  const noScope = await journey.login("noScope");
  const refused = await journey.api(`/api/patients/${own.id}/arrival-panel`, noScope.cookie);
  expect(refused.status).toBe(403);
  expect((await refused.json()).message).toMatch(ARABIC);
  expect(await journey.ddlLog()).toEqual([]);
});

it("HTTP: the workflow summary projects by grant; identity-only gets no clinical, schedule or money keys", async () => {
  const { rows: [own] } = await journey.db.query<{ id: number }>("SELECT id FROM patients WHERE patient_number='SYN-J-1'");
  const doctor = await journey.login("doctor");
  const clinical = await (await journey.api(`/api/patients/${own.id}/workflow`, doctor.cookie)).json();
  expect(clinical.patient.medicalAlert).toBe("حساسية بنسلين تجريبية");
  expect(clinical).toHaveProperty("lastVisit");
  expect(clinical).not.toHaveProperty("financial");
  const reception = await journey.login("reception");
  const identity = await journey.api(`/api/patients/${own.id}/workflow`, reception.cookie);
  expect(identity.status).toBe(200);
  const body = await identity.json();
  for (const key of ["lastVisit", "activePlans", "financial", "nextAppointment", "alerts"]) expect(body).not.toHaveProperty(key);
  expect(body.patient).not.toHaveProperty("medicalAlert");
  expect(await journey.ddlLog()).toEqual([]);
});
