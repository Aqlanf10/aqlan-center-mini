import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import type { DbClient, QueryResult } from "../../lib/db";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";

/**
 * TEST-ONLY successor, authored and NOT EXECUTED. The original 15 cases below
 * retain the executed baseline assertions (35 pass / 9 desired-red across44).
 * Original source and run evidence remain frozen in lab-batch-red-baseline-0049.
 * Run only through the unchanged vitest.config.postgres.mts / _global-setup.ts
 * PG18 harness against an explicitly authorized disposable synthetic database.
 *
 * Reference source: Aqlanf10/aqlan-center-mini@5ec284eaee54ab04ad478d3a31588d93aeefd656
 * (tree 6fa3edf05c0b362d0f137ef5cd437a0773ed2499). In particular the CASE22 fixture
 * is preserved from __tests__/postgres/supplier-payable-overpayment.test.ts:466-475:
 * https://github.com/Aqlanf10/aqlan-center-mini/blob/5ec284eaee54ab04ad478d3a31588d93aeefd656/__tests__/postgres/supplier-payable-overpayment.test.ts#L466-L475
 * The frozen original is NOT edited, copied over, skipped, or weakened.
 *
 * New expected behavior follows lab-batch-containment-design-0020/FIRST_SLICE.md.
 * This focused baseline is NOT the complete containment release matrix: remaining
 * identity/history/overflow/rollback/lock-order and route gates are separate work.
 * Expected source-predicted baseline: 9 red cases and 6 passing control cases.
 * A failed setup/typecheck/timeout is NOT a reproduced monetary defect.
 */
const originalEnvironment = { ...process.env };
assertRealPostgresUrl();
const target = validatePostgresTestTarget(originalEnvironment, { allowDatabaseUrlFallback: true });
stubPostgresEnv();
const db = await import("../../lib/db");

type Currency = "YER" | "SAR" | "USD";
type BatchResult = Awaited<ReturnType<typeof db.settleLabOrdersBatch>>;
type BatchSuccess = Extract<BatchResult, { ok: true }>;
type Refusal = "batch_requires_full_allocation" | "batch_link_invalid"
  | "batch_currency_mismatch" | "orders_already_paid" | "batch_busy" | "no_shift";
const ACTOR = "synthetic-lab-full-allocation";
const RATES = { YER: 1, SAR: 140, USD: 535 } as const;
const PREPAYMENT_REASON = "Synthetic explicit prepayment must not bypass selection validation";

async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await db.getPool().query<T>(sql, values)).rows;
}

async function lab(): Promise<number> {
  const [row] = await q<{ id: number }>(
    "INSERT INTO parties (name, kind) VALUES ('Synthetic full-allocation lab', 'lab') RETURNING id",
  );
  return row.id;
}

type Order = { id: number; payableId: number; amount: number; currency: Currency };

/** Real payable writer; only the clinical order/link scaffolding uses fixture SQL. */
async function order(partyId: number, amount = 10_000, currency: Currency = "YER"): Promise<Order> {
  const [patient] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name)
     VALUES ('LBFA-' || nextval('patients_id_seq'), 'Synthetic lab patient') RETURNING id`,
  );
  const [created] = await q<{ id: number }>(
    `INSERT INTO lab_orders
       (patient_id, lab_name, work_type, due_date, status, party_id, cost_minor, cost_currency, financial_status)
     VALUES ($1, 'Synthetic full-allocation lab', 'Synthetic crown', CURRENT_DATE, 'delivered',
             $2, $3, $4, 'payable_created') RETURNING id`,
    [patient.id, partyId, amount, currency],
  );
  const payable = await db.createPayable({
    partyId, category: "lab", description: `Synthetic RX-${created.id}`, amountMinor: amount,
    currency, baseCurrency: "YER", exchangeRate: RATES[currency], labOrderId: created.id,
    dueDate: null, createdBy: ACTOR,
  });
  expect(payable).not.toBeNull();
  await q("UPDATE lab_orders SET payable_id = $1 WHERE id = $2", [payable!.id, created.id]);
  return { id: created.id, payableId: payable!.id, amount, currency };
}

function batch(partyId: number, orderIds: number[], amount: number, currency: Currency = "YER",
  prepaymentReason: string | null = null) {
  return db.settleLabOrdersBatch({
    partyId, orderIds, amountMinor: amount, currency, baseCurrency: "YER", exchangeRate: RATES[currency],
    rates: RATES, note: null, createdBy: ACTOR, actorRole: "admin", prepaymentReason,
  });
}

function direct(partyId: number, selected: Order, amount: number) {
  return db.recordExpense({
    category: "lab", partyId, payeeText: null, payableId: selected.payableId, amountMinor: amount,
    currency: selected.currency, baseCurrency: "YER", exchangeRate: RATES[selected.currency],
    rates: RATES, note: "Synthetic actual direct payment", createdBy: ACTOR,
  });
}

async function canonical(partyId: number) {
  const statement = await db.partyStatement(partyId);
  const due = (await db.partyDueByCurrency()).filter((row) => row.partyId === partyId)
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return { statement, due };
}

/** Full persisted-row witnesses, including unrelated fixture rows. No sequences:
 * rolled-back inserts are allowed to consume an ID or document number. */
async function snapshot(partyId: number) {
  return {
    expenses: await q("SELECT * FROM expenses ORDER BY id"),
    allocations: await q("SELECT * FROM expense_payable_allocations ORDER BY id"),
    orders: await q("SELECT * FROM lab_orders ORDER BY id"),
    tracking: await q("SELECT * FROM lab_order_tracking ORDER BY id"),
    payables: await q("SELECT * FROM payables ORDER BY id"),
    shifts: await q("SELECT * FROM cashier_shifts ORDER BY id"),
    audit: await q("SELECT * FROM audit_log ORDER BY id"),
    canonical: await canonical(partyId),
  };
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

async function unchangedRefusal(partyId: number, action: () => Promise<BatchResult>, reason: Refusal) {
  const before = await snapshot(partyId);
  const result = await action();
  const after = await snapshot(partyId);
  // Soft checks retain the monetary witnesses even when old code returns success.
  expect.soft(result).toMatchObject({ ok: false, reason, quote: null });
  expect.soft(after, "Refusal must leave persisted financial/order/tracking state identical").toEqual(before);
  return { before, after, result };
}

function remaining(state: Snapshot["canonical"], selected: Order): number | undefined {
  return state.statement.payables.find((payable) => payable.id === selected.payableId)?.remainingMinor;
}

function due(state: Snapshot["canonical"], currency: Currency): number {
  return state.due.find((row) => row.currency === currency)?.dueMinor ?? 0;
}

function success(result: BatchResult): asserts result is BatchSuccess {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected full-selection success, got ${result.reason}`);
}

type AllocationRow = {
  expense_id: number; payable_id: number; paid_minor: string; payable_currency: Currency;
  payable_exchange_rate: string; settled_minor: string;
};
async function allocations(expenseId: number) {
  return q<AllocationRow>(
    `SELECT expense_id, payable_id, paid_minor, payable_currency, payable_exchange_rate, settled_minor
       FROM expense_payable_allocations WHERE expense_id = $1 ORDER BY payable_id`, [expenseId],
  );
}

async function fullAllocation(result: BatchSuccess, selected: { order: Order; remainder: number }[]) {
  const rows = await allocations(result.expense.id);
  expect(rows).toEqual([...selected].sort((a, b) => a.order.payableId - b.order.payableId).map((item) => ({
    expense_id: result.expense.id, payable_id: item.order.payableId,
    paid_minor: String(item.remainder), settled_minor: String(item.remainder),
    payable_currency: item.order.currency, payable_exchange_rate: RATES[item.order.currency].toFixed(6),
  })));
  expect(rows.reduce((sum, row) => sum + Number(row.paid_minor), 0)).toBe(result.expense.amountMinor);
  const selectedIds = selected.map((item) => item.order.id).sort((a, b) => a - b);
  expect(result.orderIds).toEqual(selectedIds);
  expect(await q("SELECT id, financial_status FROM lab_orders WHERE id = ANY($1::int[]) ORDER BY id", [selectedIds]))
    .toEqual(selectedIds.map((id) => ({ id, financial_status: "paid" })));
  expect(await q(
    `SELECT lab_order_id, action, expense_id FROM lab_order_tracking WHERE expense_id = $1 ORDER BY lab_order_id`,
    [result.expense.id],
  )).toEqual(selectedIds.map((id) => ({ lab_order_id: id, action: "financial_settlement", expense_id: result.expense.id })));
}

beforeAll(async () => {
  // Existing PG suite lifecycle, guarded using the ORIGINAL environment before
  // stubPostgresEnv removes Railway markers. Never select a production target.
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
}, 180_000);

beforeEach(async () => {
  // Existing isolated-PG reset pattern; do not disable append-only/FK guards.
  await q(`TRUNCATE expense_payable_allocations, expenses, payables, lab_order_tracking, lab_orders,
                    patients, cashier_shifts, parties, audit_log RESTART IDENTITY CASCADE`);
  await q("INSERT INTO cashier_shifts (opened_by) VALUES ($1)", [ACTOR]);
});

afterAll(async () => { await db.resetPoolForTesting(); });

