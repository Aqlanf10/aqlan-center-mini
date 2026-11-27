/**
 * 0133 (docs/finance/EXPENSE_REQUEST_RETIREMENTS_0133.md; review #483 6883224187, number 6883984936).
 * "Nothing is recorded under this key" is final only once a retirement for that request has committed.
 * Synthetic PostgreSQL database; real barriers (a gated connection, a held key lock), no sleeps.
 */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Pool, type PoolConfig } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { waitForBlockedBy } from "./_canonical-ready-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-expense-retirements-20261114");
const db = await import("../../lib/db");
const create = await import("../../lib/canonical-expense-create");

const ACCOUNTS = {
  owner: { username: "SYN-RET-OWNER", role: "admin" },
  clerk: { username: "SYN-RET-CLERK", role: "reception", grants: { "finance.expenses.create": true, "finance.expenses.view": true } },
  reader: { username: "SYN-RET-READER", role: "accountant", grants: { "finance.expenses.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let side: Pool;
let serial = 0;
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows as T[];
const n = async (sql: string, args: unknown[] = []) => Number((await q<{ n: string }>(sql, args))[0].n);
const evidence = async (note: string) => ({
  vouchers: await n("SELECT count(*) AS n FROM expenses WHERE note = $1", [note]),
  audits: await n("SELECT count(*) AS n FROM audit_log WHERE action = 'expense.create' AND entity_id IN (SELECT id::text FROM expenses WHERE note = $1)", [note]),
});
/** Audit rows of an explicit retirement (the user's own "end this request for good"); automatic ones write none. */
const retireAudits = (requestKey: string) => n("SELECT count(*) AS n FROM audit_log WHERE action = 'expense.request_retire' AND entity = 'expense_request' AND entity_id = $1", [requestKey]);
const EXPLICIT = { actorRole: "reception" };
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");
const key = () => `syn-ret-${++serial}-${Date.now()}`;

function legacyInput(note: string, amountMinor: number, requestKey: string, actor = ACCOUNTS.clerk.username) {
  return { category: "other" as const, partyId: null, payeeText: "SYN payee", amountMinor, currency: "YER" as const,
    baseCurrency: "YER" as const, exchangeRate: 1, payableId: null, note, createdBy: actor, actorRole: "reception",
    request: { key: requestKey, hash: hashOf(`${actor}|${note}|${amountMinor}`) } };
}
const canonicalBody = (note: string, amount: string) => ({ category: "other", payee: "SYN payee", amount, currency: "YER", note });
async function drawerAvailable() {
  const shift = (await db.getOpenShiftWith(fx.pool))!;
  return shift.expected.YER;
}
async function topUp(amountMinor: number) {
  const [{ id: patientId }] = await q<{ id: number }>("INSERT INTO patients (patient_number, full_name) VALUES ($1, 'SYN patient') RETURNING id", [`SYN-RET-P-${++serial}`]);
  await q(`INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor, currency, base_amount_minor, method, created_by)
    SELECT $1, $2, id, 'payment', $3, 'YER', $3, 'cash', 'synthetic' FROM cashier_shifts WHERE status = 'open'`, [`SYN-RET-R-${serial}`, patientId, amountMinor]);
}
/** The next pool connection waits here: the request has left the client but has not reached the writer. */
function gateNextConnection() {
  const pool = db.getPool(), connect = pool.connect.bind(pool);
  let open!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const atGate = new Promise<void>(resolve => { reached = resolve; });
  // pg's Pool.query calls connect with a callback; transactions call it for a promise. Gate both.
  const spy = vi.spyOn(pool, "connect").mockImplementationOnce(((callback?: (...args: unknown[]) => void) => {
    reached();
    if (callback) { void gate.then(() => (connect as unknown as (cb: typeof callback) => void)(callback)); return undefined; }
    return gate.then(() => connect());
  }) as typeof pool.connect);
  return { atGate, open: () => { open(); spy.mockRestore(); } };
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  side = new Pool({ ...(fx.pool as unknown as { options: PoolConfig }).options, max: 4 });
  expect(await db.openShift({ openedBy: "synthetic", opening: { YER: 1000, SAR: 0, USD: 0 } })).not.toBeNull();
}, 180_000);
beforeEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await side?.end(); await fx?.close(); });

