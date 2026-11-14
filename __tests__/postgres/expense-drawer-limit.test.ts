// Owner #483 6831365228 item 2: an expense may not take more from the drawer than the drawer holds.
// Contract: docs/finance/EXPENSE_COMMANDS_0128.md §2.2. Real PostgreSQL, the real POST /api/expenses route on
// legacy sessions, and the internal writer used by payroll and lab settlements. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
const context = vi.hoisted(() => ({ username: "syn-drawer-admin", role: "admin" }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ username: context.username, role: context.role,
  ...(context.role === "cashier" ? { financeAccess: { createExpenses: true } } : {}) }) }));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_expense_drawer_limit_test");
const db = await import("../../lib/db");
const { POST } = await import("../../app/api/expenses/route");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
let serial = 0;

beforeAll(async () => {
  await db.ensureSchema();
  await db.saveSettings({ "finance.rate.SAR": "140", "finance.rate.USD": "535" });
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

/** A fresh drawer for each case: close any open shift with its exact count, then open with this float. */
async function drawer(opening: { YER: number; SAR: number; USD: number }) {
  const open = await db.getOpenShift();
  if (open) {
    const expected = (await db.shiftDrawerBreakdown(open)).expected;
    const closed = await db.closeShift({ id: open.id, closedBy: "syn-drawer-admin", counted: expected, note: null, differenceReason: null });
    if (closed.reason) throw new Error(`synthetic shift did not close: ${closed.reason}`);
  }
  const shift = await db.openShift({ openedBy: "syn-drawer-admin", opening });
  if (!shift) throw new Error("synthetic shift did not open");
  return shift;
}
const body = (amount: string, currency = "YER", extra: Record<string, unknown> = {}) =>
  ({ category: "other", amount, currency, payee: "SYN payee", note: `SYN drawer ${++serial}`, ...extra });
function send(payload: object, key = `syn-drawer-key-${++serial}`) {
  return POST(new Request("https://synthetic.invalid/api/expenses", { method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(payload) }));
}
const footprint = async () => (await q<{ vouchers: number; audits: number }>(`SELECT
  (SELECT count(*) FROM expenses)::int AS vouchers,
  (SELECT count(*) FROM audit_log WHERE entity='expense')::int AS audits`))[0];
const expected = async () => (await db.getOpenShift())!.expected;

describe("the drawer limit", () => {
  it.each(["admin", "reception", "cashier"])("lets %s spend exactly the drawer and refuses one unit more", async (role) => {
    await drawer({ YER: 1000, SAR: 0, USD: 0 });
    context.role = role;
    try {
      expect((await send(body("1000"))).status).toBe(201);
      expect(await expected()).toEqual({ YER: 0, SAR: 0, USD: 0 });
      const before = await footprint();
      const refused = await send(body("1"));
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "exceeds_drawer_cash", drawerAvailableMinor: 0 });
      expect(await footprint()).toEqual(before);
    } finally { context.role = "admin"; }
  });

  it("is per currency: cash in one currency does not cover another", async () => {
    await drawer({ YER: 100_000, SAR: 0, USD: 500 });
    const refused = await send(body("1", "SAR"));
    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toMatch(/الدرج/);
    expect((await send(body("5", "USD"))).status).toBe(201);
    expect(await expected()).toEqual({ YER: 100_000, SAR: 0, USD: 0 });
  });

  it("serializes two vouchers against the same cash: one is recorded, one is refused", async () => {
    await drawer({ YER: 1000, SAR: 0, USD: 0 });
    const results = await Promise.all([send(body("600")), send(body("600"))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await expected()).toEqual({ YER: 400, SAR: 0, USD: 0 });
  });

  it("replays a lost response even after the drawer was emptied by it", async () => {
    await drawer({ YER: 700, SAR: 0, USD: 0 });
    const payload = body("700");
    const first = await send(payload, "syn-drawer-replay-0001"); expect(first.status).toBe(201);
    const replay = await send(payload, "syn-drawer-replay-0001");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: (await first.json()).id, replayed: true });
    expect(await expected()).toEqual({ YER: 0, SAR: 0, USD: 0 });
  });

  it("applies to the internal writer used by payroll and lab settlements", async () => {
    await drawer({ YER: 50, SAR: 0, USD: 0 });
    const client = await db.getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await db.recordExpenseInTx(client, { category: "other", partyId: null, payeeText: "SYN internal",
        amountMinor: 51, currency: "YER", baseCurrency: "YER", exchangeRate: 1, payableId: null, note: null,
        createdBy: "syn-drawer-admin" }, { YER: 1, SAR: 140, USD: 535 });
      expect(result).toMatchObject({ id: null, reason: "exceeds_drawer_cash" });
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
});

describe("a private part from a legacy session", () => {
  it.each(["admin", "reception"])("is refused for %s (no owner proof) and nothing is written", async (role) => {
    await drawer({ YER: 5000, SAR: 0, USD: 0 });
    context.role = role;
    try {
      const before = await footprint();
      const refused = await send(body("300", "YER", { ownerPrivateAmount: "200", ownerPrivateReason: "SYN private" }));
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "owner_private_requires_owner" });
      expect(await footprint()).toEqual(before);
    } finally { context.role = "admin"; }
  });
});

