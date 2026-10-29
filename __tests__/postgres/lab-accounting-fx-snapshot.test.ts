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
    audit: await q("SELECT * FROM audit_log WHERE entity='lab_order' AND entity_id=$1 AND action='lab_order.accounting' ORDER BY id", [orderId]),
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
  it.each([[true, "lab_order_tracking"], [false, "lab_order_tracking"], [true, "audit_log"], [false, "audit_log"]] as const)("rolls back snapshots and evidence after late failure, existing payable=%s at %s", async (withCost, failTable) => {
    const order = await fixture(withCost), before = await snapshot(order.id);
    const pool = db.getPool(), connect = pool.connect.bind(pool);
    const fault = new Error("Synthetic late accounting tracking failure");
    const spy = vi.spyOn(pool, "connect").mockImplementation(async () => {
      const client = await connect(), query = client.query.bind(client);
      client.query = async (sql, values) => {
        if (new RegExp(`INSERT INTO ${failTable}`).test(sql)) throw fault;
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

describe("lab accounting settlement and period fences", () => {
  it.each(["direct", "allocated"] as const)("preserves all rows after %s partial settlement", async kind => {
    const order = await fixture();
    const shiftId = await id("INSERT INTO cashier_shifts(opened_by,status) VALUES($1,'closed') RETURNING id", [run]);
    const expenseId = await id(`INSERT INTO expenses(voucher_number,category,party_id,shift_id,amount_minor,currency,
      exchange_rate,base_amount_minor,base_currency,payable_id,payable_currency,payable_amount_minor,
      payable_exchange_rate,payable_settled_minor,created_by)
      VALUES($1,'lab',$2,$3,100,'USD',531.125,531,'YER',$4,$5,$6,$7,$8,$9) RETURNING id`,
      [`${run}-paid-${sequence}`, order.partyId, shiftId, kind === "direct" ? order.payableId : null,
        kind === "direct" ? "USD" : null, kind === "direct" ? 2500 : null,
        kind === "direct" ? 531.125 : null, kind === "direct" ? 100 : null, run]);
    if (kind === "allocated") await q(`INSERT INTO expense_payable_allocations
      (expense_id,payable_id,paid_minor,payable_currency,payable_exchange_rate,settled_minor)
      VALUES($1,$2,100,'USD',531.125,100)`, [expenseId, order.payableId]);
    const before = await snapshot(order.id);
    for (const input of [{ costMinor: 3000 }, { costCurrency: "SAR" as const }, { isPosted: false }, { expenseAccountCode: "5102" }]) {
      await expect(db.updateLabOrderAccounting(order.id, input)).rejects.toThrow("lab_order_accounting_settled");
      expect(await snapshot(order.id)).toEqual(before);
    }
  });
  it("does not wait on a concurrent payment's payable lock", async () => {
    const order = await fixture(), before = await snapshot(order.id);
    const holder = await db.getPool().connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM payables WHERE id=$1 FOR UPDATE", [order.payableId]);
      await expect(db.updateLabOrderAccounting(order.id, { costMinor: 3000 })).rejects.toThrow("lab_order_accounting_busy");
    } finally { await holder.query("ROLLBACK"); holder.release(); }
    expect(await snapshot(order.id)).toEqual(before);
  });
  it("fences a concurrent close-setting write even when the setting was absent", async () => {
    const order = await fixture(), before = await snapshot(order.id);
    const holder = await db.getPool().connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`INSERT INTO settings(key,value) VALUES('finance.locked_before','2099-01-01')
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
      await expect(db.updateLabOrderAccounting(order.id, { costMinor: 3000 })).rejects.toThrow("lab_order_accounting_busy");
    } finally { await holder.query("ROLLBACK"); holder.release(); }
    expect(await snapshot(order.id)).toEqual(before);
  });
  it("blocks a closed-period change but keeps a paid exact no-op byte-for-byte", async () => {
    const order = await fixture();
    const previous = await q<{ value: string }>("SELECT value FROM settings WHERE key='finance.locked_before'");
    try {
      await q(`INSERT INTO settings(key,value) VALUES('finance.locked_before','2099-01-01')
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
      const before = await snapshot(order.id);
      await expect(db.updateLabOrderAccounting(order.id, { costMinor: 3000 })).rejects.toThrow("lab_order_accounting_period_locked");
      expect(await snapshot(order.id)).toEqual(before);
      await q("UPDATE lab_orders SET financial_status='paid' WHERE id=$1", [order.id]);
      const paid = await snapshot(order.id);
      await db.updateLabOrderAccounting(order.id, {});
      expect(await snapshot(order.id)).toEqual(paid);
    } finally {
      if (previous.length) await q("UPDATE settings SET value=$1 WHERE key='finance.locked_before'", [previous[0].value]);
      else await q("DELETE FROM settings WHERE key='finance.locked_before'");
    }
  });
});


it.each(["structural", "legacy"] as const)("blocks reversed %s batch tracking without a payable allocation", async link => {
  const order = await fixture();
  const shiftId = await id("INSERT INTO cashier_shifts(opened_by,status) VALUES($1,'closed') RETURNING id", [run]);
  const voucher = `${run}-legacy-${sequence}`;
  const expenseId = await id(`INSERT INTO expenses(voucher_number,category,party_id,shift_id,amount_minor,currency,
    exchange_rate,base_amount_minor,base_currency,created_by)
    VALUES($1,'lab',$2,$3,100,'USD',531.125,531,'YER',$4) RETURNING id`, [voucher, order.partyId, shiftId, run]);
  await q(`INSERT INTO lab_order_tracking(lab_order_id,action,notes,actor,expense_id)
    VALUES($1,'financial_settlement',$2,$3,$4)`,
    [order.id, `تمت التسوية المالية المجمعة بسند صرف رقم ${voucher} بمبلغ 100 USD`, run, link === "structural" ? expenseId : null]);
  await q(`INSERT INTO lab_order_tracking(lab_order_id,action,notes,actor)
    VALUES($1,'financial_settlement_reversed','Synthetic historical reversal',$2)`, [order.id, run]);
  // Historical reversal reopens the marker without erasing original batch history.
  await q("UPDATE lab_orders SET financial_status='payable_created' WHERE id=$1", [order.id]);
  const before = await snapshot(order.id);
  await expect(db.updateLabOrderAccounting(order.id, { costMinor: 3000 })).rejects.toThrow("lab_order_accounting_settled");
  expect(await snapshot(order.id)).toEqual(before);
});
