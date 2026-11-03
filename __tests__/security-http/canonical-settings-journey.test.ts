/**
 * Owner decision 5 — canonical clinic settings, built application, owned database and
 * server.
 *
 * UI → HTTP → DB with password logins: the read needs `settings.view`; a write needs
 * every key's requirement (delegable capability or owner-only operation); a mixed batch
 * is refused whole; the audit row carries the canonical actor; the screen enables only
 * the keys the server says this account may write; refusals carry an Arabic `message`;
 * no request runs DDL. Synthetic data only.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-s-owner", password: "Canon#SOwner1", role: "admin", display: "المالك التجريبي" },
  operational: { username: "canon-s-ops", password: "Canon#SOps1", role: "reception", display: "منسق تشغيل تجريبي", grants: { "settings.view": true, "settings.operational.edit": true } },
  viewer: { username: "canon-s-viewer", password: "Canon#SViewer1", role: "accountant", display: "قارئ إعدادات تجريبي", grants: { "settings.view": true } },
  none: { username: "canon-s-none", password: "Canon#SNone1", role: "admin", display: "حساب بلا إعدادات", grants: { "patients.create": true }, patientScope: "all" },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;

beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 7, secret: "canonical-settings-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner" });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

const versionsOf = async (cookie: string, keys: string[]) => {
  const body = await (await journey.api("/api/settings", cookie)).json() as { __versions: Record<string, string | null> };
  return Object.fromEntries(keys.map(key => [key, body.__versions[key] ?? null]));
};
const patch = (cookie: string, body: unknown) => journey.api("/api/settings", cookie, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

it("HTTP: per-key writes, whole-batch refusal, owner-only keys and the audit actor", async () => {
  const ops = await journey.login("operational");
  const read = await journey.api("/api/settings", ops.cookie);
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toMatch(/no-store/);
  const body = await read.json() as { __canWrite: string[] };
  expect(body.__canWrite).toContain("clinic.chairs");
  expect(body.__canWrite).not.toContain("finance.rate_max_age_days");
  expect(body.__canWrite).not.toContain("workflow.doctor_financial_view");

  const saved = await patch(ops.cookie, { "clinic.chairs": "4", __versions: await versionsOf(ops.cookie, ["clinic.chairs"]) });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ "clinic.chairs": "4", __changed: ["clinic.chairs"] });
  const { rows: audit } = await journey.db.query("SELECT actor, action FROM audit_log WHERE entity='clinic_setting' AND entity_id='clinic.chairs'");
  expect(audit).toEqual([{ actor: "canon-s-ops", action: "clinic_settings.update" }]);

  const mixed = await patch(ops.cookie, { "clinic.chairs": "5", "finance.rate_max_age_days": "9", __versions: await versionsOf(ops.cookie, ["clinic.chairs", "finance.rate_max_age_days"]) });
  expect(mixed.status).toBe(403);
  const mixedBody = await mixed.json();
  expect(mixedBody).toMatchObject({ code: "setting_not_granted", key: "finance.rate_max_age_days" });
  expect(mixedBody.message).toMatch(ARABIC);
  expect((await journey.db.query("SELECT value FROM settings WHERE key='clinic.chairs'")).rows[0].value).toBe("4");

  const authority = await patch(ops.cookie, { "workflow.doctor_financial_view": "true", __reason: "تجربة", __versions: await versionsOf(ops.cookie, ["workflow.doctor_financial_view"]) });
  expect(authority.status).toBe(403);
  const owner = await journey.login("owner");
  const ownerWrite = await patch(owner.cookie, { "workflow.doctor_financial_view": "true", __reason: "قرار المالك التجريبي", __versions: await versionsOf(owner.cookie, ["workflow.doctor_financial_view"]) });
  expect(ownerWrite.status).toBe(200);

  const viewer = await journey.login("viewer");
  const viewerWrite = await patch(viewer.cookie, { "clinic.chairs": "3", __versions: await versionsOf(viewer.cookie, ["clinic.chairs"]) });
  expect(viewerWrite.status).toBe(403);
  expect((await viewerWrite.json()).message).toMatch(ARABIC);

  const none = await journey.login("none");
  const refused = await journey.api("/api/settings", none.cookie);
  expect(refused.status).toBe(403);
  expect((await refused.json()).message).toMatch(ARABIC);
  const forged = await journey.api("/api/settings", `${ops.cookie.slice(0, -2)}xx`);
  expect(forged.status).toBe(401);
  expect((await forged.json()).message).toMatch(ARABIC);
  const stale = await patch(ops.cookie, { "clinic.chairs": "6", __versions: { "clinic.chairs": "2000-01-01T00:00:00.000Z" } });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: "setting_conflict", key: "clinic.chairs" });
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the settings entry opens the screen; only granted keys are editable; a save goes through the canonical route", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  const failures: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(path); });
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await journey.browserLogin(page, "operational");
  apiCalls.length = 0; failures.length = 0;
  await page.getByRole("link", { name: "الإعدادات" }).first().click();
  await page.waitForURL(/\/settings$/);
  await page.getByText("يمكنك تعديل المفاتيح المصرّح بها لحسابك فقط", { exact: false }).waitFor();
  // Legacy-only areas are not linked from the canonical screen.
  expect(await page.locator('a[href="/settings/users"]').count()).toBe(0);
  expect(await page.locator('a[href="/settings/history"]').count()).toBe(0);
  await page.getByTestId("settings-pending-areas").waitFor();

  await page.getByRole("button", { name: "الطاقة الاستيعابية" }).click();
  const chairs = page.getByRole("article", { name: "عدد الكراسي" });
  await chairs.getByRole("button", { name: "تعديل" }).click();
  await page.locator('input[aria-label="عدد الكراسي"]').fill("7");
  await page.getByRole("button", { name: "حفظ التغيير" }).click();
  await page.getByText("حُفظ الإعداد وسُجّل التغيير.").waitFor();
  expect((await journey.db.query("SELECT value FROM settings WHERE key='clinic.chairs'")).rows[0].value).toBe("7");

  await page.getByRole("button", { name: "المالية" }).click();
  const rate = page.getByRole("article", { name: "عمر سعر الصرف قبل التنبيه" });
  await rate.getByText("للقراءة فقط").waitFor();
  expect(await rate.getByRole("button", { name: "تعديل" }).count()).toBe(0);
  await page.getByRole("button", { name: "الطاقم والصلاحيات" }).click();
  const authority = page.getByRole("article", { name: "رؤية الطبيب للمالية" });
  await authority.getByText("للمالك فقط").waitFor();
  expect(await authority.getByRole("button", { name: "تعديل" }).count()).toBe(0);

  expect(new Set(apiCalls.filter(path => !/^\/api\/auth\/(login|me)$/.test(path)))).toEqual(new Set(["/api/settings"]));
  expect(failures).toEqual([]);
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});
