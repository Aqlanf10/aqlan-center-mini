/**
 * Owner decisions on initial grants and revocation (Dot 6494187100 items 2–3), built
 * application, owned database and server. Synthetic data only.
 *
 * - A pending account (imported or prepared, not confirmed by the owner) holds nothing,
 *   on the server, the API and the screen. A delegated manager can neither edit nor
 *   confirm it. The owner reviews an atomic change preview; that save is the confirmation.
 * - Hiding a module of a restricted doctor through the preview revokes it on the server:
 *   the live session falls, a fresh one is refused the module's API and keeps its scopes.
 * - A doctor-manager maintains only within its own authority; revoking its staff module
 *   ends its live session and the direct page and API refuse it.
 * - Titles (doctor, admin) never grant anything.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-c-owner", password: "Canon#COwner1", role: "admin", display: "المالك التجريبي" },
  manager: { username: "canon-c-manager", password: "Canon#CManager1", role: "reception", display: "مدير صلاحيات تجريبي", patientScope: "all", appointmentScope: "all",
    grants: { "staff.view": true, "staff.permissions.edit": true, "appointments.create": true } },
  pending: { username: "canon-c-pending", password: "Canon#CPending1", role: "reception", display: "موظف بانتظار التأكيد", confirmation: "pending", patientScope: "all",
    grants: { "staff.view": true } },
  doctor: { username: "canon-c-doctor", password: "Canon#CDoctor1", role: "doctor", display: "طبيب مقيّد تجريبي", doctor: true, patientScope: "own", appointmentScope: "own",
    grants: { "clinical.plans.view": true, "clinical.visits.document": true } },
  docManager: { username: "canon-c-docmanager", password: "Canon#CDocManager1", role: "doctor", display: "طبيب مدير تجريبي", doctor: true, patientScope: "own", appointmentScope: "own",
    grants: { "staff.view": true, "staff.permissions.edit": true, "clinical.plans.view": true } },
  titled: { username: "canon-c-titled", password: "Canon#CTitled1", role: "admin", display: "لقب مدير فقط" },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
let patientId = 0;

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 9, secret: "canonical-confirmation-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      const { rows: [row] } = await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-C-1','مريض تجريبي للطبيب','0500000000',$1) RETURNING id", [parties.doctor!]);
      patientId = row.id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

const capabilitiesOf = async (cookie: string) => (await (await journey.api("/api/auth/me", cookie)).json()) as { capabilities: string[]; patientScope: string };
async function target(cookie: string, key: Key) {
  const response = await journey.api(`/api/staff-access/${journey.ids[key]}`, cookie);
  return { status: response.status, body: await response.json() as { revision: number; confirmation: string; editable: boolean; message?: string; code?: string } };
}
const save = (cookie: string, key: Key, body: Record<string, unknown>) =>
  journey.api(`/api/staff-access/${journey.ids[key]}`, cookie, { method: "PATCH", body: JSON.stringify(body) });

it("HTTP: a pending account holds nothing, and a delegated manager can neither edit nor confirm it", async () => {
  const pending = await journey.login("pending");
  expect(pending.status).toBe(200);
  expect(await capabilitiesOf(pending.cookie)).toMatchObject({ capabilities: [], patientScope: "none" });
  const refused = await journey.api("/api/staff-access", pending.cookie);
  expect(refused.status).toBe(403);
  expect((await refused.json()).message).toMatch(ARABIC);

  const manager = await journey.login("manager");
  const view = await target(manager.cookie, "pending");
  expect(view.body).toMatchObject({ confirmation: "pending", editable: false });
  const attempt = await save(manager.cookie, "pending", { expectedRevision: view.body.revision, patientScope: "none", appointmentScope: "none", grants: { "staff.view": true } });
  expect(attempt.status).toBe(403);
  const body = await attempt.json();
  expect(body.code).toBe("initial-owner-confirmation-required");
  expect(body.message).toMatch(ARABIC);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the manager sees why it cannot edit; the owner confirms through an atomic preview", async () => {
  const managerContext = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  const managerPage = await managerContext.newPage();
  await journey.browserLogin(managerPage, "manager");
  await managerPage.goto(`${journey.baseUrl}/staff-access`);
  const managerRow = managerPage.getByTestId("staff-directory").locator("li", { hasText: ACCOUNTS.pending.username });
  await managerRow.getByRole("button", { name: "الصلاحيات" }).click();
  const managerEditor = managerPage.getByTestId("capability-editor");
  await managerEditor.getByTestId("confirmation-pending").waitFor();
  expect(await managerEditor.getByRole("button", { name: /مراجعة الصلاحيات|حفظ الصلاحيات/ }).count()).toBe(0);
  await managerContext.close();

  const pendingBefore = await journey.login("pending");
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  const page = await context.newPage();
  await journey.browserLogin(page, "owner");
  await page.goto(`${journey.baseUrl}/staff-access`);
  const row = page.getByTestId("staff-directory").locator("li", { hasText: ACCOUNTS.pending.username });
  await row.getByRole("button", { name: "الصلاحيات" }).click();
  const editor = page.getByTestId("capability-editor");
  await editor.getByTestId("confirmation-pending").waitFor();
  await editor.getByRole("button", { name: "مراجعة الصلاحيات وتأكيدها" }).click();
  const preview = editor.getByTestId("change-preview");
  await preview.getByTestId("preview-confirmation").waitFor();
  expect(await preview.getByTestId("preview-added").textContent()).toContain("لا شيء");
  // Nothing is written before the confirmation click.
  expect((await target((await journey.login("owner")).cookie, "pending")).body.confirmation).toBe("pending");
  await preview.getByRole("button", { name: "تأكيد الصلاحيات وحفظها" }).click();
  await expect.poll(() => editor.getByRole("status").textContent()).toMatch(/أُكّدت صلاحيات الحساب الأولية/);
  await context.close();

  const { rows: [audit] } = await journey.db.query("SELECT actor, details FROM audit_log WHERE action='staff.capabilities.update' AND entity_id=$1::text ORDER BY id DESC LIMIT 1", [journey.ids.pending]);
  expect(audit).toMatchObject({ actor: ACCOUNTS.owner.username, details: { confirmation: ["pending", "owner"], confirmedByThisSave: true } });
  expect((await journey.api("/api/staff-access", pendingBefore.cookie)).status).toBe(401);
  const fresh = await journey.login("pending");
  expect((await journey.api("/api/staff-access", fresh.cookie)).status).toBe(200);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser + HTTP: hiding a restricted doctor's clinical module through the preview revokes it on the server; scopes stay", async () => {
  const doctorBefore = await journey.login("doctor");
  expect((await journey.api(`/api/patients/${patientId}/medical-history`, doctorBefore.cookie)).status).toBe(200);
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  const page = await context.newPage();
  await journey.browserLogin(page, "owner");
  await page.goto(`${journey.baseUrl}/staff-access`);
  await page.getByTestId("staff-directory").locator("li", { hasText: ACCOUNTS.doctor.username }).getByRole("button", { name: "الصلاحيات" }).click();
  const editor = page.getByTestId("capability-editor");
  await editor.getByText(ACCOUNTS.doctor.display).waitFor();
  await editor.getByTestId("module-clinic").getByRole("button", { name: "إخفاء الوحدة" }).click();
  await editor.getByRole("button", { name: "حفظ الصلاحيات" }).click();
  const preview = editor.getByTestId("change-preview");
  expect(await preview.getByTestId("preview-hidden").textContent()).toContain("العيادة");
  expect(await preview.getByTestId("preview-removed").textContent()).toContain("توثيق");
  await preview.getByRole("button", { name: "تأكيد الحفظ" }).click();
  await expect.poll(() => editor.getByRole("status").textContent()).toMatch(/حُفظت الصلاحيات/);
  await context.close();

  // The live session falls; a fresh one is refused the module's API and direct reads, and keeps its scope.
  expect((await journey.api(`/api/patients/${patientId}/medical-history`, doctorBefore.cookie)).status).toBe(401);
  const fresh = await journey.login("doctor");
  expect(await capabilitiesOf(fresh.cookie)).toMatchObject({ capabilities: [], patientScope: "own" });
  const clinical = await journey.api(`/api/patients/${patientId}/medical-history`, fresh.cookie);
  expect(clinical.status).toBe(403);
  expect((await clinical.json()).message).toMatch(ARABIC);
  expect((await journey.api(`/api/patients/${patientId}`, fresh.cookie)).status).toBe(200);
  expect(await journey.ddlLog()).toEqual([]);
});

it("HTTP: a doctor-manager stays within its authority; revoking its staff module refuses the API and the direct page; titles grant nothing", async () => {
  const docManager = await journey.login("docManager");
  const view = await target(docManager.cookie, "titled");
  expect(view.status).toBe(200);
  const beyond = await save(docManager.cookie, "titled", { expectedRevision: view.body.revision, patientScope: "none", appointmentScope: "none", grants: { "clinical.visits.sign": true, "clinical.visits.document": true } });
  expect(beyond.status).toBe(403);
  expect(await beyond.json()).toMatchObject({ code: "outside-delegable-authority" });
  const ownScope = await save(docManager.cookie, "titled", { expectedRevision: view.body.revision, patientScope: "own", appointmentScope: "none", grants: {} });
  expect(ownScope.status).toBe(403);

  const titled = await journey.login("titled");
  expect(await capabilitiesOf(titled.cookie)).toMatchObject({ capabilities: [], patientScope: "none" });
  expect((await journey.api("/api/staff-access", titled.cookie)).status).toBe(403);
  expect((await journey.api(`/api/patients/${patientId}`, titled.cookie)).status).toBe(403);

  const owner = await journey.login("owner");
  const managerView = await target(owner.cookie, "docManager");
  const revoked = await save(owner.cookie, "docManager", { expectedRevision: managerView.body.revision, patientScope: "own", appointmentScope: "own", grants: { "clinical.plans.view": true } });
  expect(revoked.status).toBe(200);
  expect((await journey.api("/api/staff-access", docManager.cookie)).status).toBe(401);
  const fresh = await journey.login("docManager");
  expect((await journey.api("/api/staff-access", fresh.cookie)).status).toBe(403);
  expect((await journey.api(`/api/staff-access/${journey.ids.titled}`, fresh.cookie)).status).toBe(403);
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  const page = await context.newPage();
  await journey.browserLogin(page, "docManager");
  await page.goto(`${journey.baseUrl}/staff-access`);
  await page.getByTestId("canonical-workspace").waitFor();
  expect(await page.getByTestId("staff-directory").count()).toBe(0);
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});