describe("a late first request after the key was retired", () => {
  it("legacy writer: the retry is refused and retired; the late first request then writes nothing", async () => {
    const note = `SYN-RET-LEGACY-${++serial}`, requestKey = key();
    const amount = (await drawerAvailable()) + 500;
    const gate = gateNextConnection();
    const first = db.recordExpense(legacyInput(note, amount, requestKey));
    await gate.atGate;
    const retry = await db.recordExpense(legacyInput(note, amount, requestKey));
    expect(retry).toMatchObject({ expense: null, reason: "exceeds_drawer_cash", keyState: "retired" });
    expect(await n("SELECT count(*) AS n FROM expense_request_retirements WHERE idempotency_key = $1", [requestKey])).toBe(1);
    await topUp(amount * 2);
    gate.open();
    expect(await first).toMatchObject({ expense: null, reason: "expense_request_retired" });
    expect(await evidence(note)).toEqual({ vouchers: 0, audits: 0 });
    expect(await retireAudits(requestKey)).toBe(0);
  });

  it("canonical command: the same, under the operation's own transaction", async () => {
    const note = `SYN-RET-CANON-${++serial}`, requestKey = key();
    const amount = String((await drawerAvailable()) + 700);
    const session = await fx.session("clerk");
    const gate = gateNextConnection();
    const first = create.commandCanonicalExpenseCreate(session, { source: canonicalBody(note, amount), requestKey });
    first.catch(() => undefined);
    await gate.atGate;
    await expect(create.commandCanonicalExpenseCreate(await fx.session("clerk"), { source: canonicalBody(note, amount), requestKey }))
      .rejects.toMatchObject({ code: "exceeds_drawer_cash", keyState: "retired" });
    await topUp(Number(amount) * 2);
    gate.open();
    await expect(first).rejects.toMatchObject({ code: "expense_request_retired", status: 409 });
    expect(await evidence(note)).toEqual({ vouchers: 0, audits: 0 });
    expect(await retireAudits(requestKey)).toBe(0);
  });
});