describe("desired full-allocation refusals: source-predicted RED on unchanged batch writer", () => {
  it("RED CASE22: two 10,000 payables and the original 15,000 request refuse without any mutation", async () => {
    const partyId = await lab();
    const a = await order(partyId, 10_000);
    const b = await order(partyId, 10_000);
    const { after } = await unchangedRefusal(partyId, () => batch(partyId, [a.id, b.id], 15_000),
      "batch_requires_full_allocation");
    // Retain the original CASE22's two monetary and allocation-count oracles.
    // The old 0 / 5,000 / 2 expectations become 10,000 / 10,000 / 0 on refusal.
    expect.soft(remaining(after.canonical, a)).toBe(10_000);
    expect.soft(remaining(after.canonical, b)).toBe(10_000);
    expect.soft(after.allocations).toHaveLength(0);
    expect.soft(after.expenses).toHaveLength(0);
    expect.soft(after.tracking).toHaveLength(0);
    expect.soft(after.orders.map((row) => row.financial_status)).toEqual(["payable_created", "payable_created"]);
    expect.soft(due(after.canonical, "YER")).toBe(20_000);
  });

  it.each([null, PREPAYMENT_REASON])("RED excess: unselected SAME-lab debt cannot absorb a selected excess (reason %s)",
    async (prepaymentReason) => {
      const partyId = await lab();
      const selected = await order(partyId, 10_000);
      const unselected = await order(partyId, 20_000);
      const prior = await direct(partyId, selected, 6_000);
      expect(prior.reason).toBeNull();
      expect(prior.expense).not.toBeNull();
      const state = await canonical(partyId);
      expect(remaining(state, selected)).toBe(4_000);
      expect(due(state, "YER")).toBe(24_000); // Old 10,000 request passes the whole-party guard.
      const { after } = await unchangedRefusal(partyId,
        () => batch(partyId, [selected.id], 10_000, "YER", prepaymentReason), "batch_requires_full_allocation");
      expect.soft(remaining(after.canonical, selected)).toBe(4_000);
      expect.soft(remaining(after.canonical, unselected)).toBe(20_000);
      expect.soft(after.expenses).toHaveLength(1);
      expect.soft(after.allocations).toHaveLength(0);
      expect.soft(after.tracking).toHaveLength(0);
      expect.soft(due(after.canonical, "YER")).toBe(24_000);
    });

  it.each([null, PREPAYMENT_REASON])("RED unlinked: a null forward pointer cannot be skipped or inferred (reason %s)",
    async (prepaymentReason) => {
      const partyId = await lab();
      const linked = await order(partyId, 10_000);
      const unlinked = await order(partyId, 10_000);
      const unselected = await order(partyId, 20_000);
      // Legal legacy asymmetry: keep the real reverse-linked payable; never
      // disable an FK or invent a nonexistent non-null forward pointer.
      await q("UPDATE lab_orders SET payable_id = NULL WHERE id = $1", [unlinked.id]);
      const { after } = await unchangedRefusal(partyId,
        () => batch(partyId, [linked.id, unlinked.id], 20_000, "YER", prepaymentReason), "batch_link_invalid");
      expect.soft(remaining(after.canonical, linked)).toBe(10_000);
      expect.soft(remaining(after.canonical, unlinked)).toBe(10_000);
      expect.soft(remaining(after.canonical, unselected)).toBe(20_000);
      expect.soft(after.orders.find((row) => row.id === unlinked.id)?.payable_id).toBeNull();
      expect.soft(due(after.canonical, "YER")).toBe(40_000);
    });

  it("RED identity: a same-party payable with another order's backlink is refused", async () => {
    const partyId = await lab();
    const selected = await order(partyId, 10_000);
    const other = await order(partyId, 10_000);
    // Both legal payables keep distinct UNIQUE backlinks. Only the selected
    // order's forward pointer becomes nonreciprocal; no constraint is weakened.
    await q("UPDATE lab_orders SET payable_id = $1 WHERE id = $2", [other.payableId, selected.id]);
    const { after } = await unchangedRefusal(partyId, () => batch(partyId, [selected.id], 10_000),
      "batch_link_invalid");
    expect.soft(remaining(after.canonical, selected)).toBe(10_000);
    expect.soft(remaining(after.canonical, other)).toBe(10_000);
    expect.soft(due(after.canonical, "YER")).toBe(20_000);
  });

  it("RED currency: mixed selected YER/USD refuses even with a written prepayment reason", async () => {
    const partyId = await lab();
    const yer = await order(partyId, 10_000, "YER");
    const usd = await order(partyId, 10_000, "USD");
    // 10,000 YER + 100 USD at 535 = 63,500 YER; old conversion path accepts.
    const { after } = await unchangedRefusal(partyId,
      () => batch(partyId, [yer.id, usd.id], 63_500, "YER", PREPAYMENT_REASON), "batch_currency_mismatch");
    expect.soft(remaining(after.canonical, yer)).toBe(10_000);
    expect.soft(remaining(after.canonical, usd)).toBe(10_000);
    expect.soft(due(after.canonical, "YER")).toBe(10_000);
    expect.soft(due(after.canonical, "USD")).toBe(10_000);
  });

  it("RED currency: homogeneous USD debts paid in YER are outside the full same-currency contract", async () => {
    const partyId = await lab();
    const usd = await order(partyId, 10_000, "USD");
    const { after } = await unchangedRefusal(partyId, () => batch(partyId, [usd.id], 53_500, "YER"),
      "batch_currency_mismatch");
    expect.soft(remaining(after.canonical, usd)).toBe(10_000);
    expect.soft(due(after.canonical, "USD")).toBe(10_000);
    expect.soft(due(after.canonical, "YER")).toBe(0);
  });
});

