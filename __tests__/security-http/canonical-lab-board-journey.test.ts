/**
 * M2 slice 66 — canonical lab reads and board, built application, owned database and
 * server. Synthetic data only.
 *
 * - The patient scope bounds the orders (own: the clinician's patients); the money group
 *   reaches only finance.cost-prices.view; the whole-clinic backlog needs the whole
 *   patient scope; tasks only with tasks.use.
 * - /lab mounts the canonical board (never the legacy page or its requests); a doctor
 *   sees only its own patients' work and no backlog; no request runs DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-lb-owner", password: "Canon#LBOwner1", role: "admin", display: "المالك التجريبي" },
  coordinator: { username: "canon-lb-coord", password: "Canon#LBCoord1", role: "reception", display: "منسق المختبر", patientScope: "all",
    grants: { "clinical.lab.view": true, "tasks.use": true } },
  finance: { username: "canon-lb-fin", password: "Canon#LBFin1", role: "accountant", display: "المحاسب", patientScope: "all",
    grants: { "clinical.lab.view": true, "finance.cost-prices.view": true } },
  doctor: { username: "canon-lb-doc", password: "Canon#LBDoc1", role: "doctor", display: "طبيب تجريبي", doctor: true, patientScope: "own",
    grants: { "clinical.lab.view": true } },
  noLab: { username: "canon-lb-nolab", password: "Canon#LBNoLab1", role: "reception", display: "استقبال", patientScope: "all", grants: {} },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { overdue: 0, mine: 0 };

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 106, secret: "canonical-lab-board-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      const patient = async (number: string, name: string, doctor: number | null) =>
        (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000800',$3) RETURNING id", [number, name, doctor])).rows[0].id;
      const theirs = await patient("SYN-LBJ-1", "مريض تاج متأخر", null);
      const mine = await patient("SYN-LBJ-2", "مريضة الطبيب", parties.doctor!);
      const order = async (patientId: number, due: string, cost: number) => (await db.query<{ id: number }>(
        `INSERT INTO lab_orders(patient_id,lab_name,work_type,status,sent_date,due_date,cost_minor,cost_currency,base_amount_minor,exchange_rate)
         VALUES ($1,'مختبر النور التجريبي','تاج زركون','sent',((NOW() AT TIME ZONE 'Asia/Aden')::date - 10),${due},$2,'SAR',$3,120) RETURNING id`,
        [patientId, cost, cost * 120])).rows[0].id;
      ids.overdue = await order(theirs, "((NOW() AT TIME ZONE 'Asia/Aden')::date - 3)", 43210);
      ids.mine = await order(mine, "((NOW() AT TIME ZONE 'Asia/Aden')::date + 5)", 11111);
      const owner = (await db.query<{ id: number }>("SELECT id FROM users WHERE username=$1", [ACCOUNTS.owner.username])).rows[0].id;
      const task = (await db.query<{ id: number }>("INSERT INTO hr_tasks(title,is_private,owner_user_id,owner_display_name,created_by,due_at) VALUES ('اتصل بالمختبر بشأن التاج',FALSE,$1,'المالك','المالك',NOW()) RETURNING id", [owner])).rows[0].id;
      await db.query("INSERT INTO hr_task_links(task_id,link_kind,link_id,linked_by) VALUES ($1,'lab_order',$2,'المالك')", [task, ids.overdue]);
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: scope bounds the orders, money only with the cost capability, backlog only with the whole scope", async () => {
  const doctor = await journey.login("doctor");
  const own = await (await journey.api("/api/lab", doctor.cookie)).json();
  expect(own.orders.map((order: { id: number }) => order.id)).toEqual([ids.mine]);
  expect(own.orders[0]).not.toHaveProperty("costMinor");
  const backlog = await journey.api("/api/lab/backlog?filter=all", doctor.cookie);
  expect(backlog.status).toBe(403);
  expect((await backlog.json()).message).toMatch(ARABIC);

  const coordinator = await journey.login("coordinator");
  const all = await (await journey.api("/api/lab", coordinator.cookie)).json();
  expect(all.orders.map((order: { id: number }) => order.id).sort()).toEqual([ids.overdue, ids.mine].sort());
  expect(JSON.stringify(all)).not.toMatch(/43210|5185200/);
  const withTasks = await (await journey.api("/api/lab/backlog?filter=overdue", coordinator.cookie)).json();
  expect(withTasks.counts.overdue).toBe(1);
  expect(withTasks.items[0].tasks.map((task: { title: string }) => task.title)).toEqual(["اتصل بالمختبر بشأن التاج"]);

  const finance = await journey.login("finance");
  const money = await (await journey.api("/api/lab", finance.cookie)).json();
  expect(money.orders.find((order: { id: number }) => order.id === ids.overdue)).toMatchObject({ costMinor: 43210, baseAmountMinor: 5185200 });
  const noTasks = await (await journey.api("/api/lab/backlog?filter=overdue", finance.cookie)).json();
  expect(noTasks.items[0].tasks).toEqual([]);

  const noLab = await journey.login("noLab");
  const refused = await journey.api("/api/lab", noLab.cookie);
  expect(refused.status).toBe(403);
  expect((await refused.json()).message).toMatch(ARABIC);
  expect((await journey.api("/api/lab?patientId=1e9", coordinator.cookie)).status).toBe(400);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the coordinator's board shows the overdue crown and the backlog, without costs, and only canonical requests", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(path); });
  await journey.browserLogin(page, "coordinator");
  await page.goto(`${journey.baseUrl}/lab`);
  const board = page.getByTestId("canonical-lab-board");
  await board.getByTestId("lab-orders").waitFor();
  const late = board.locator(`[data-order="${ids.overdue}"]`);
  await expect.poll(() => late.textContent()).toMatch(/متأخر 3 يومًا/);
  expect(await board.locator(`[data-order="${ids.mine}"]`).count()).toBe(0);
  expect(await board.textContent()).not.toMatch(/التكلفة/);
  await board.getByTestId("lab-backlog-items").waitFor();
  expect(await board.getByTestId("lab-backlog").textContent()).toContain("اتصل بالمختبر بشأن التاج");
  // No horizontal overflow at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await context.close();
  expect(apiCalls.filter(path => !/^\/api\/auth\/(login|me)$/.test(path) && !["/api/lab", "/api/lab/backlog"].includes(path))).toEqual([]);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: a doctor's board lists its own patients' work and no clinic-wide backlog", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  await journey.browserLogin(page, "doctor");
  await page.goto(`${journey.baseUrl}/lab`);
  const board = page.getByTestId("canonical-lab-board");
  await board.getByRole("button", { name: /عند المختبر/ }).click();
  await board.locator(`[data-order="${ids.mine}"]`).waitFor();
  expect(await board.locator(`[data-order="${ids.overdue}"]`).count()).toBe(0);
  expect(await board.getByTestId("lab-backlog").count()).toBe(0);
  expect(await board.textContent()).toContain("أعمال مرضاك");
  await context.close();
});
