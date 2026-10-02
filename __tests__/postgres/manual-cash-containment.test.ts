import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { validatePostgresTestTarget } from "./_safe-target";
import { stubPostgresEnv } from "./_setup";
import { prepareManualCashFixture } from "./_manual-cash-fixture";

/** Real prospective guard. Standalone runs require a NEW guarded PG18 database;
 * aggregate CI explicitly opts into the existing disposable reset lifecycle. */
const originalEnvironment = { ...process.env };
const target = validatePostgresTestTarget(originalEnvironment);
stubPostgresEnv();
const db = await import("../../lib/db");
const { CASH_ACCOUNT } = await import("../../lib/accounting");
const { CURRENCIES } = await import("../../lib/money");
type Currency = (typeof CURRENCIES)[number];
type ManualInput = Parameters<typeof db.createManualEntry>[0];
const ACTOR = "synthetic-manual-cash-containment";
const REFUSAL = "manual_cash_requires_linked_movement";
const ZERO = { YER: 0, SAR: 0, USD: 0 };
let sequence = 0;

function input(accountCode = CASH_ACCOUNT.YER, currency: Currency = "YER", side: "debit" | "credit" = "debit"): ManualInput {
  return {
    date: "2026-10-02", description: `Synthetic manual guard ${++sequence}`, createdBy: ACTOR,
    lines: [
      { accountCode, currency, amountMinor: 1_000, side },
      { accountCode: "3101", currency, amountMinor: 1_000, side: side === "debit" ? "credit" : "debit" },
    ],
  };
}

async function client(): Promise<Client> {
  const connection = new Client({ connectionString: target.testUrl.toString(), ssl: false });
  await connection.connect();
  await connection.query("SET statement_timeout = '10s'");
  return connection;
}

async function counts() {
  const { rows: [row] } = await db.getPool().query<{
    headers: number; lines: number; audits: number;
  }>(`SELECT
    (SELECT count(*)::int FROM journal_manual WHERE created_by = $1) AS headers,
    (SELECT count(*)::int FROM journal_manual_lines l JOIN journal_manual m ON m.id = l.entry_id WHERE m.created_by = $1) AS lines,
    (SELECT count(*)::int FROM audit_log WHERE actor = $1 AND action = 'journal.manual') AS audits`, [ACTOR]);
  return row;
}

async function closeRemainingSyntheticShift() {
  const shift = await db.getOpenShift();
  if (!shift) return;
  expect(shift.openedBy, "Do not touch another fixture's open shift").toBe(ACTOR);
  const result = await db.closeShift({ id: shift.id, closedBy: ACTOR, counted: shift.expected, note: "Synthetic test cleanup by ordinary close" });
  expect(result.reason).toBeNull();
}

async function openShift(opening = ZERO) {
  const shift = await db.openShift({ openedBy: ACTOR, opening });
  expect(shift).not.toBeNull();
  return shift!;
}

async function assertRefused(command: ManualInput) {
  const before = await counts();
  await expect(db.createManualEntry(command)).rejects.toMatchObject({ code: REFUSAL });
  expect(await counts()).toEqual(before);
}

type Outcome<T> = { status: "resolved"; value: T } | { status: "rejected"; error: unknown };
function observe<T>(promise: Promise<T>) {
  const state: { outcome?: Outcome<T> } = {};
  const settled = promise.then(
    (value): Outcome<T> => (state.outcome = { status: "resolved", value }),
    (error: unknown): Outcome<T> => (state.outcome = { status: "rejected", error }),
  );
  return { state, settled };
}

async function until(condition: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Did not observe PostgreSQL barrier: ${label}`);
}

async function pendingOpeningPid(observer: Client): Promise<number | null> {
  const { rows } = await observer.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
    WHERE datname = current_database() AND application_name = 'aqlan-center-mini'
      AND wait_event_type = 'Lock' AND query ILIKE '%INSERT INTO cashier_shifts%'
    ORDER BY pid LIMIT 1`);
  return rows[0]?.pid ?? null;
}

async function pendingManualInsertPid(observer: Client): Promise<number | null> {
  const { rows } = await observer.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
    WHERE datname = current_database() AND application_name = 'aqlan-center-mini'
      AND wait_event_type = 'Lock' AND query ILIKE '%INSERT INTO journal_manual (%'
    ORDER BY pid LIMIT 1`);
  return rows[0]?.pid ?? null;
}

async function anotherRuntimeLockWait(observer: Client, exceptPid: number): Promise<boolean> {
  const { rows: [row] } = await observer.query<{ waiting: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
      AND application_name = 'aqlan-center-mini' AND wait_event_type = 'Lock' AND pid <> $1
  ) AS waiting`, [exceptPid]);
  return row.waiting;
}

