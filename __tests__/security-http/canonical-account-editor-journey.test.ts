/**
 * Canonical account editor (review 6507696166 item 2), built application, owned
 * database and server. Synthetic data only.
 *
 * - A delegate with staff.accounts.disable deactivates and reactivates an account
 *   through the editor's preview: only the target's sessions fall, its login is refused
 *   while inactive, and every save is audited with no secret.
 * - The batch rule, the version CAS, the protected owner and owner-only fields are
 *   refused over HTTP with Arabic messages and change nothing.
 * - The owner relinks a clinician and sets a temporary password in one atomic save: the
 *   commission change is recorded in the same transaction, the old session and the old
 *   password stop working, the new password works with the new link.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-a-owner", password: "Canon#AOwner1", role: "admin", display: "المالك التجريبي" },
  manager: { username: "canon-a-manager", password: "Canon#AManager1", role: "reception", display: "مدير حسابات تجريبي", patientScope: "all", appointmentScope: "all",
    grants: { "staff.view": true, "staff.profile.edit": true, "staff.accounts.disable": true } },
  reception: { username: "canon-a-reception", password: "Canon#AReception1", role: "reception", display: "استقبال تجريبي", grants: { "staff.view": true } },
  doctor: { username: "canon-a-doctor", password: "Canon#ADoctor1", role: "doctor", display: "طبيب تجريبي", doctor: true, grants: { "staff.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
let secondDoctor = 0;

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 27, secret: "canonical-account-editor-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, ids) {
      secondDoctor = (await db.query<{ id: number }>("INSERT INTO parties(name,kind,is_active) VALUES('SYN طبيب ثان للربط','doctor',TRUE) RETURNING id")).rows[0].id;
      await db.query("UPDATE users SET commission_config=$2 WHERE id=$1", [ids.doctor,
        JSON.stringify({ calculationMode: "percent", defaultPercent: 40, deductLabCost: true, basis: "collected" })]);
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

type View = { version: string; active: boolean; clinicianPartyId: number | null; allowed: Record<string, boolean>; message?: string; code?: string };
async function account(cookie: string, key: Key) {
  const response = await journey.api(`/api/staff-access/${journey.ids[key]}/account`, cookie);
  return { status: response.status, body: await response.json() as View };
}
async function patch(cookie: string, key: Key, body: unknown) {
  const response = await journey.api(`/api/staff-access/${journey.ids[key]}/account`, cookie, { method: "PATCH", body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as View };
}
const userRow = async (key: Key) => (await journey.db.query("SELECT display_name, role, is_active, party_id, password_hash FROM users WHERE id=$1", [journey.ids[key]])).rows[0];
const accountAudits = async () => Number((await journey.db.query("SELECT count(*) FROM audit_log WHERE action='staff.account.update'")).rows[0].count);

it("HTTP: refusals change nothing and say why in Arabic", async () => {
  const manager = await journey.login("manager");
  const view = await account(manager.cookie, "reception");
  expect(view.body).toMatchObject({ active: true, allowed: { active: true, displayName: true, roleLabel: false, clinicianPartyId: false, temporaryPassword: false } });
  const before = await userRow("reception"), audits = await accountAudits();
  for (const [body, status, code] of [
    [{ expectedVersion: view.body.version, changes: { active: false, roleLabel: "admin" } }, 403, "owner-operation-required"],
    [{ expectedVersion: view.body.version, changes: { active: false, isOwner: true } }, 422, "unknown-account-field"],
    [{ expectedVersion: "0".repeat(64), changes: { active: false } }, 409, "stale-version"],
  ] as const) {
    const response = await patch(manager.cookie, "reception", body);
    expect([response.status, response.body.code]).toEqual([status, code]);
    expect(response.body.message).toMatch(ARABIC);
  }
  const owner = await account(manager.cookie, "owner");
  expect((await patch(manager.cookie, "owner", { expectedVersion: owner.body.version, changes: { active: false } })).body.code).toBe("protected-owner");
  expect((await patch(manager.cookie, "manager", { expectedVersion: (await account(manager.cookie, "manager")).body.version, changes: { active: false } })).body.code).toBe("self-staff-maintenance");
  expect((await patch(manager.cookie, "reception", { expectedVersion: view.body.version, changes: { active: false }, extra: 1 })).status).toBe(400);
  expect([await userRow("reception"), await accountAudits()]).toEqual([before, audits]);
  // A plain staff.view reader sees the account and may change nothing.
  expect((await account((await journey.login("reception")).cookie, "doctor")).body).toMatchObject({ allowed: { displayName: false, active: false, roleLabel: false, clinicianPartyId: false, temporaryPassword: false } });
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser + HTTP: a delegate deactivates through the preview; only the target's sessions fall; reactivation restores entry", async () => {
  const target = await journey.login("reception");
  const bystander = await journey.login("doctor");
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  const page = await context.newPage();
  await journey.browserLogin(page, "manager");
  await page.goto(`${journey.baseUrl}/staff-access`);
  await page.getByTestId("staff-directory").locator("li", { hasText: ACCOUNTS.reception.username }).getByRole("button", { name: "الحساب" }).click();
  const editor = page.getByTestId("account-editor");
  // Owner-only fields are shown disabled to a delegate.
  await expect.poll(() => editor.getByLabel("الدور (تسمية فقط)").isDisabled()).toBe(true);
  expect(await editor.getByLabel("كلمة مرور مؤقتة (اتركها فارغة لعدم التغيير)").count()).toBe(0);
  await editor.getByLabel("الحالة").selectOption("inactive");
  await editor.getByRole("button", { name: "حفظ الحساب" }).click();
  const preview = editor.getByTestId("account-preview");
  expect(await preview.textContent()).toContain("إيقاف الحساب");
  // Nothing is written before the confirmation click.
  expect((await userRow("reception")).is_active).toBe(true);
  await preview.getByRole("button", { name: "تأكيد حفظ الحساب" }).click();
  await expect.poll(() => editor.getByRole("status").textContent()).toMatch(/جلسات هذا الموظف القائمة سقطت/);

  expect((await userRow("reception")).is_active).toBe(false);
  expect((await journey.api("/api/staff-access", target.cookie)).status).toBe(401);
  expect((await journey.api("/api/staff-access", bystander.cookie)).status).toBe(200);
  const refused = await journey.login("reception");
  expect(refused.status).not.toBe(200);
  expect(refused.cookie).toBe("");
  const { rows: [audit] } = await journey.db.query("SELECT actor, details FROM audit_log WHERE action='staff.account.update' AND entity_id=$1::text ORDER BY id DESC LIMIT 1", [journey.ids.reception]);
  expect(audit).toMatchObject({ actor: ACCOUNTS.manager.username, details: { changes: { active: [true, false] }, sessionsRevoked: true, credentialReset: false } });

  await editor.getByLabel("الحالة").selectOption("active");
  await editor.getByRole("button", { name: "حفظ الحساب" }).click();
  await editor.getByTestId("account-preview").getByRole("button", { name: "تأكيد حفظ الحساب" }).click();
  await expect.poll(async () => (await userRow("reception")).is_active).toBe(true);
  await context.close();
  expect((await journey.login("reception")).status).toBe(200);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser + HTTP: the owner relinks a clinician and sets a temporary password in one save; commission and sessions follow atomically", async () => {
  const doctorBefore = await journey.login("doctor");
  const firstParty = journey.parties.doctor!;
  const commissionBefore = Number((await journey.db.query("SELECT count(*) FROM audit_log WHERE action='doctor.commission.update'")).rows[0].count);
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  const page = await context.newPage();
  await journey.browserLogin(page, "owner");
  await page.goto(`${journey.baseUrl}/staff-access`);
  await page.getByTestId("staff-directory").locator("li", { hasText: ACCOUNTS.doctor.username }).getByRole("button", { name: "الحساب والصلاحيات" }).click();
  const editor = page.getByTestId("account-editor");
  await expect.poll(() => editor.getByLabel("ربط بطبيب").isDisabled()).toBe(false);
  await editor.getByLabel("ربط بطبيب").selectOption(String(secondDoctor));
  await editor.getByLabel("كلمة مرور مؤقتة (اتركها فارغة لعدم التغيير)").fill("Temporary#Pass9");
  await editor.getByRole("button", { name: "حفظ الحساب" }).click();
  const preview = editor.getByTestId("account-preview");
  expect(await preview.textContent()).toMatch(/ربط الطبيب[\s\S]*كلمة مرور مؤقتة/);
  await preview.getByRole("button", { name: "تأكيد حفظ الحساب" }).click();
  await expect.poll(() => editor.getByRole("status").textContent()).toMatch(/حُفظ الحساب/);
  await context.close();

  expect((await userRow("doctor")).party_id).toBe(secondDoctor);
  expect((await journey.api("/api/staff-access", doctorBefore.cookie)).status).toBe(401);
  expect((await journey.login("doctor")).status).not.toBe(200);
  const fresh = await journey.api("/api/auth/login", "", { method: "POST", body: JSON.stringify({ username: ACCOUNTS.doctor.username, password: "Temporary#Pass9" }) });
  expect(fresh.status).toBe(200);
  const cookie = (fresh.headers.get("set-cookie") ?? "").split(";")[0];
  expect(await (await journey.api("/api/auth/me", cookie)).json()).toMatchObject({ doctorPartyId: secondDoctor });
  // The commission effect of the link change was recorded in the same transaction (both doctors).
  const { rows: history } = await journey.db.query("SELECT party_id, source FROM doctor_commission_history WHERE party_id = ANY($1::int[]) ORDER BY party_id, id", [[firstParty, secondDoctor]]);
  expect(history.map(row => row.source)).toEqual(["baseline", "advanced", "baseline", "advanced"]);
  expect(Number((await journey.db.query("SELECT count(*) FROM audit_log WHERE action='doctor.commission.update'")).rows[0].count)).toBe(commissionBefore + 2);
  const { rows: [audit] } = await journey.db.query("SELECT details::text AS text, details FROM audit_log WHERE action='staff.account.update' AND entity_id=$1::text ORDER BY id DESC LIMIT 1", [journey.ids.doctor]);
  expect(audit.details).toMatchObject({ changes: { clinicianPartyId: [firstParty, secondDoctor] }, credentialReset: true, sessionsRevoked: true });
  expect(audit.text).not.toMatch(/Temporary#Pass9|scrypt/);
  expect(await journey.ddlLog()).toEqual([]);
});
