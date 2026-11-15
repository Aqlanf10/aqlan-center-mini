/**
 * Owner #483 6831365228 item 2 and the worked examples of 6833690789: only the protected owner may pay
 * part of an expense from a private source; only the drawer part leaves the drawer. Contract:
 * docs/finance/EXPENSE_COMMANDS_0128.md §2.2–2.3. Canonical runtime on an owned synthetic database.
 *
 * The funding account is set to "3101" here ONLY to exercise the posting path. That value is a synthetic
 * test choice, not the owner's accounting decision (asked on #483, 6878857625).
 */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { toInputAmount } from "../../lib/money";
import type { CashierShift } from "../../lib/db";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-expense-owner-private-20261114");
const db = await import("../../lib/db");
const shifts = await import("../../lib/canonical-shifts");
const expenses = await import("../../lib/canonical-expense-create");
const ALL = { "finance.expenses.create": true, "finance.expenses.view": true, "finance.fx.manage": true,
  "finance.payables.record": true, "finance.shifts.operate": true, "finance.shifts.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-EXP-OWNER", role: "admin" },
  manager: { username: "SYN-EXP-MANAGER", role: "admin", grants: ALL },
  cashier: { username: "SYN-EXP-CASHIER", role: "cashier", grants: { "finance.expenses.create": true } },
  reader: { username: "SYN-EXP-READER", role: "accountant", grants: { "finance.expenses.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let serial = 0;
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows as T[];
const counted = (a: CashierShift["expected"]) => ({ YER: toInputAmount(a.YER, "YER"), SAR: toInputAmount(a.SAR, "SAR"), USD: toInputAmount(a.USD, "USD") });
const footprint = async () => (await q<{ vouchers: number; audits: number }>(`SELECT (SELECT count(*) FROM expenses)::int AS vouchers,
  (SELECT count(*) FROM audit_log WHERE entity='expense')::int AS audits`))[0];
const drawer = async () => (await db.getOpenShiftWith(fx.pool))!.expected;
const setAccount = (value: string) => q("INSERT INTO settings(key,value) VALUES('finance.owner_private_funding_account',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [value]);

async function freshDrawer(yer: string) {
  const current = await db.getOpenShiftWith(fx.pool);
  if (current) await shifts.commandCanonicalShiftClose(await fx.session("owner"), { id: current.id, counted: counted(current.expected), differenceReason: "synthetic cleanup" });
  await shifts.commandCanonicalShiftOpen(await fx.session("owner"), { opening: { YER: yer, SAR: "0", USD: "0" } });
}
async function supplierDebt(amountMinor: number) {
  const [{ id: partyId }] = await q<{ id: number }>("INSERT INTO parties(name,kind) VALUES($1,'supplier') RETURNING id", [`SYN supplier ${++serial}`]);
  const payable = await db.createPayable({ partyId, category: "supplier", description: "SYN debt", amountMinor, currency: "YER",
    baseCurrency: "YER", exchangeRate: 1, labOrderId: null, dueDate: null, createdBy: "synthetic" });
  return { partyId, payableId: payable!.id };
}
const remaining = async (partyId: number) => (await db.partyStatement(partyId)).totals[0]?.remainingMinor;
function create(key: Key, body: Record<string, unknown>, requestKey = `syn-owner-src-${++serial}`) {
  return fx.session(key).then((session) => expenses.commandCanonicalExpenseCreate(session, { source: body, requestKey }));
}

beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); }, 180_000);
beforeEach(async () => { await setAccount(""); });
afterAll(async () => { await fx?.close(); });

