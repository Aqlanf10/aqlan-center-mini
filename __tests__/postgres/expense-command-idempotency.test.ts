// Owner #483 6831365228 item 3 (duplicate expense protection); migration 0128 allocated in 6833690789.
// Contract: docs/finance/EXPENSE_COMMANDS_0128.md §2.1. Real PostgreSQL and the real POST /api/expenses
// route on a legacy session; only the session reader and framework markers are stubbed. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
const context = vi.hoisted(() => ({ username: "syn-expense-key-admin", role: "admin" }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ username: context.username, role: context.role }) }));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_expense_command_idempotency_test");
const db = await import("../../lib/db");
const { POST } = await import("../../app/api/expenses/route");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
let serial = 0;

beforeAll(async () => {
  await db.ensureSchema();
  await db.saveSettings({ "finance.rate.SAR": "140", "finance.rate.USD": "535" });
  await db.openShift({ openedBy: "syn-expense-key-admin", opening: { YER: 1_000_000, SAR: 100_000, USD: 100_000 } });
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

const body = (extra: Record<string, unknown> = {}) => ({ category: "other", amount: "125", currency: "YER",
  payee: "SYN payee", note: `SYN expense ${++serial}`, ...extra });
function send(payload: object, key?: string | null) {
  return POST(new Request("https://synthetic.invalid/api/expenses", { method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify(payload) }));
}
const footprint = async () => (await q<{ vouchers: number; audits: number }>(`SELECT
  (SELECT count(*) FROM expenses)::int AS vouchers,
  (SELECT count(*) FROM audit_log WHERE entity='expense')::int AS audits`))[0];
const expected = async () => (await db.getOpenShift())!.expected;

describe("expense create carries a request key", () => {
  it.each([["no key", null], ["a short key", "short"], ["a key with spaces", "syn key with spaces"]])(
    "refuses %s with 400 and writes nothing", async (_label, key) => {
      const before = await footprint();
      const response = await send(body(), key);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "expense_request_key_required" });
      expect(await footprint()).toEqual(before);
    });
});

describe("the same key and the same request", () => {
  it("records once and replays the original voucher, cash movement and audit", async () => {
    const payload = body(); const before = { footprint: await footprint(), cash: await expected() };
    const first = await send(payload, "syn-expense-replay-0001");
    expect(first.status).toBe(201);
    const voucher = await first.json();
    for (let attempt = 0; attempt < 2; attempt++) {
      const replay = await send(payload, "syn-expense-replay-0001");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ id: voucher.id, voucherNumber: voucher.voucherNumber, replayed: true });
    }
    expect(await footprint()).toEqual({ vouchers: before.footprint.vouchers + 1, audits: before.footprint.audits + 1 });
    expect(await expected()).toEqual({ ...before.cash, YER: before.cash.YER - 125 });
    expect(await q("SELECT idempotency_key FROM expenses WHERE id=$1", [voucher.id])).toEqual([{ idempotency_key: "syn-expense-replay-0001" }]);
  });

  it("replays even when the preview values or the settings rate changed since the first send", async () => {
    const payload = body({ currency: "SAR", amount: "10", expected: { paymentExchangeRate: 140 } });
    const first = await send(payload, "syn-expense-rate-moved-01"); expect(first.status).toBe(201);
    const id = (await first.json()).id;
    await db.saveSettings({ "finance.rate.SAR": "150" });
    try {
      const replay = await send({ ...payload, expected: { paymentExchangeRate: 150 } }, "syn-expense-rate-moved-01");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ id, replayed: true, exchangeRate: 140 });
    } finally { await db.saveSettings({ "finance.rate.SAR": "140" }); }
  });

  it("serializes concurrent sends of one key to one voucher", async () => {
    const payload = body(); const before = await footprint();
    const responses = await Promise.all(Array.from({ length: 6 }, () => send(payload, "syn-expense-race-key-01")));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    const ids = new Set(await Promise.all(responses.map(async (r) => (await r.json()).id)));
    expect(ids.size).toBe(1);
    expect(await footprint()).toEqual({ vouchers: before.vouchers + 1, audits: before.audits + 1 });
  });
});

