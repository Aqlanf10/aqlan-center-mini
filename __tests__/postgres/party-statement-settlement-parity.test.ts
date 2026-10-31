import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { partyStatementNetMinor } from "../../lib/party-statement";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const rates = { YER: 1, SAR: 140, USD: 535 } as const;
type Currency = keyof typeof rates;

const query = async (sql: string, params: unknown[] = []) => (await db.getPool().query(sql, params)).rows;

async function party(kind: "supplier" | "lab") {
  return (await query("INSERT INTO parties (name, kind) VALUES ($1, $2) RETURNING id", [`Synthetic ${kind}`, kind]))[0].id as number;
}

async function bill(partyId: number, amountMinor: number, currency: Currency = "YER", labOrderId: number | null = null) {
  const payable = await db.createPayable({ partyId, category: "lab", description: "Synthetic statement acceptance",
    amountMinor, currency, baseCurrency: "YER", exchangeRate: rates[currency], labOrderId, dueDate: null, createdBy: "test" });
  return payable!.id;
}

async function payment(partyId: number, amountMinor: number, currency: Currency = "YER", payableId: number | null = null) {
  return db.recordExpense({ category: "lab", partyId, amountMinor, currency, payableId,
    baseCurrency: "YER", exchangeRate: rates[currency], rates, createdBy: "test", payeeText: null, note: null });
}

async function order(partyId: number, amountMinor: number, currency: Currency = "YER") {
  const patientId = (await query("INSERT INTO patients (patient_number, full_name) VALUES ('SYN-' || nextval('patients_id_seq'), 'Synthetic') RETURNING id"))[0].id;
  const id = (await query(`INSERT INTO lab_orders (patient_id, lab_name, work_type, due_date, status, party_id, cost_minor, cost_currency, financial_status)
    VALUES ($1, 'Synthetic lab', 'test', CURRENT_DATE, 'delivered', $2, $3, $4, 'payable_created') RETURNING id`, [patientId, partyId, amountMinor, currency]))[0].id as number;
  const payableId = await bill(partyId, amountMinor, currency, id);
  await query("UPDATE lab_orders SET payable_id=$1 WHERE id=$2", [payableId, id]);
  return id;
}

async function expectParity(partyId: number) {
  const statement = await db.partyStatement(partyId);
  const statementNet = statement.totals.map((row) => ({ currency: row.currency, dueMinor: partyStatementNetMinor(row) })).filter((row) => row.dueMinor !== 0);
  const canonical = (await db.partyDueByCurrency()).filter((row) => row.partyId === partyId).map(({ currency, dueMinor }) => ({ currency, dueMinor }));
  expect(statementNet).toEqual(canonical);
  return statement;
}

beforeEach(async () => {
  await db.resetPoolForTesting();
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  await query("DELETE FROM parties");
  await query("INSERT INTO cashier_shifts (opened_by) VALUES ('statement-acceptance')");
});
afterAll(async () => { await db.resetPoolForTesting(); });