describe("explicit retirement", () => {
  it("saved first: the receipt comes back, nothing is cancelled or written; another fingerprint is a conflict", async () => {
    const note = `SYN-RET-SAVED-${++serial}`, requestKey = key(), input = legacyInput(note, 10, requestKey);
    const saved = await db.recordExpense(input);
    expect(saved.expense?.id).toBeGreaterThan(0);
    expect(await db.retireExpenseRequest({ key: requestKey, hash: input.request.hash, actor: input.createdBy }, EXPLICIT))
      .toMatchObject({ state: "saved", expense: { id: saved.expense!.id } });
    expect(await db.retireExpenseRequest({ key: requestKey, hash: hashOf("other"), actor: input.createdBy }, EXPLICIT)).toEqual({ state: "conflict" });
    expect(await n("SELECT count(*) AS n FROM expense_request_retirements WHERE idempotency_key = $1", [requestKey])).toBe(0);
    expect(await retireAudits(requestKey)).toBe(0);
    expect(await evidence(note)).toEqual({ vouchers: 1, audits: 1 });
  });

  it("retired first: the late request writes nothing; a second identical retirement is idempotent; another one conflicts", async () => {
    const note = `SYN-RET-FIRST-${++serial}`, requestKey = key(), input = legacyInput(note, 10, requestKey);
    expect(await db.retireExpenseRequest({ key: requestKey, hash: input.request.hash, actor: input.createdBy }, EXPLICIT)).toEqual({ state: "retired" });
    // The explicit retirement is audited once, in its own transaction; the idempotent repeat and the conflict add nothing.
    expect(await retireAudits(requestKey)).toBe(1);
    expect((await q<{ actor: string; actor_role: string; summary: string }>("SELECT actor, actor_role, summary FROM audit_log WHERE action = 'expense.request_retire' AND entity_id = $1", [requestKey])))
      .toEqual([{ actor: input.createdBy, actor_role: "reception", summary: expect.stringMatching(/[؀-ۿ]/) }]);
    expect(await db.retireExpenseRequest({ key: requestKey, hash: input.request.hash, actor: input.createdBy }, EXPLICIT)).toEqual({ state: "retired" });
    expect(await db.retireExpenseRequest({ key: requestKey, hash: hashOf("x"), actor: input.createdBy }, EXPLICIT)).toEqual({ state: "conflict" });
    expect(await retireAudits(requestKey)).toBe(1);
    expect(await db.recordExpense(input)).toMatchObject({ expense: null, reason: "expense_request_retired" });
    expect(await evidence(note)).toEqual({ vouchers: 0, audits: 0 });
  });

  it("a retirement by another actor or for another fingerprint never cancels the original request", async () => {
    for (const other of [{ hash: hashOf("another request"), actor: ACCOUNTS.clerk.username }, { actor: "SYN-SOMEONE-ELSE" }]) {
      const note = `SYN-RET-MISMATCH-${++serial}`, requestKey = key(), input = legacyInput(note, 10, requestKey);
      expect(await db.retireExpenseRequest({ key: requestKey, hash: other.hash ?? input.request.hash, actor: other.actor })).toEqual({ state: "retired" });
      expect((await db.recordExpense(input)).expense?.id).toBeGreaterThan(0);
      expect(await evidence(note)).toEqual({ vouchers: 1, audits: 1 });
    }
  });

  it("canonical retirement follows the create grant and the session; refusals write nothing", async () => {
    const note = `SYN-RET-AUTH-${++serial}`, requestKey = key(), body = canonicalBody(note, "10");
    await expect(create.commandCanonicalRetireExpenseRequest(await fx.session("reader"), { requestKey, source: body })).rejects.toThrow(/CAPABILITY_DENIED/);
    const expiring = await fx.session("clerk", 60_000);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    try {
      await expect(create.commandCanonicalRetireExpenseRequest(expiring, { requestKey, source: body })).rejects.toThrow(/SESSION|EXPIRED/);
    } finally { clock.mockRestore(); }
    expect(await n("SELECT count(*) AS n FROM expense_request_retirements WHERE idempotency_key = $1", [requestKey])).toBe(0);
    expect(await retireAudits(requestKey)).toBe(0);
    expect(await create.commandCanonicalRetireExpenseRequest(await fx.session("clerk"), { requestKey, source: body })).toEqual({ state: "retired" });
    expect((await q("SELECT actor, actor_role FROM audit_log WHERE action = 'expense.request_retire' AND entity_id = $1", [requestKey])))
      .toEqual([{ actor: ACCOUNTS.clerk.username, actor_role: "reception" }]);
    await expect(create.commandCanonicalExpenseCreate(await fx.session("clerk"), { source: body, requestKey }))
      .rejects.toMatchObject({ code: "expense_request_retired" });
    // The same key from another user is another request: it is not fenced by the clerk's retirement.
    const ownerVoucher = await create.commandCanonicalExpenseCreate(await fx.session("owner"), { source: body, requestKey });
    expect(ownerVoucher.expense.createdBy).toBe(ACCOUNTS.owner.username);
  });

  it("save and retirement racing under the key lock: exactly one wins and the other reports it", async () => {
    for (let round = 0; round < 3; round++) {
      const note = `SYN-RET-RACE-${++serial}`, requestKey = key(), input = legacyInput(note, 10, requestKey);
      const holder = await side.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`aqlan.expense.request:${requestKey}`]);
        const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const saving = db.recordExpense(input);
        const retiring = db.retireExpenseRequest({ key: requestKey, hash: input.request.hash, actor: input.createdBy });
        await expect.poll(async () => (await waitForBlockedBy(side, pid, 10_000)).length, { timeout: 10_000 }).toBe(2);
        await holder.query("COMMIT");
        const [saved, retired] = await Promise.all([saving, retiring]);
        const vouchers = (await evidence(note)).vouchers;
        const rows = await n("SELECT count(*) AS n FROM expense_request_retirements WHERE idempotency_key = $1", [requestKey]);
        expect(vouchers + rows).toBe(1);
        if (vouchers === 1) expect(retired).toMatchObject({ state: "saved", expense: { id: saved.expense!.id } });
        else expect(saved).toMatchObject({ expense: null, reason: "expense_request_retired" });
      } finally { holder.release(); }
    }
  });
});

