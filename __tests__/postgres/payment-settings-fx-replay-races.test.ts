import { createHash } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbClient, Payment, QueryResult } from "../../lib/db";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema, stubPostgresEnv } from "./_setup";

// Validate the original destination before the usual test environment rewrite.
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
stubPostgresEnv();
const auth = vi.hoisted(() => ({
  session: { username: "synthetic-settings-fx-race", role: "admin", userId: 1 },
}));
vi.mock("@/lib/session", () => ({ requireSession: async () => auth.session }));
const db = await import("../../lib/db");
const { POST } = await import("../../app/api/payments/route");

const ACTOR = "synthetic-settings-fx-race";
const RAW = 140.1234567;
const STORED = 140.123457;
const NEW_RATE = 175.9876543;
const SHIFT_LOCK = /^SELECT id FROM cashier_shifts WHERE status = 'open' FOR UPDATE$/;
const KEY_READ = /^SELECT id, idempotency_request_hash(?:, exchange_rate)? FROM payments WHERE idempotency_key = \$1$/;
const PAYMENT_INSERT = /^INSERT INTO payments\s*\(/;
let serial = 0;
let closedShiftId: number;

beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
  await db.getPool().query("INSERT INTO cashier_shifts(opened_by) VALUES($1)", [ACTOR]);
  const { rows: [closed] } = await db.getPool().query<{ id: number }>(
    `INSERT INTO cashier_shifts(opened_by,status,closed_by,closed_at,counted_yer,counted_sar,counted_usd)
     VALUES($1,'closed',$1,NOW(),0,0,0) RETURNING id`, [ACTOR],
  );
  closedShiftId = closed.id;
  const { rows: [stock] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO inventory_items(name,created_by) VALUES('Synthetic FX race stock',$1) RETURNING id", [ACTOR],
  );
  await db.getPool().query(
    "INSERT INTO inventory_movements(item_id,kind,qty,created_by) VALUES($1,'in',7,$2)", [stock.id, ACTOR],
  );
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await db.resetPoolForTesting(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`FX race barrier timed out: ${label}`)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
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
  const outcome = await bounded(running.settled, "operation completion");
  if (outcome.status === "rejected") throw outcome.error;
  return outcome.value;
}