describe("statement balances agree with the current native settlement owner", () => {
  it.each(["supplier", "lab"] as const)("on-account %s payment reduces the displayed debt, not its invoice remainder", async (kind) => {
    const partyId = await party(kind);
    await bill(partyId, 30_000);
    const paid = await payment(partyId, 20_000);
    expect(paid.reason).toBeNull();
    const statement = await db.partyStatement(partyId);
    const canonical = (await db.partyDueByCurrency()).filter((row) => row.partyId === partyId);
    expect(canonical).toMatchObject([{ currency: "YER", dueMinor: 10_000 }]);
    expect(statement.payables[0].remainingMinor).toBe(30_000);
    expect(statement.totals[0].unlinkedPaidMinor).toBe(20_000);
    const displayed = partyStatementNetMinor(statement.totals[0]);
    expect(displayed).toBe(canonical[0].dueMinor);
  });

  it("a fully allocated lab batch is not an on-account advance", async () => {
    const partyId = await party("lab");
    const a = await order(partyId, 10_000);
    const b = await order(partyId, 10_000);
    const result = await db.settleLabOrdersBatch({ partyId, orderIds: [a, b], amountMinor: 20_000, currency: "YER",
      baseCurrency: "YER", exchangeRate: 1, rates, createdBy: "test", actorRole: "admin", note: null });
    expect(result.ok).toBe(true);
    const statement = await db.partyStatement(partyId);
    expect((await db.partyDueByCurrency()).filter((row) => row.partyId === partyId)).toEqual([]);
    expect(statement.payables.map((row) => row.remainingMinor)).toEqual([0, 0]);
    expect(statement.totals[0]).toMatchObject({ paidMinor: 20_000, settledMinor: 20_000, remainingMinor: 0, unlinkedPaidMinor: 0 });
  });

  it("linked cross-currency payment, stored FX and reversal already preserve native debt", async () => {
    const partyId = await party("lab");
    const payableId = await bill(partyId, 10_000, "USD");
    const paid = await payment(partyId, 26_750, "YER", payableId);
    expect(paid.expense).toMatchObject({ currency: "YER", amountMinor: 26_750, payableCurrency: "USD", payableSettledMinor: 5_000, payableExchangeRate: 535 });
    expect((await db.partyDueByCurrency()).filter((row) => row.partyId === partyId)).toMatchObject([{ currency: "USD", dueMinor: 5_000 }]);
    const quote = await db.recordExpense({ category: "lab", partyId, payableId, amountMinor: 1, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      rates: { ...rates, USD: 600 }, createdBy: "test", payeeText: null, note: null, quoteOnly: true });
    expect(quote.quote?.payable?.remainingBeforeMinor).toBe(5_000);
    expect((await db.getExpense(paid.expense!.id))?.payableExchangeRate).toBe(535);
    const reversed = await db.voidExpense(paid.expense!.id, { actor: "test", actorRole: "admin", reason: "Synthetic reversal" });
    expect(reversed.ok).toBe(true);
    expect((await db.partyDueByCurrency()).filter((row) => row.partyId === partyId)).toMatchObject([{ currency: "USD", dueMinor: 10_000 }]);
    expect((await query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action='expense.void'"))[0].n).toBe(1);
    expect((await db.partyStatement(partyId)).totals).toMatchObject([{ currency: "USD", settledMinor: 0, remainingMinor: 10_000, unlinkedPaidMinor: 0 }]);
  });

  it.each(["YER", "SAR", "USD"] as const)("partial historical allocation and its reversal preserve %s native net", async (currency) => {
    const partyId = await party("supplier");
    const payableId = await bill(partyId, 30_000, currency);
    const paid = await payment(partyId, 20_000, currency);
    expect(paid.reason).toBeNull();
    // Compatibility with existing historical partial allocations, not a new writer feature.
    await query(`INSERT INTO expense_payable_allocations (expense_id, payable_id, paid_minor, payable_currency, payable_exchange_rate, settled_minor)
      VALUES ($1, $2, 10000, $3, $4, 10000)`, [paid.expense!.id, payableId, currency, rates[currency]]);
    const before = await expectParity(partyId);
    expect(before.totals[0]).toMatchObject({ currency, paidMinor: 20_000, unlinkedPaidMinor: 10_000, remainingMinor: 20_000 });
    expect(partyStatementNetMinor(before.totals[0])).toBe(10_000);
    const originalExpense = await db.getExpense(paid.expense!.id);
    expect((await db.voidExpense(paid.expense!.id, { actor: "test", reason: "Synthetic allocation reversal" })).ok).toBe(true);
    expect(await db.getExpense(paid.expense!.id)).toEqual(originalExpense);
    expect((await expectParity(partyId)).totals[0]).toMatchObject({ currency, paidMinor: 0, unlinkedPaidMinor: 0, remainingMinor: 30_000 });
  });

  it("mixed legacy allocation currencies subtract payment units, never payable settled units", async () => {
    const partyId = await party("lab");
    const usd = await bill(partyId, 10_000, "USD"), sar = await bill(partyId, 2_000, "SAR");
    await bill(partyId, 5_000, "YER");
    const paid = await payment(partyId, 30_000);
    expect(paid.reason).toBeNull();
    await query(`INSERT INTO expense_payable_allocations (expense_id, payable_id, paid_minor, payable_currency, payable_exchange_rate, settled_minor)
      VALUES ($1, $2, 26750, 'USD', 535, 5000), ($1, $3, 1400, 'SAR', 140, 1000)`, [paid.expense!.id, usd, sar]);
    const statement = await expectParity(partyId);
    expect(statement.totals.map((row) => [row.currency, row.unlinkedPaidMinor, partyStatementNetMinor(row)])).toEqual([
      ["YER", 1_850, 3_150], ["SAR", 0, 1_000], ["USD", 0, 5_000],
    ]);
    expect((await db.voidExpense(paid.expense!.id, { actor: "test", reason: "Synthetic mixed reversal" })).ok).toBe(true);
    expect((await expectParity(partyId)).totals.map((row) => [row.currency, partyStatementNetMinor(row)])).toEqual([
      ["YER", 5_000], ["SAR", 2_000], ["USD", 10_000],
    ]);
  });

  it("keeps an unlinked foreign-currency payment as its own credit bucket", async () => {
    const partyId = await party("supplier");
    await bill(partyId, 10_000, "USD");
    expect((await payment(partyId, 26_750)).reason).toBeNull();
    expect((await expectParity(partyId)).totals.map((row) => [row.currency, partyStatementNetMinor(row)])).toEqual([
      ["YER", -26_750], ["USD", 10_000],
    ]);
  });

  it("matches canonical dangling historical payable linkage without changing the stored ID", async () => {
    const partyId = await party("supplier");
    await bill(partyId, 30_000);
    const [expense] = await query(`INSERT INTO expenses
      (voucher_number, category, party_id, shift_id, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, payable_id, created_by)
      VALUES ('SYN-ORPHAN', 'lab', $1, (SELECT id FROM cashier_shifts WHERE status='open'), 20000, 'YER', 1, 20000, 'YER', 999999, 'test') RETURNING id`, [partyId]);
    const statement = await expectParity(partyId);
    expect(statement.totals[0]).toMatchObject({ remainingMinor: 30_000, unlinkedPaidMinor: 20_000 });
    expect(partyStatementNetMinor(statement.totals[0])).toBe(10_000);
    expect(statement.expenses[0]).toMatchObject({ payableId: 999999, payableExists: false });
    expect((await query("SELECT payable_id FROM expenses WHERE id=$1", [expense.id]))[0].payable_id).toBe(999999);
  });

  it.each(["YER", "SAR", "USD"] as const)("full %s batch, cancellation and reversal preserve statement parity", async (currency) => {
    const partyId = await party("lab");
    const a = await order(partyId, 10_000, currency), b = await order(partyId, 10_000, currency);
    const result = await db.settleLabOrdersBatch({ partyId, orderIds: [a, b], amountMinor: 20_000, currency,
      baseCurrency: "YER", exchangeRate: rates[currency], rates, createdBy: "test", actorRole: "admin", note: null });
    if (!result.ok) throw new Error(`Unexpected refusal ${result.reason}`);
    const paid = await expectParity(partyId);
    expect(paid.totals[0]).toMatchObject({ currency, unlinkedPaidMinor: 0, remainingMinor: 0 });
    await db.setLabOrderStatus(a, "cancelled", { actor: "test" });
    const cancelled = await expectParity(partyId);
    expect(cancelled.payables).toHaveLength(2);
    expect(cancelled.totals).toEqual(paid.totals);
    expect((await db.voidExpense(result.expense.id, { actor: "test", reason: "Synthetic batch reversal" })).ok).toBe(true);
    expect((await expectParity(partyId)).totals[0]).toMatchObject({ currency, unlinkedPaidMinor: 0, paidMinor: 0, remainingMinor: 20_000 });
    expect((await db.voidExpense(result.expense.id, { actor: "test", reason: "Duplicate reversal" })).reason).toBe("already_voided");
  });
});
