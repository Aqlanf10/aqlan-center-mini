/**
 * M2 slice 67 — canonical lab-order commands, built application, owned database and
 * server. Synthetic data only.
 *
 * - PATCH /api/lab/[id]: status (with the screen's expected status), due date and events
 *   under clinical.lab.order / clinical.lab.view inside the patient scope; cancel after
 *   dispatch needs clinical.lab.cancel; every other action is refused explicitly.
 * - DELETE /api/lab/[id]: clinical.lab.cancel with a reason; the audit row commits with it.
 * - The board moves work with real clicks (receipt recognises the payable once), changes
 *   the promised date and cancels with an explicit confirmation; only canonical requests;
 *   no request runs DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-lo-owner", password: "Canon#LOOwner1", role: "admin", display: "المالك التجريبي" },
  coordinator: { username: "canon-lo-coord", password: "Canon#LOCoord1", role: "reception", display: "منسق المختبر", patientScope: "all",
    grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
  manager: { username: "canon-lo-mgr", password: "Canon#LOMgr1", role: "reception", display: "مدير المختبر", patientScope: "all",
    grants: { "clinical.lab.view": true, "clinical.lab.order": true, "clinical.lab.cancel": true } },
  doctor: { username: "canon-lo-doc", password: "Canon#LODoc1", role: "doctor", display: "طبيب تجريبي", doctor: true, patientScope: "own",
    grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { api: 0, board: 0, mine: 0, doomed: 0 };
const json = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });
const statusOf = async (id: number) => (await journey.db.query<{ status: string }>("SELECT status FROM lab_orders WHERE id=$1", [id])).rows[0]?.status;

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 108, secret: "canonical-lab-orders-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      const patient = async (number: string, name: string, doctor: number | null) =>
        (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000810',$3) RETURNING id", [number, name, doctor])).rows[0].id;
      const theirs = await patient("SYN-LOJ-1", "مريض جسر تجريبي", null);
      const mine = await patient("SYN-LOJ-2", "مريضة الطبيب التجريبية", parties.doctor!);
      const labParty = (await db.query<{ id: number }>("INSERT INTO parties(name,kind,currency) VALUES('مختبر الأمل التجريبي','lab','YER') RETURNING id")).rows[0].id;
      const order = async (patientId: number, work: string, due: string) => (await db.query<{ id: number }>(
        `INSERT INTO lab_orders(patient_id,party_id,lab_name,work_type,status,sent_date,due_date,cost_minor,cost_currency,exchange_rate,base_amount_minor)
         VALUES ($1,$2,'مختبر الأمل التجريبي',$3,'sent',((NOW() AT TIME ZONE 'Asia/Aden')::date - 10),${due},30000,'YER',1,30000) RETURNING id`,
        [patientId, labParty, work])).rows[0].id;
      ids.api = await order(theirs, "تاج زركون", "((NOW() AT TIME ZONE 'Asia/Aden')::date - 2)");
      ids.board = await order(theirs, "جسر ثلاثي", "((NOW() AT TIME ZONE 'Asia/Aden')::date - 1)");
      ids.doomed = await order(theirs, "قشرة خزفية", "((NOW() AT TIME ZONE 'Asia/Aden')::date - 4)");
      ids.mine = await order(mine, "تاج مؤقت", "((NOW() AT TIME ZONE 'Asia/Aden')::date + 3)");
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: status with the expected status, scope, cancel authority, explicit refusals, events and delete", async () => {
  const coordinator = await journey.login("coordinator");
  const moved = await journey.api(`/api/lab/${ids.api}`, coordinator.cookie, json({ status: "in_progress", expectedStatus: "sent" }));
  expect(moved.status).toBe(200);
  expect(moved.headers.get("cache-control")).toContain("no-store");
  const body = await moved.json();
  expect(body.order).toMatchObject({ id: ids.api, status: "in_progress" });
  expect(body.order).not.toHaveProperty("costMinor");

  const stale = await journey.api(`/api/lab/${ids.api}`, coordinator.cookie, json({ status: "received", expectedStatus: "sent" }));
  expect(stale.status).toBe(409);
  expect((await stale.json()).message).toMatch(ARABIC);
  const cancel = await journey.api(`/api/lab/${ids.api}`, coordinator.cookie, json({ status: "cancelled" }));
  expect(cancel.status).toBe(403);
  expect((await cancel.json()).message).toMatch(ARABIC);
  // Slice 69 moved the clinical corrections; accounting and posting stay refused.
  for (const action of ["update_accounting", "post", "unpost"]) {
    const refused = await journey.api(`/api/lab/${ids.api}`, coordinator.cookie, json({ action, isPosted: true, cost: "1" }));
    expect([action, refused.status, (await refused.json()).code]).toEqual([action, 409, "lab_action_not_canonical"]);
  }
  expect(await statusOf(ids.api)).toBe("in_progress");

  const doctor = await journey.login("doctor");
  expect((await journey.api(`/api/lab/${ids.api}`, doctor.cookie, json({ status: "received" }))).status).toBe(404);
  expect((await journey.api(`/api/lab/${ids.mine}`, doctor.cookie, json({ dueDate: "2031-05-02" }))).status).toBe(200);

  const events = await (await journey.api(`/api/lab/${ids.api}`, coordinator.cookie, json({ action: "events" }))).json();
  expect(events.events.map((event: { toStatus: string; actor: string }) => [event.toStatus, event.actor])).toEqual([["in_progress", "canon-lo-coord"]]);

  expect((await journey.api(`/api/lab/${ids.doomed}`, coordinator.cookie, { method: "DELETE", body: JSON.stringify({ reason: "سجل مكرر" }) })).status).toBe(403);
  const manager = await journey.login("manager");
  const noReason = await journey.api(`/api/lab/${ids.doomed}`, manager.cookie, { method: "DELETE", body: JSON.stringify({}) });
  expect(noReason.status).toBe(400);
  expect((await noReason.json()).message).toMatch(ARABIC);
  expect((await journey.api(`/api/lab/${ids.doomed}`, manager.cookie, { method: "DELETE", body: JSON.stringify({ reason: "سجل مكرر" }) })).status).toBe(200);
  expect(await statusOf(ids.doomed)).toBeUndefined();
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='lab_order.delete' AND entity_id=$1", [String(ids.doomed)])).rows).toEqual([{ actor: "canon-lo-mgr" }]);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the manager receives work with a click, moves a promised date and cancels with a confirmation — canonical requests only", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(`${request.method()} ${path}`); });
  await journey.browserLogin(page, "manager");
  await page.goto(`${journey.baseUrl}/lab`);
  const board = page.getByTestId("canonical-lab-board");
  await board.getByRole("button", { name: /عند المختبر/ }).click();
  const card = board.locator(`[data-order="${ids.board}"]`);
  await card.locator('[data-move="received"]').click();
  await expect.poll(() => statusOf(ids.board)).toBe("received");
  expect((await journey.db.query("SELECT count(*)::int AS n FROM payables WHERE lab_order_id=$1", [ids.board])).rows[0].n).toBe(1);

  // The promised date of work still at the lab.
  await board.getByRole("button", { name: /عند المختبر/ }).click();
  const atLab = board.locator(`[data-order="${ids.api}"]`);
  await atLab.getByTestId("lab-due-input").fill("2031-06-15");
  await atLab.getByTestId("lab-due-save").click();
  await expect.poll(async () => (await journey.db.query<{ d: string }>("SELECT due_date::text AS d FROM lab_orders WHERE id=$1", [ids.api])).rows[0].d).toBe("2031-06-15");

  // Cancel needs the explicit second press.
  await board.getByRole("button", { name: /عند المختبر/ }).click();
  await atLab.getByTestId("lab-cancel").click();
  expect(await statusOf(ids.api)).toBe("in_progress");
  await atLab.locator('[data-move="cancelled"]').click();
  await expect.poll(() => statusOf(ids.api)).toBe("cancelled");
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='lab_order.cancel' AND entity_id=$1", [String(ids.api)])).rows).toEqual([{ actor: "canon-lo-mgr" }]);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await context.close();
  expect(apiCalls.filter(call => !/^(GET|POST) \/api\/auth\/(login|me)$/.test(call) && !/^(GET \/api\/lab(\/backlog)?|PATCH \/api\/lab\/\d+)$/.test(call))).toEqual([]);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: a coordinator without clinical.lab.cancel sees the moves but no cancel after dispatch", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  await journey.browserLogin(page, "coordinator");
  await page.goto(`${journey.baseUrl}/lab`);
  const board = page.getByTestId("canonical-lab-board");
  await board.getByRole("button", { name: /عند المختبر/ }).click();
  const mine = board.locator(`[data-order="${ids.mine}"]`);
  await mine.locator('[data-move="received"]').waitFor();
  expect(await mine.getByTestId("lab-cancel").count()).toBe(0);
  await context.close();
});