type Witness = { sql: string; completed: boolean; rows?: number };
type Pause = { when: "before" | "after"; sql: RegExp };
function transactionHook(pauses: Pause[]) {
  const connected = deferred();
  const barriers = pauses.map((pause) => ({ ...pause, reached: deferred(), release: deferred(), used: false }));
  const statements: Witness[] = [];
  let pid = 0, released = false;
  const pool = db.getPool();
  const connect = pool.connect.bind(pool);
  const spy = vi.spyOn(pool, "connect");
  // Native pg pool.query invokes connect(callback). Forward those calls intact:
  // only the domain writer's explicit promise-based checkout gets the wrapper.
  spy.mockImplementation((...args: unknown[]) => {
    if (args.length) return Reflect.apply(connect, pool, args);
    spy.mockRestore();
    return (async () => {
      const client = await connect();
      const query = client.query.bind(client);
      try { pid = (await query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid; }
      catch (error) { client.release(); throw error; }
      connected.resolve();
      async function pause(when: Pause["when"], sql: string) {
        const barrier = barriers.find((entry) => !entry.used && entry.when === when && entry.sql.test(sql.trim()));
        if (!barrier) return;
        barrier.used = true;
        barrier.reached.resolve();
        await bounded(barrier.release.promise, `release ${when} ${barrier.sql.source}`);
      }
      const wrapper: DbClient = {
        async query<T>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
          const witness: Witness = { sql, completed: false };
          statements.push(witness);
          await pause("before", sql);
          const result = await query<T>(sql, values);
          witness.completed = true;
          witness.rows = result.rows.length;
          if (/^BEGIN$/i.test(sql.trim())) {
            await query("SET LOCAL statement_timeout = '10s'");
            await query("SET LOCAL lock_timeout = '10s'");
            const { rows: [isolation] } = await query<{ level: string }>("SELECT current_setting('transaction_isolation') AS level");
            expect(isolation.level).toBe("read committed");
          }
          await pause("after", sql);
          return result;
        },
        release(destroy) { released = true; client.release(destroy); },
      };
      return wrapper;
    })();
  });
  return { connected, barriers, statements, pid: () => pid, released: () => released, restore: () => spy.mockRestore() };
}
type Hook = ReturnType<typeof transactionHook>;
async function start<T>(
  hooks: Hook[], runs: Promise<unknown>[], pauses: Pause[], operation: () => Promise<T>,
) {
  const hook = transactionHook(pauses);
  hooks.push(hook);
  const running = observe(operation());
  runs.push(running.settled);
  await bounded(Promise.race([hook.connected.promise, running.settled.then(() => {
    throw new Error("Operation ended before its real transaction client connected");
  })]), "transaction connection");
  return { hook, running };
}
async function reached<T>(hook: Hook, running: Running<T>, index = 0) {
  await bounded(Promise.race([hook.barriers[index].reached.promise, running.settled.then(() => {
    throw new Error("Operation ended before the required real SQL barrier");
  })]), "real SQL barrier");
}
async function observerClient() {
  const client = new Client({ connectionString: target.testUrl.toString(), ssl: false, statement_timeout: 5_000 });
  await client.connect();
  return client;
}
async function lockWait<T>(observer: Client, blocked: Hook, ownerPid: number, running: Running<T>, sql: RegExp) {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (running.state.outcome) throw new Error("Operation ended before the required real lock wait");
    // The external winner may hold BEGIN; refresh its cached activity snapshot
    // so the first sample cannot hide a later genuine INSERT lock wait.
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const { rows: [active] } = await observer.query<{
      state: string; query: string; blockers: number[]; wait_event_type: string | null;
    }>("SELECT state,query,pg_blocking_pids(pid) AS blockers,wait_event_type FROM pg_stat_activity WHERE pid=$1", [blocked.pid()]);
    const pending = blocked.statements.at(-1);
    if (active?.state === "active" && active.wait_event_type === "Lock" && active.blockers.includes(ownerPid)
      && pending && !pending.completed && sql.test(pending.sql.trim()) && pending.sql.startsWith(active.query)) return;
    // Scheduler yield only: observed PostgreSQL blocking, not elapsed sleep,
    // decides when the next transaction is allowed to progress.
    await new Promise<void>((done) => setImmediate(done));
  }
  throw new Error(`Required PostgreSQL lock wait absent: ${sql.source}`);
}
async function drain(hooks: Hook[], runs: Promise<unknown>[], observer: Client) {
  for (const hook of hooks) {
    hook.restore();
    for (const barrier of hook.barriers) barrier.release.resolve();
  }
  try {
    await observer.query("ROLLBACK");
    await bounded(Promise.all(runs), "drain real transaction operations", 15_000);
  } finally { await observer.end(); }
  for (const hook of hooks) expect(hook.released()).toBe(true);
}
function watchRoutePeek(key: string) {
  const rows: number[] = [];
  const pool = db.getPool();
  const query = pool.query.bind(pool);
  const spy = vi.spyOn(pool, "query").mockImplementation(async function<T>(
    sql: string, values: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await query<T>(sql, values);
    if (/WHERE y\.idempotency_key\s*=\s*\$1/.test(sql) && values[0] === key) rows.push(result.rows.length);
    return result;
  });
  return { rows, restore: () => spy.mockRestore() };
}

