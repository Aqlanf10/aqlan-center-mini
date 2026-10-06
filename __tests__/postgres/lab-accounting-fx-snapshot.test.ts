import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import type { Currency } from "../../lib/money";

// Guard the original environment before imports or SQL. This suite is for the
// owned PostgreSQL 18 CI database only. It never rewrites historical live data.
validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query<T>(sql, values)).rows;
const id = async (sql: string, values: unknown[] = []) => (await q<{ id: number }>(sql, values))[0].id;
const run = `synthetic-lab-snapshot-${Date.now().toString(36)}`;
let sequence = 0;
beforeAll(async () => { await db.ensureSchema(); }, 180_000);
afterAll(async () => { vi.restoreAllMocks(); await db.resetPoolForTesting(); });

async function fixture(withCost = true) {
  const n = ++sequence;
  const patientId = await id(`INSERT INTO patients(patient_number,full_name)
    VALUES($1,'Synthetic lab snapshot patient') RETURNING id`, [`${run}-${n}`]);
  const partyId = await id(`INSERT INTO parties(name,kind,currency)
    VALUES($1,'lab','YER') RETURNING id`, [`${run}-lab-${n}`]);
  const order = await db.createLabOrder({ patientId, partyId, labName: `${run}-lab-${n}`,
    labPhone: null, workType: "Synthetic crown", details: "Synthetic lab snapshot", note: null,
    sentDate: "2026-10-05", dueDate: "2026-10-12", costMinor: withCost ? 2500 : null,
    costCurrency: withCost ? "USD" : null, baseCurrency: "YER", exchangeRate: 531.125,
    createdBy: "synthetic-lab-snapshot-actor", actorRole: "admin", toothNumbers: "16",
    source: "manual", status: "sent", isPosted: true });
  expect(order).not.toBeNull();
  return order!;
}
async function money(orderId: number) {
  const [order] = await q(`SELECT cost_minor,cost_currency,exchange_rate,base_amount_minor,payable_id
    FROM lab_orders WHERE id=$1`, [orderId]);
  const payable = await q(`SELECT id,amount_minor,currency,exchange_rate,base_amount_minor,base_currency
    FROM payables WHERE lab_order_id=$1 ORDER BY id`, [orderId]);
  return { order, payable };
}
async function exactPair(orderId: number, cost: number, currency: Currency, rate: number, base: number) {
  const value = await money(orderId);
  expect(value.order).toMatchObject({ cost_minor: String(cost), cost_currency: currency,
    base_amount_minor: String(base) });
  expect(value.order.exchange_rate).toBe(rate.toFixed(6));
  expect(value.payable).toEqual([{ id: value.order.payable_id, amount_minor: String(cost), currency,
    exchange_rate: rate.toFixed(6), base_amount_minor: String(base), base_currency: "YER" }]);
  const returned = await db.getLabOrderById(orderId);
  expect(returned).toMatchObject({ costMinor: cost, costCurrency: currency, exchangeRate: rate, baseAmountMinor: base });
}
async function snapshot(orderId: number) {
  return {
    orders: await q("SELECT * FROM lab_orders WHERE id=$1", [orderId]),
    payables: await q("SELECT * FROM payables WHERE lab_order_id=$1 ORDER BY id", [orderId]),
    tracking: await q("SELECT * FROM lab_order_tracking WHERE lab_order_id=$1 ORDER BY id", [orderId]),
  };
}