describe("the owner's worked examples (6833690789)", () => {
  it("debt 1000, owner pays 300 privately: the debt is 700 and the drawer does not move", async () => {
    await freshDrawer("1000"); await setAccount("3101");
    const { partyId, payableId } = await supplierDebt(1000);
    const before = await drawer();
    const { expense } = await create("owner", { category: "supplier", partyId, payableId, amount: "300", currency: "YER",
      ownerPrivateAmount: "300", ownerPrivateReason: "SYN paid from the owner's own money" });
    expect(expense).toMatchObject({ amountMinor: 300, paymentSource: "owner_private", drawerAmountMinor: 0, ownerPrivateAmountMinor: 300 });
    expect(await remaining(partyId)).toBe(700);
    expect(await drawer()).toEqual(before);
    const [audit] = await q<{ actor: string; details: Record<string, unknown> }>("SELECT actor, details FROM audit_log WHERE action='expense.create' AND entity_id=$1", [String(expense.id)]);
    expect(audit).toMatchObject({ actor: ACCOUNTS.owner.username, details: { المبلغ: 300, العملة: "YER", مصدر_الدفع: "owner_private",
      جزء_الدرج: 0, جزء_المالك: 300, سبب_المالك: "SYN paid from the owner's own money", حساب_تمويل_المالك: "3101", إثبات_المالك: true } });
  });

  it("drawer 150, owner pays 300 with 100 from the drawer and 200 privately: drawer 50, debt 700", async () => {
    await freshDrawer("150"); await setAccount("3101");
    const { partyId, payableId } = await supplierDebt(1000);
    const { expense } = await create("owner", { category: "supplier", partyId, payableId, amount: "300", currency: "YER",
      ownerPrivateAmount: "200", ownerPrivateReason: "SYN drawer short" });
    expect(expense).toMatchObject({ paymentSource: "drawer_and_owner_private", drawerAmountMinor: 100, ownerPrivateAmountMinor: 200 });
    expect(await drawer()).toEqual({ YER: 50, SAR: 0, USD: 0 });
    expect(await remaining(partyId)).toBe(700);
    // The close sees no surplus and no shortage: only the drawer part left the drawer.
    const shift = (await db.getOpenShiftWith(fx.pool))!;
    const closed = await shifts.commandCanonicalShiftClose(await fx.session("owner"), { id: shift.id, counted: counted(shift.expected) });
    expect(closed).toMatchObject({ expected: { YER: 50, SAR: 0, USD: 0 }, difference: { YER: 0, SAR: 0, USD: 0 } });
  });
});

describe("the journal", () => {
  it("credits cash with the drawer part and the configured account with the private part, and mirrors a void", async () => {
    await freshDrawer("500"); await setAccount("3101");
    const { expense } = await create("owner", { category: "other", payee: "SYN payee", amount: "300", currency: "YER",
      ownerPrivateAmount: "200", ownerPrivateReason: "SYN mixed" });
    const entries = (await db.journalEntries("0001-01-01", "9999-12-31", fx.pool)).filter((e) => e.reference === expense.voucherNumber);
    expect(entries).toHaveLength(1);
    const credits = entries[0].lines.filter((l) => l.side === "credit").map((l) => [l.accountCode, l.amountMinor]);
    expect(credits).toEqual([["1101", 100], ["3101", 200]]);
    expect(entries[0].lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amountMinor, 0)).toBe(300);
    const voided = await db.voidExpense(expense.id, { actor: ACCOUNTS.owner.username, actorRole: "admin", reason: "SYN void" });
    expect(voided.ok).toBe(true);
    expect(await drawer()).toEqual({ YER: 500, SAR: 0, USD: 0 });
    const reversal = (await db.journalEntries("0001-01-01", "9999-12-31", fx.pool)).find((e) => e.reference === voided.voidedVoucherNumber)!;
    expect(reversal.lines.filter((l) => l.side === "debit").map((l) => [l.accountCode, l.amountMinor])).toEqual([["1101", 100], ["3101", 200]]);
  });
});

describe("who may record a private part", () => {
  it.each(["manager", "cashier"] as const)("refuses %s even with every expense grant, and writes nothing", async (key) => {
    await freshDrawer("1000"); await setAccount("3101");
    const before = await footprint();
    await expect(create(key, { category: "other", payee: "SYN", amount: "100", currency: "YER", ownerPrivateAmount: "100", ownerPrivateReason: "SYN try" }))
      .rejects.toMatchObject({ code: "owner_private_requires_owner", status: 403, keyUnused: true });
    expect(await footprint()).toEqual(before);
    // The same account may still pay from the drawer.
    await expect(create(key, { category: "other", payee: "SYN", amount: "100", currency: "YER" })).resolves.toMatchObject({ expense: { paymentSource: "drawer" } });
  });

  it("refuses an account without the create grant before anything else", async () => {
    await freshDrawer("1000");
    await expect(create("reader", { category: "other", payee: "SYN", amount: "1", currency: "YER" })).rejects.toThrow(/CAPABILITY_DENIED/);
  });

  it("refuses the owner too while no funding account is set, and still allows a drawer voucher", async () => {
    await freshDrawer("1000");
    const before = await footprint();
    await expect(create("owner", { category: "other", payee: "SYN", amount: "100", currency: "YER", ownerPrivateAmount: "100", ownerPrivateReason: "SYN try" }))
      .rejects.toMatchObject({ code: "owner_private_account_unset", status: 409 });
    expect(await footprint()).toEqual(before);
    await expect(create("owner", { category: "other", payee: "SYN", amount: "100", currency: "YER" })).resolves.toBeDefined();
  });

  it.each([["a cash account", "1101"], ["an expense account", "5901"], ["an unknown account", "3999"]])(
    "refuses %s as the funding account", async (_label, code) => {
      await freshDrawer("1000"); await setAccount(code);
      await expect(create("owner", { category: "other", payee: "SYN", amount: "100", currency: "YER", ownerPrivateAmount: "100", ownerPrivateReason: "SYN try" }))
        .rejects.toMatchObject({ code: "owner_private_account_unset" });
    });
});