async function fixture() {
  const key = `settings-fx-race-${++serial}`;
  const { rows: [patient] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic FX race patient') RETURNING id", [key],
  );
  const { rows: [invoice] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by) VALUES($1,$2,10000,0,'YER',$3) RETURNING id",
    [key, patient.id, ACTOR],
  );
  return { key, patientId: patient.id, invoiceId: invoice.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function input(f: Fixture, amountMinor = 81) {
  return {
    patientId: f.patientId, invoiceId: f.invoiceId, amountMinor, currency: "SAR" as const,
    baseCurrency: "YER" as const, method: "cash", note: null, createdBy: ACTOR,
    actorRole: "admin", idempotencyKey: f.key,
  };
}
function request(f: Fixture, amountMinor = 81) {
  return new Request("http://localhost/api/payments", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": f.key },
    body: JSON.stringify({
      patientId: f.patientId, invoiceId: f.invoiceId, amount: (amountMinor / 100).toFixed(2),
      currency: "SAR", method: "cash",
    }),
  });
}
async function setRate(rate: number | string) {
  return db.saveSettings({ "finance.rate.SAR": String(rate) });
}
async function financialState(f: Fixture) {
  const { rows: [state] } = await db.getPool().query(`
    SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM payments p) AS payments,
      (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM audit_log a WHERE action<>'payment.idempotent_replay') AS original_audits,
      (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY id),'[]') FROM invoice_settlement_reclassification_events e) AS events,
      (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY id),'[]') FROM inventory_items i) AS stock_items,
      (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY id),'[]') FROM inventory_movements m) AS stock_movements,
      (SELECT COALESCE(sum(CASE WHEN kind='payment' THEN amount_minor ELSE -amount_minor END),0)::text FROM payments WHERE patient_id=$1) AS native,
      (SELECT COALESCE(sum(CASE WHEN kind='payment' THEN base_amount_minor ELSE -base_amount_minor END),0)::text FROM payments WHERE patient_id=$1) AS base`, [f.patientId]);
  return {
    ...state,
    balance: db.ledgerBalancesByCurrency(f.patientId, await db.patientLedger(f.patientId), new Map()),
    drawer: (await db.getOpenShift())!.expected,
  };
}
async function audits(f: Fixture) {
  return (await db.getPool().query(
    `SELECT * FROM audit_log WHERE entity='payment'
     AND entity_id IN (SELECT id::text FROM payments WHERE idempotency_key=$1) ORDER BY id`, [f.key],
  )).rows;
}
async function expectHttpAudit(f: Fixture, before: Awaited<ReturnType<typeof audits>>, replayed: boolean, paymentId: number) {
  const after = await audits(f);
  if (!replayed) { expect(after).toEqual(before); return; }
  expect(after).toHaveLength(before.length + 1);
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.at(-1)).toMatchObject({
    action: "payment.idempotent_replay", entity: "payment", entity_id: String(paymentId),
    actor: ACTOR, actor_role: "admin", details: { المريض: f.patientId, مفتاح_الإعادة: f.key },
  });
}

describe("settings-owned FX retry after a real winner transaction/shift-lock wait", () => {
  it.each([
    { id: "A09", winnerRate: STORED, observedRate: NEW_RATE, laterRate: "191.7654321", amount: 81, status: 200, base: 114 },
    { id: "A10/A15 exact", winnerRate: RAW, observedRate: RAW, laterRate: String(NEW_RATE), amount: 81, status: 200, base: 113 },
    { id: "A11 lost raw", winnerRate: RAW, observedRate: NEW_RATE, laterRate: String(RAW), amount: 81, status: 409, base: 113 },
    { id: "A12 invalid observation", winnerRate: STORED, observedRate: "invalid", laterRate: "invalid", amount: 81, status: 200, base: 114 },
    { id: "A15 changed payload", winnerRate: STORED, observedRate: STORED, laterRate: String(NEW_RATE), amount: 82, status: 409, base: 114 },
  ])("$id: route miss resolves only with the complete permitted winning hash", async (scenario) => {
    const f = await fixture();
    const captured = await setRate(scenario.winnerRate);
    const hooks: Hook[] = [], runs: Promise<unknown>[] = [];
    const observer = await observerClient();
    const peek = watchRoutePeek(f.key);
    try {
      const winner = await start(hooks, runs, [{ when: "before", sql: /^COMMIT$/ }], () =>
        db.recordSettingsOwnedPayment(input(f), captured));
      await reached(winner.hook, winner.running);
      await setRate(scenario.observedRate);
      const retry = await start(hooks, runs, [{ when: "after", sql: SHIFT_LOCK }], () => POST(request(f, scenario.amount)));
      // Reaching the real transaction proves settings and outside peek completed.
      expect(peek.rows).toEqual([0]);
      peek.restore();
      await lockWait(observer, retry.hook, winner.hook.pid(), retry.running, SHIFT_LOCK);
      await setRate(scenario.laterRate);
      winner.hook.barriers[0].release.resolve();
      const original = await finish(winner.running);
      expect(original.reason).toBeNull();
      expect(original.payment).toMatchObject({ amountMinor: 81, baseAmountMinor: scenario.base, exchangeRate: STORED });
      await reached(retry.hook, retry.running);
      const before = await financialState(f), beforeAudits = await audits(f);
      expect(beforeAudits.filter((row) => row.action === "payment.create")).toHaveLength(1);
      retry.hook.barriers[0].release.resolve();
      const response = await finish(retry.running);
      expect(response.status).toBe(scenario.status);
      const body = await response.json();
      if (scenario.status === 200) expect(body).toMatchObject({ id: original.payment!.id, baseAmountMinor: scenario.base });
      else expect(body.message).toContain("مفتاح الإعادة");
      expect(await financialState(f)).toEqual(before);
      await expectHttpAudit(f, beforeAudits, scenario.status === 200, original.payment!.id);
      expect(retry.hook.statements.filter((row) => KEY_READ.test(row.sql.trim())).map((row) => row.rows)).toEqual([1]);
      expect(retry.hook.statements.filter((row) => PAYMENT_INSERT.test(row.sql.trim()))).toEqual([]);
      expect((await db.getPool().query("SELECT count(*)::int AS n FROM payments WHERE idempotency_key=$1", [f.key])).rows).toEqual([{ n: 1 }]);
    } finally { peek.restore(); await drain(hooks, runs, observer); }
  });
});

