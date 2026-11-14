/** M2 slice 66: canonical lab reads (GET /api/lab, GET /api/lab/backlog) on real
 * PostgreSQL, synthetic data only. Patient scope in SQL before the limit, the money
 * group only with finance.cost-prices.view, the backlog only with the whole patient
 * scope and tasks only with tasks.use; and the daily window regression (legacy too). */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-lab-reads-2026-xyz");
const db = await import("../../lib/db");
const reads = await import("../../lib/canonical-lab-reads");

const ACCOUNTS = {
  owner: { username: "SYN-LR-OWNER", role: "admin" },
  coordinator: { username: "SYN-LR-COORD", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "clinical.lab.order": true, "tasks.use": true } },
  finance: { username: "SYN-LR-FIN", role: "accountant", patientScope: "all", grants: { "clinical.lab.view": true, "finance.cost-prices.view": true } },
  doctor: { username: "SYN-LR-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.lab.view": true } },
  noLab: { username: "SYN-LR-NOLAB", role: "reception", patientScope: "all", grants: {} },
  noScope: { username: "SYN-LR-NOSCOPE", role: "reception", grants: { "clinical.lab.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const ids = { mine: 0, theirs: 0, mineOrder: 0, theirsOrder: 0, oldDelivered: 0, remake: 0 };
const MONEY = ["costMinor", "costCurrency", "baseAmountMinor", "exchangeRate", "financialStatus", "payableId", "expenseAccountCode", "payableAccountCode", "isPosted", "postedAt"];
const params = (value: Record<string, string> = {}) => new URLSearchParams(value);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000700',$3) RETURNING id", [number, `SYN Lab ${number}`, doctor]))[0].id as number;
  ids.mine = await patient("SYN-LR-1", fx.parties.doctor!);
  ids.theirs = await patient("SYN-LR-2", null);
  const order = async (patientId: number, status: string, extra = "") =>
    (await q(`INSERT INTO lab_orders(patient_id,lab_name,work_type,status,sent_date,due_date,cost_minor,cost_currency,base_amount_minor,exchange_rate${extra ? ",delivered_at" : ""})
      VALUES ($1,'SYN Lab One','Synthetic crown',$2,'2031-01-01','2031-01-10',50000,'SAR',6000000,120${extra ? ",$3::timestamptz" : ""}) RETURNING id`, extra ? [patientId, status, extra] : [patientId, status]))[0].id as number;
  ids.mineOrder = await order(ids.mine, "sent");
  ids.theirsOrder = await order(ids.theirs, "sent");
  ids.remake = await order(ids.theirs, "remake");
  ids.oldDelivered = await order(ids.theirs, "delivered", "2020-01-01T00:00:00Z");
  const [task] = await q("INSERT INTO hr_tasks(title,is_private,owner_user_id,owner_display_name,created_by,due_at) VALUES ('SYN lab follow-up task',FALSE,$1,'Synthetic owner','Synthetic creator','2031-01-05T10:00:00Z') RETURNING id", [fx.ids.owner]);
  await q("INSERT INTO hr_task_links(task_id,link_kind,link_id,linked_by) VALUES ($1,'lab_order',$2,'Synthetic linker')", [task.id, ids.theirsOrder]);
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("orders", () => {
  it("the daily window keeps open work (remake included) and drops long-delivered orders — legacy and canonical alike", async () => {
    const legacy = (await db.listLabOrders()).map(row => row.id);
    expect(legacy).toEqual(expect.arrayContaining([ids.mineOrder, ids.theirsOrder, ids.remake]));
    expect(legacy).not.toContain(ids.oldDelivered);
    const canonical = await reads.readCanonicalLabOrders(await fx.session("coordinator"), params()) as { orders: { id: number }[] };
    expect(canonical.orders.map(row => row.id).sort()).toEqual([...legacy].sort());
    // A patient filter is a history: its delivered orders are included, as before.
    const history = await reads.readCanonicalLabOrders(await fx.session("coordinator"), params({ patientId: String(ids.theirs) })) as { orders: { id: number }[] };
    expect(history.orders.map(row => row.id)).toContain(ids.oldDelivered);
  });
  it("own scope lists only the clinician's patients (in SQL, before the limit); another patient answers like one without orders", async () => {
    const own = await reads.readCanonicalLabOrders(await fx.session("doctor"), params()) as { orders: { id: number }[] };
    expect(own.orders.map(row => row.id)).toEqual([ids.mineOrder]);
    const outside = await reads.readCanonicalLabOrders(await fx.session("doctor"), params({ patientId: String(ids.theirs) })) as { orders: unknown[] };
    const missing = await reads.readCanonicalLabOrders(await fx.session("doctor"), params({ patientId: "999999" })) as { orders: unknown[] };
    expect([outside.orders, missing.orders]).toEqual([[], []]);
    expect(await reads.readCanonicalLabOrders(await fx.session("doctor"), params({ summary: "1" }))).toMatchObject({ outstanding: 1 });
    expect(await reads.readCanonicalLabOrders(await fx.session("coordinator"), params({ summary: "1" }))).toMatchObject({ outstanding: 2 });
  });
  it("the money group appears only with finance.cost-prices.view; the clinical projection is an allowlist", async () => {
    const clinical = await reads.readCanonicalLabOrders(await fx.session("coordinator"), params()) as unknown as { orders: Record<string, unknown>[]; projection: { costs: boolean } };
    expect(clinical.projection.costs).toBe(false);
    for (const order of clinical.orders) for (const key of MONEY) expect(order).not.toHaveProperty(key);
    expect(JSON.stringify(clinical)).not.toMatch(/:(6000000|50000|120)[,}]/);
    const finance = await reads.readCanonicalLabOrders(await fx.session("finance"), params()) as unknown as { orders: Record<string, unknown>[]; projection: { costs: boolean } };
    expect(finance.projection.costs).toBe(true);
    expect(finance.orders.find(order => order.id === ids.theirsOrder)).toMatchObject({ costMinor: 50000, baseAmountMinor: 6000000 });
    // The owner holds every capability.
    expect((await reads.readCanonicalLabOrders(await fx.session("owner"), params()) as unknown as { projection: { costs: boolean } }).projection.costs).toBe(true);
  });
  it("refuses without the grant or a patient scope, and a malformed patient id", async () => {
    await expect(reads.readCanonicalLabOrders(await fx.session("noLab"), params())).rejects.toThrow("CAPABILITY_DENIED");
    await expect(reads.readCanonicalLabOrders(await fx.session("noScope"), params())).rejects.toThrow(/SCOPE/);
    await expect(reads.readCanonicalLabOrders(await fx.session("coordinator"), params({ patientId: "1e9" }))).rejects.toMatchObject({ code: "invalid_lab_query" });
    await expect(reads.readCanonicalLabOrders(await fx.session("coordinator"), params({ patientId: "99999999999" }))).rejects.toMatchObject({ code: "invalid_lab_query" });
  });
});

describe("backlog", () => {
  it("needs the whole patient scope; tasks only with tasks.use", async () => {
    const withTasks = await reads.readCanonicalLabBacklog(await fx.session("coordinator"), { filter: "all", page: 0 });
    expect(withTasks.counts).toMatchObject({ orders: 3, withLab: 3 });
    expect(withTasks.items.find(item => item.id === ids.theirsOrder)?.tasks.map(task => task.title)).toEqual(["SYN lab follow-up task"]);
    const withoutTasks = await reads.readCanonicalLabBacklog(await fx.session("finance"), { filter: "all", page: 0 });
    expect(withoutTasks.counts).toEqual(withTasks.counts);
    expect(withoutTasks.items.every(item => item.visibleTaskCount === 0 && item.tasks.length === 0)).toBe(true);
    expect(JSON.stringify(withoutTasks)).not.toContain("SYN lab follow-up task");
    await expect(reads.readCanonicalLabBacklog(await fx.session("doctor"), { filter: "all", page: 0 })).rejects.toThrow(/SCOPE/);
    await expect(reads.readCanonicalLabBacklog(await fx.session("noLab"), { filter: "all", page: 0 })).rejects.toThrow("CAPABILITY_DENIED");
  });
  it("matches the legacy admin snapshot for the same data", async () => {
    const legacy = await (await import("../../lib/lab-backlog-db")).readLabBacklog(fx.pool, { filter: "overdue", page: 0 }, db.CLINIC_TIME_ZONE, { role: "admin", userId: fx.ids.owner });
    const canonical = await reads.readCanonicalLabBacklog(await fx.session("owner"), { filter: "overdue", page: 0 });
    expect({ ...canonical, asOf: "" }).toEqual({ ...legacy, asOf: "" });
  });
});
