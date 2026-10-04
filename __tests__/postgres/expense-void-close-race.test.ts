import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { validatePostgresTestTarget } from "./_safe-target";
import { stubPostgresEnv } from "./_setup";
import { prepareManualCashFixture } from "./_manual-cash-fixture";

/** Actual domain writers on a NEW guarded PostgreSQL 18 database. Reuse the
 * existing fresh-only/disposable-CI fixture contract; no production migrations,
 * runtime writer mocks, historical updates, or sleep-based concurrency oracle. */
const originalEnvironment = { ...process.env };
const target = validatePostgresTestTarget(originalEnvironment);
stubPostgresEnv();
const db = await import("../../lib/db");
const { CASH_ACCOUNT } = await import("../../lib/accounting");
const { CURRENCIES } = await import("../../lib/money");
type Currency = (typeof CURRENCIES)[number];
const ACTOR = "synthetic-expense-void-close";
const ZERO = { YER: 0, SAR: 0, USD: 0 };
const CLOSE_GATE = [140019, 190201] as const;
const VOID_GATE = [140019, 190202] as const;
let sequence = 0;

type Outcome<T> = { status: "resolved"; value: T } | { status: "rejected"; error: unknown };
function observe<T>(promise: Promise<T>) {
  const state: { outcome?: Outcome<T> } = {};
  const settled = promise.then(
    (value): Outcome<T> => (state.outcome = { status: "resolved", value }),
    (error: unknown): Outcome<T> => (state.outcome = { status: "rejected", error }),
  );
  return { state, settled };
}
type Closing = ReturnType<typeof observe<Awaited<ReturnType<typeof db.closeShift>>>>;
type Voiding = ReturnType<typeof observe<Awaited<ReturnType<typeof db.voidExpense>>>>;

async function connection(): Promise<Client> {
  const client = new Client({ connectionString: target.testUrl.toString(), ssl: false });
  await client.connect();
  await client.query("SET statement_timeout = '15s'");
  return client;
}

async function until(condition: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    // Poll the actual PostgreSQL state. Elapsed time alone never means success.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Did not observe PostgreSQL barrier: ${label}`);
}

async function waitingPid(observer: Client, queryPattern: string): Promise<number | null> {
  const { rows } = await observer.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
    WHERE datname = current_database() AND application_name = 'aqlan-center-mini'
      AND wait_event_type = 'Lock' AND query ILIKE $1 ORDER BY pid LIMIT 1`, [queryPattern]);
  return rows[0]?.pid ?? null;
}

async function otherWait(observer: Client, exceptPid: number): Promise<boolean> {
  const { rows: [row] } = await observer.query<{ waiting: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
      AND application_name = 'aqlan-center-mini' AND wait_event_type = 'Lock' AND pid <> $1
  ) AS waiting`, [exceptPid]);
  return row.waiting;
}

async function hold(controller: Client, gate: readonly [number, number]) {
  await controller.query("BEGIN");
  await controller.query("SELECT pg_advisory_xact_lock($1, $2)", [...gate]);
}

async function finish(controller: Client, observer: Client, pending: (Closing | Voiding | undefined)[]) {
  try {
    await controller.query("COMMIT").catch(async () => { await controller.query("ROLLBACK"); });
    await Promise.all(pending.map((operation) => operation?.settled));
  } finally {
    await Promise.all([controller.end(), observer.end()]);
  }
}

async function closeRemainingSyntheticShift() {
  const shift = await db.getOpenShift();
  if (!shift) return;
  expect(shift.openedBy, "Do not close another fixture's shift").toBe(ACTOR);
  const result = await db.closeShift({ id: shift.id, closedBy: ACTOR, counted: shift.expected, note: "Synthetic cleanup" });
  expect(result.reason).toBeNull();
}

