import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl } from "./_setup";
import { loadDailyClinicExpenseReport } from "../../lib/daily-clinic-expense-report";

/** Query-contract fixtures only: temporary tables shadow production names, never public schema. */
const connectionString = assertRealPostgresUrl();
const target = new URL(connectionString);
if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
  throw new Error("Daily-clinic expense query fixtures require an explicitly local PostgreSQL test target.");
}
const client = new Client({ connectionString, ssl: false });
const query = { date: "2026-10-07", timeZone: "Asia/Aden" };

beforeAll(async () => {
  await client.connect();
  await client.query(`
    CREATE TEMP TABLE parties (id integer PRIMARY KEY, name text, kind text);
    CREATE TEMP TABLE payables (id integer PRIMARY KEY, party_id integer, source_type text);
    CREATE TEMP TABLE expense_categories (id integer PRIMARY KEY, key text, name text);
    CREATE TEMP TABLE expenses (
      id integer PRIMARY KEY, voucher_number text, created_at timestamptz, shift_id integer DEFAULT 1,
      category text DEFAULT 'custom', party_id integer, payee_text text DEFAULT 'synthetic recipient',
      amount_minor bigint, currency text, reversal_of_id integer, payable_id integer, note text, created_by text
    );
    CREATE TEMP TABLE expense_payable_allocations (
      id integer PRIMARY KEY, expense_id integer, payable_id integer,
      paid_minor bigint, payable_currency text, settled_minor bigint
    );
  `);
});
beforeEach(async () => {
  await client.query("TRUNCATE pg_temp.expense_payable_allocations, pg_temp.expenses, pg_temp.payables, pg_temp.parties, pg_temp.expense_categories");
});
afterAll(async () => { await client.end(); });

async function read(date = query.date, timeZone = query.timeZone) {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    return await loadDailyClinicExpenseReport({ date, timeZone }, client);
  } finally { await client.query("ROLLBACK"); }
}

describe("daily-clinic spending query on PostgreSQL", () => {
  it("selects the exact Asia/Aden day across UTC midnight, independent of shift", async () => {
    await client.query(`INSERT INTO pg_temp.expenses (id,voucher_number,created_at,amount_minor,currency,shift_id) VALUES
      (1,'EX-1','2026-10-06 20:59:59.999+00',1,'YER',99),
      (2,'EX-2','2026-10-06 21:00:00+00',10,'YER',99),
      (3,'EX-3','2026-10-07 20:59:59.999+00',20,'YER',100),
      (4,'EX-4','2026-10-07 21:00:00+00',100,'YER',100)`);
    const report = await read();
    expect(report.movements.map((row) => row.id)).toEqual([2, 3]);
    expect(report.totals.netOutflowMinor.YER).toBe(30);
  });

  it("keeps both repeated midnight hours in a configured DST timezone", async () => {
    await client.query(`INSERT INTO pg_temp.expenses (id,voucher_number,created_at,amount_minor,currency)
      SELECT row_number() OVER ()::int, 'DST-' || row_number() OVER (), instant, 1, 'YER'
      FROM generate_series('2026-11-01 03:00+00'::timestamptz, '2026-11-02 07:00+00'::timestamptz, interval '30 minute') instant`);
    const expected = (await client.query("SELECT id FROM pg_temp.expenses WHERE (created_at AT TIME ZONE 'America/Havana')::date = '2026-11-01' ORDER BY created_at,id")).rows;
    const report = await read("2026-11-01", "America/Havana");
    expect(report.movements.map((row) => row.id)).toEqual(expected.map((row) => row.id));
    expect(report.movements).toHaveLength(50);
  });

  it("aggregates allocation children without multiplying the native cash amount", async () => {
    await client.query(`
      INSERT INTO pg_temp.parties VALUES (8,'current laboratory name','lab');
      INSERT INTO pg_temp.payables VALUES (10,8,'operational'), (11,8,'operational'), (12,8,'operational');
      INSERT INTO pg_temp.expense_categories VALUES (1,'custom','custom inactive category');
      INSERT INTO pg_temp.expenses (id,voucher_number,created_at,amount_minor,currency,party_id,payee_text)
        VALUES (1,'EX-1','2026-10-07 09:00+00',1000,'YER',8,'recorded older name');
      INSERT INTO pg_temp.expense_payable_allocations VALUES
        (1,1,10,200,'SAR',50), (2,1,11,300,'SAR',75), (3,1,12,500,'USD',100);
    `);
    const report = await read();
    expect(report.movements).toHaveLength(1);
    expect(report.movements[0].allocations).toHaveLength(3);
    expect(report.movements[0].unallocatedMinor).toBe(0);
    expect(report.movements[0].recipient).toMatchObject({ partyId: 8, currentPartyName: "current laboratory name", recordedPayeeText: "recorded older name" });
    expect(report.totals.netOutflowMinor).toEqual({ YER: 1000, SAR: 0, USD: 0 });
  });

  it("shows later-day reversals and opening-debt payments without counting payable creation", async () => {
    await client.query(`
      INSERT INTO pg_temp.parties VALUES (8,'supplier','supplier');
      INSERT INTO pg_temp.payables VALUES (10,8,'opening'), (11,8,'operational');
      INSERT INTO pg_temp.expenses (id,voucher_number,created_at,amount_minor,currency,party_id,payable_id,reversal_of_id)
        VALUES (1,'EX-1','2026-10-06 10:00+00',1000,'YER',8,10,NULL),
               (2,'RV-2','2026-10-07 10:00+00',-1000,'YER',8,10,1);
    `);
    const report = await read();
    expect(report.movements).toHaveLength(1);
    expect(report.movements[0]).toMatchObject({ originalVoucherNumber: "EX-1", payableSourceType: "opening", kind: "reversal" });
    expect(report.totals.netOutflowMinor.YER).toBe(-1000);
  });

  it("does not cap a busy day at the old expense-list limit", async () => {
    await client.query(`INSERT INTO pg_temp.expenses (id,voucher_number,created_at,amount_minor,currency)
      SELECT i, 'EX-' || i, '2026-10-07 09:00+00'::timestamptz, 1, 'YER' FROM generate_series(1,1005) i`);
    const report = await read();
    expect(report.movements).toHaveLength(1005);
    expect(report.totals.netOutflowMinor.YER).toBe(1005);
    expect(report.recipientTotals[0].totals.voucherCount).toBe(1005);
  });
});