describe("the same key with a different request", () => {
  it.each([
    ["a changed amount", { amount: "126" }],
    ["a changed note", { note: "SYN other note" }],
    ["a changed category", { category: "maintenance" }],
    ["a changed currency", { currency: "USD", amount: "1" }],
  ])("refuses %s with 409 and writes nothing", async (_label, change) => {
    const payload = body(); const key = `syn-expense-conflict-${serial}`;
    expect((await send(payload, key)).status).toBe(201);
    const before = { footprint: await footprint(), cash: await expected() };
    const conflict = await send({ ...payload, ...change }, key);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "expense_request_conflict" });
    expect(await footprint()).toEqual(before.footprint);
    expect(await expected()).toEqual(before.cash);
  });

  it("refuses another user's key even with an identical request", async () => {
    const payload = body();
    expect((await send(payload, "syn-expense-other-actor-1")).status).toBe(201);
    const before = await footprint();
    context.username = "syn-expense-key-reception"; context.role = "reception";
    try {
      const response = await send(payload, "syn-expense-other-actor-1");
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("expense_request_conflict");
    } finally { context.username = "syn-expense-key-admin"; context.role = "admin"; }
    expect(await footprint()).toEqual(before);
  });
});

describe("refusals and reversals", () => {
  it("leaves the key unused when the first send is refused, so a corrected retry under a new key works", async () => {
    const before = await footprint();
    const refused = await send(body({ currency: "SAR", amount: "10", expected: { paymentExchangeRate: 999 } }), "syn-expense-stale-key-01");
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("stale_quote");
    expect(await footprint()).toEqual(before);
    expect(await q("SELECT id FROM expenses WHERE idempotency_key='syn-expense-stale-key-01'")).toEqual([]);
  });

  it("gives a void's reversal no key, and the original key still replays the original voucher", async () => {
    const payload = body();
    const voucher = await (await send(payload, "syn-expense-voided-key-1")).json();
    const voided = await db.voidExpense(voucher.id, { actor: "syn-expense-key-admin", actorRole: "admin", reason: "SYN void" });
    expect(voided.ok).toBe(true);
    expect(await q("SELECT idempotency_key, idempotency_request_hash FROM expenses WHERE reversal_of_id=$1", [voucher.id]))
      .toEqual([{ idempotency_key: null, idempotency_request_hash: null }]);
    const replay = await send(payload, "syn-expense-voided-key-1");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: voucher.id, replayed: true });
    expect(await q("SELECT count(*)::int AS n FROM expenses WHERE reversal_of_id=$1", [voucher.id])).toEqual([{ n: 1 }]);
  });
});

describe("0128 storage", () => {
  it("is registered once and survives a second initialisation", async () => {
    await db.ensureSchema();
    expect(await q("SELECT version, name FROM schema_migrations WHERE version='0128'")).toEqual([{ version: "0128", name: "expense_commands" }]);
  });
  it("refuses a duplicate key, a key without a hash and a keyed reversal at the database", async () => {
    const [{ id: shiftId }] = await q<{ id: number }>("SELECT id FROM cashier_shifts WHERE status='open'");
    const insert = (key: string | null, hash: string | null, voucher: string) => db.getPool().query(`INSERT INTO expenses
      (voucher_number, category, payee_text, shift_id, amount_minor, currency, base_amount_minor, idempotency_key, idempotency_request_hash)
      VALUES ($1,'other','SYN',$2,100,'YER',100,$3,$4)`, [voucher, shiftId, key, hash]);
    const hash = "a".repeat(64);
    await insert("syn-db-key-000001", hash, "SYN-DB-1");
    await expect(insert("syn-db-key-000001", hash, "SYN-DB-2")).rejects.toMatchObject({ code: "23505" });
    await expect(insert("syn-db-key-000002", null, "SYN-DB-3")).rejects.toMatchObject({ code: "23514" });
    await expect(insert(null, hash, "SYN-DB-4")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("bad key", hash, "SYN-DB-5")).rejects.toMatchObject({ code: "23514" });
    await expect(db.getPool().query("UPDATE expenses SET idempotency_key='syn-db-key-000009' WHERE voucher_number='SYN-DB-1'"))
      .rejects.toThrow(/append-only/);
  });
});
