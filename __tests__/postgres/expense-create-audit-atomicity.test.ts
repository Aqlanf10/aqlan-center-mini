import type { DbClient, QueryResult } from "../../lib/db";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv, dropPublicSchema } from "./_setup";
assertRealPostgresUrl();
stubPostgresEnv();
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ username: "expense-audit-ci", role: "admin" }) }));
const db = await import("../../lib/db");
const { POST } = await import("../../app/api/expenses/route");
let sequence = 0;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  await db.openShift({ openedBy: "expense-audit-ci", opening: { YER: 10000, SAR: 10000, USD: 10000 } });
}, 180000);
afterAll(async () => { await db.resetPoolForTesting(); });
afterEach(() => vi.restoreAllMocks());
function request(note: string) {
  return new Request("http://localhost/api/expenses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ category: "other", amount: "100", currency: "YER", payee: "Synthetic recipient", note }) });
}
async function failAudit(action: string) {
  await db.getPool().query(`CREATE FUNCTION ci_expense_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' THEN RAISE EXCEPTION 'synthetic expense audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ci_expense_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ci_expense_audit_fail()`);
}
async function restoreAudit() {
  await db.getPool().query("DROP TRIGGER ci_expense_audit_fail ON audit_log; DROP FUNCTION ci_expense_audit_fail()");
}
it("rolls back the cash voucher and journal when its required creation audit fails", async () => {
  const note = `synthetic-audit-${++sequence}`;
  const before = (await db.getOpenShift())!.expected;
  const journalBefore = await db.journalEntries("0001-01-01", "9999-12-31");
  await failAudit("expense.create");
  try {
    const response = await POST(request(note));
    expect.soft(response.status).toBe(500);
    expect.soft((await db.getPool().query("SELECT id FROM expenses WHERE note=$1", [note])).rows).toHaveLength(0);
    expect.soft((await db.getOpenShift())!.expected).toEqual(before);
    expect.soft(await db.journalEntries("0001-01-01", "9999-12-31")).toEqual(journalBefore);
    expect.soft((await db.getPool().query("SELECT id FROM audit_log WHERE action='expense.create' AND entity_id IN (SELECT id::text FROM expenses WHERE note=$1)", [note])).rows).toHaveLength(0);
  } finally { await restoreAudit(); }
  const response = await POST(request(note));
  expect(response.status).toBe(201);
  const expense = await response.json();
  expect((await db.getPool().query("SELECT id FROM expenses WHERE note=$1", [note])).rows).toHaveLength(1);
  expect((await db.getPool().query("SELECT actor,actor_role FROM audit_log WHERE action='expense.create' AND entity_id=$1", [String(expense.id)])).rows)
    .toEqual([{ actor: "expense-audit-ci", actor_role: "admin" }]);
});
function direct(overrides: Partial<Parameters<typeof db.recordExpense>[0]> = {}) {
  return { category: "other", partyId: null, payeeText: "Synthetic recipient", amountMinor: 100,
    currency: "YER" as const, baseCurrency: "YER" as const, exchangeRate: 1, payableId: null,
    note: `synthetic-direct-${++sequence}`, createdBy: "expense-audit-ci", actorRole: "admin",
    rates: { YER: 1, SAR: 140, USD: 535 }, ...overrides };
}
it.each(["expense.rate_override", "expense.prepayment"])("rolls back all evidence and cash when %s fails", async (action) => {
  const { rows: [party] } = await db.getPool().query("INSERT INTO parties(name,kind) VALUES('Synthetic supplier','supplier') RETURNING id");
  const input = direct({ currency: "SAR", amountMinor: 100, exchangeRate: 150,
    rateOverrideReason: "Synthetic rate reason", partyId: party.id, prepaymentReason: "Synthetic prepayment" });
  const before = (await db.getOpenShift())!.expected;
  const journalBefore = await db.journalEntries("0001-01-01", "9999-12-31");
  await failAudit(action);
  try {
    await expect(db.recordExpense(input)).rejects.toThrow("synthetic expense audit failure");
    expect((await db.getPool().query("SELECT id FROM expenses WHERE party_id=$1", [party.id])).rows).toHaveLength(0);
    expect((await db.getOpenShift())!.expected).toEqual(before);
    expect(await db.journalEntries("0001-01-01", "9999-12-31")).toEqual(journalBefore);
  } finally { await restoreAudit(); }
  const { expense } = await db.recordExpense(input);
  expect(expense).not.toBeNull();
  const { rows } = await db.getPool().query("SELECT action,details,actor_role FROM audit_log WHERE entity='expense' AND entity_id=$1 ORDER BY id", [String(expense!.id)]);
  expect(rows.map(row => row.action)).toEqual(["expense.create", "expense.rate_override", "expense.prepayment"]);
  expect(rows.every(row => row.actor_role === "admin")).toBe(true);
  expect(rows[1].details).toMatchObject({ سعر_الإعدادات: 140, السعر_المستعمل: 150, السبب: "Synthetic rate reason" });
  expect(rows[2].details).toMatchObject({ المستحق_قبل: 0, السبب: "Synthetic prepayment" });
});
it.each(["YER", "SAR", "USD"] as const)("records one audit and changes only the native %s cash bucket", async currency => {
  const input = direct({ currency, exchangeRate: { YER: 1, SAR: 140, USD: 535 }[currency] });
  const before = (await db.getOpenShift())!.expected;
  const { expense } = await db.recordExpense(input);
  expect((await db.getOpenShift())!.expected).toEqual({ ...before, [currency]: before[currency] - 100 });
  const { rows } = await db.getPool().query("SELECT details FROM audit_log WHERE action='expense.create' AND entity_id=$1", [String(expense!.id)]);
  expect(rows).toHaveLength(1);
  expect(rows[0].details).toMatchObject({ العملة: currency, المبلغ: 100, المكافئ: expense!.baseAmountMinor });
});
it("receipt read failure rolls back instead of failing after a committed cash movement", async () => {
  const pool = db.getPool();
  const connect = pool.connect.bind(pool);
  let injected = false;
  const before = (await db.getOpenShift())!.expected;
  vi.spyOn(pool, "connect").mockImplementationOnce(async () => {
    const client = await connect();
    const query = client.query.bind(client);
    return { async query<T>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
      if (sql.includes("FROM expenses e LEFT JOIN parties t") && sql.includes("WHERE e.id = $1")) {
        injected = true; throw new Error("synthetic receipt read failure");
      }
      return query<T>(sql, values);
    }, release() { client.release(); } } as DbClient;
  });
  const input = direct();
  await expect(db.recordExpense(input)).rejects.toThrow("synthetic receipt read failure");
  expect(injected).toBe(true);
  expect((await db.getPool().query("SELECT id FROM expenses WHERE note=$1", [input.note])).rows).toHaveLength(0);
  expect((await db.getOpenShift())!.expected).toEqual(before);
});
it("quote-only and refused expenses do not create vouchers or audit events", async () => {
  const before = await db.getPool().query("SELECT count(*)::int AS n FROM audit_log WHERE entity='expense'");
  expect((await db.recordExpense(direct({ quoteOnly: true }))).expense).toBeNull();
  expect((await db.recordExpense(direct({ expectedQuote: { paymentExchangeRate: 999 } }))).reason).toBe("stale_quote");
  expect((await db.getPool().query("SELECT count(*)::int AS n FROM audit_log WHERE entity='expense'")).rows).toEqual(before.rows);
});
it("discards the connection when rollback fails and preserves the original write error", async () => {
  const pool = db.getPool();
  const connect = pool.connect.bind(pool);
  const originalError = new Error("synthetic original expense read failure");
  let destroyed: boolean | undefined;
  const input = direct();
  vi.spyOn(pool, "connect").mockImplementationOnce(async () => {
    const client = await connect();
    const query = client.query.bind(client);
    return { async query<T>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
      if (sql.includes("FROM expenses e LEFT JOIN parties t") && sql.includes("WHERE e.id = $1")) throw originalError;
      if (sql === "ROLLBACK") throw new Error("synthetic failed rollback");
      return query<T>(sql, values);
    }, release(destroy?: boolean) { destroyed = destroy; client.release(destroy); } } as DbClient;
  });
  await expect(db.recordExpense(input)).rejects.toBe(originalError);
  expect(destroyed).toBe(true);
  expect((await db.getPool().query("SELECT id FROM expenses WHERE note=$1", [input.note])).rows).toHaveLength(0);
});
it.each([
  { currency: "YER" as const, rates: {}, exchangeRate: 1, expected: 1 },
  { currency: "SAR" as const, rates: {}, exchangeRate: 150, expected: null },
  { currency: "USD" as const, rates: { USD: 535 }, exchangeRate: 540, expected: 535 },
])("preserves settings audit value for $currency with $rates", async ({ currency, rates, exchangeRate, expected }) => {
  const input = direct({ currency, rates, exchangeRate, rateOverrideReason: "Synthetic override audit parity" });
  const { expense } = await db.recordExpense(input);
  const { rows } = await db.getPool().query("SELECT details FROM audit_log WHERE action='expense.rate_override' AND entity_id=$1", [String(expense!.id)]);
  expect(rows).toHaveLength(1);
  expect(rows[0].details).toMatchObject({ سعر_الإعدادات: expected, السعر_المستعمل: exchangeRate });
});
