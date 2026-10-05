import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CashierShift, DbClient, Payment, QueryResult } from "../../lib/db";
import { prepareManualCashFixture } from "./_manual-cash-fixture";
import { validatePostgresTestTarget } from "./_safe-target";
import { stubPostgresEnv } from "./_setup";

/** Real PG18 domain writers, synthetic data only. Validate the ORIGINAL target
 * and Railway/production markers before stubPostgresEnv rewrites anything.
 * The existing fresh-only fixture permits schema reset only with its explicit
 * disposable-CI opt-in, after loopback/aqlan_p1_test validation. No migration,
 * runtime hook, fabricated query result, source rewrite or fixed-sleep oracle. */
const originalEnvironment = { ...process.env };
const target = validatePostgresTestTarget(originalEnvironment);
stubPostgresEnv();
const db = await import("../../lib/db");
const ACTOR = "synthetic-payment-shift-admission";
const ZERO = { YER: 0, SAR: 0, USD: 0 };
const SHIFT_LOCK = /^SELECT id FROM cashier_shifts WHERE status = 'open' FOR UPDATE$/;
const CLOSE_WRITE = /^UPDATE cashier_shifts SET/;
const PAYMENT_INSERT = /^INSERT INTO payments\s*\(/;
const FIRST_KEY_READ = /^SELECT id, idempotency_request_hash FROM payments WHERE idempotency_key = \$1$/;
type Kind = "receipt" | "refund" | "void";
type Currency = "YER" | "SAR" | "USD";
const KINDS: Kind[] = ["receipt", "refund", "void"];
let serial = 0;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 12_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Payment shift barrier timed out: ${label}`)), milliseconds);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
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
type Running<T> = ReturnType<typeof observe<T>>;
async function finish<T>(running: Running<T>): Promise<T> {
  const outcome = await bounded(running.settled, "domain operation completion");
  if (outcome.status === "rejected") throw outcome.error;
  return outcome.value;
}

/** Scheduling-only wrapper of one genuine checked-out client. It forwards the
 * original SQL/arguments and returns the unmodified real result after a barrier.
 * Adapted from lab-batch-full-allocation.test.ts's real-client transactionHook. */
type Witness = { sql: string; values: unknown[]; completed: boolean; rowCount?: number };
function transactionHook(after: RegExp) {
  const connected = deferred(), paused = deferred(), release = deferred();
  const statements: Witness[] = [];
  let pid = 0, pausedOnce = false, released = false;
  const connect = db.getPool().connect.bind(db.getPool());
  const spy = vi.spyOn(db.getPool(), "connect").mockImplementationOnce(async () => {
    const client = await connect();
    const query = client.query.bind(client);
    try { pid = (await query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid; }
    catch (error) { client.release(); throw error; }
    connected.resolve();
    const wrapper: DbClient = {
      async query<T>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
        const witness: Witness = { sql, values, completed: false };
        statements.push(witness);
        const result = await query<T>(sql, values);
        witness.completed = true;
        witness.rowCount = result.rows.length;
        if (/^BEGIN\s*;?$/i.test(sql.trim())) {
          await query("SET LOCAL statement_timeout = '10s'");
          await query("SET LOCAL lock_timeout = '10s'");
          const { rows: [isolation] } = await query<{ level: string }>("SELECT current_setting('transaction_isolation') AS level");
          expect(isolation.level).toBe("read committed");
        }
        if (!pausedOnce && after.test(sql.trim())) {
          pausedOnce = true;
          paused.resolve();
          await bounded(release.promise, "release real query result");
        }
        return result;
      },
      release: () => { released = true; client.release(); },
    };
    return wrapper;
  });
  return { connected, paused, release, statements, pid: () => pid, released: () => released,
    restore: () => spy.mockRestore() };
}
type Hook = ReturnType<typeof transactionHook>;
async function start<T>(hooks: Hook[], runs: Promise<unknown>[], after: RegExp, operation: () => Promise<T>) {
  const hook = transactionHook(after);
  hooks.push(hook);
  const running = observe(operation());
  runs.push(running.settled);
  await bounded(Promise.race([hook.connected.promise, running.settled.then(() => {
    throw new Error("Domain operation ended before its real client connected");
  })]), "real domain client connection");
  // Do not intercept a later pool.query/openShift/hydration connection.
  hook.restore();
  return { hook, running };
}
async function reached<T>(hook: Hook, running: Running<T>) {
  await bounded(Promise.race([hook.paused.promise, running.settled.then(() => {
    throw new Error("Domain operation ended before its required SQL barrier");
  })]), "completed real SQL barrier");
}
async function observerClient() {
  const client = new Client({ connectionString: target.testUrl.toString(), ssl: false, statement_timeout: 5_000 });
  await client.connect();
  return client;
}
async function blockedBy(observer: Client, blocked: Hook, owner: Hook, statement: RegExp) {
  const { rows: [active] } = await observer.query<{
    state: string; query: string; blockers: number[]; wait_event_type: string | null;
  }>("SELECT state, query, pg_blocking_pids(pid) AS blockers, wait_event_type FROM pg_stat_activity WHERE pid = $1 AND datname = current_database()", [blocked.pid()]);
  const pending = blocked.statements[blocked.statements.length - 1];
  return active?.state === "active" && active.wait_event_type === "Lock"
    && active.blockers.includes(owner.pid()) && !!pending && !pending.completed
    && statement.test(pending.sql.trim()) && active.query.length > 0 && pending.sql.startsWith(active.query);
}
async function lockWait<T>(observer: Client, blocked: Hook, owner: Hook, running: Running<T>, statement: RegExp) {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (running.state.outcome) throw new Error("Domain operation ended before the required owner/SQL lock wait");
    if (await blockedBy(observer, blocked, owner, statement)) return;
    await new Promise<void>((done) => setImmediate(done));
  }
  throw new Error(`Required lock wait absent: blocked=${blocked.pid()} owner=${owner.pid()} SQL=${statement.source}`);
}
/** Fixed code finishes with no_shift while S1 close is held. Original code
 * instead waits at the real INSERT/FK. Accommodate both schedules, then release
 * the owner and assert the SAME semantic result after draining. A timeout or
 * absent-query assertion must not be the old-source negative-control failure. */
async function outcomeOrInsertWait<T>(observer: Client, blocked: Hook, owner: Hook, running: Running<T>) {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (running.state.outcome) return "settled" as const;
    if (await blockedBy(observer, blocked, owner, PAYMENT_INSERT)) return "insert_wait" as const;
    await new Promise<void>((done) => setImmediate(done));
  }
  throw new Error("Neither a completed refusal nor an actual replacement-shift INSERT/FK wait was observed");
}
async function drain(hooks: Hook[], runs: Promise<unknown>[], observer: Client) {
  for (const hook of hooks) { hook.release.resolve(); hook.restore(); }
  try { await bounded(Promise.all(runs), "release and drain all actual domain calls", 15_000); }
  finally { await observer.end(); }
  for (const hook of hooks) expect(hook.released()).toBe(true);
}

async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await db.getPool().query<T>(sql, values)).rows;
}
async function counters() {
  return {
    receipts: await q("SELECT last_value::text, is_called FROM receipt_number_seq"),
    payments: await q("SELECT last_value::text, is_called FROM payments_id_seq"),
  };
}
async function close(shift: CashierShift) {
  return db.closeShift({ id: shift.id, closedBy: ACTOR, counted: shift.expected, note: "Synthetic admission close" });
}
async function open() {
  const shift = await db.openShift({ openedBy: ACTOR, opening: { ...ZERO, YER: 1_000 } });
  if (!shift) throw new Error("Synthetic shift did not open");
  return shift;
}
async function cleanupOpenShift() {
  const shift = await db.getOpenShift();
  if (!shift) return;
  expect(shift.openedBy, "Never close a shift outside this fixture").toBe(ACTOR);
  expect((await close(shift)).reason).toBeNull();
}
async function fixture(currency: Currency = "YER") {
  const shift = await open();
  const label = `${ACTOR}-${++serial}`;
  const [patient] = await q<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id", [label]);
  const invoice = await db.createInvoice({ patientId: patient.id, baseCurrency: currency,
    discountMinor: 0, note: null, createdBy: ACTOR,
    items: [{ serviceId: null, doctorId: null, description: label, quantity: 1, unitPriceMinor: 5_000 }] });
  if (!invoice) throw new Error("Synthetic invoice was not created");
  const input = { patientId: patient.id, invoiceId: invoice.id, planId: null, openingCurrency: null,
    kind: "payment" as const, amountMinor: 500, currency, baseCurrency: "YER" as const,
    exchangeRate: currency === "YER" ? 1 : 140, method: "cash", note: label, createdBy: ACTOR };
  const original = await db.recordPayment({ ...input, idempotencyKey: `${label}-origin` });
  if (original.reason !== null || !original.payment) throw new Error(`Synthetic origin refused: ${original.reason}`);
  const current = await db.getShift(shift.id);
  if (!current) throw new Error("Synthetic shift disappeared");
  return { label, patientId: patient.id, invoice, input, origin: original.payment, shift: current };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Result = { reason: string | null; replayed?: boolean; ids: number[]; payment?: Payment | null };
async function invoke(f: Fixture, kind: Kind, key: string, changed = false): Promise<Result> {
  if (kind === "void") {
    const result = await db.correctPayment({ paymentId: f.origin.id,
      reason: changed ? "Different synthetic correction reason" : "Synthetic wrong receipt",
      actor: ACTOR, actorRole: "admin", idempotencyKey: key, replacement: null });
    if (result.reason !== null) return { reason: result.reason, ids: [] };
    return { reason: null, replayed: result.replayed, ids: result.reversal ? [result.reversal.id] : [], payment: result.reversal };
  }
  const result = await db.recordPayment({ ...f.input, kind: kind === "refund" ? "refund" : "payment",
    amountMinor: changed ? 201 : 200, idempotencyKey: key,
    reversalOfId: kind === "refund" ? f.origin.id : null,
    // A refund must ignore this caller rate and retain its origin's stored rate.
    exchangeRate: kind === "refund" ? 999 : f.input.exchangeRate });
  return { reason: result.reason, replayed: result.replayed, ids: result.payment ? [result.payment.id] : [], payment: result.payment };
}
async function financialState(f: Fixture) {
  return {
    payments: await q("SELECT * FROM payments ORDER BY id"),
    correctionAudits: await q("SELECT * FROM audit_log WHERE action = 'payment.correct' ORDER BY id"),
    ledger: await db.patientLedger(f.patientId),
    remainders: await db.patientReceiptRemainders(f.patientId),
    journal: (await db.journalEntries("0001-01-01", "2099-12-31")).sort((left, right) =>
      `${left.source}/${left.reference}/${left.date}`.localeCompare(`${right.source}/${right.reference}/${right.date}`)),
    counters: await counters(),
  };
}
async function closedWitness(id: number) {
  const shift = await db.getShift(id);
  if (!shift) throw new Error("Closed synthetic shift missing");
  return { shift, recomputed: (await db.shiftDrawerBreakdown(shift)).expected,
    payments: await q("SELECT * FROM payments WHERE shift_id = $1 ORDER BY id", [id]) };
}
function delta(kind: Kind) { return kind === "receipt" ? 200 : kind === "refund" ? -200 : -500; }

beforeAll(async () => {
  await prepareManualCashFixture(originalEnvironment);
  await db.ensureSchema(); // Cold-start setval/bootstrap precedes every counter baseline.
  const [server] = await q<{ version: string }>("SELECT current_setting('server_version_num') AS version");
  expect(Math.floor(Number(server.version) / 10_000)).toBe(18);
}, 180_000);
beforeEach(cleanupOpenShift);
afterEach(cleanupOpenShift);
afterAll(async () => { vi.restoreAllMocks(); await db.resetPoolForTesting(); });

describe("payment shift admission uses the exact row locked before settlement targets", () => {
  it.each(KINDS)("rollover close wins: %s cannot enter replacement S1 after its saved close", async (kind) => {
    const f = await fixture();
    const before = await financialState(f);
    const hooks: Hook[] = [], runs: Promise<unknown>[] = [];
    const observer = await observerClient();
    let s1: CashierShift | undefined;
    let result: Result | undefined;
    try {
      const firstClose = await start(hooks, runs, CLOSE_WRITE, () => close(f.shift));
      await reached(firstClose.hook, firstClose.running);
      const writing = await start(hooks, runs, SHIFT_LOCK, () => invoke(f, kind, `${f.label}-rollover`));
      await lockWait(observer, writing.hook, firstClose.hook, writing.running, SHIFT_LOCK);
      firstClose.hook.release.resolve();
      expect((await finish(firstClose.running)).reason).toBeNull();
      await reached(writing.hook, writing.running);
      expect(writing.hook.statements.find((s) => SHIFT_LOCK.test(s.sql.trim()))?.rowCount).toBe(0);
      s1 = await open();
      const secondClose = await start(hooks, runs, CLOSE_WRITE, () => close(s1!));
      await reached(secondClose.hook, secondClose.running);
      writing.hook.release.resolve();
      await outcomeOrInsertWait(observer, writing.hook, secondClose.hook, writing.running);
      secondClose.hook.release.resolve();
      expect((await finish(secondClose.running)).reason).toBeNull();
      result = await finish(writing.running);
    } finally { await drain(hooks, runs, observer); }
    const closed = await closedWitness(s1!.id);
    const after = await financialState(f);
    // Collect all facts before semantic assertions so the old-source run exposes
    // its successful late row AND saved/recomputed cash divergence, not a timeout.
    expect.soft({ result, expected: closed.shift.expected, counted: closed.shift.counted,
      recomputed: closed.recomputed, payments: closed.payments }).toMatchObject({
      result: { reason: "no_shift", ids: [] }, expected: { ...ZERO, YER: 1_000 },
      counted: { ...ZERO, YER: 1_000 }, recomputed: { ...ZERO, YER: 1_000 }, payments: [],
    });
    expect.soft(after).toEqual(before);
    expect(closed.shift).toMatchObject({ status: "closed", expectedSource: "stored", difference: ZERO });
    expect((await db.getShift(f.shift.id))!.expected).toEqual(f.shift.expected);
  });

  it.each(KINDS)("initial absence: %s ignores a late-open S1, then the same unspent key succeeds on fresh retry", async (kind) => {
    const f = await fixture();
    expect((await close(f.shift)).reason).toBeNull();
    const before = await financialState(f);
    const hooks: Hook[] = [], runs: Promise<unknown>[] = [];
    const observer = await observerClient();
    const key = `${f.label}-initially-absent`;
    let s1: CashierShift | undefined;
    let result: Result | undefined;
    try {
      const writing = await start(hooks, runs, SHIFT_LOCK, () => invoke(f, kind, key));
      await reached(writing.hook, writing.running);
      expect(writing.hook.statements.find((s) => SHIFT_LOCK.test(s.sql.trim()))?.rowCount).toBe(0);
      s1 = await open();
      writing.hook.release.resolve();
      result = await finish(writing.running);
    } finally { await drain(hooks, runs, observer); }
    expect.soft(result).toMatchObject({ reason: "no_shift", ids: [] });
    expect(await financialState(f)).toEqual(before);
    const retried = await invoke(f, kind, key);
    expect(retried.reason).toBeNull();
    expect(retried.ids).toHaveLength(1);
    expect(retried.payment?.shiftId).toBe(s1!.id);
    const afterSuccess = await financialState(f);
    const replay = await invoke(f, kind, key);
    expect(replay).toMatchObject({ reason: null, replayed: true, ids: retried.ids });
    expect(await financialState(f)).toEqual(afterSuccess);
  });

  it.each(KINDS)("no open shift at all: %s refuses without allocating receipt or row numbers", async (kind) => {
    const f = await fixture();
    expect((await close(f.shift)).reason).toBeNull();
    const before = await financialState(f);
    expect(await invoke(f, kind, `${f.label}-none`)).toMatchObject({ reason: "no_shift", ids: [] });
    expect(await financialState(f)).toEqual(before);
  });

  it.each(KINDS)("closed-shift %s success still replays and conflicting intent remains a conflict", async (kind) => {
    const f = await fixture();
    const key = `${f.label}-replay`;
    const first = await invoke(f, kind, key);
    expect(first.reason).toBeNull();
    const shift = await db.getOpenShift();
    expect((await close(shift!)).reason).toBeNull();
    const before = await financialState(f);
    expect(await invoke(f, kind, key)).toMatchObject({ reason: null, replayed: true, ids: first.ids });
    expect(await invoke(f, kind, key, true)).toMatchObject({ reason: "idempotency_conflict", ids: [] });
    expect(await financialState(f)).toEqual(before);
  });

  it.each([false, true])("late committed key retains second lookup with no shift: conflict=%s", async (conflict) => {
    const f = await fixture();
    expect((await close(f.shift)).reason).toBeNull();
    const hooks: Hook[] = [], runs: Promise<unknown>[] = [];
    const observer = await observerClient();
    const key = `${f.label}-late-key`;
    let winner: Result | undefined;
    let result: Result | undefined;
    let afterWinner: Awaited<ReturnType<typeof financialState>> | undefined;
    try {
      const writing = await start(hooks, runs, FIRST_KEY_READ, () => invoke(f, "receipt", key));
      await reached(writing.hook, writing.running);
      expect(writing.hook.statements.find((s) => FIRST_KEY_READ.test(s.sql.trim()))?.rowCount).toBe(0);
      expect(writing.hook.statements.find((s) => SHIFT_LOCK.test(s.sql.trim()))?.rowCount).toBe(0);
      await open();
      winner = await invoke(f, "receipt", key, conflict);
      expect(winner.reason).toBeNull();
      expect((await close((await db.getOpenShift())!)).reason).toBeNull();
      afterWinner = await financialState(f);
      writing.hook.release.resolve();
      result = await finish(writing.running);
      expect(writing.hook.statements.filter((s) => FIRST_KEY_READ.test(s.sql.trim()))).toHaveLength(2);
    } finally { await drain(hooks, runs, observer); }
    expect(result).toMatchObject(conflict
      ? { reason: "idempotency_conflict", ids: [] }
      : { reason: null, replayed: true, ids: winner!.ids });
    expect(await financialState(f)).toEqual(afterWinner);
  });

  it.each(KINDS)("admitted %s wins: close waits and includes its committed cash before freezing", async (kind) => {
    const f = await fixture();
    const hooks: Hook[] = [], runs: Promise<unknown>[] = [];
    const observer = await observerClient();
    let result: Result | undefined;
    const counted = { ...f.shift.expected, YER: f.shift.expected.YER + delta(kind) };
    try {
      const writing = await start(hooks, runs, PAYMENT_INSERT, () => invoke(f, kind, `${f.label}-writer-first`));
      await reached(writing.hook, writing.running);
      const closing = await start(hooks, runs, CLOSE_WRITE, () => db.closeShift({
        id: f.shift.id, closedBy: ACTOR, counted, note: "Synthetic writer-first close",
      }));
      await lockWait(observer, closing.hook, writing.hook, closing.running, /FROM cashier_shifts s[\s\S]*FOR UPDATE OF s/);
      writing.hook.release.resolve();
      result = await finish(writing.running);
      await reached(closing.hook, closing.running);
      closing.hook.release.resolve();
      expect((await finish(closing.running)).reason).toBeNull();
    } finally { await drain(hooks, runs, observer); }
    expect(result).toMatchObject({ reason: null });
    expect(result!.payment?.shiftId).toBe(f.shift.id);
    const saved = await closedWitness(f.shift.id);
    expect(saved.shift).toMatchObject({ status: "closed", expectedSource: "stored", expected: counted,
      counted, difference: ZERO });
    expect(saved.recomputed).toEqual(counted);
  });

  it("fresh foreign refund and correction retain origin currency, target and FX after no-shift refusal", async () => {
    const f = await fixture("SAR");
    expect((await close(f.shift)).reason).toBeNull();
    const before = await financialState(f);
    const refundKey = `${f.label}-foreign-refund`, voidKey = `${f.label}-foreign-void`;
    expect((await invoke(f, "refund", refundKey)).reason).toBe("no_shift");
    expect(await financialState(f)).toEqual(before);
    const s1 = await open();
    const refund = await invoke(f, "refund", refundKey);
    expect(refund.payment).toMatchObject({ kind: "refund", currency: "SAR", invoiceId: f.invoice.id,
      amountMinor: 200, exchangeRate: f.origin.exchangeRate, baseCurrency: f.origin.baseCurrency, shiftId: s1.id });
    const corrected = await invoke(f, "void", voidKey);
    expect(corrected.payment).toMatchObject({ kind: "refund", currency: "SAR", invoiceId: f.invoice.id,
      amountMinor: 300, exchangeRate: f.origin.exchangeRate, baseCurrency: f.origin.baseCurrency, shiftId: s1.id });
    expect(refund.payment!.baseAmountMinor + corrected.payment!.baseAmountMinor).toBe(f.origin.baseAmountMinor);
    expect(await db.getPayment(f.origin.id)).toEqual(f.origin);
    const audits = await q<{ details: Record<string, unknown> }>(
      "SELECT details FROM audit_log WHERE action = 'payment.correct' AND entity_id = $1", [String(f.origin.id)]);
    expect(audits).toHaveLength(1);
    expect(audits[0].details).toMatchObject({ المبلغ_المعكوس: 300, العملة_المعكوسة: "SAR", السند_الصحيح: null });
  });
});
