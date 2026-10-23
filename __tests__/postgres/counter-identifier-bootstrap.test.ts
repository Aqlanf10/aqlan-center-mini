import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { documentNumberSql, PATIENT_NUMBER_SQL } from "../../lib/document-numbers";
import { counterIdentifierBigintSql } from "../../lib/counter-identifier-sql";

assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const counters = [
  ["patients", "patient_number", "patient_number_seq"],
  ["invoices", "invoice_number", "invoice_number_seq"],
  ["payments", "receipt_number", "receipt_number_seq"],
  ["expenses", "voucher_number", "voucher_number_seq"],
] as const;

beforeAll(async () => { await dropPublicSchema(process.env.DATABASE_URL!); await db.ensureSchema(); });
afterAll(async () => { await db.resetPoolForTesting(); });

it.each([
  ["", "0"], ["letters-only", "0"], ["000000", "0"],
  ["P-" + "0".repeat(1000) + "42", "42"], ["P12-middle003", "12003"],
  ["9223372036854775806", "9223372036854775806"],
  ["9223372036854775807", "9223372036854775807"],
  ["9223372036854775808", null], ["9999999999999999999", null],
  ["10000000000000000000", null], ["9".repeat(100_000), null],
])("projects bounded digits without unsafe casts (case %#)", async (value, expected) => {
  for (const [, column] of counters) {
    const { rows } = await db.getPool().query(
      `SELECT (${counterIdentifierBigintSql(column)})::text AS n FROM (VALUES ($1::text)) fixture(${column})`, [value]);
    expect(rows[0].n).toBe(expected);
  }
});

it("restarts on arbitrary TEXT identifiers, retains rows and forward-only positions, and issues unique next values", async () => {
  const pool = db.getPool();
  const patient = (await pool.query(`INSERT INTO patients (patient_number, full_name)
    VALUES ('synthetic-9223372036854775808', 'Synthetic counter bootstrap') RETURNING id`)).rows[0].id;
  const shift = (await pool.query(`INSERT INTO cashier_shifts (opened_by) VALUES ('synthetic-counter') RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO invoices (invoice_number, patient_id, total_minor) VALUES ('synthetic-9223372036854775808', $1, 100)`, [patient]);
  await pool.query(`INSERT INTO payments (receipt_number, patient_id, shift_id, amount_minor, currency, base_amount_minor)
    VALUES ('synthetic-9223372036854775808', $1, $2, 10, 'YER', 10)`, [patient, shift]);
  await pool.query(`INSERT INTO expenses (voucher_number, category, shift_id, amount_minor, currency, base_amount_minor)
    VALUES ('synthetic-9223372036854775808', 'other', $1, 5, 'YER', 5)`, [shift]);
  for (const [, , sequence] of counters) {
    await pool.query(`SELECT setval('${sequence}', 500, true)`);
  }
  const before = await Promise.all(counters.map(async ([table]) =>
    (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows));
  await db.resetPoolForTesting(); // New pool/connection and schema promise, like a fresh server bundle.
  await expect(db.ensureSchema()).resolves.toBeUndefined();
  for (const [index, [table, column, sequence]] of counters.entries()) {
    expect((await db.getPool().query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows).toEqual(before[index]);
    expect((await db.getPool().query(`SELECT last_value::text FROM ${sequence}`)).rows[0].last_value).toBe("500");
    const numberSql = [PATIENT_NUMBER_SQL, documentNumberSql("invoice"), documentNumberSql("receipt"), documentNumberSql("voucher")][index];
    const values = (await db.getPool().query(`SELECT ${numberSql} AS n FROM generate_series(1,2)`)).rows.map(row => row.n);
    const prefix = ["P", "INV", "R", "V"][index];
    expect(values).toEqual([`${prefix}-00501`, `${prefix}-00502`]);
    expect((await db.getPool().query(`SELECT 1 FROM ${table} WHERE ${column} = ANY($1::text[])`, [values])).rows).toEqual([]);
  }
});

it("aligns a genuine maximum and keeps sequence exhaustion fail-closed", async () => {
  await db.getPool().query(`INSERT INTO patients (patient_number, full_name)
    VALUES ('P-0009223372036854775807', 'Synthetic maximum counter')`);
  await db.resetPoolForTesting();
  await db.ensureSchema();
  expect((await db.getPool().query("SELECT last_value::text FROM patient_number_seq")).rows[0].last_value).toBe("9223372036854775807");
  await expect(db.getPool().query("SELECT nextval('patient_number_seq')")).rejects.toMatchObject({ code: "2200H" });
});