async function pendingClosePid(observer: Client, phase: "lock" | "update"): Promise<number | null> {
  const { rows } = await observer.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
    WHERE datname = current_database() AND application_name = 'aqlan-center-mini'
      AND wait_event_type = 'Lock' AND query ILIKE $1 ORDER BY pid LIMIT 1`,
  // SHIFT_SELECT exceeds pg_stat_activity's default query-length limit; match
  // its unique prefix instead of the trailing FOR UPDATE clause that is cut off.
  [phase === "update" ? "%UPDATE cashier_shifts SET%" : "SELECT s.*%"]);
  return rows[0]?.pid ?? null;
}

beforeAll(async () => {
  await prepareManualCashFixture(originalEnvironment);
  await db.ensureSchema();
  // Fresh synthetic database instrumentation only. The actual openShift INSERT
  // has inserted its row when this AFTER trigger waits, but other transactions
  // cannot see that row until the real domain call commits. No runtime writer
  // is mocked or patched, and no product migration contains this trigger.
  await db.getPool().query(`CREATE FUNCTION test_manual_cash_open_insert_barrier()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.opened_by = 'synthetic-manual-cash-containment' THEN
        PERFORM pg_advisory_xact_lock(140013, 190101);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_manual_cash_open_insert_barrier
      AFTER INSERT ON cashier_shifts FOR EACH ROW
      EXECUTE FUNCTION test_manual_cash_open_insert_barrier();
    CREATE FUNCTION test_manual_cash_close_update_barrier()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.opened_by = 'synthetic-manual-cash-containment' AND NEW.status = 'closed' THEN
        PERFORM pg_advisory_xact_lock(140013, 190102);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_manual_cash_close_update_barrier
      AFTER UPDATE ON cashier_shifts FOR EACH ROW
      EXECUTE FUNCTION test_manual_cash_close_update_barrier()`);
}, 180_000);
beforeEach(closeRemainingSyntheticShift);
afterEach(closeRemainingSyntheticShift);
afterAll(async () => { await db.resetPoolForTesting(); });

describe("prospective manual cash containment at the canonical domain writer", () => {
  for (const currency of CURRENCIES) {
    for (const side of ["debit", "credit"] as const) {
      it(`refuses ${currency} ${side} on its cash account while a shift is open`, async () => {
        await openShift();
        await assertRefused(input(CASH_ACCOUNT[currency], currency, side));
      });
    }
  }

  for (const date of ["2000-01-01", "2099-12-31"]) {
    it(`does not let accounting date ${date} bypass the open-shift guard`, async () => {
      await openShift();
      await assertRefused({ ...input(), date });
    });
  }

  it("recognizes a cash code even if the caller supplies a different line currency", async () => {
    await openShift();
    await assertRefused(input("1101", "USD"));
  });

  it("does not create an unclassified bypass merely because cash lines net to zero", async () => {
    await openShift();
    const command = input();
    command.lines[1].accountCode = CASH_ACCOUNT.YER;
    await assertRefused(command);
  });

  it("preserves valid bank-only manual journals during an open shift", async () => {
    const shift = await openShift();
    const before = await counts();
    const id = await db.createManualEntry(input("1111"));
    expect(id).toEqual(expect.any(Number));
    expect(await counts()).toMatchObject({ headers: before.headers + 1, lines: before.lines + 2 });
    expect((await db.getShift(shift.id))?.expected).toEqual(ZERO);
  });

  it("inserts the classified line snapshot even if a direct caller mutates its draft during an await", async () => {
    await openShift();
    const command = input("1111");
    const saved = db.createManualEntry(command);
    command.lines[0].accountCode = "1101";
    const id = await saved;
    const { rows } = await db.getPool().query<{ account_code: string }>(
      "SELECT account_code FROM journal_manual_lines WHERE entry_id = $1 ORDER BY id", [id],
    );
    expect(rows.map((row) => row.account_code)).toEqual(["1111", "3101"]);
  });

  it("keeps existing no-open-shift cash bookkeeping available without inferring a physical shift", async () => {
    expect(await db.getOpenShift()).toBeNull();
    const before = await counts();
    const id = await db.createManualEntry(input());
    expect(id).toEqual(expect.any(Number));
    expect(await counts()).toMatchObject({ headers: before.headers + 1, lines: before.lines + 2 });
    expect(await db.getOpenShift()).toBeNull();
  });

  it("leaves an existing manual journal and a completed shift snapshot unchanged after refusal", async () => {
    const original = input();
    original.lines = original.lines.map((line) => ({ ...line, amountMinor: 8_000 }));
    const id = await db.createManualEntry(original);
    const first = await openShift({ ...ZERO, YER: 8_000 });
    await closeRemainingSyntheticShift();
    const snapshot = await db.getShift(first.id);
    const journalBefore = (await db.journalEntries("0001-01-01", "2099-12-31")).find((entry) => entry.reference === `JM-${id}`);
    await openShift({ ...ZERO, YER: 8_000 });
    await assertRefused(input());
    expect(await db.getShift(first.id)).toEqual(snapshot);
    const journalAfter = (await db.journalEntries("0001-01-01", "2099-12-31")).find((entry) => entry.reference === `JM-${id}`);
    expect(journalAfter).toEqual(journalBefore);
  });
});

describe("real PostgreSQL opening/manual interleavings", () => {
  it("opening wins: cash posting cannot observe a stale absence and commit behind that opening", async () => {
    const controller = await client();
    const observer = await client();
    const before = await counts();
    let opening: ReturnType<typeof observe<Awaited<ReturnType<typeof db.openShift>>>> | undefined;
    let manual: ReturnType<typeof observe<Awaited<ReturnType<typeof db.createManualEntry>>>> | undefined;
    try {
      await controller.query("BEGIN");
      await controller.query("SELECT pg_advisory_xact_lock(140013, 190101)");
      opening = observe(db.openShift({ openedBy: ACTOR, opening: ZERO }));
      let openingPid: number | null = null;
      await until(async () => ((openingPid = await pendingOpeningPid(observer)) !== null), "real openShift waits inside its AFTER INSERT trigger");
      manual = observe(db.createManualEntry(input()));
      await until(async () => Boolean(manual!.state.outcome) || await anotherRuntimeLockWait(observer, openingPid!), "manual writer finishes or waits behind opening");
      expect(manual.state.outcome, "Cash writer must not commit around an already-inserted but invisible opening row").toBeUndefined();
    } finally {
      await controller.query("COMMIT").catch(() => {});
      await Promise.all([opening?.settled, manual?.settled]);
      await Promise.all([controller.end(), observer.end()]);
    }
    expect(opening!.state.outcome).toMatchObject({ status: "resolved", value: { openedBy: ACTOR, status: "open" } });
    expect(manual!.state.outcome).toMatchObject({ status: "rejected", error: { code: REFUSAL } });
    expect(await counts()).toEqual(before);
  });

  it("manual wins: no-open cash posting commits fully before the blocked next shift opens", async () => {
    const controller = await client();
    const observer = await client();
    const before = await counts();
    let opening: ReturnType<typeof observe<Awaited<ReturnType<typeof db.openShift>>>> | undefined;
    let manual: ReturnType<typeof observe<Awaited<ReturnType<typeof db.createManualEntry>>>> | undefined;
    try {
      await controller.query("BEGIN");
      // Hold the real header INSERT after any prospective shift guard has
      // completed. This does not prescribe the guard's own lock implementation.
      await controller.query("LOCK TABLE journal_manual IN SHARE MODE");
      manual = observe(db.createManualEntry(input()));
      let manualPid: number | null = null;
      await until(async () => ((manualPid = await pendingManualInsertPid(observer)) !== null), "real manual header INSERT is waiting");
      opening = observe(db.openShift({ openedBy: ACTOR, opening: { ...ZERO, YER: 1_000 } }));
      await until(async () => Boolean(opening!.state.outcome) || await anotherRuntimeLockWait(observer, manualPid!), "next opening finishes or waits behind manual transaction");
      expect(opening.state.outcome, "Opening must not commit in the middle of an admitted cash journal").toBeUndefined();
      expect(await counts()).toEqual(before);
    } finally {
      await controller.query("COMMIT").catch(() => {});
      await Promise.all([opening?.settled, manual?.settled]);
      await Promise.all([controller.end(), observer.end()]);
    }
    expect(manual!.state.outcome).toMatchObject({ status: "resolved", value: expect.any(Number) });
    expect(opening!.state.outcome).toMatchObject({ status: "resolved", value: { status: "open", expected: { ...ZERO, YER: 1_000 } } });
    expect(await counts()).toMatchObject({ headers: before.headers + 1, lines: before.lines + 2 });
  });

  it("close racing cash posting either refuses while open or saves only after a completed close", async () => {
    const shift = await openShift();
    const before = await counts();
    const [closed, manual] = await Promise.all([
      observe(db.closeShift({ id: shift.id, closedBy: ACTOR, counted: ZERO, note: null })).settled,
      observe(db.createManualEntry(input())).settled,
    ]);
    expect(closed).toMatchObject({ status: "resolved", value: { reason: null, difference: ZERO } });
    expect((await db.getShift(shift.id))?.expected).toEqual(ZERO);
    if (manual.status === "rejected") {
      expect(manual.error).toMatchObject({ code: REFUSAL });
      expect(await counts()).toEqual(before);
    } else {
      expect(manual.value).toEqual(expect.any(Number));
      expect(await db.getOpenShift()).toBeNull();
      expect(await counts()).toMatchObject({ headers: before.headers + 1, lines: before.lines + 2 });
    }
  });

  it("a bounded cash lock timeout refuses without writes while noncash posting remains available", async () => {
    const controller = await client();
    const observer = await client();
    const before = await counts();
    let cash: ReturnType<typeof observe<Awaited<ReturnType<typeof db.createManualEntry>>>> | undefined;
    try {
      await controller.query("BEGIN");
      await controller.query("LOCK TABLE cashier_shifts IN ROW EXCLUSIVE MODE");
      cash = observe(db.createManualEntry(input()));
      await until(async () => Boolean(cash!.state.outcome) || await anotherRuntimeLockWait(observer, -1), "cash waits on the controller lock");
      expect(cash.state.outcome).toBeUndefined();
      expect(await db.createManualEntry(input("1111"))).toEqual(expect.any(Number));
      const outcome = await cash.settled;
      expect(outcome).toMatchObject({ status: "rejected", error: { code: "manual_cash_shift_busy" } });
      expect(await counts()).toEqual({ ...before, headers: before.headers + 1, lines: before.lines + 2 });
    } finally {
      await controller.query("ROLLBACK").catch(() => {});
      await cash?.settled;
      await Promise.all([controller.end(), observer.end()]);
    }
  });

  it("refuses promptly while close is waiting for a tuple lock, without joining its row-lock cycle", async () => {
    const shift = await openShift();
    const controller = await client();
    const observer = await client();
    const before = await counts();
    let closing: ReturnType<typeof observe<Awaited<ReturnType<typeof db.closeShift>>>> | undefined;
    try {
      await controller.query("BEGIN");
      await controller.query("SELECT id FROM cashier_shifts WHERE id = $1 FOR UPDATE", [shift.id]);
      closing = observe(db.closeShift({ id: shift.id, closedBy: ACTOR, counted: ZERO, note: null }));
      await until(async () => (await pendingClosePid(observer, "lock")) !== null, "real close waits for its row");
      await assertRefused(input());
      expect(closing.state.outcome).toBeUndefined();
    } finally {
      await controller.query("COMMIT").catch(() => {});
      await closing?.settled;
      await Promise.all([controller.end(), observer.end()]);
    }
    expect(closing!.state.outcome).toMatchObject({ status: "resolved", value: { reason: null, difference: ZERO } });
    expect(await counts()).toEqual(before);
  });

  it("waits for a close snapshot already written but uncommitted, then permits no-open bookkeeping", async () => {
    const shift = await openShift();
    const controller = await client();
    const observer = await client();
    const before = await counts();
    let closing: ReturnType<typeof observe<Awaited<ReturnType<typeof db.closeShift>>>> | undefined;
    let manual: ReturnType<typeof observe<Awaited<ReturnType<typeof db.createManualEntry>>>> | undefined;
    try {
      await controller.query("BEGIN");
      await controller.query("SELECT pg_advisory_xact_lock(140013, 190102)");
      closing = observe(db.closeShift({ id: shift.id, closedBy: ACTOR, counted: ZERO, note: null }));
      let closingPid: number | null = null;
      await until(async () => ((closingPid = await pendingClosePid(observer, "update")) !== null), "real close waits after writing its snapshot");
      manual = observe(db.createManualEntry(input()));
      await until(async () => Boolean(manual!.state.outcome) || await anotherRuntimeLockWait(observer, closingPid!), "manual waits for close commit");
      expect(manual.state.outcome).toBeUndefined();
    } finally {
      await controller.query("COMMIT").catch(() => {});
      await Promise.all([closing?.settled, manual?.settled]);
      await Promise.all([controller.end(), observer.end()]);
    }
    expect(closing!.state.outcome).toMatchObject({ status: "resolved", value: { reason: null, difference: ZERO } });
    expect(manual!.state.outcome).toMatchObject({ status: "resolved", value: expect.any(Number) });
    expect((await db.getShift(shift.id))?.expected).toEqual(ZERO);
    expect(await counts()).toMatchObject({ headers: before.headers + 1, lines: before.lines + 2 });
  });
});