async function fixture(currency: Currency = "YER", supplier = false) {
  const shift = await db.openShift({ openedBy: ACTOR, opening: ZERO });
  expect(shift).not.toBeNull();
  const label = `${ACTOR}-${++sequence}`;
  const { rows: [patient] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id", [label]);
  const invoice = await db.createInvoice({ patientId: patient.id, baseCurrency: currency, discountMinor: 0,
    note: null, createdBy: ACTOR, items: [{ serviceId: null, doctorId: null, description: label, quantity: 1, unitPriceMinor: 10_000 }] });
  expect(invoice).not.toBeNull();
  const paid = await db.recordPayment({ patientId: patient.id, invoiceId: invoice!.id, kind: "payment",
    amountMinor: 10_000, currency, baseCurrency: "YER", exchangeRate: currency === "YER" ? 1 : 140,
    method: "cash", note: null, createdBy: ACTOR });
  expect(paid.reason).toBeNull();
  let partyId: number | null = null;
  let payableId: number | null = null;
  if (supplier) {
    const { rows: [party] } = await db.getPool().query<{ id: number }>(
      "INSERT INTO parties (name, kind) VALUES ($1, 'supplier') RETURNING id", [label]);
    partyId = party.id;
    const payable = await db.createPayable({ partyId, category: "supplier", description: label,
      amountMinor: 2_000, currency, baseCurrency: "YER", exchangeRate: 1, labOrderId: null,
      dueDate: null, createdBy: ACTOR });
    expect(payable).not.toBeNull();
    payableId = payable!.id;
  }
  const spent = await db.recordExpense({ category: supplier ? "supplier" : "other", partyId,
    payableId, payeeText: supplier ? null : label, amountMinor: 2_000, currency,
    baseCurrency: "YER", exchangeRate: currency === "YER" ? 1 : 140, note: null, createdBy: ACTOR,
    rates: { YER: 1, SAR: 140, USD: 140 } });
  expect(spent.reason).toBeNull();
  expect((await db.getShift(shift!.id))!.expected).toEqual({ ...ZERO, [currency]: 8_000 });
  return { shift: shift!, expense: spent.expense!, payment: paid.payment!, currency, payableId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function reversalRows(expenseId: number) {
  return (await db.getPool().query<{ id: number; shift_id: number; amount_minor: string }>(
    "SELECT id, shift_id, amount_minor FROM expenses WHERE reversal_of_id = $1 ORDER BY id", [expenseId])).rows;
}

async function auditCount(expenseId: number) {
  const { rows: [row] } = await db.getPool().query<{ n: number }>(
    "SELECT count(*)::int AS n FROM audit_log WHERE actor = $1 AND action = 'expense.void' AND entity_id = $2",
    [ACTOR, String(expenseId)]);
  return row.n;
}

async function sourceCash(f: Fixture): Promise<number> {
  const reversals = await reversalRows(f.expense.id);
  const vouchers = await Promise.all(reversals.map((row) => db.getExpense(row.id)));
  const references = new Set([f.payment.receiptNumber, f.expense.voucherNumber,
    ...vouchers.map((voucher) => voucher!.voucherNumber), `SH-${f.shift.id}-${f.currency}`]);
  return (await db.journalEntries("0001-01-01", "2099-12-31"))
    .filter((entry) => references.has(entry.reference))
    .flatMap((entry) => entry.lines)
    .filter((line) => line.accountCode === CASH_ACCOUNT[f.currency] && line.currency === f.currency)
    .reduce((sum, line) => sum + (line.side === "debit" ? line.amountMinor : -line.amountMinor), 0);
}

beforeAll(async () => {
  await prepareManualCashFixture(originalEnvironment);
  await db.ensureSchema();
  // Synthetic barriers pause actual domain calls. The close already owns its
  // shift row; the reversal pauses BEFORE insertion/FK checks, after admission.
  await db.getPool().query(`CREATE FUNCTION test_expense_void_close_barrier()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.opened_by = '${ACTOR}' AND NEW.status = 'closed' THEN
        PERFORM pg_advisory_xact_lock(${CLOSE_GATE[0]}, ${CLOSE_GATE[1]});
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_expense_void_close_barrier AFTER UPDATE ON cashier_shifts
      FOR EACH ROW EXECUTE FUNCTION test_expense_void_close_barrier();
    CREATE FUNCTION test_expense_void_insert_barrier()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.created_by = '${ACTOR}' AND NEW.reversal_of_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(${VOID_GATE[0]}, ${VOID_GATE[1]});
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_expense_void_insert_barrier BEFORE INSERT ON expenses
      FOR EACH ROW EXECUTE FUNCTION test_expense_void_insert_barrier()`);
}, 180_000);
beforeEach(closeRemainingSyntheticShift);
afterEach(closeRemainingSyntheticShift);
afterAll(async () => { await db.resetPoolForTesting(); });

describe("direct expense reversal and blind shift close serialize", () => {
  for (const currency of CURRENCIES) {
    it(`close wins: ${currency} direct reversal cannot enter the newly closed shift`, async () => {
      const f = await fixture(currency);
      const original = await db.getExpense(f.expense.id);
      const controller = await connection();
      const observer = await connection();
      let closing: Closing | undefined;
      let voiding: Voiding | undefined;
      try {
        await hold(controller, CLOSE_GATE);
        closing = observe(db.closeShift({ id: f.shift.id, closedBy: ACTOR,
          counted: { ...ZERO, [currency]: 8_000 }, note: null }));
        let closingPid: number | null = null;
        await until(async () => ((closingPid = await waitingPid(observer, "%UPDATE cashier_shifts SET%")) !== null), "real close holds shift after writing snapshot");
        voiding = observe(db.voidExpense(f.expense.id, { actor: ACTOR, reason: "Synthetic correction" }));
        await until(async () => Boolean(voiding!.state.outcome) || await otherWait(observer, closingPid!), "reversal waits behind real close");
        expect(voiding.state.outcome).toBeUndefined();
      } finally { await finish(controller, observer, [closing, voiding]); }
      expect(closing!.state.outcome).toMatchObject({ status: "resolved", value: { reason: null, difference: ZERO } });
      const saved = await db.getShift(f.shift.id);
      const breakdown = await db.shiftDrawerBreakdown(saved!);
      // Read every witness before asserting the refusal, so the red baseline
      // records the documentary/closed-snapshot divergence as well as success.
      expect({ outcome: voiding!.state.outcome,
        savedExpected: saved!.expected[currency], counted: saved!.counted![currency],
        recomputedExpected: breakdown.expected[currency], sourceCash: await sourceCash(f),
      }).toMatchObject({ outcome: { status: "resolved", value: { ok: false, reason: "closed_shift" } },
        savedExpected: 8_000, counted: 8_000, recomputedExpected: 8_000, sourceCash: 8_000 });
      expect(await reversalRows(f.expense.id)).toEqual([]);
      expect(await auditCount(f.expense.id)).toBe(0);
      expect(await db.getExpense(f.expense.id)).toEqual(original);
      expect(saved).toMatchObject({ status: "closed", expectedSource: "stored", difference: ZERO,
        expected: { ...ZERO, [currency]: 8_000 }, counted: { ...ZERO, [currency]: 8_000 } });
      expect(await sourceCash(f)).toBe(8_000);
      expect((await db.shiftDrawerBreakdown(saved!)).expected).toEqual(saved!.expected);
    });
  }

  it("reversal wins: close waits and includes its committed source before freezing expected", async () => {
    const f = await fixture();
    const original = await db.getExpense(f.expense.id);
    const controller = await connection();
    const observer = await connection();
    let closing: Closing | undefined;
    let voiding: Voiding | undefined;
    try {
      await hold(controller, VOID_GATE);
      voiding = observe(db.voidExpense(f.expense.id, { actor: ACTOR, reason: "Synthetic correction" }));
      await until(async () => (await waitingPid(observer, "%INSERT INTO expenses (%")) !== null, "real reversal reaches insertion barrier");
      closing = observe(db.closeShift({ id: f.shift.id, closedBy: ACTOR, counted: { ...ZERO, YER: 10_000 }, note: null }));
      // SHIFT_SELECT is long: pg_stat_activity truncates its trailing FOR UPDATE.
      await until(async () => Boolean(closing!.state.outcome) || (await waitingPid(observer, "SELECT s.*%")) !== null, "close waits for admitted reversal");
      expect(closing.state.outcome, "Close must not compute before the admitted reversal commits").toBeUndefined();
    } finally { await finish(controller, observer, [closing, voiding]); }
    expect(voiding!.state.outcome).toMatchObject({ status: "resolved", value: { ok: true } });
    expect(closing!.state.outcome).toMatchObject({ status: "resolved", value: { reason: null, difference: ZERO } });
    expect(await db.getExpense(f.expense.id)).toEqual(original);
    expect(await reversalRows(f.expense.id)).toMatchObject([{ shift_id: f.shift.id, amount_minor: "-2000" }]);
    expect(await auditCount(f.expense.id)).toBe(1);
    const saved = await db.getShift(f.shift.id);
    expect(saved).toMatchObject({ status: "closed", expected: { ...ZERO, YER: 10_000 }, counted: { ...ZERO, YER: 10_000 }, difference: ZERO });
    expect(await sourceCash(f)).toBe(10_000);
    expect((await db.shiftDrawerBreakdown(saved!)).expected).toEqual(saved!.expected);
  });
});

describe("supplier and existing reversal contracts remain intact", () => {
  it("supplier close wins: reversal waits then returns no_shift without changing its payable", async () => {
    const f = await fixture("YER", true);
    const original = await db.getExpense(f.expense.id);
    const controller = await connection();
    const observer = await connection();
    let closing: Closing | undefined;
    let voiding: Voiding | undefined;
    try {
      await hold(controller, CLOSE_GATE);
      closing = observe(db.closeShift({ id: f.shift.id, closedBy: ACTOR, counted: { ...ZERO, YER: 8_000 }, note: null }));
      let closingPid: number | null = null;
      await until(async () => ((closingPid = await waitingPid(observer, "%UPDATE cashier_shifts SET%")) !== null), "supplier close paused");
      voiding = observe(db.voidExpense(f.expense.id, { actor: ACTOR, reason: "Synthetic supplier correction" }));
      await until(async () => Boolean(voiding!.state.outcome) || await otherWait(observer, closingPid!), "supplier reversal waits for close");
      expect(voiding.state.outcome).toBeUndefined();
    } finally { await finish(controller, observer, [closing, voiding]); }
    expect(closing!.state.outcome).toMatchObject({ status: "resolved", value: { reason: null } });
    expect(voiding!.state.outcome).toMatchObject({ status: "resolved", value: { ok: false, reason: "no_shift" } });
    expect(await reversalRows(f.expense.id)).toEqual([]);
    expect(await auditCount(f.expense.id)).toBe(0);
    expect(await db.getExpense(f.expense.id)).toEqual(original);
    expect(await sourceCash(f)).toBe(8_000);
  });

  it("supplier history reverses into the current shift and preserves the old closed snapshot", async () => {
    const f = await fixture("YER", true);
    const closed = await db.closeShift({ id: f.shift.id, closedBy: ACTOR, counted: { ...ZERO, YER: 8_000 }, note: null });
    expect(closed.reason).toBeNull();
    const saved = await db.getShift(f.shift.id);
    const today = await db.openShift({ openedBy: ACTOR, opening: { ...ZERO, YER: 8_000 } });
    expect(today).not.toBeNull();
    const result = await db.voidExpense(f.expense.id, { actor: ACTOR, reason: "Synthetic supplier correction" });
    expect(result.ok).toBe(true);
    expect(await reversalRows(f.expense.id)).toMatchObject([{ shift_id: today!.id, amount_minor: "-2000" }]);
    expect((await db.getShift(today!.id))!.expected).toEqual({ ...ZERO, YER: 10_000 });
    expect(await db.getShift(f.shift.id)).toEqual(saved);
    const { rows: [settled] } = await db.getPool().query<{ n: string }>(
      "SELECT sum(payable_settled_minor)::text AS n FROM expenses WHERE payable_id = $1", [f.payableId]);
    expect(settled.n).toBe("0");
    expect(await auditCount(f.expense.id)).toBe(1);
  });

  it("a different open shift never authorizes a direct reversal of an already closed shift", async () => {
    const f = await fixture();
    expect((await db.closeShift({ id: f.shift.id, closedBy: ACTOR, counted: { ...ZERO, YER: 8_000 }, note: null })).reason).toBeNull();
    const saved = await db.getShift(f.shift.id);
    await db.openShift({ openedBy: ACTOR, opening: { ...ZERO, YER: 8_000 } });
    expect(await db.voidExpense(f.expense.id, { actor: ACTOR, reason: "Synthetic correction" }))
      .toMatchObject({ ok: false, reason: "closed_shift" });
    expect(await reversalRows(f.expense.id)).toEqual([]);
    expect(await auditCount(f.expense.id)).toBe(0);
    expect(await db.getShift(f.shift.id)).toEqual(saved);
  });

  it("concurrent direct reversals create one mirror and one audit only", async () => {
    const f = await fixture();
    const controller = await connection();
    const observer = await connection();
    let first: Voiding | undefined;
    let second: Voiding | undefined;
    try {
      await hold(controller, VOID_GATE);
      first = observe(db.voidExpense(f.expense.id, { actor: ACTOR, reason: "Synthetic correction" }));
      let firstPid: number | null = null;
      await until(async () => ((firstPid = await waitingPid(observer, "%INSERT INTO expenses (%")) !== null), "first reversal paused");
      second = observe(db.voidExpense(f.expense.id, { actor: ACTOR, reason: "Synthetic duplicate" }));
      await until(async () => Boolean(second!.state.outcome) || await otherWait(observer, firstPid!), "duplicate waits for origin");
      expect(second.state.outcome).toBeUndefined();
    } finally { await finish(controller, observer, [first, second]); }
    expect(first!.state.outcome).toMatchObject({ status: "resolved", value: { ok: true } });
    expect(second!.state.outcome).toMatchObject({ status: "resolved", value: { ok: false, reason: "already_voided" } });
    expect(await reversalRows(f.expense.id)).toHaveLength(1);
    expect(await auditCount(f.expense.id)).toBe(1);
    expect(await sourceCash(f)).toBe(10_000);
  });
});