function legacyHash(f: Fixture, exchangeRate: number) {
  return createHash("sha256").update(JSON.stringify({
    v: 1, actor: ACTOR, patientId: f.patientId, invoiceId: f.invoiceId, kind: "payment", amountMinor: 81,
    currency: "SAR", baseCurrency: "YER", exchangeRate, method: "cash", reversalOfId: null,
  }), "utf8").digest("hex");
}
async function insertUncommittedLegacyWinner(client: Client, f: Fixture, rate: number, hash: string) {
  const { rows: [winner] } = await client.query<{ id: number }>(
    `INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,
       exchange_rate,base_amount_minor,base_currency,method,created_by,idempotency_key,idempotency_request_hash)
     VALUES($1,$2,$3,$4,'payment',81,'SAR',$5,$6,'YER','cash',$7,$8,$9) RETURNING id`,
    [`${f.key}-legacy`, f.patientId, f.invoiceId, closedShiftId, rate, Math.round(81 / 100 * rate), ACTOR, f.key, hash],
  );
  return winner.id;
}
type PaymentResult = { reason: string | null; payment: Payment | null; replayed?: boolean };
async function purposeReceipt(f: Fixture, rate: number, requestHash: string): Promise<PaymentResult> {
  const client = await db.getPool().connect();
  let result: Awaited<ReturnType<typeof db.writeDebtCollectionReceipt>>;
  try {
    await client.query("BEGIN");
    result = await db.writeDebtCollectionReceipt(client, {
      ...input(f), openingCurrency: null, exchangeRate: rate, requestHash,
    });
    await client.query(result.kind === "reason" ? "ROLLBACK" : "COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  if (result.kind === "reason") return { payment: null, reason: result.reason };
  return { payment: await db.getPayment(result.paymentId), reason: null, replayed: result.kind === "replay" };
}

describe("A16 real post-ON-CONFLICT lookup preserves the same bounded mode-specific matcher", () => {
  it.each([
    { label: "settings stored winner survives different observed/current rates", mode: "settings", winnerRate: STORED, observedRate: NEW_RATE, laterRate: "190", amount: 81, replay: true, purpose: false },
    { label: "settings retains captured raw despite later settings replacement", mode: "settings", winnerRate: RAW, observedRate: RAW, laterRate: String(NEW_RATE), amount: 81, replay: true, purpose: false },
    { label: "settings cannot recover lost raw even if settings later return to it", mode: "settings", winnerRate: RAW, observedRate: NEW_RATE, laterRate: String(RAW), amount: 81, replay: false, purpose: false },
    { label: "settings never reconstructs the winner's changed native payload", mode: "settings", winnerRate: STORED, observedRate: NEW_RATE, laterRate: "190", amount: 82, replay: false, purpose: false },
    { label: "explicit changed FX cannot borrow the stored winner's FX", mode: "explicit", winnerRate: STORED, observedRate: 141, laterRate: String(STORED), amount: 81, replay: false, purpose: false },
    { label: "explicit exact raw still replays its unchanged v1 hash", mode: "explicit", winnerRate: RAW, observedRate: RAW, laterRate: "190", amount: 81, replay: true, purpose: false },
    { label: "purpose override cannot fall back to a generic stored-FX hash", mode: "purpose", winnerRate: STORED, observedRate: STORED, laterRate: "190", amount: 81, replay: false, purpose: false },
    { label: "purpose override replays only its exact opaque purpose hash", mode: "purpose", winnerRate: STORED, observedRate: 141, laterRate: "190", amount: 81, replay: true, purpose: true },
    { label: "settings mode cannot borrow a matching row with a purpose hash", mode: "settings", winnerRate: STORED, observedRate: STORED, laterRate: "190", amount: 81, replay: false, purpose: true },
  ] as const)("$label", async (scenario) => {
    const f = await fixture();
    const captured = await setRate(scenario.observedRate);
    const hooks: Hook[] = [], runs: Promise<unknown>[] = [];
    // This independent transaction models an imported/legacy successful key.
    // Its closed shift avoids FK contention with the retry's normally locked
    // OPEN shift. No production lock, guard, query result or row is weakened.
    const external = await observerClient();
    const { rows: [owner] } = await external.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const purposeHash = "a".repeat(64);
    try {
      const retry = await start(hooks, runs, [
        { when: "after", sql: KEY_READ }, { when: "after", sql: PAYMENT_INSERT },
      ], () => {
        if (scenario.mode === "settings") return db.recordSettingsOwnedPayment(input(f, scenario.amount), captured);
        if (scenario.mode === "explicit") return db.recordPayment({
          ...input(f, scenario.amount), kind: "payment", exchangeRate: scenario.observedRate,
        });
        return purposeReceipt(f, scenario.observedRate, purposeHash);
      });
      await reached(retry.hook, retry.running);
      expect(retry.hook.statements.filter((row) => KEY_READ.test(row.sql.trim())).map((row) => row.rows)).toEqual([0]);
      await external.query("BEGIN");
      const winnerId = await insertUncommittedLegacyWinner(
        external, f, scenario.winnerRate, scenario.purpose ? purposeHash : legacyHash(f, scenario.winnerRate),
      );
      await setRate(scenario.laterRate);
      retry.hook.barriers[0].release.resolve();
      await lockWait(external, retry.hook, owner.pid, retry.running, PAYMENT_INSERT);
      await external.query("COMMIT");
      await reached(retry.hook, retry.running, 1);
      expect(retry.hook.statements.filter((row) => PAYMENT_INSERT.test(row.sql.trim())).map((row) => row.rows)).toEqual([0]);
      const before = await financialState(f), beforeAudits = await audits(f);
      expect(beforeAudits).toEqual([]); // Never backfill invented creation evidence.
      retry.hook.barriers[1].release.resolve();
      const result = await finish(retry.running);
      if (scenario.replay) expect(result).toMatchObject({ reason: null, replayed: true, payment: { id: winnerId } });
      else expect(result).toMatchObject({ reason: "idempotency_conflict", payment: null });
      expect(retry.hook.statements.filter((row) => KEY_READ.test(row.sql.trim())).map((row) => row.rows)).toEqual([0, 1]);
      expect(await financialState(f)).toEqual(before);
      expect(await audits(f)).toEqual(beforeAudits);
      expect((await db.getPool().query("SELECT count(*)::int AS n FROM payments WHERE idempotency_key=$1", [f.key])).rows).toEqual([{ n: 1 }]);
    } finally { await drain(hooks, runs, external); }
  });
});