describe("rollback and the database fence", () => {
  it("the retirement survives the refusal's rollback; a failed retirement claims nothing", async () => {
    const note = `SYN-RET-ROLLBACK-${++serial}`, requestKey = key();
    const amount = String((await drawerAvailable()) + 900);
    await expect(create.commandCanonicalExpenseCreate(await fx.session("clerk"), { source: canonicalBody(note, amount), requestKey }))
      .rejects.toMatchObject({ code: "exceeds_drawer_cash", keyState: "retired" });
    expect(await n("SELECT count(*) AS n FROM expense_request_retirements WHERE idempotency_key = $1", [requestKey])).toBe(1);
    const failing = key();
    await q("ALTER TABLE expense_request_retirements ADD CONSTRAINT synthetic_retirement_failure CHECK (idempotency_key <> $$" + failing + "$$) NOT VALID");
    try {
      await expect(create.commandCanonicalExpenseCreate(await fx.session("clerk"), { source: canonicalBody(`${note}-b`, amount), requestKey: failing }))
        .rejects.toMatchObject({ code: "exceeds_drawer_cash", keyState: null });
      const legacy = await db.recordExpense(legacyInput(`${note}-c`, Number(amount), failing));
      expect(legacy.reason).toBe("exceeds_drawer_cash");
      expect(legacy.keyState).toBeUndefined();
    } finally { await q("ALTER TABLE expense_request_retirements DROP CONSTRAINT synthetic_retirement_failure"); }
    expect(await n("SELECT count(*) AS n FROM expense_request_retirements WHERE idempotency_key = $1", [failing])).toBe(0);
  });

  it("the triggers fence a matching raw insert and keep retirements append-only", async () => {
    const note = `SYN-RET-FENCE-${++serial}`, requestKey = key(), input = legacyInput(note, 10, requestKey);
    await db.retireExpenseRequest({ key: requestKey, hash: input.request.hash, actor: input.createdBy });
    const shiftId = (await db.getOpenShiftWith(fx.pool))!.id;
    await expect(q(`INSERT INTO expenses (voucher_number, category, payee_text, shift_id, amount_minor, currency, base_amount_minor, created_by,
        idempotency_key, idempotency_request_hash, note) VALUES ('SYN-RET-RAW', 'other', 'SYN', $1, 10, 'YER', 10, $2, $3, $4, $5)`,
      [shiftId, input.createdBy, requestKey, input.request.hash, note])).rejects.toThrow(/مسحوب/);
    await expect(q("UPDATE expense_request_retirements SET retired_by = 'x' WHERE idempotency_key = $1", [requestKey])).rejects.toThrow(/append-only/);
    await expect(q("DELETE FROM expense_request_retirements WHERE idempotency_key = $1", [requestKey])).rejects.toThrow(/append-only/);
    await expect(q("TRUNCATE expense_request_retirements")).rejects.toThrow(/append-only/);
    expect(await evidence(note)).toEqual({ vouchers: 0, audits: 0 });
  });
});