describe("the payment source of a drawer voucher", () => {
  it("is recorded as the drawer for every new voucher, and a void mirrors it", async () => {
    await drawer({ YER: 5000, SAR: 0, USD: 0 });
    const voucher = await (await send(body("300"))).json();
    expect(voucher).toMatchObject({ paymentSource: "drawer", drawerAmountMinor: 300, ownerPrivateAmountMinor: 0 });
    expect(await q("SELECT payment_source, drawer_amount_minor::int, owner_private_amount_minor::int, owner_private_reason, owner_private_user_id FROM expenses WHERE id=$1", [voucher.id]))
      .toEqual([{ payment_source: "drawer", drawer_amount_minor: 300, owner_private_amount_minor: 0, owner_private_reason: null, owner_private_user_id: null }]);
    expect((await db.voidExpense(voucher.id, { actor: "syn-drawer-admin", actorRole: "admin", reason: "SYN void" })).ok).toBe(true);
    expect(await q("SELECT payment_source, drawer_amount_minor::int, owner_private_amount_minor::int FROM expenses WHERE reversal_of_id=$1", [voucher.id]))
      .toEqual([{ payment_source: "drawer", drawer_amount_minor: -300, owner_private_amount_minor: 0 }]);
    expect(await expected()).toEqual({ YER: 5000, SAR: 0, USD: 0 });
  });

  it("reads a voucher written before 0128 (no source) as fully from the drawer", async () => {
    const shift = await drawer({ YER: 900, SAR: 0, USD: 0 });
    await q(`INSERT INTO expenses(voucher_number, category, payee_text, shift_id, amount_minor, currency, base_amount_minor)
      VALUES('SYN-LEGACY-DRAWER','other','SYN',$1,250,'YER',250)`, [shift.id]);
    expect(await expected()).toEqual({ YER: 650, SAR: 0, USD: 0 });
    expect((await db.shiftDrawerBreakdown((await db.getOpenShift())!)).spent).toEqual({ YER: 250, SAR: 0, USD: 0 });
    expect((await send(body("651"))).status).toBe(409);
  });
});

describe("0128 payment-source storage", () => {
  it("refuses every invalid shape at the database", async () => {
    const shift = await drawer({ YER: 0, SAR: 0, USD: 0 });
    const [{ id: user }] = await q<{ id: number }>(`INSERT INTO users(username, display_name, password_hash, role)
      VALUES('syn-drawer-owner','SYN','x','admin') RETURNING id`);
    const insert = (amount: number, source: string | null, drawerPart: number | null, privatePart: number | null,
      reason: string | null, owner: number | null, account?: string | null) => db.getPool().query(`INSERT INTO expenses(voucher_number, category, payee_text,
        shift_id, amount_minor, currency, base_amount_minor, payment_source, drawer_amount_minor, owner_private_amount_minor,
        owner_private_reason, owner_private_user_id, owner_private_account_code) VALUES($1,'other','SYN',$2,$3,'YER',$3,$4,$5,$6,$7,$8,$9)`,
      [`SYN-SRC-${++serial}`, shift.id, amount, source, drawerPart, privatePart, reason, owner, account === undefined ? (owner === null ? null : "3101") : account]);
    type Shape = [number, string | null, number | null, number | null, string | null, number | null, (string | null)?];
    for (const valid of <Shape[]>[[100, "drawer", 100, 0, null, null], [100, "owner_private", 0, 100, "SYN reason", user],
      [100, "drawer_and_owner_private", 40, 60, "SYN reason", user], [-100, "drawer_and_owner_private", -40, -60, "SYN reason", user]]) {
      await expect(insert(...valid), JSON.stringify(valid)).resolves.toBeDefined();
    }
    for (const invalid of <Shape[]>[
      [100, null, 100, 0, null, null], [100, "drawer", 90, 0, null, null], [100, "drawer", 100, 0, "SYN reason", user],
      [100, "owner_private", 0, 100, null, user], [100, "owner_private", 0, 100, "SYN reason", null], [100, "owner_private", 10, 90, "SYN reason", user],
      [100, "drawer_and_owner_private", 100, 0, "SYN reason", user], [100, "drawer_and_owner_private", 120, -20, "SYN reason", user],
      [100, "owner_private", 0, 100, " SYN", user], [100, "owner_private", 0, 100, "ab", user], [100, "bank", 100, 0, null, null],
      [100, "owner_private", 0, 100, "SYN reason", user, null], [100, "owner_private", 0, 100, "SYN reason", user, "cash"],
      [100, "drawer", 100, 0, null, null, "3101"],
    ]) {
      await expect(insert(...invalid), JSON.stringify(invalid)).rejects.toMatchObject({ code: "23514" });
    }
  });
});
