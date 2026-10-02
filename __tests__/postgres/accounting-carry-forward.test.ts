import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema, stubPostgresEnv } from "./_setup";
import { accountLedger, accountingPeriod, LEDGER_HISTORY_START } from "../../lib/accounting-reports";

// Reject unsafe original classifications before any environment normalization
// or database operation. Only the canonical isolated synthetic test DB is used.
const target = validatePostgresTestTarget(process.env);
stubPostgresEnv();
const db = await import("../../lib/db");

beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
  const shift = (await db.openShift({ openedBy: "carry-forward-test", opening: { YER: 0, SAR: 0, USD: 0 } }))!;
  const pool = db.getPool();
  const { rows: [patient] } = await pool.query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ('CARRY-FORWARD', 'Synthetic carry-forward') RETURNING id",
  );
  // Source timestamps straddle clinic midnight (Asia/Aden), not UTC midnight.
  for (const [reference, time, amount] of [
    ["CARRY-PREV", "2098-09-30T20:59:59Z", 10_000],
    ["CARRY-FUTURE", "2098-10-01T21:00:00Z", 70_000],
  ] as const) {
    await pool.query(`INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor,
      currency, exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
      VALUES ($1, $2, $3, 'payment', $4, 'YER', 1, $4, 'YER', 'cash', 'carry-forward-test', $5)`,
    [reference, patient.id, shift.id, amount, time]);
  }
  await pool.query(`INSERT INTO expenses (voucher_number, category, shift_id, amount_minor,
    currency, exchange_rate, base_amount_minor, base_currency, created_at)
    VALUES ('CARRY-EXP', 'electricity', $1, 2000, 'YER', 1, 2000, 'YER', '2098-09-30T21:00:00Z')`, [shift.id]);
  await db.createManualEntry({ date: "0999-01-01", description: "Synthetic early opening", createdBy: "carry-forward-test", lines: [
    { accountCode: "1103", currency: "USD", amountMinor: 12_345, side: "debit" },
    { accountCode: "3101", currency: "USD", amountMinor: 12_345, side: "credit" },
  ] });
  await db.createManualEntry({ date: "0001-01-01", description: "Synthetic first-year opening", createdBy: "carry-forward-test", lines: [
    { accountCode: "1102", currency: "SAR", amountMinor: 500, side: "debit" },
    { accountCode: "3101", currency: "SAR", amountMinor: 500, side: "credit" },
  ] });
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

describe("carry-forward reads real PostgreSQL source dates without rewriting history", () => {
  it("includes prior clinic-day cash and earliest dated opening, excluding the following clinic day", async () => {
    const entries = await db.journalEntries(LEDGER_HISTORY_START, "2098-10-01");
    const report = accountingPeriod(entries, "2098-10-01", "2098-10-01");
    expect(entries.find((entry) => entry.reference === "CARRY-PREV")?.date).toBe("2098-09-30");
    expect(entries.find((entry) => entry.reference === "CARRY-EXP")?.date).toBe("2098-10-01");
    expect(entries.some((entry) => entry.reference === "CARRY-FUTURE")).toBe(false);
    expect(accountLedger(report, "1101", "YER")).toMatchObject({
      openingBalanceMinor: 10_000, periodDebitMinor: 0, periodCreditMinor: 2_000, closingBalanceMinor: 8_000,
      rows: [{ reference: "CARRY-EXP", balanceMinor: 8_000 }],
    });
    expect(accountLedger(report, "1103", "USD")).toMatchObject({
      openingBalanceMinor: 12_345, periodDebitMinor: 0, periodCreditMinor: 0, closingBalanceMinor: 12_345, rows: [],
    });
    expect(accountLedger(report, "1102", "SAR")).toMatchObject({
      openingBalanceMinor: 500, closingBalanceMinor: 500, rows: [],
    });
    expect(report.statements.find((item) => item.currency === "USD")?.income.netProfitMinor).toBe(0);
    expect(report.statements.every((item) => item.sheet.differenceMinor === 0)).toBe(true);
  });

  it("keeps existing period journal reads unchanged for journal export", async () => {
    const periodEntries = await db.journalEntries("2098-10-01", "2098-10-01");
    expect(periodEntries.map((entry) => entry.reference)).toEqual(["CARRY-EXP"]);
    const { rows } = await db.getPool().query("SELECT amount_minor::text, created_at FROM payments WHERE receipt_number='CARRY-PREV'");
    expect(rows[0].amount_minor).toBe("10000");
    expect(rows[0].created_at.toISOString()).toBe("2098-09-30T20:59:59.000Z");
  });
});