describe("persisted lab accounting FX snapshot", () => {
  it.each([
    ["USD", 7500, 531.125, 39834], ["SAR", 7500, 141.25, 10594],
    ["YER", 7500, 1, 7500], ["USD", 1, 531.123456, 5],
  ] as const)("updates both rows with exact %s amount/rate/base", async (currency, cost, rate, base) => {
    const order = await fixture();
    await db.updateLabOrderAccounting(order.id, { costMinor: cost, costCurrency: currency,
      exchangeRate: rate, actor: "synthetic-lab-snapshot-actor", actorRole: "admin" });
    await exactPair(order.id, cost, currency, rate, base);
  });
  it("preserves the stored rate for a cost-only edit", async () => {
    const order = await fixture();
    await db.updateLabOrderAccounting(order.id, { costMinor: 7500 });
    await exactPair(order.id, 7500, "USD", 531.125, 39834);
  });
  it("persists rate-only revaluation and survives a following metadata-only update", async () => {
    const order = await fixture();
    await db.updateLabOrderAccounting(order.id, { exchangeRate: 540.123456 });
    await exactPair(order.id, 2500, "USD", 540.123456, 13503);
    const before = await money(order.id);
    await db.updateLabOrderAccounting(order.id, { expenseAccountCode: "5101", isPosted: false });
    expect(await money(order.id)).toEqual(before);
  });
  it("keeps successive USD, SAR and YER edits in the newly chosen denomination", async () => {
    const order = await fixture();
    for (const [currency, rate, base] of [["USD", 540, 40500], ["SAR", 141.25, 10594], ["YER", 1, 7500]] as const) {
      await db.updateLabOrderAccounting(order.id, { costMinor: 7500, costCurrency: currency, exchangeRate: rate });
      await exactPair(order.id, 7500, currency, rate, base);
    }
  });
  it.each([true, false])("metadata-only isPosted=%s preserves both historical snapshots independently", async isPosted => {
    const order = await fixture();
    // Deliberately divergent synthetic legacy snapshots must not be silently
    // corrected by a category/posting operation with no monetary input.
    await q("UPDATE lab_orders SET base_amount_minor=13001 WHERE id=$1", [order.id]);
    await q("UPDATE payables SET base_amount_minor=14002,exchange_rate=560.08 WHERE lab_order_id=$1", [order.id]);
    const before = await money(order.id);
    await db.updateLabOrderAccounting(order.id, { isPosted, expenseAccountCode: "5101", payableAccountCode: "2101" });
    expect(await money(order.id)).toEqual(before);
  });
  it("inserts a missing payable with the same complete money snapshot", async () => {
    const order = await fixture(false);
    await db.updateLabOrderAccounting(order.id, { costMinor: 7500, costCurrency: "SAR", exchangeRate: 141.25 });
    await exactPair(order.id, 7500, "SAR", 141.25, 10594);
  });
  it("retains the existing payable ID and updates FX when the unique order link conflicts", async () => {
    const order = await fixture();
    const before = await money(order.id);
    await q("UPDATE lab_orders SET payable_id=NULL WHERE id=$1", [order.id]);
    await db.updateLabOrderAccounting(order.id, { costMinor: 7500, costCurrency: "SAR", exchangeRate: 141.25 });
    await exactPair(order.id, 7500, "SAR", 141.25, 10594);
    expect((await money(order.id)).order.payable_id).toBe(before.order.payable_id);
  });
  it("metadata-only relinking preserves a conflicting payable's divergent historical snapshot", async () => {
    const order = await fixture();
    const payableId = (await money(order.id)).order.payable_id;
    await q("UPDATE lab_orders SET payable_id=NULL,base_amount_minor=13001 WHERE id=$1", [order.id]);
    await q(`UPDATE payables SET amount_minor=3333,currency='SAR',exchange_rate=140.75,base_amount_minor=4691
      WHERE lab_order_id=$1`, [order.id]);
    const before = await money(order.id);
    await db.updateLabOrderAccounting(order.id, { isPosted: false, expenseAccountCode: "5101" });
    const after = await money(order.id);
    expect(after.payable).toEqual(before.payable);
    expect(after.order).toEqual({ ...before.order, payable_id: payableId });
  });
  it.each([
    { costMinor: 100, exchangeRate: 0.49999999, error: "lab_order_exchange_rate_invalid" },
    { costMinor: 100, exchangeRate: 1.0000004, error: "lab_order_exchange_rate_invalid" },
    { costMinor: 100, exchangeRate: Infinity, error: "lab_order_exchange_rate_invalid" },
    { costMinor: 100, exchangeRate: 1_000_001, error: "lab_order_exchange_rate_invalid" },
    { costMinor: Number.MAX_SAFE_INTEGER + 1, exchangeRate: 1, error: "lab_order_accounting_price_invalid" },
    { costMinor: Number.MAX_SAFE_INTEGER, exchangeRate: 1_000_000, error: "lab_order_accounting_price_invalid" },
    { costMinor: 0.5, exchangeRate: 1, error: "lab_order_accounting_price_invalid" },
  ])("rejects unrepresentable positive money without changing any row: $costMinor at $exchangeRate", async ({ error, ...input }) => {
    const order = await fixture(), before = await snapshot(order.id);
    await expect(db.updateLabOrderAccounting(order.id, input)).rejects.toThrow(error);
    expect(await snapshot(order.id)).toEqual(before);
  });
  it.each([true, false])("rolls back both snapshots and tracking after a late failure, existing payable=%s", async withCost => {
    const order = await fixture(withCost), before = await snapshot(order.id);
    const pool = db.getPool(), connect = pool.connect.bind(pool);
    const fault = new Error("Synthetic late accounting tracking failure");
    const spy = vi.spyOn(pool, "connect").mockImplementation(async () => {
      const client = await connect(), query = client.query.bind(client);
      client.query = async (sql, values) => {
        if (/INSERT INTO lab_order_tracking/.test(sql)) throw fault;
        return query(sql, values);
      };
      return { query: client.query, release: () => { client.query = query; client.release(); } };
    });
    try {
      await expect(db.updateLabOrderAccounting(order.id, { costMinor: 7500, costCurrency: "SAR", exchangeRate: 141.25 }))
        .rejects.toBe(fault);
    } finally { spy.mockRestore(); }
    expect(await snapshot(order.id)).toEqual(before);
  });
});