describe("the request shape", () => {
  it.each([
    ["no reason", { ownerPrivateAmount: "100" }],
    ["a two-letter reason", { ownerPrivateAmount: "100", ownerPrivateReason: "ab" }],
    ["a private part above the amount", { ownerPrivateAmount: "101", ownerPrivateReason: "SYN" + "x" }],
    ["a negative private part", { ownerPrivateAmount: "-5", ownerPrivateReason: "SYN reason" }],
    ["a reason without a private part", { ownerPrivateReason: "SYN reason" }],
  ])("refuses %s with 400 and writes nothing", async (_label, extra) => {
    await freshDrawer("1000"); await setAccount("3101");
    const before = await footprint();
    await expect(create("owner", { category: "other", payee: "SYN", amount: "100", currency: "YER", ...extra }))
      .rejects.toMatchObject({ code: "invalid_payment_split", status: 400 });
    expect(await footprint()).toEqual(before);
  });

  it("still applies the drawer limit to the drawer part of a mixed payment", async () => {
    await freshDrawer("50"); await setAccount("3101");
    await expect(create("owner", { category: "other", payee: "SYN", amount: "300", currency: "YER", ownerPrivateAmount: "200", ownerPrivateReason: "SYN mixed" }))
      .rejects.toMatchObject({ code: "exceeds_drawer_cash", status: 409 });
    await expect(create("owner", { category: "other", payee: "SYN", amount: "300", currency: "YER", ownerPrivateAmount: "250", ownerPrivateReason: "SYN mixed" }))
      .resolves.toMatchObject({ expense: { drawerAmountMinor: 50 } });
    expect(await drawer()).toEqual({ YER: 0, SAR: 0, USD: 0 });
  });

  it("replays the same request once and refuses the same key with another split", async () => {
    await freshDrawer("1000"); await setAccount("3101");
    const body = { category: "other", payee: "SYN", amount: "300", currency: "YER", ownerPrivateAmount: "200", ownerPrivateReason: "SYN replay" };
    const first = await create("owner", body, "syn-owner-src-replay-01");
    const before = await footprint();
    await expect(create("owner", body, "syn-owner-src-replay-01")).resolves.toMatchObject({ expense: { id: first.expense.id }, replayed: true });
    await expect(create("owner", { ...body, ownerPrivateAmount: "100" }, "syn-owner-src-replay-01"))
      .rejects.toMatchObject({ code: "expense_request_conflict", status: 409, keyUnused: false });
    expect(await footprint()).toEqual(before);
  });

  it("replays a saved private-part request even after the funding account setting was cleared", async () => {
    await freshDrawer("1000"); await setAccount("3101");
    const body = { category: "other", payee: "SYN", amount: "300", currency: "YER", ownerPrivateAmount: "300", ownerPrivateReason: "SYN replay later" };
    const first = await create("owner", body, "syn-owner-src-replay-02");
    await setAccount("");
    const before = await footprint();
    await expect(create("owner", body, "syn-owner-src-replay-02")).resolves.toMatchObject({ expense: { id: first.expense.id }, replayed: true });
    await expect(create("owner", { ...body, ownerPrivateAmount: "200" }, "syn-owner-src-replay-02")).rejects.toMatchObject({ code: "expense_request_conflict" });
    await expect(create("owner", body, "syn-owner-src-replay-03")).rejects.toMatchObject({ code: "owner_private_account_unset" });
    expect(await footprint()).toEqual(before);
  });

  it("records the actor from the operation, never from the request", async () => {
    await freshDrawer("1000");
    const { expense } = await create("cashier", { category: "other", payee: "SYN", amount: "10", currency: "YER", createdBy: "forged" });
    expect(expense.createdBy).toBe(ACCOUNTS.cashier.username);
  });
});
