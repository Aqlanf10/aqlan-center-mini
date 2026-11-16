/**
 * M2 slice 71 — canonical lab-order accounting, built application, owned database and
 * server. Synthetic data only.
 *
 * - update_accounting / post / unpost under finance.payables.record; without it 403; the
 *   response never carries an amount without finance.cost-prices.view (owner rule).
 * - The board's accounting panel unposts and posts with clicks; only canonical requests;
 *   no request runs DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-laj-owner", password: "Canon#LAJOwner1", role: "admin", display: "المالك التجريبي" },
  accountant: { username: "canon-laj-acc", password: "Canon#LAJAcc1", role: "accountant", display: "المحاسب", patientScope: "all",
    grants: { "clinical.lab.view": true, "finance.payables.record": true } },
  coordinator: { username: "canon-laj-coord", password: "Canon#LAJCoord1", role: "reception", display: "منسق المختبر", patientScope: "all",
    grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { order: 0 };
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });
const posted = async () => (await journey.db.query<{ is_posted: boolean }>("SELECT is_posted FROM lab_orders WHERE id=$1", [ids.order])).rows[0].is_posted;

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 118, secret: "canonical-lab-accounting-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db) {
      const patient = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES ('SYN-LAJ-1','مريض محاسبة تجريبي','0500000850') RETURNING id")).rows[0].id;
      const lab = (await db.query<{ id: number }>("INSERT INTO parties(name,kind,currency) VALUES('مختبر الحساب التجريبي','lab','YER') RETURNING id")).rows[0].id;
      ids.order = (await db.query<{ id: number }>(`INSERT INTO lab_orders(patient_id,party_id,lab_name,work_type,status,sent_date,due_date,cost_minor,cost_currency,exchange_rate,base_amount_minor,is_posted)
        VALUES ($1,$2,'مختبر الحساب التجريبي','تاج زيركون كامل','sent',((NOW() AT TIME ZONE 'Asia/Aden')::date),((NOW() AT TIME ZONE 'Asia/Aden')::date + 7),777000,'YER',1,777000,TRUE) RETURNING id`,
      [patient, lab])).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: posting needs finance.payables.record; the accountant without cost view never receives the amount", async () => {
  const coordinator = await journey.login("coordinator");
  const denied = await journey.api(`/api/lab/${ids.order}`, coordinator.cookie, patch({ action: "unpost" }));
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);
  expect(await posted()).toBe(true);
  const accountant = await journey.login("accountant");
  const unposted = await journey.api(`/api/lab/${ids.order}`, accountant.cookie, patch({ action: "unpost" }));
  expect(unposted.status).toBe(200);
  expect(await unposted.text()).not.toMatch(/777000|costMinor/);
  expect(await posted()).toBe(false);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the accountant posts from the board's accounting panel — canonical requests only", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(`${request.method()} ${path}`); });
  await journey.browserLogin(page, "accountant");
  await page.goto(`${journey.baseUrl}/lab`);
  const board = page.getByTestId("canonical-lab-board");
  await board.getByRole("button", { name: /عند المختبر/ }).click();
  const card = board.locator(`[data-order="${ids.order}"]`);
  await card.getByTestId("lab-accounting").getByRole("button", { name: "الربط المحاسبي" }).click();
  await card.getByTestId("acct-post").click();
  await expect.poll(posted).toBe(true);
  expect(await card.textContent()).not.toMatch(/777,?000|7,770/);
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='lab_order.accounting' AND entity_id=$1::text ORDER BY id", [String(ids.order)])).rows.map(row => row.actor))
    .toEqual(["canon-laj-acc", "canon-laj-acc"]);
  await context.close();
  expect(apiCalls.filter(call => !/^(GET|POST) \/api\/auth\/(login|me)$/.test(call) && !/^(GET \/api\/lab(\/backlog)?|PATCH \/api\/lab\/\d+)$/.test(call))).toEqual([]);
  expect(await journey.ddlLog()).toEqual([]);
});