describe("unchanged monetary controls: expected GREEN on old and contained writers", () => {
  it.each(["YER", "SAR", "USD"] as const)("CONTROL exact full %s settlement allocates once and leaves unselected debt unchanged", async (currency) => {
    const partyId = await lab();
    const a = await order(partyId, 10_000, currency);
    const b = await order(partyId, 10_000, currency);
    const unselected = await order(partyId, 7_000, currency);
    const before = await snapshot(partyId);
    const paid = await batch(partyId, [a.id, b.id], 20_000, currency);
    success(paid);
    expect(paid.expense).toMatchObject({ amountMinor: 20_000, currency, payableId: null,
      exchangeRate: RATES[currency], baseAmountMinor: currency === "YER" ? 20_000 : 200 * RATES[currency] });
    await fullAllocation(paid, [{ order: a, remainder: 10_000 }, { order: b, remainder: 10_000 }]);
    const after = await snapshot(partyId);
    expect(after.expenses).toHaveLength(1);
    expect(after.allocations).toHaveLength(2);
    expect(after.tracking).toHaveLength(2);
    expect(after.payables).toEqual(before.payables);
    expect(after.orders.find((row) => row.id === unselected.id)).toEqual(before.orders.find((row) => row.id === unselected.id));
    expect(remaining(after.canonical, a)).toBe(0);
    expect(remaining(after.canonical, b)).toBe(0);
    expect(remaining(after.canonical, unselected)).toBe(7_000);
    expect(after.canonical.statement.totals).toMatchObject([
      { currency, owedMinor: 27_000, settledMinor: 20_000, remainingMinor: 7_000, paidMinor: 20_000 },
    ]);
    expect(due(after.canonical, currency)).toBe(7_000); // No double-subtraction of batch allocations.
  });

  it("CONTROL prior direct-partial settlement admits exactly its current remainder", async () => {
    const partyId = await lab();
    const selected = await order(partyId, 10_000);
    const unselected = await order(partyId, 20_000);
    const prior = await direct(partyId, selected, 6_000);
    expect(prior.reason).toBeNull();
    expect(prior.expense).not.toBeNull();
    const before = await snapshot(partyId);
    expect(remaining(before.canonical, selected)).toBe(4_000);
    const paid = await batch(partyId, [selected.id], 4_000);
    success(paid);
    await fullAllocation(paid, [{ order: selected, remainder: 4_000 }]);
    const after = await snapshot(partyId);
    expect(after.expenses).toHaveLength(2);
    expect(after.expenses.find((row) => row.id === prior.expense!.id)).toEqual(before.expenses[0]);
    expect(after.orders.find((row) => row.id === unselected.id)).toEqual(before.orders.find((row) => row.id === unselected.id));
    expect(remaining(after.canonical, selected)).toBe(0);
    expect(remaining(after.canonical, unselected)).toBe(20_000);
    expect(due(after.canonical, "YER")).toBe(20_000);
    expect(after.canonical.statement.totals).toMatchObject([
      { currency: "YER", owedMinor: 30_000, settledMinor: 10_000, remainingMinor: 20_000, paidMinor: 10_000 },
    ]);
  });

  it("CONTROL duplicate/permuted IDs allocate once; retry and direct re-payment make no second financial effect", async () => {
    const partyId = await lab();
    const a = await order(partyId);
    const b = await order(partyId);
    const ids = [b.id, a.id, b.id, a.id];
    const paid = await batch(partyId, ids, 20_000);
    success(paid);
    await fullAllocation(paid, [{ order: a, remainder: 10_000 }, { order: b, remainder: 10_000 }]);
    const { after } = await unchangedRefusal(partyId, () => batch(partyId, ids, 20_000), "orders_already_paid");
    expect(after.expenses).toHaveLength(1);
    expect(after.allocations).toHaveLength(2);
    expect(after.tracking).toHaveLength(2);
    expect(due(after.canonical, "YER")).toBe(0);
    expect(await direct(partyId, a, 10_000)).toMatchObject({ expense: null, reason: "exceeds_payable" });
    expect(await snapshot(partyId)).toEqual(after);
  });

  it("CONTROL full USD batch reversal restores saved remainders and tracked markers without changing original rows", async () => {
    const partyId = await lab();
    const a = await order(partyId, 10_000, "USD");
    const b = await order(partyId, 10_000, "USD");
    const unselected = await order(partyId, 7_000, "USD");
    const initial = await snapshot(partyId);
    const paid = await batch(partyId, [a.id, b.id], 20_000, "USD");
    success(paid);
    await fullAllocation(paid, [{ order: a, remainder: 10_000 }, { order: b, remainder: 10_000 }]);
    const saved = await snapshot(partyId);
    const voided = await db.voidExpense(paid.expense.id, { actor: ACTOR, actorRole: "admin", reason: "Synthetic correction" });
    expect(voided).toMatchObject({ ok: true, reopenedLabOrderIds: [a.id, b.id] });
    const after = await snapshot(partyId);
    expect(after.expenses).toHaveLength(2);
    expect(after.expenses.find((row) => row.id === paid.expense.id)).toEqual(saved.expenses[0]);
    expect(after.allocations.filter((row) => row.expense_id === paid.expense.id)).toEqual(saved.allocations);
    expect(after.expenses.find((row) => row.id === voided.voidedId)).toMatchObject({
      reversal_of_id: paid.expense.id, amount_minor: "-20000", currency: "USD", exchange_rate: "535.000000",
      base_amount_minor: "-107000",
    });
    expect(await allocations(voided.voidedId!)).toEqual([a, b].map((item) => ({
      expense_id: voided.voidedId, payable_id: item.payableId, paid_minor: "-10000", settled_minor: "-10000",
      payable_currency: "USD", payable_exchange_rate: "535.000000",
    })));
    expect(after.orders).toEqual(initial.orders);
    expect(after.payables).toEqual(initial.payables);
    expect(after.tracking.filter((row) => row.expense_id === paid.expense.id)).toEqual(saved.tracking);
    expect(after.tracking.filter((row) => row.expense_id === voided.voidedId).map((row) => row.action))
      .toEqual(["financial_settlement_reversed", "financial_settlement_reversed"]);
    expect(remaining(after.canonical, a)).toBe(10_000);
    expect(remaining(after.canonical, b)).toBe(10_000);
    expect(remaining(after.canonical, unselected)).toBe(7_000);
    expect(due(after.canonical, "USD")).toBe(27_000);
    expect(after.canonical.statement.totals).toMatchObject([
      { currency: "USD", owedMinor: 27_000, settledMinor: 0, remainingMinor: 27_000, paidMinor: 0 },
    ]);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out at synthetic barrier: ${label}`)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

type Outcome<T> = { status: "resolved"; value: T } | { status: "rejected"; error: unknown };
function observe<T>(promise: Promise<T>) {
  const state: { outcome?: Outcome<T> } = {};
  // Record rejections for explicit assertion; never suppress runtime/global errors.
  const settled = promise.then(
    (value): Outcome<T> => (state.outcome = { status: "resolved", value }),
    (error: unknown): Outcome<T> => (state.outcome = { status: "rejected", error }),
  );
  return { state, settled };
}

/** Test-only scheduling wrapper: every application statement runs unchanged on
 * its real transaction client. The next connection alone is wrapped; restore the
 * spy before starting the other operation. No writer or monetary SQL is mocked. */
function pauseNextTransaction(afterSql: RegExp) {
  const connected = deferred();
  const paused = deferred();
  const release = deferred();
  let pid = 0;
  let stopped = false;
  const pool = db.getPool();
  const connect = pool.connect.bind(pool);
  const spy = vi.spyOn(pool, "connect").mockImplementationOnce(async () => {
    const client = await connect();
    try {
      pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    } catch (error) { client.release(); throw error; }
    connected.resolve();
    const query = client.query.bind(client);
    const wrapper: DbClient = {
      async query<T>(sql: string, values?: unknown[]): Promise<QueryResult<T>> {
        const result = await query<T>(sql, values);
        if (/^BEGIN\s*;?$/i.test(sql.trim())) {
          await query("SET LOCAL statement_timeout = '10s'");
          await query("SET LOCAL lock_timeout = '10s'");
        }
        if (!stopped && afterSql.test(sql)) {
          stopped = true;
          paused.resolve();
          await bounded(release.promise, "release actual transaction");
        }
        return result;
      },
      release: () => client.release(),
    };
    return wrapper;
  });
  return { connected, paused, release, spy, pid: () => pid };
}

async function waitForPartyWaiter(observer: Client, blockedPid: number, ownerPid: number,
  outcome: () => Outcome<BatchResult> | undefined) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (outcome()) throw new Error("Batch ended before its required observable party-lock wait");
    const { rows } = await observer.query<{ blocked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE pid = $1 AND datname = current_database() AND wait_event_type = 'Lock'
          AND query ~* 'FROM[[:space:]]+parties' AND $2::int = ANY(pg_blocking_pids(pid))) AS blocked`,
      [blockedPid, ownerPid],
    );
    if (rows[0].blocked) return;
    // Yield for real query progress; never infer ordering from a sleep duration.
    await new Promise<void>((done) => setImmediate(done));
  }
  throw new Error("Did not observe the exact batch backend waiting for the actual direct writer's party lock");
}

it("RED fresh projection: real direct payment wins; waiting stale-full batch cannot consume unselected SAME-lab debt", async () => {
  const partyId = await lab();
  const selected = await order(partyId, 10_000);
  const unselected = await order(partyId, 20_000);
  const observer = new Client({ connectionString: target.testUrl.toString(), ssl: false, statement_timeout: 5_000 });
  await observer.connect();
  const directHook = pauseNextTransaction(/INSERT\s+INTO\s+expenses\s*\(/i);
  let batchHook: ReturnType<typeof pauseNextTransaction> | undefined;
  const paying = observe(direct(partyId, selected, 6_000));
  let settling: ReturnType<typeof observe<BatchResult>> | undefined;
  let directOnly: Snapshot | undefined;
  try {
    await bounded(Promise.race([
      directHook.paused.promise,
      paying.settled.then((outcome) => { throw new Error(`Direct writer missed insertion barrier: ${JSON.stringify(outcome)}`); }),
    ]), "direct writer inserted while holding party");
    directHook.spy.mockRestore();
    batchHook = pauseNextTransaction(/FROM\s+parties\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i);
    settling = observe(batch(partyId, [selected.id], 10_000));
    await bounded(batchHook.connected.promise, "batch connection");
    await waitForPartyWaiter(observer, batchHook.pid(), directHook.pid(), () => settling!.state.outcome);
    expect(settling.state.outcome).toBeUndefined();
    directHook.release.resolve();
    const written = await bounded(paying.settled, "actual direct commit");
    expect(written).toMatchObject({ status: "resolved", value: { reason: null, expense: { amountMinor: 6_000 } } });
    await bounded(Promise.race([
      batchHook.paused.promise,
      settling.settled.then((outcome) => { throw new Error(`Batch missed post-lock barrier: ${JSON.stringify(outcome)}`); }),
    ]), "batch acquired party after direct commit");
    batchHook.spy.mockRestore();
    // Batch now owns the party but has not projected selected remainders. This
    // committed direct-only baseline proves any subsequent batch refusal writes
    // nothing; a before-race snapshot would wrongly include the intended direct.
    directOnly = await snapshot(partyId);
    expect(directOnly.expenses).toHaveLength(1);
    expect(directOnly.allocations).toHaveLength(0);
    expect(directOnly.tracking).toHaveLength(0);
    expect(remaining(directOnly.canonical, selected)).toBe(4_000);
    expect(remaining(directOnly.canonical, unselected)).toBe(20_000);
    expect(due(directOnly.canonical, "YER")).toBe(24_000);
    batchHook.release.resolve();
    await bounded(settling.settled, "batch terminal result");
  } finally {
    // Always release both barriers and restore pool.connect, including assertions
    // and early failures. Observed operations retain their errors for assertions.
    directHook.release.resolve();
    batchHook?.release.resolve();
    batchHook?.spy.mockRestore();
    directHook.spy.mockRestore();
    try {
      await bounded(Promise.all([paying.settled, ...(settling ? [settling.settled] : [])]), "drain actual writers", 15_000);
    } finally { await observer.end(); }
  }
  const after = await snapshot(partyId);
  expect.soft(settling!.state.outcome).toMatchObject({ status: "resolved", value: {
    ok: false, reason: "batch_requires_full_allocation", quote: null,
  } });
  expect.soft(after).toEqual(directOnly);
  expect.soft(after.expenses).toHaveLength(1);
  expect.soft(after.allocations).toHaveLength(0);
  expect.soft(after.tracking).toHaveLength(0);
  expect.soft(remaining(after.canonical, selected)).toBe(4_000);
  expect.soft(remaining(after.canonical, unselected)).toBe(20_000);
  expect.soft(due(after.canonical, "YER")).toBe(24_000);
}, 40_000);

// Successor coverage: additions only below this line. AUTHORED, NOT EXECUTED.
// Raw witnesses are needed for malformed stored values which canonical readers
// intentionally cannot decode. Ordinary fixtures still use snapshot()/canonical().
async function rawSnapshot() {
  return {
    expenses: await q("SELECT * FROM expenses ORDER BY id"),
    allocations: await q("SELECT * FROM expense_payable_allocations ORDER BY id"),
    orders: await q("SELECT * FROM lab_orders ORDER BY id"),
    tracking: await q("SELECT * FROM lab_order_tracking ORDER BY id"),
    payables: await q("SELECT * FROM payables ORDER BY id"),
    shifts: await q("SELECT * FROM cashier_shifts ORDER BY id"),
    audit: await q("SELECT * FROM audit_log ORDER BY id"),
    adjustments: await q("SELECT * FROM payable_adjustments ORDER BY id"),
    advances: await q("SELECT * FROM party_opening_advances ORDER BY id"),
  };
}

/** Schema-permitted historical row; guards/FKs remain enabled. */
async function historicalExpense(partyId: number | null, selected: Order | null,
  amount: number | string, settled: number | string = amount, reversalOf: number | null = null) {
  const [row] = await q<{ id: number }>(
    `INSERT INTO expenses (voucher_number, category, party_id, shift_id, amount_minor, currency,
      exchange_rate, base_amount_minor, base_currency, payable_id, payable_currency,
      payable_amount_minor, payable_exchange_rate, payable_settled_minor, reversal_of_id, created_by)
     SELECT 'LB-H-' || nextval('voucher_number_seq'), 'lab', $1, id, $2, 'YER', 1, $2,
      'YER', $3, $4, $5, $6, $7, $8, $9 FROM cashier_shifts WHERE status = 'open' RETURNING id`,
    [partyId, amount, selected?.payableId ?? null, selected ? 'YER' : null,
      selected?.amount ?? null, selected ? 1 : null, selected ? settled : null, reversalOf, ACTOR],
  );
  return row.id;
}

async function rawRefusal(action: () => Promise<BatchResult>, reason: Refusal) {
  const before = await rawSnapshot();
  const outcome = await observe(action()).settled;
  expect.soft(outcome).toMatchObject({ status: "resolved", value: { ok: false, reason, quote: null } });
  expect.soft(await rawSnapshot()).toEqual(before);
}

describe("successor: reciprocal identity, history and safe arithmetic", () => {
  it.each(["duplicate", "foreign", "null-backlink", "opening"] as const)("refuses %s payable attribution atomically", async (kind) => {
    const partyId = await lab();
    const a = await order(partyId);
    const b = await order(partyId);
    let ids = [a.id];
    if (kind === "duplicate") {
      await q("UPDATE lab_orders SET payable_id = $1 WHERE id = $2", [a.payableId, b.id]);
      ids = [a.id, b.id];
    } else if (kind === "foreign") {
      const foreign = await order(await lab());
      await q("UPDATE lab_orders SET payable_id = $1 WHERE id = $2", [foreign.payableId, a.id]);
    } else if (kind === "null-backlink") {
      await q("UPDATE payables SET lab_order_id = NULL WHERE id = $1", [a.payableId]);
    } else {
      const [opening] = await q<{ id: number }>(
        `INSERT INTO payables (party_id, category, description, amount_minor, currency, exchange_rate,
          base_amount_minor, base_currency, source_type, as_of_date, opening_reason)
         VALUES ($1, 'lab', 'Synthetic opening', 10000, 'YER', 1, 10000, 'YER',
          'opening', CURRENT_DATE, 'Synthetic opening fixture') RETURNING id`, [partyId]);
      await q("INSERT INTO payable_adjustments (payable_id, delta_minor, reason, created_by) VALUES ($1, 2000, 'Synthetic adjustment', $2)", [opening.id, ACTOR]);
      await q("UPDATE lab_orders SET payable_id = $1 WHERE id = $2", [opening.id, a.id]);
    }
    await unchangedRefusal(partyId, () => batch(partyId, ids, ids.length * 10_000, "YER", PREPAYMENT_REASON), "batch_link_invalid");
  });

  it.each(["null", "foreign", "null-reversed", "foreign-reversed"] as const)("refuses %s directly linked history even when signed total is zero", async (kind) => {
    const partyId = await lab();
    const selected = await order(partyId);
    const other = await order(partyId, 20_000);
    const attributedParty = kind.startsWith("null") ? null : await lab();
    const oldId = await historicalExpense(attributedParty, selected, 2_000);
    if (kind.endsWith("reversed")) await historicalExpense(attributedParty, selected, -2_000, -2_000, oldId);
    const before = await snapshot(partyId);
    const left = kind.endsWith("reversed") ? 10_000 : 8_000;
    expect(remaining(before.canonical, selected)).toBe(left);
    await unchangedRefusal(partyId, () => batch(partyId, [selected.id], left, "YER", PREPAYMENT_REASON), "batch_link_invalid");
    expect(remaining(await canonical(partyId), other)).toBe(20_000);
  });

  it.each([0, -2_000])("refuses selected remainder %s without skipping or offsetting it", async (left) => {
    const partyId = await lab();
    const a = await order(partyId);
    const b = await order(partyId);
    await historicalExpense(partyId, a, 10_000 - left);
    expect(remaining(await canonical(partyId), a)).toBe(left);
    await unchangedRefusal(partyId, () => batch(partyId, [a.id, b.id], 10_000 + left, "YER", PREPAYMENT_REASON), "batch_requires_full_allocation");
  });

  it.each(["stored-bigint", "subtraction", "sum", "invalid-currency"] as const)("fails closed on %s without decoding unsafe amounts into writes", async (kind) => {
    const partyId = await lab();
    const a = await order(partyId);
    const b = await order(partyId);
    let ids = [a.id];
    if (kind === "stored-bigint") await q("UPDATE payables SET amount_minor = '9007199254740992' WHERE id = $1", [a.payableId]);
    if (kind === "subtraction") {
      await q("UPDATE payables SET amount_minor = '9007199254740991' WHERE id = $1", [a.payableId]);
      // Each operand is safe; their difference is not. The anomalous negative
      // historical settlement is inserted legally, without weakening guards.
      await historicalExpense(partyId, a, -1);
    }
    if (kind === "sum") {
      await q("UPDATE payables SET amount_minor = '4503599627370496' WHERE id = ANY($1::int[])", [[a.payableId, b.payableId]]);
      ids = [a.id, b.id];
    }
    if (kind === "invalid-currency") await q("UPDATE payables SET currency = 'ZZZ' WHERE id = $1", [a.payableId]);
    await rawRefusal(() => batch(partyId, ids, 10_000, "YER", PREPAYMENT_REASON),
      kind === "invalid-currency" ? "batch_currency_mismatch" : "batch_requires_full_allocation");
  });

  it.each([950_000_000_000, Number.MAX_VALUE])("refuses unsafe/nonfinite saved base at finite rate %s before expense insertion", async (exchangeRate) => {
    const partyId = await lab();
    const selected = await order(partyId, 1_000_000, "USD");
    const before = await snapshot(partyId);
    await rawRefusal(() => db.settleLabOrdersBatch({ partyId, orderIds: [selected.id], amountMinor: selected.amount,
      currency: "USD", baseCurrency: "YER", exchangeRate, rates: RATES, note: null, createdBy: ACTOR }),
    "batch_requires_full_allocation");
    expect(await snapshot(partyId)).toEqual(before);
  });

  it.each(["unlinked-expense", "opening-advance"] as const)("keeps exact selection separate from %s party credit and explicit prepayment", async (kind) => {
    const partyId = await lab();
    const selected = await order(partyId);
    if (kind === "unlinked-expense") {
      const credit = await db.recordExpense({ category: "lab", partyId, payableId: null, payeeText: null,
        amountMinor: 6_000, currency: "YER", baseCurrency: "YER", exchangeRate: 1, rates: RATES, note: null, createdBy: ACTOR });
      expect(credit.reason).toBeNull();
    } else {
      await q(`INSERT INTO party_opening_advances (party_id, currency, amount_minor, exchange_rate,
        base_amount_minor, as_of_date, reason, created_by) VALUES ($1, 'YER', 6000, 1, 6000, CURRENT_DATE,
        'Synthetic advance', $2)`, [partyId, ACTOR]);
    }
    expect(due(await canonical(partyId), "YER")).toBe(4_000);
    await unchangedRefusal(partyId, () => batch(partyId, [selected.id], 4_000, "YER", PREPAYMENT_REASON), "batch_requires_full_allocation");
    const before = await snapshot(partyId);
    expect(await batch(partyId, [selected.id], 10_000)).toMatchObject({ ok: false, reason: "exceeds_party_balance" });
    expect(await snapshot(partyId)).toEqual(before);
    const paid = await batch(partyId, [selected.id], 10_000, "YER", PREPAYMENT_REASON);
    success(paid);
    await fullAllocation(paid, [{ order: selected, remainder: 10_000 }]);
    expect(paid.quote?.party?.prepayment).toBe(true);
    expect(remaining(await canonical(partyId), selected)).toBe(0);
    expect(due(await canonical(partyId), "YER")).toBe(-6_000);
  });

  it("keeps null-party exact-name and pending-post eligibility; payable currency owns the amount", async () => {
    const partyId = await lab();
    const selected = await order(partyId, 10_000, "USD");
    await q("UPDATE lab_orders SET party_id = NULL, is_posted = false, financial_status = 'pending_post', cost_currency = 'SAR' WHERE id = $1", [selected.id]);
    await q("UPDATE parties SET currency = 'YER' WHERE id = $1", [partyId]);
    const paid = await batch(partyId, [selected.id], 10_000, "USD");
    success(paid);
    await fullAllocation(paid, [{ order: selected, remainder: 10_000 }]);
  });

  it("keeps no-shift refusal atomic", async () => {
    const partyId = await lab();
    const selected = await order(partyId);
    const shift = await db.getOpenShift();
    expect(shift).not.toBeNull();
    expect((await db.closeShift({ id: shift!.id, closedBy: ACTOR, counted: { YER: 0, SAR: 0, USD: 0 }, note: null })).reason).toBeNull();
    await unchangedRefusal(partyId, () => batch(partyId, [selected.id], 10_000), "no_shift");
  });
});

const PARTY_LOCK = /FROM\s+parties\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i;
const ORDER_LOCK = /FROM\s+lab_orders\s+WHERE[\s\S]*FOR\s+UPDATE/i;
const PAYABLE_LOCK = /FROM\s+payables\b[\s\S]*FOR\s+UPDATE/i;
const SHIFT_ADMISSION = /FROM\s+cashier_shifts\b[\s\S]*FOR\s+SHARE\b[\s\S]*NOWAIT/i;
const SHIFT_CLOSE = /FROM\s+cashier_shifts\b[\s\S]*FOR\s+UPDATE/i;
const EXPENSE_INSERT = /INSERT\s+INTO\s+expenses\s*\(/i;
const ALLOCATION_INSERT = /INSERT\s+INTO\s+expense_payable_allocations\b/i;

type QueryWitness = { sql: string; values: unknown[]; completed: boolean };
/** Real-client scheduling/fault wrapper, never substitutes a writer/SQL result. */
function transactionHook(options: { after?: RegExp; failAfter?: RegExp; failAt?: number } = {}) {
  const connected = deferred(), paused = deferred(), release = deferred();
  const statements: QueryWitness[] = [];
  let pid = 0, pausedOnce = false, faultHits = 0, released = false;
  const connect = db.getPool().connect.bind(db.getPool());
  const fault = new Error("Synthetic late batch transaction fault");
  const spy = vi.spyOn(db.getPool(), "connect").mockImplementationOnce(async () => {
    const client = await connect();
    const query = client.query.bind(client);
    try { pid = (await query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid; }
    catch (error) { client.release(); throw error; }
    connected.resolve();
    const wrapper: DbClient = {
      async query<T>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
        const witness = { sql, values, completed: false };
        statements.push(witness);
        const result = await query<T>(sql, values);
        witness.completed = true;
        if (/^BEGIN\s*;?$/i.test(sql.trim())) {
          await query("SET LOCAL statement_timeout = '8s'");
          await query("SET LOCAL lock_timeout = '8s'");
        }
        if (options.failAfter?.test(sql) && ++faultHits === (options.failAt ?? 1)) throw fault;
        if (!pausedOnce && options.after?.test(sql)) {
          pausedOnce = true; paused.resolve();
          await bounded(release.promise, "release successor transaction", 12_000);
        }
        return result;
      },
      release: () => { released = true; client.release(); },
    };
    return wrapper;
  });
  return { connected, paused, release, spy, statements, fault, pid: () => pid, released: () => released };
}

type Hook = ReturnType<typeof transactionHook>;
type Running<T> = ReturnType<typeof observe<T>>;
async function reached<T>(hook: Hook, running: Running<T>, label: string) {
  await bounded(Promise.race([hook.paused.promise, running.settled.then((outcome) => {
    throw new Error(`Required ${label} barrier was not reached: ${JSON.stringify(outcome)}`);
  })]), label);
  hook.spy.mockRestore();
}
async function connected<T>(hook: Hook, running: Running<T>) {
  await bounded(Promise.race([hook.connected.promise, running.settled.then(() => {
    throw new Error("Actual transaction ended before connection observation");
  })]), "successor connection");
  hook.spy.mockRestore();
}
async function observerClient() {
  const client = new Client({ connectionString: target.testUrl.toString(), ssl: false, statement_timeout: 5_000 });
  await client.connect();
  return client;
}
async function lockWait<T>(observer: Client, blocked: Hook, owner: Hook, running: Running<T>, sql: RegExp) {
  const deadline = Date.now() + 5_000;
  let lastObservation: unknown = null;
  const absent = (detail: string) => new Error(`${detail}; blocked=${blocked.pid()} owner=${owner.pid()} intended=${sql.source}; witness=${JSON.stringify(lastObservation)}`);
  while (Date.now() < deadline) {
    if (running.state.outcome) throw absent("Writer ended before the required observable lock wait");
    const { rows } = await observer.query<{
      pid: number; state: string; query: string; blockers: number[]; wait_event_type: string | null;
    }>(
      "SELECT pid, state, query, pg_blocking_pids(pid) AS blockers, wait_event_type FROM pg_stat_activity WHERE pid = $1 AND datname = current_database()", [blocked.pid()]);
    // pg_stat_activity.query may truncate a long statement. Match its nonempty
    // visible prefix to the exact pending query on this actual wrapped client;
    // apply the intended lock-statement predicate to that complete SQL instead.
    const pending = blocked.statements[blocked.statements.length - 1];
    const active = rows[0];
    lastObservation = { server: active ?? null, pending: pending ? {
      sql: pending.sql, values: pending.values, completed: pending.completed,
    } : null };
    if (active?.pid === blocked.pid() && active.state === "active" && active.wait_event_type === "Lock"
      && active.blockers.includes(owner.pid()) && pending && !pending.completed && sql.test(pending.sql)
      && typeof active.query === "string" && active.query.length > 0 && pending.sql.startsWith(active.query)) return;
    await new Promise<void>((done) => setImmediate(done));
  }
  throw absent("Required exact client SQL/owner lock wait was not observed");
}
async function finish<T>(running: Running<T>, label: string): Promise<T> {
  const outcome = await bounded(running.settled, label);
  if (outcome.status === "rejected") throw outcome.error;
  return outcome.value;
}
async function releaseAndDrain(hooks: (Hook | undefined)[], runs: (Promise<unknown> | undefined)[], observer?: Client) {
  for (const hook of hooks) { hook?.release.resolve(); hook?.spy.mockRestore(); }
  try { await bounded(Promise.all(runs.filter((item): item is Promise<unknown> => Boolean(item))), "drain successor writers", 15_000); }
  finally { await observer?.end(); }
}
function noExpenseAttempt(hook: Hook) {
  expect(hook.statements.filter((item) => EXPENSE_INSERT.test(item.sql))).toEqual([]);
}

it.each(["first-allocation", "paid-marking"] as const)("late failure after %s rolls back all persisted financial/order/tracking state", async (stage) => {
  const partyId = await lab();
  const a = await order(partyId), b = await order(partyId), unrelated = await order(partyId, 7_000);
  const before = await snapshot(partyId);
  const hook = transactionHook({ failAfter: stage === "first-allocation" ? ALLOCATION_INSERT : /UPDATE\s+lab_orders\s+SET\s+financial_status\s*=\s*'paid'/i });
  const running = observe(batch(partyId, [a.id, b.id], 20_000));
  try {
    const result = await bounded(running.settled, "late injected failure");
    expect(result).toEqual({ status: "rejected", error: hook.fault });
    expect(hook.statements.filter((item) => item.completed && EXPENSE_INSERT.test(item.sql))).toHaveLength(1);
    expect(hook.statements.filter((item) => item.completed && ALLOCATION_INSERT.test(item.sql)).length).toBeGreaterThanOrEqual(1);
    expect(hook.statements.some((item) => /^ROLLBACK\s*;?$/i.test(item.sql.trim()) && item.completed)).toBe(true);
    expect(hook.statements.some((item) => /^COMMIT\s*;?$/i.test(item.sql.trim()))).toBe(false);
    expect(await snapshot(partyId)).toEqual(before);
    expect(remaining(await canonical(partyId), unrelated)).toBe(7_000);
  } finally { await releaseAndDrain([hook], [running.settled]); }
});

it("same selected batches serialize on the actual party and commit exactly one full allocation", async () => {
  const partyId = await lab(); const selected = await order(partyId);
  const observer = await observerClient();
  const firstHook = transactionHook({ after: EXPENSE_INSERT });
  const first = observe(batch(partyId, [selected.id], 10_000));
  let secondHook: Hook | undefined, second: Running<BatchResult> | undefined;
  try {
    await reached(firstHook, first, "first expense insertion");
    secondHook = transactionHook({ after: PARTY_LOCK });
    second = observe(batch(partyId, [selected.id, selected.id], 10_000));
    await connected(secondHook, second);
    await lockWait(observer, secondHook, firstHook, second, PARTY_LOCK);
    firstHook.release.resolve();
    const paid = await finish(first, "first full commit"); success(paid);
    await reached(secondHook, second, "second acquired party");
    const once = await snapshot(partyId);
    secondHook.release.resolve();
    expect(await finish(second, "second paid refusal")).toMatchObject({ ok: false, reason: "orders_already_paid" });
    expect(await snapshot(partyId)).toEqual(once);
    await fullAllocation(paid, [{ order: selected, remainder: 10_000 }]);
    expect(once.expenses).toHaveLength(1); expect(once.allocations).toHaveLength(1);
  } finally { await releaseAndDrain([firstHook, secondHook], [first.settled, second?.settled], observer); }
}, 40_000);

it("batch wins; actual direct owner waits on party then refuses payable overpayment", async () => {
  const partyId = await lab(); const selected = await order(partyId);
  const observer = await observerClient();
  const batchHook = transactionHook({ after: ALLOCATION_INSERT });
  const settling = observe(batch(partyId, [selected.id], 10_000));
  let directHook: Hook | undefined, paying: Running<Awaited<ReturnType<typeof direct>>> | undefined;
  try {
    await reached(batchHook, settling, "batch allocation");
    directHook = transactionHook(); paying = observe(direct(partyId, selected, 10_000));
    await connected(directHook, paying); await lockWait(observer, directHook, batchHook, paying, PARTY_LOCK);
    batchHook.release.resolve();
    const paid = await finish(settling, "batch commit"); success(paid);
    fullPlanTrace(batchHook, partyId, [selected]);
    expect(await finish(paying, "direct overpayment refusal")).toMatchObject({ expense: null, reason: "exceeds_payable" });
    await fullAllocation(paid, [{ order: selected, remainder: 10_000 }]);
    const after = await snapshot(partyId);
    expect(after.expenses).toHaveLength(1); expect(after.allocations).toHaveLength(1);
    expect(remaining(after.canonical, selected)).toBe(0); expect(due(after.canonical, "YER")).toBe(0);
  } finally { await releaseAndDrain([batchHook, directHook], [settling.settled, paying?.settled], observer); }
}, 40_000);

it("order-first actual accounting creation and party-first batch cannot form a wait cycle", async () => {
  const partyId = await lab(); const selected = await order(partyId);
  // Real accounting owner must create a fresh link. Keep the unrelated original
  // payable as legally detached debt rather than deleting financial history.
  await q("UPDATE lab_orders SET payable_id = NULL WHERE id = $1", [selected.id]);
  await q("UPDATE payables SET lab_order_id = NULL WHERE id = $1", [selected.payableId]);
  const before = await snapshot(partyId), observer = await observerClient();
  const editHook = transactionHook({ after: ORDER_LOCK });
  const editing = observe(db.updateLabOrderAccounting(selected.id, { costMinor: 12_000, actor: ACTOR }));
  let batchHook: Hook | undefined, settling: Running<BatchResult> | undefined;
  try {
    await reached(editHook, editing, "accounting holds order");
    batchHook = transactionHook({ after: PARTY_LOCK }); settling = observe(batch(partyId, [selected.id], 10_000));
    await reached(batchHook, settling, "batch holds party");
    editHook.release.resolve();
    await lockWait(observer, editHook, batchHook, editing, /INSERT\s+INTO\s+payables/i);
    batchHook.release.resolve();
    expect(await bounded(finish(settling, "order NOWAIT refusal"), "bounded busy", 2_000))
      .toMatchObject({ ok: false, reason: "batch_busy", quote: null });
    noExpenseAttempt(batchHook);
    expect(await finish(editing, "accounting completes after batch rollback")).not.toBeNull();
    const after = await snapshot(partyId);
    expect(after.expenses).toEqual(before.expenses); expect(after.allocations).toEqual(before.allocations);
    expect(after.orders.find((row) => row.id === selected.id)?.cost_minor).toBe("12000");
    expect(after.payables).toHaveLength(2);
    await unchangedRefusal(partyId, () => batch(partyId, [selected.id], 10_000), "batch_requires_full_allocation");
  } finally { await releaseAndDrain([editHook, batchHook], [editing.settled, settling?.settled], observer); }
}, 40_000);

it("selected payable NOWAIT is bounded, atomic and releases target party before the holder ends", async () => {
  const partyId = await lab(); const selected = await order(partyId);
  const before = await snapshot(partyId), holder = await observerClient(), probe = await observerClient();
  const hook = transactionHook();
  let settling: Running<BatchResult> | undefined;
  try {
    await holder.query("BEGIN"); await holder.query("SELECT id FROM payables WHERE id = $1 FOR UPDATE", [selected.payableId]);
    settling = observe(batch(partyId, [selected.id], 10_000));
    expect(await bounded(finish(settling, "payable NOWAIT"), "bounded payable busy", 2_000))
      .toMatchObject({ ok: false, reason: "batch_busy", quote: null });
    hook.spy.mockRestore(); noExpenseAttempt(hook);
    expect(await snapshot(partyId)).toEqual(before);
    await probe.query("BEGIN"); await probe.query("SELECT id FROM parties WHERE id = $1 FOR UPDATE NOWAIT", [partyId]);
    await probe.query("ROLLBACK");
  } finally {
    await holder.query("ROLLBACK"); await probe.query("ROLLBACK");
    await releaseAndDrain([hook], [settling?.settled]); await holder.end(); await probe.end();
  }
}, 30_000);

it("batch-owned selected rows fence actual cancellation; later cancellation preserves paid history", async () => {
  const partyId = await lab(); const selected = await order(partyId);
  await q("UPDATE lab_orders SET status = 'received' WHERE id = $1", [selected.id]);
  const observer = await observerClient(), batchHook = transactionHook({ after: ALLOCATION_INSERT });
  const settling = observe(batch(partyId, [selected.id], 10_000));
  let cancelHook: Hook | undefined, cancelling: Running<Awaited<ReturnType<typeof db.setLabOrderStatus>>> | undefined;
  try {
    await reached(batchHook, settling, "batch holds selected rows");
    cancelHook = transactionHook(); cancelling = observe(db.setLabOrderStatus(selected.id, "cancelled", { actor: ACTOR }));
    await connected(cancelHook, cancelling); await lockWait(observer, cancelHook, batchHook, cancelling, ORDER_LOCK);
    batchHook.release.resolve(); const paid = await finish(settling, "batch commit before cancellation"); success(paid);
    expect(await finish(cancelling, "later cancellation")).not.toBeNull();
    const after = await snapshot(partyId);
    expect(after.expenses).toHaveLength(1); expect(after.allocations).toHaveLength(1); expect(after.payables).toHaveLength(1);
    expect(after.orders[0]).toMatchObject({ status: "cancelled", financial_status: "paid", payable_id: selected.payableId });
    expect(remaining(after.canonical, selected)).toBe(0); expect(due(after.canonical, "YER")).toBe(0);
  } finally { await releaseAndDrain([batchHook, cancelHook], [settling.settled, cancelling?.settled], observer); }
}, 40_000);

it("admitted direct reversal wins the party fence; waiting stale-smaller batch reads restored remaining", async () => {
  const partyId = await lab(); const selected = await order(partyId);
  const prior = await direct(partyId, selected, 6_000); expect(prior.expense).not.toBeNull();
  const observer = await observerClient(), reversalHook = transactionHook({ after: EXPENSE_INSERT });
  const reversing = observe(db.voidExpense(prior.expense!.id, { actor: ACTOR, actorRole: "admin", reason: "Synthetic direct correction" }));
  let batchHook: Hook | undefined, settling: Running<BatchResult> | undefined;
  try {
    // Actual reversal INSERT has acquired target-party FK key-share; batch's
    // UPDATE lock must wait, even though reversal has no explicit party SELECT.
    await reached(reversalHook, reversing, "reversal inserted under party FK");
    batchHook = transactionHook({ after: PARTY_LOCK }); settling = observe(batch(partyId, [selected.id], 4_000));
    await connected(batchHook, settling); await lockWait(observer, batchHook, reversalHook, settling, PARTY_LOCK);
    reversalHook.release.resolve(); expect(await finish(reversing, "direct reversal commit")).toMatchObject({ ok: true });
    await reached(batchHook, settling, "batch party acquired after reversal");
    const reversed = await snapshot(partyId);
    expect(remaining(reversed.canonical, selected)).toBe(10_000);
    expect(reversed.expenses).toHaveLength(2);
    expect(reversed.expenses.find((row) => row.reversal_of_id === prior.expense!.id)).toMatchObject({ amount_minor: "-6000", payable_settled_minor: "-6000" });
    batchHook.release.resolve();
    expect(await finish(settling, "fresh smaller refusal")).toMatchObject({ ok: false, reason: "batch_requires_full_allocation", quote: null });
    expect(await snapshot(partyId)).toEqual(reversed); noExpenseAttempt(batchHook);
  } finally { await releaseAndDrain([reversalHook, batchHook], [reversing.settled, settling?.settled], observer); }
}, 40_000);

it("batch wins over admitted direct reversal; later reversal restores remaining and reopens paid marker", async () => {
  const partyId = await lab(); const selected = await order(partyId);
  const prior = await direct(partyId, selected, 6_000); expect(prior.expense).not.toBeNull();
  const observer = await observerClient(), batchHook = transactionHook({ after: EXPENSE_INSERT });
  const settling = observe(batch(partyId, [selected.id], 4_000));
  let reversalHook: Hook | undefined, reversing: Running<Awaited<ReturnType<typeof db.voidExpense>>> | undefined;
  try {
    await reached(batchHook, settling, "batch expense holds party");
    reversalHook = transactionHook(); reversing = observe(db.voidExpense(prior.expense!.id,
      { actor: ACTOR, actorRole: "admin", reason: "Synthetic later direct reversal" }));
    await connected(reversalHook, reversing); await lockWait(observer, reversalHook, batchHook, reversing, EXPENSE_INSERT);
    batchHook.release.resolve(); const paid = await finish(settling, "batch current remainder commit"); success(paid);
    expect(await finish(reversing, "later admitted reversal")).toMatchObject({ ok: true, reopenedLabOrderIds: [selected.id] });
    const after = await snapshot(partyId);
    expect(after.expenses).toHaveLength(3); expect(after.allocations).toHaveLength(1);
    expect(await allocations(paid.expense.id)).toEqual([{ expense_id: paid.expense.id, payable_id: selected.payableId,
      paid_minor: "4000", settled_minor: "4000", payable_currency: "YER", payable_exchange_rate: "1.000000" }]);
    expect(after.orders[0].financial_status).toBe("payable_created");
    expect(remaining(after.canonical, selected)).toBe(6_000); expect(due(after.canonical, "YER")).toBe(6_000);
    expect(after.expenses.find((row) => row.id === prior.expense!.id)).toMatchObject({ amount_minor: "6000", payable_settled_minor: "6000" });
  } finally { await releaseAndDrain([batchHook, reversalHook], [settling.settled, reversing?.settled], observer); }
}, 40_000);

const closeInput = (id: number) => ({ id, closedBy: ACTOR, counted: { YER: 0, SAR: 0, USD: 0 },
  note: null, differenceReason: "Synthetic closing count" });

it("actual shift close wins: batch NOWAIT refuses before expense and a later request sees no shift", async () => {
  const partyId = await lab(); const selected = await order(partyId), shift = await db.getOpenShift();
  const before = await snapshot(partyId), closeHook = transactionHook({ after: SHIFT_CLOSE });
  const closing = observe(db.closeShift(closeInput(shift!.id)));
  let batchHook: Hook | undefined, settling: Running<BatchResult> | undefined;
  try {
    await reached(closeHook, closing, "actual close locked shift");
    batchHook = transactionHook(); settling = observe(batch(partyId, [selected.id], 10_000));
    expect(await bounded(finish(settling, "shift busy refusal"), "bounded shift busy", 2_000))
      .toMatchObject({ ok: false, reason: "batch_busy", quote: null });
    batchHook.spy.mockRestore(); noExpenseAttempt(batchHook);
    expect(await snapshot(partyId)).toEqual(before);
    closeHook.release.resolve(); expect((await finish(closing, "close after busy")).reason).toBeNull();
    await unchangedRefusal(partyId, () => batch(partyId, [selected.id], 10_000), "no_shift");
  } finally { await releaseAndDrain([closeHook, batchHook], [closing.settled, settling?.settled]); }
}, 35_000);

it("batch preheld shift SHARE is reusable by unchanged expense owner despite queued close", async () => {
  const partyId = await lab(); const selected = await order(partyId), shift = await db.getOpenShift();
  const observer = await observerClient(), batchHook = transactionHook({ after: SHIFT_ADMISSION });
  const settling = observe(batch(partyId, [selected.id], 10_000));
  let closeHook: Hook | undefined, closing: Running<Awaited<ReturnType<typeof db.closeShift>>> | undefined;
  try {
    await reached(batchHook, settling, "batch shift SHARE NOWAIT admission");
    noExpenseAttempt(batchHook);
    closeHook = transactionHook(); closing = observe(db.closeShift(closeInput(shift!.id)));
    await connected(closeHook, closing); await lockWait(observer, closeHook, batchHook, closing, SHIFT_CLOSE);
    batchHook.release.resolve();
    const paid = await bounded(finish(settling, "reuse own shift SHARE"), "no queued-close self wait", 2_000); success(paid);
    const closed = await finish(closing, "close includes committed batch");
    expect(closed.reason).toBeNull(); expect(closed.breakdown?.expected.YER).toBe(-10_000);
    expect((await q<{ expected_yer: string; status: string }>("SELECT expected_yer, status FROM cashier_shifts WHERE id = $1", [shift!.id]))[0])
      .toEqual({ expected_yer: "-10000", status: "closed" });
    expect(batchHook.statements.filter((item) => item.completed && EXPENSE_INSERT.test(item.sql))).toHaveLength(1);
    await fullAllocation(paid, [{ order: selected, remainder: 10_000 }]);
    expect(remaining(await canonical(partyId), selected)).toBe(0);
  } finally { await releaseAndDrain([batchHook, closeHook], [settling.settled, closing?.settled], observer); }
}, 40_000);

it("three-session legacy allocation reversal / queued close cannot trap batch behind its own payable lock", async () => {
  const partyId = await lab(); const selected = await order(partyId), shift = await db.getOpenShift();
  // Legacy allocation history is deliberately not a direct-link row. Null party
  // avoids the target-party FK fence; actual reversal uses its open original
  // shift SHARE, then waits on the selected payable allocation FK.
  const oldExpense = await historicalExpense(null, null, 6_000);
  await q(`INSERT INTO expense_payable_allocations (expense_id, payable_id, paid_minor,
    payable_currency, payable_exchange_rate, settled_minor) VALUES ($1, $2, 6000, 'YER', 1, 6000)`, [oldExpense, selected.payableId]);
  expect(remaining(await canonical(partyId), selected)).toBe(4_000);
  const before = await snapshot(partyId);
  const observer = await observerClient(), batchHook = transactionHook({ after: PAYABLE_LOCK });
  const settling = observe(batch(partyId, [selected.id], 4_000));
  let reversalHook: Hook | undefined, closeHook: Hook | undefined;
  let reversing: Running<Awaited<ReturnType<typeof db.voidExpense>>> | undefined;
  let closing: Running<Awaited<ReturnType<typeof db.closeShift>>> | undefined;
  try {
    await reached(batchHook, settling, "batch selected payable locked before shift");
    noExpenseAttempt(batchHook);
    expect(batchHook.statements.some((item) => SHIFT_ADMISSION.test(item.sql))).toBe(false);
    reversalHook = transactionHook({ after: ALLOCATION_INSERT }); reversing = observe(db.voidExpense(oldExpense,
      { actor: ACTOR, actorRole: "admin", reason: "Synthetic legacy allocation correction" }));
    await connected(reversalHook, reversing);
    await lockWait(observer, reversalHook, batchHook, reversing, ALLOCATION_INSERT);
    expect(reversalHook.statements.some((item) => item.completed && /FROM\s+cashier_shifts\b[\s\S]*FOR\s+SHARE/i.test(item.sql))).toBe(true);
    closeHook = transactionHook(); closing = observe(db.closeShift(closeInput(shift!.id)));
    await connected(closeHook, closing); await lockWait(observer, closeHook, reversalHook, closing, SHIFT_CLOSE);
    // Preserve exact server observations and full pending SQL before any holder
    // is released. Both required lockWait predicates have already succeeded.
    const { rows: observedWaiters } = await observer.query(
      "SELECT pid, datname, state, query, wait_event_type, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND datname = current_database() ORDER BY pid",
      [[reversalHook.pid(), closeHook.pid()]],
    );
    const pendingSql = [reversalHook, closeHook].map((hook) => ({ pid: hook.pid(),
      statement: { ...hook.statements[hook.statements.length - 1] } }));
    batchHook.release.resolve();
    const batchOutcome = await bounded(settling.settled, "bounded three-session escape", 2_000);
    // Extra observation barrier only: the actual reversal allocation INSERT has
    // completed on its real transaction, but it has not committed or audited.
    await reached(reversalHook, reversing, "actual reversal allocation before commit");
    const intermediate = await snapshot(partyId);
    const reversalReleasedAtIntermediate = reversalHook.released();
    const closeOutcomeAtIntermediate = closing.state.outcome;
    reversalHook.release.resolve();
    const reversalOutcome = await bounded(reversing.settled, "reversal released by batch rollback or commit");
    const closeOutcome = await bounded(closing.settled, "queued close finishes");
    const after = await snapshot(partyId);
    const reversed = reversalOutcome.status === "resolved" ? reversalOutcome.value : undefined;
    const closed = closeOutcome.status === "resolved" ? closeOutcome.value : undefined;
    const reversedAllocations = reversed?.voidedId ? await allocations(reversed.voidedId) : [];
    const serializableOutcome = (outcome: Outcome<unknown>) => outcome.status === "resolved" ? outcome : {
      status: outcome.status, error: outcome.error instanceof Error
        ? { name: outcome.error.name, message: outcome.error.message, stack: outcome.error.stack } : String(outcome.error),
    };
    // Retain all observations BEFORE the contract checks. The earlier red runs
    // remain immutable; no successful batch is relabeled a valid refusal.
    // The allocation-provenance gate now rejects this null-party history before
    // shift admission. Only the refusal reason changes from batch_busy to
    // batch_link_invalid; retain every money/marker/close witness and barrier.
    console.info("LAB_BATCH_THREE_SESSION_CHARACTERIZATION", JSON.stringify({
      version: 2, expectedContract: "batch_link_invalid before shift admission with no batch financial effect",
      partyId, selected, oldExpense, shiftId: shift!.id,
      pids: { batch: batchHook.pid(), reversal: reversalHook.pid(), close: closeHook.pid() },
      observedWaiters, pendingSql, before,
      intermediate: { state: intermediate, reversalClientReleased: reversalReleasedAtIntermediate,
        closeOutcome: closeOutcomeAtIntermediate ? serializableOutcome(closeOutcomeAtIntermediate) : null },
      outcomes: { batch: serializableOutcome(batchOutcome), reversal: serializableOutcome(reversalOutcome), close: serializableOutcome(closeOutcome) },
      after, reversedAllocations, batchStatements: batchHook.statements,
    }));
    expect.soft(reversalReleasedAtIntermediate).toBe(false);
    expect.soft(closeOutcomeAtIntermediate).toBeUndefined();
    // Original no-write and final financial assertions remain intact.
    // Soft checks report every discrepancy after the complete evidence is saved.
    expect.soft(batchOutcome).toMatchObject({ status: "resolved", value: { ok: false, reason: "batch_link_invalid", quote: null } });
    expect.soft(batchHook.statements.filter((item) => /FROM\s+cashier_shifts\b/i.test(item.sql))).toEqual([]);
    expect.soft(batchHook.statements.filter((item) => EXPENSE_INSERT.test(item.sql))).toEqual([]);
    expect.soft(reversed?.ok).toBe(true);
    expect.soft(closed?.reason).toBeNull(); expect.soft(closed?.breakdown?.expected.YER).toBe(0);
    expect.soft(after.expenses).toHaveLength(2); expect.soft(after.allocations).toHaveLength(2); expect.soft(after.tracking).toHaveLength(0);
    expect.soft(after.expenses.find((row) => row.id === oldExpense)).toMatchObject({ amount_minor: "6000", party_id: null, payable_id: null });
    expect.soft(after.expenses.find((row) => row.id === reversed?.voidedId)).toMatchObject({ amount_minor: "-6000", reversal_of_id: oldExpense });
    expect.soft(reversedAllocations).toEqual([{ expense_id: reversed?.voidedId, payable_id: selected.payableId,
      paid_minor: "-6000", settled_minor: "-6000", payable_currency: "YER", payable_exchange_rate: "1.000000" }]);
    expect.soft(after.orders[0].financial_status).toBe("payable_created");
    expect.soft(remaining(after.canonical, selected)).toBe(10_000); expect.soft(due(after.canonical, "YER")).toBe(10_000);
  } finally { await releaseAndDrain([batchHook, reversalHook, closeHook], [settling.settled, reversing?.settled, closing?.settled], observer); }
}, 45_000);

/** Assert actual SQL scheduling, never reimplement a monetary calculation. */
function fullPlanTrace(hook: Hook, partyId: number, selected: Order[]) {
  const orderIndex = hook.statements.findIndex((item) => ORDER_LOCK.test(item.sql));
  const payableIndex = hook.statements.findIndex((item) => PAYABLE_LOCK.test(item.sql));
  expect(orderIndex).toBeGreaterThan(-1); expect(payableIndex).toBeGreaterThan(orderIndex);
  const orderIds = selected.map((row) => row.id).sort((a, b) => a - b);
  const payableIds = selected.map((row) => row.payableId).sort((a, b) => a - b);
  for (const index of [orderIndex, payableIndex]) {
    const statement = hook.statements[index];
    expect(statement.completed).toBe(true);
    expect(statement.sql).toMatch(/ORDER\s+BY[\s\S]*FOR\s+UPDATE[\s\S]*NOWAIT/i);
    expect(statement.sql).not.toMatch(/\bSUM\s*\(|expense_payable_allocations|payable_adjustments|FROM\s+expenses\b/i);
  }
  expect(hook.statements[orderIndex].values).toContainEqual(orderIds);
  expect(hook.statements[payableIndex].values).toContainEqual(payableIds);
  expect(hook.statements[payableIndex].values).toContain(partyId);
  expect(hook.statements[payableIndex].sql).toMatch(/party_id\s*=/i);
  const projectionIndex = hook.statements.findIndex((item, index) => index > payableIndex
    && /FROM\s+payables\b/i.test(item.sql) && /expense_payable_allocations/i.test(item.sql)
    && /payable_adjustments/i.test(item.sql) && !/FOR\s+(?:UPDATE|SHARE)/i.test(item.sql));
  expect(projectionIndex, "canonical amount/settlement projection must be a new statement after row locks").toBeGreaterThan(payableIndex);
  const shiftIndex = hook.statements.findIndex((item) => SHIFT_ADMISSION.test(item.sql));
  const expenseIndex = hook.statements.findIndex((item) => EXPENSE_INSERT.test(item.sql));
  expect(shiftIndex).toBeGreaterThan(projectionIndex); expect(expenseIndex).toBeGreaterThan(shiftIndex);
}

describe("exported writer validates untrusted input before financial writes", () => {
  const malformed: { label: string; changes: (id: number) => Record<string, unknown> }[] = [
    { label: "empty selection", changes: () => ({ orderIds: [] }) },
    { label: "mixed fractional ID", changes: (id) => ({ orderIds: [id, 1.5] }) },
    { label: "mixed boolean ID", changes: (id) => ({ orderIds: [id, true] }) },
    { label: "mixed object ID", changes: (id) => ({ orderIds: [id, {}] }) },
    { label: "mixed invalid numeric ID", changes: (id) => ({ orderIds: [id, Number.NaN] }) },
    { label: "unsafe ID", changes: (id) => ({ orderIds: [id, Number.MAX_SAFE_INTEGER + 1] }) },
    { label: "int4 overflow ID", changes: (id) => ({ orderIds: [id, 2_147_483_648] }) },
    { label: "fractional party", changes: () => ({ partyId: 1.5 }) },
    { label: "int4 overflow party", changes: () => ({ partyId: 2_147_483_648 }) },
    { label: "fractional minor amount", changes: () => ({ amountMinor: 10_000.5 }) },
    { label: "unsafe minor amount", changes: () => ({ amountMinor: Number.MAX_SAFE_INTEGER + 1 }) },
    { label: "zero amount", changes: () => ({ amountMinor: 0 }) },
    { label: "negative amount", changes: () => ({ amountMinor: -10_000 }) },
    { label: "invalid currency", changes: () => ({ currency: "ZZZ" }) },
    { label: "invalid base currency", changes: () => ({ baseCurrency: "ZZZ" }) },
    { label: "nonconstitutional base currency", changes: () => ({ baseCurrency: "USD" }) },
    { label: "NaN rate", changes: () => ({ exchangeRate: Number.NaN }) },
    { label: "infinite rate", changes: () => ({ exchangeRate: Number.POSITIVE_INFINITY }) },
    { label: "zero rate", changes: () => ({ exchangeRate: 0 }) },
    { label: "negative rate", changes: () => ({ exchangeRate: -1 }) },
    { label: "nonunit base-currency rate", changes: () => ({ exchangeRate: 2 }) },
  ];
  it.each(malformed)("$label refuses without filtering or persistence", async ({ changes }) => {
    const partyId = await lab(), selected = await order(partyId);
    const before = await snapshot(partyId);
    const input = { partyId, orderIds: [selected.id], amountMinor: 10_000, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, rates: RATES, note: null, createdBy: ACTOR, prepaymentReason: PREPAYMENT_REASON,
      ...changes(selected.id) } as Parameters<typeof db.settleLabOrdersBatch>[0];
    const result = await observe(db.settleLabOrdersBatch(input)).settled;
    expect.soft(result).toMatchObject({ status: "resolved", value: { ok: false, quote: null } });
    if (result.status === "resolved" && !result.value.ok) {
      // The design specifies no separate writer-input reason vocabulary. Keep
      // malformed admission typed, without inventing HTTP400 at the DB layer.
      expect.soft(["orders_invalid", "batch_link_invalid", "batch_currency_mismatch", "batch_requires_full_allocation", "not_lab"])
        .toContain(result.value.reason);
    }
    expect.soft(await snapshot(partyId)).toEqual(before);
  });
});

// Implementation-review addition: refusal cleanup must finish before pool reuse.
it("busy refusal waits for ROLLBACK acknowledgement before releasing its client", async () => {
  const partyId = await lab(), selected = await order(partyId);
  const before = await snapshot(partyId), holder = await observerClient();
  const hook = transactionHook({ after: /^ROLLBACK\s*;?$/i });
  let settling: Running<BatchResult> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM payables WHERE id = $1 FOR UPDATE", [selected.payableId]);
    settling = observe(batch(partyId, [selected.id], 10_000));
    // Real SQL has rolled back, but its completion is withheld from the caller.
    // Returning a pending refuse() promise through finally would release here.
    await reached(hook, settling, "rollback acknowledgement held at client boundary");
    expect(hook.released()).toBe(false);
    expect(settling.state.outcome).toBeUndefined();
    noExpenseAttempt(hook);
    hook.release.resolve();
    expect(await finish(settling, "acknowledged busy refusal")).toMatchObject({ ok: false, reason: "batch_busy", quote: null });
    expect(hook.released()).toBe(true);
    expect(await snapshot(partyId)).toEqual(before);
  } finally {
    await holder.query("ROLLBACK");
    await releaseAndDrain([hook], [settling?.settled]);
    await holder.end();
  }
}, 30_000);

// Provenance successor: allocation history and genuine tracked reversal compatibility.
// AUTHORED, NOT EXECUTED. Existing cases above remain unchanged except the
// documented three-session refusal reason and its additional pre-shift witness.
async function historicalAllocation(expenseId: number, selected: Order, amount: number) {
  await q(`INSERT INTO expense_payable_allocations (expense_id, payable_id, paid_minor,
    payable_currency, payable_exchange_rate, settled_minor) VALUES ($1, $2, $3, 'YER', 1, $3)`,
  [expenseId, selected.payableId, amount]);
}

type TrackingLink = "structural" | "legacy";
async function historicalSettlementTracking(expenseId: number, selected: Order, link: TrackingLink) {
  const [expense] = await q<{ voucher_number: string; amount_minor: string }>(
    "SELECT voucher_number, amount_minor FROM expenses WHERE id = $1", [expenseId]);
  // Preserve the product's exact historical note, status pair and actor fields.
  // Legacy rows predate the structural expense_id link, not the settlement event.
  await q(`INSERT INTO lab_order_tracking
    (lab_order_id, action, from_status, to_status, notes, actor, actor_role, expense_id)
    SELECT id, 'financial_settlement', status, status, $1, $2, 'admin', $3
      FROM lab_orders WHERE id = $4`,
  [`تمت التسوية المالية المجمعة بسند صرف رقم ${expense.voucher_number} بمبلغ ${expense.amount_minor} YER`,
    ACTOR, link === "structural" ? expenseId : null, selected.id]);
}

/** Reproduce the old partial-batch product shape without calling the new full-only
 * writer: its real expense owner plus legal allocation/tracking fixture SQL and
 * the old paid marker. The actual direct-payment/void pair then reopens that
 * marker with zero-net direct settlement. Never pretend old partial batches left
 * the marker unpaid, mutate old expenses, or erase their tracking/audit history. */
async function historicalPartialBatch(partyId: number, selected: Order, link: TrackingLink) {
  const prior = await db.recordExpense({ category: "lab", partyId, payeeText: "Synthetic full-allocation lab",
    payableId: null, amountMinor: 6_000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
    rates: RATES, createdBy: ACTOR,
    note: `تسوية وسداد كشف حساب مختبر [Synthetic full-allocation lab] لعدد (1) أوامر عمل: [RX-${selected.id}]` });
  expect(prior.reason).toBeNull(); expect(prior.expense).not.toBeNull();
  const expenseId = prior.expense!.id;
  await historicalAllocation(expenseId, selected, 6_000);
  await q("UPDATE lab_orders SET financial_status = 'paid' WHERE id = $1", [selected.id]);
  await historicalSettlementTracking(expenseId, selected, link);
  expect((await q("SELECT financial_status FROM lab_orders WHERE id = $1", [selected.id]))[0])
    .toEqual({ financial_status: "paid" });
  expect(remaining(await canonical(partyId), selected)).toBe(4_000);
  const directPayment = await direct(partyId, selected, 1_000);
  expect(directPayment.reason).toBeNull(); expect(directPayment.expense).not.toBeNull();
  expect(remaining(await canonical(partyId), selected)).toBe(3_000);
  const reopened = await db.voidExpense(directPayment.expense!.id,
    { actor: ACTOR, actorRole: "admin", reason: "Synthetic product reopening after historical partial batch" });
  expect(reopened).toMatchObject({ ok: true, reopenedLabOrderIds: [selected.id] });
  const state = await snapshot(partyId);
  expect(state.expenses).toHaveLength(3); expect(state.allocations).toHaveLength(1); expect(state.tracking).toHaveLength(2);
  expect(state.orders.find((row) => row.id === selected.id)?.financial_status).toBe("payable_created");
  expect(remaining(state.canonical, selected)).toBe(4_000); expect(due(state.canonical, "YER")).toBe(4_000);
  expect(state.expenses.find((row) => row.id === directPayment.expense!.id))
    .toMatchObject({ amount_minor: "1000", payable_settled_minor: "1000" });
  expect(state.expenses.find((row) => row.id === reopened.voidedId))
    .toMatchObject({ amount_minor: "-1000", payable_settled_minor: "-1000", reversal_of_id: directPayment.expense!.id });
  expect(state.tracking.filter((row) => row.expense_id === reopened.voidedId))
    .toMatchObject([{ lab_order_id: selected.id, action: "financial_settlement_reversed" }]);
  expect(state.audit.filter((row) => row.action === "expense.void" && row.entity_id === String(directPayment.expense!.id)))
    .toMatchObject([{ entity: "expense", actor: ACTOR, actor_role: "admin" }]);
  return expenseId;
}
/** Full snapshot refusal plus actual-client evidence that provenance is checked
 * before shift admission or expense insertion, not merely rolled back later. */
async function provenanceRefusal(partyId: number, selected: Order[], amount: number) {
  const before = await snapshot(partyId);
  const hook = transactionHook();
  const running = observe(batch(partyId, selected.map((item) => item.id), amount, "YER", PREPAYMENT_REASON));
  try {
    const result = await finish(running, "allocation provenance refusal");
    hook.spy.mockRestore();
    expect.soft(result).toMatchObject({ ok: false, reason: "batch_link_invalid", quote: null });
    expect.soft(await snapshot(partyId)).toEqual(before);
    expect.soft(hook.statements.filter((item) => EXPENSE_INSERT.test(item.sql))).toEqual([]);
    expect.soft(hook.statements.filter((item) => /FROM\s+cashier_shifts\b/i.test(item.sql))).toEqual([]);
    expect.soft(hook.statements.some((item) => item.completed && /^ROLLBACK\s*;?$/i.test(item.sql.trim()))).toBe(true);
    expect.soft(hook.released()).toBe(true);
  } finally { await releaseAndDrain([hook], [running.settled]); }
}

function originalHistoryUnchanged(before: Snapshot, after: Snapshot) {
  for (const key of ["expenses", "allocations", "tracking", "audit"] as const) {
    const ids = new Set(before[key].map((row) => row.id));
    expect(after[key].filter((row) => ids.has(row.id))).toEqual(before[key]);
  }
  expect(after.payables).toEqual(before.payables);
}

describe("allocation provenance refuses ambiguous attribution and untracked original history", () => {
  it.each(["null", "foreign", "null-reversed", "foreign-reversed"] as const)(
    "refuses %s allocation-linked expense history even with genuine tracking and zero signed total", async (kind) => {
      const partyId = await lab(), selected = await order(partyId), unrelated = await order(partyId, 20_000);
      const attributedParty = kind.startsWith("null") ? null : await lab();
      const original = await historicalExpense(attributedParty, null, 2_000);
      await historicalAllocation(original, selected, 2_000);
      await historicalSettlementTracking(original, selected, "structural");
      if (kind.endsWith("reversed")) {
        const reversed = await historicalExpense(attributedParty, null, -2_000, -2_000, original);
        await historicalAllocation(reversed, selected, -2_000);
      }
      const left = kind.endsWith("reversed") ? 10_000 : 8_000;
      expect(remaining(await canonical(partyId), selected)).toBe(left);
      await provenanceRefusal(partyId, [selected], left);
      expect(remaining(await canonical(partyId), unrelated)).toBe(20_000);
    });

  it.each(["null", "foreign"] as const)(
    "refuses a %s-party allocation reversal even when its original has same-party structural provenance", async (kind) => {
      const partyId = await lab(), selected = await order(partyId);
      const original = await historicalExpense(partyId, null, 2_000);
      await historicalAllocation(original, selected, 2_000);
      await historicalSettlementTracking(original, selected, "structural");
      const reversed = await historicalExpense(kind === "null" ? null : await lab(), null, -2_000, -2_000, original);
      await historicalAllocation(reversed, selected, -2_000);
      expect(remaining(await canonical(partyId), selected)).toBe(10_000);
      await provenanceRefusal(partyId, [selected], 10_000);
    });

  const invalidTracking = ["missing", "wrong-order", "wrong-expense", "wrong-action", "wrong-legacy-note"] as const;
  it.each(invalidTracking.flatMap((kind) => [false, true].map((reversed) => ({ kind, reversed }))))(
    "refuses same-party $kind settlement provenance (reversed zero-net: $reversed)", async ({ kind, reversed }) => {
      const partyId = await lab(), selected = await order(partyId), unrelated = await order(partyId, 20_000);
      const original = await historicalExpense(partyId, null, 2_000);
      await historicalAllocation(original, selected, 2_000);
      if (kind !== "missing") {
        // Wrong-expense deliberately retains a correct-looking legacy note:
        // the legacy fallback is legal ONLY when the structural link is NULL.
        const wrongExpense = kind === "wrong-expense" ? await historicalExpense(partyId, null, 0) : original;
        const [saved] = await q<{ voucher_number: string }>("SELECT voucher_number FROM expenses WHERE id = $1", [original]);
        const voucher = kind === "wrong-legacy-note" ? `${saved.voucher_number}-unrelated` : saved.voucher_number;
        await q(`INSERT INTO lab_order_tracking
          (lab_order_id, action, from_status, to_status, notes, actor, actor_role, expense_id)
          SELECT id, $1, status, status, $2, $3, 'admin', $4 FROM lab_orders WHERE id = $5`,
        [kind === "wrong-action" ? "financial_settlement_reversed" : "financial_settlement",
          `تمت التسوية المالية المجمعة بسند صرف رقم ${voucher} بمبلغ 2000 YER`, ACTOR,
          kind === "wrong-legacy-note" ? null : wrongExpense, kind === "wrong-order" ? unrelated.id : selected.id]);
      }
      if (reversed) {
        const reversal = await historicalExpense(partyId, null, -2_000, -2_000, original);
        await historicalAllocation(reversal, selected, -2_000);
      }
      const left = reversed ? 10_000 : 8_000;
      expect(remaining(await canonical(partyId), selected)).toBe(left);
      await provenanceRefusal(partyId, [selected], left);
      expect(remaining(await canonical(partyId), unrelated)).toBe(20_000);
    });

  it.each([false, true])("requires tracking for every selected allocation/order pair (reversed zero-net: %s)", async (reversed) => {
    const partyId = await lab(), a = await order(partyId), b = await order(partyId);
    const original = await historicalExpense(partyId, null, 4_000);
    await historicalAllocation(original, a, 2_000); await historicalAllocation(original, b, 2_000);
    await historicalSettlementTracking(original, a, "structural");
    if (reversed) {
      const reversal = await historicalExpense(partyId, null, -4_000, -4_000, original);
      await historicalAllocation(reversal, a, -2_000); await historicalAllocation(reversal, b, -2_000);
    }
    const left = reversed ? 10_000 : 8_000;
    const state = await canonical(partyId);
    expect(remaining(state, a)).toBe(left); expect(remaining(state, b)).toBe(left);
    await provenanceRefusal(partyId, [a, b], left * 2);
  });
});

describe("genuine historical partial-batch allocation and tracking remain compatible", () => {
  it.each(["structural", "legacy"] as const)("admits the exact remainder after actual marker reopening with %s tracking", async (link) => {
    const partyId = await lab(), selected = await order(partyId);
    const original = await historicalPartialBatch(partyId, selected, link);
    const before = await snapshot(partyId);
    const paid = await batch(partyId, [selected.id], 4_000); success(paid);
    await fullAllocation(paid, [{ order: selected, remainder: 4_000 }]);
    const after = await snapshot(partyId);
    originalHistoryUnchanged(before, after);
    expect(after.expenses).toHaveLength(4); expect(after.allocations).toHaveLength(2); expect(after.tracking).toHaveLength(3);
    expect(after.expenses.find((row) => row.id === original)).toMatchObject({ party_id: partyId, payable_id: null, amount_minor: "6000" });
    expect(remaining(after.canonical, selected)).toBe(0); expect(due(after.canonical, "YER")).toBe(0);
  });

  it.each(["structural", "legacy"] as const)(
    "tracked %s allocation reversal wins party FK; stale-smaller batch refuses without writing", async (link) => {
      const partyId = await lab(), selected = await order(partyId);
      const original = await historicalPartialBatch(partyId, selected, link);
      const before = await snapshot(partyId);
      const observer = await observerClient(), reversalHook = transactionHook({ after: EXPENSE_INSERT });
      const reversing = observe(db.voidExpense(original,
        { actor: ACTOR, actorRole: "admin", reason: "Synthetic historical partial-batch correction" }));
      let batchHook: Hook | undefined, settling: Running<BatchResult> | undefined;
      try {
        // The real allocation reversal's same-party expense INSERT holds the FK
        // fence before its allocation INSERT, while batch waits on that party.
        await reached(reversalHook, reversing, "tracked allocation reversal inserted under party FK");
        batchHook = transactionHook({ after: PARTY_LOCK }); settling = observe(batch(partyId, [selected.id], 4_000));
        await connected(batchHook, settling); await lockWait(observer, batchHook, reversalHook, settling, PARTY_LOCK);
        reversalHook.release.resolve();
        const reversed = await finish(reversing, "tracked allocation reversal commit"); expect(reversed).toMatchObject({ ok: true });
        await reached(batchHook, settling, "batch party acquired after tracked allocation reversal");
        const restored = await snapshot(partyId);
        originalHistoryUnchanged(before, restored);
        expect(restored.expenses).toHaveLength(4); expect(restored.allocations).toHaveLength(2); expect(restored.tracking).toEqual(before.tracking);
        expect(restored.expenses.find((row) => row.id === reversed.voidedId))
          .toMatchObject({ party_id: partyId, payable_id: null, amount_minor: "-6000", reversal_of_id: original });
        expect(await allocations(reversed.voidedId!)).toEqual([{ expense_id: reversed.voidedId, payable_id: selected.payableId,
          paid_minor: "-6000", settled_minor: "-6000", payable_currency: "YER", payable_exchange_rate: "1.000000" }]);
        expect(restored.orders.find((row) => row.id === selected.id)?.financial_status).toBe("payable_created");
        expect(remaining(restored.canonical, selected)).toBe(10_000); expect(due(restored.canonical, "YER")).toBe(10_000);
        // A reversal has no financial_settlement row of its own. The original's
        // retained provenance must still admit this history to the amount check.
        batchHook.release.resolve();
        expect(await finish(settling, "fresh smaller tracked-allocation refusal"))
          .toMatchObject({ ok: false, reason: "batch_requires_full_allocation", quote: null });
        expect(await snapshot(partyId)).toEqual(restored); noExpenseAttempt(batchHook);
        expect(batchHook.statements.filter((item) => /FROM\s+cashier_shifts\b/i.test(item.sql))).toEqual([]);
      } finally { await releaseAndDrain([reversalHook, batchHook], [reversing.settled, settling?.settled], observer); }
    }, 40_000);

  it.each(["structural", "legacy"] as const)(
    "batch wins over tracked %s allocation reversal; later reversal restores 6000 and reopens marker", async (link) => {
      const partyId = await lab(), selected = await order(partyId);
      const original = await historicalPartialBatch(partyId, selected, link);
      const before = await snapshot(partyId);
      const observer = await observerClient(), batchHook = transactionHook({ after: EXPENSE_INSERT });
      const settling = observe(batch(partyId, [selected.id], 4_000));
      let reversalHook: Hook | undefined, reversing: Running<Awaited<ReturnType<typeof db.voidExpense>>> | undefined;
      try {
        await reached(batchHook, settling, "batch expense holds party over tracked allocation reversal");
        reversalHook = transactionHook({ after: EXPENSE_INSERT }); reversing = observe(db.voidExpense(original,
          { actor: ACTOR, actorRole: "admin", reason: "Synthetic later historical partial-batch correction" }));
        await connected(reversalHook, reversing); await lockWait(observer, reversalHook, batchHook, reversing, EXPENSE_INSERT);
        batchHook.release.resolve(); const paid = await finish(settling, "current remainder with tracked allocation commit"); success(paid);
        await reached(reversalHook, reversing, "later tracked allocation reversal expense before allocation and reopen");
        await fullAllocation(paid, [{ order: selected, remainder: 4_000 }]);
        const committed = await snapshot(partyId);
        originalHistoryUnchanged(before, committed);
        expect(committed.expenses).toHaveLength(4); expect(committed.allocations).toHaveLength(2); expect(committed.tracking).toHaveLength(3);
        expect(committed.orders.find((row) => row.id === selected.id)?.financial_status).toBe("paid");
        expect(remaining(committed.canonical, selected)).toBe(0); expect(due(committed.canonical, "YER")).toBe(0);
        reversalHook.release.resolve(); const reversed = await finish(reversing, "later tracked allocation reversal commit");
        expect(reversed).toMatchObject({ ok: true, reopenedLabOrderIds: [selected.id] });
        const after = await snapshot(partyId);
        originalHistoryUnchanged(committed, after);
        expect(after.expenses).toHaveLength(5); expect(after.allocations).toHaveLength(3); expect(after.tracking).toHaveLength(4);
        expect(after.expenses.find((row) => row.id === reversed.voidedId))
          .toMatchObject({ party_id: partyId, payable_id: null, amount_minor: "-6000", reversal_of_id: original });
        expect(await allocations(reversed.voidedId!)).toEqual([{ expense_id: reversed.voidedId, payable_id: selected.payableId,
          paid_minor: "-6000", settled_minor: "-6000", payable_currency: "YER", payable_exchange_rate: "1.000000" }]);
        expect(after.tracking.filter((row) => row.expense_id === reversed.voidedId))
          .toMatchObject([{ lab_order_id: selected.id, action: "financial_settlement_reversed" }]);
        expect(after.orders.find((row) => row.id === selected.id)?.financial_status).toBe("payable_created");
        expect(remaining(after.canonical, selected)).toBe(6_000); expect(due(after.canonical, "YER")).toBe(6_000);
      } finally { await releaseAndDrain([batchHook, reversalHook], [settling.settled, reversing?.settled], observer); }
    }, 40_000);
});
