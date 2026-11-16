/**
 * M2 slice 70a — canonical laboratory directory, built application, owned database and
 * server. Synthetic data only.
 *
 * - Reads under clinical.lab.view; the accounting group only with finance.payables.record.
 * - Writes under clinical.laboratories.manage; accounting fields refused; audit with the write.
 * - /settings/laboratories mounts the canonical directory: add, edit, delete with a
 *   confirmation; only canonical requests; no request runs DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-ld-owner", password: "Canon#LDOwner1", role: "admin", display: "المالك التجريبي" },
  viewer: { username: "canon-ld-view", password: "Canon#LDView1", role: "reception", display: "مطّلع", grants: { "clinical.lab.view": true } },
  finance: { username: "canon-ld-fin", password: "Canon#LDFin1", role: "accountant", display: "المحاسب", grants: { "clinical.lab.view": true, "finance.payables.record": true } },
  manager: { username: "canon-ld-mgr", password: "Canon#LDMgr1", role: "reception", display: "مدير المختبرات", grants: { "clinical.lab.view": true, "clinical.laboratories.manage": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
let seeded = 0;
const json = (method: string, body?: unknown) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const party = async (name: string) => (await journey.db.query("SELECT id, phone, is_active, expense_account_code FROM parties WHERE kind='lab' AND name=$1", [name])).rows[0];

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 114, secret: "canonical-lab-directory-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db) {
      seeded = (await db.query<{ id: number }>("INSERT INTO parties(name,kind,currency,expense_account_code) VALUES('مختبر البدر التجريبي','lab','USD','5188') RETURNING id")).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: accounting visible only with finance.payables.record, never writable here; writes need the manage grant", async () => {
  const viewer = await journey.login("viewer");
  const plain = await (await journey.api("/api/laboratories", viewer.cookie)).json();
  const lab = plain.laboratories.find((row: { id: number }) => row.id === seeded);
  expect(lab).toMatchObject({ name: "مختبر البدر التجريبي" });
  expect(lab).not.toHaveProperty("expenseAccountCode");
  expect(await (await journey.api("/api/lab/services", viewer.cookie)).json()).toHaveProperty("services");
  const finance = await journey.login("finance");
  expect(await (await journey.api(`/api/laboratories/${seeded}`, finance.cookie)).json()).toMatchObject({ laboratory: { currency: "USD", expenseAccountCode: "5188" } });
  const denied = await journey.api("/api/laboratories", viewer.cookie, json("POST", { name: "مختبر مرفوض" }));
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);
  const manager = await journey.login("manager");
  const money = await journey.api(`/api/laboratories/${seeded}`, manager.cookie, json("PATCH", { expenseAccountCode: "5100" }));
  expect(money.status).toBe(409);
  expect(await money.json()).toMatchObject({ code: "lab_money_not_canonical", field: "expenseAccountCode", message: expect.stringMatching(ARABIC) });
  expect((await party("مختبر البدر التجريبي")).expense_account_code).toBe("5188");
  expect((await journey.api("/api/lab/work-intents/capability", viewer.cookie)).status).toBe(403);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the manager adds a lab, edits its phone and deletes it with a confirmation — canonical requests only", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(`${request.method()} ${path}`); });
  await journey.browserLogin(page, "manager");
  await page.goto(`${journey.baseUrl}/settings/laboratories`);
  const directory = page.getByTestId("canonical-laboratories");
  await directory.getByTestId("laboratory-list").waitFor();
  await directory.getByTestId("laboratory-add").click();
  await directory.locator('[data-lab-field="name"]').fill("مختبر النجمة التجريبي");
  await directory.locator('[data-lab-field="phone"]').fill("0500000840");
  await directory.getByTestId("laboratory-save").click();
  await expect.poll(async () => (await party("مختبر النجمة التجريبي"))?.phone ?? null).toBe("0500000840");
  const created = (await party("مختبر النجمة التجريبي")).id as number;
  expect((await party("مختبر النجمة التجريبي")).expense_account_code).toBe("5101");

  const card = directory.locator(`[data-lab="${created}"]`);
  await card.getByRole("button", { name: "تعديل" }).click();
  await card.locator('[data-lab-field="phone"]').fill("0500000841");
  await card.getByTestId("laboratory-save").click();
  await expect.poll(async () => (await party("مختبر النجمة التجريبي"))?.phone ?? null).toBe("0500000841");

  await card.getByTestId("laboratory-delete").click();
  expect(await party("مختبر النجمة التجريبي")).toBeDefined();
  await card.getByTestId("laboratory-confirm-delete").click();
  await expect.poll(async () => (await party("مختبر النجمة التجريبي")) ?? null).toBeNull();
  expect((await journey.db.query("SELECT details->>'operation' AS op, actor FROM audit_log WHERE entity='laboratory' AND entity_id=$1::text ORDER BY id", [created])).rows)
    .toEqual([{ op: "create", actor: "canon-ld-mgr" }, { op: "update", actor: "canon-ld-mgr" }, { op: "delete", actor: "canon-ld-mgr" }]);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await context.close();
  expect(apiCalls.filter(call => !/^(GET|POST) \/api\/auth\/(login|me)$/.test(call) && !/^(GET \/api\/laboratories|POST \/api\/laboratories|(PATCH|DELETE) \/api\/laboratories\/\d+)$/.test(call))).toEqual([]);
  expect(await journey.ddlLog()).toEqual([]);
});
