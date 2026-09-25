import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P2-5 + P2-9) على PostgreSQL 18: سجلّ الرصيد الافتتاحي append-only، وقيود المال.
 *
 * العيب (تدقيق الجاهزية): الرصيد الافتتاحي يُستبدل (upsert) ويُحذف (DELETE) بلا أثرٍ
 * لقيمته السابقة؛ وجداول المال بلا أي قيد CHECK — تحقق الـAPI وحده يحرسها.
 */
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const { ensureSchema, getPool, resetPoolForTesting, setPatientOpeningBalance, clearPatientOpeningBalance, listOpeningBalanceHistory } = db;

const q = async (sql: string, params: unknown[] = []) => (await getPool().query(sql, params)).rows;
let patientId = 0;
let shiftId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  [{ id: patientId }] = await q(`INSERT INTO patients (patient_number, full_name) VALUES ('FC-1', 'رصيد افتتاحي') RETURNING id`);
  [{ id: shiftId }] = await q(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd) VALUES ('fc', 0, 0, 0) RETURNING id`);
});
afterAll(async () => { await resetPoolForTesting(); });

describe("P2-5 — opening balance history", () => {
  it("set → correct → clear leaves three history rows with every previous value", async () => {
    await setPatientOpeningBalance({ patientId, amountMinor: 50000, asOfDate: "2025-01-01", note: null, createdBy: "admin" });
    await setPatientOpeningBalance({ patientId, amountMinor: 45000, asOfDate: "2025-01-01", note: null, createdBy: "admin", reason: "تصحيح دفتر قديم" });
    expect(await clearPatientOpeningBalance(patientId, "admin", "سُدّد خارج النظام")).toBe(true);

    const history = await listOpeningBalanceHistory(patientId);
    expect(history.map((row) => row.action)).toEqual(["clear", "set", "set"]);
    expect(history[2]).toMatchObject({ beforeAmountMinor: null, afterAmountMinor: 50000, actor: "admin" });
    expect(history[1]).toMatchObject({ beforeAmountMinor: 50000, afterAmountMinor: 45000, reason: "تصحيح دفتر قديم" });
    expect(history[0]).toMatchObject({ beforeAmountMinor: 45000, afterAmountMinor: null, reason: "سُدّد خارج النظام" });
  });

  it("history cannot be edited or deleted, even from SQL", async () => {
    await expect(q(`UPDATE patient_opening_balance_history SET after_amount_minor = 1 WHERE patient_id = $1`, [patientId]))
      .rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM patient_opening_balance_history WHERE patient_id = $1`, [patientId]))
      .rejects.toThrow(/append-only/);
  });

  it("deleting the patient itself (cascade) still works", async () => {
    const [{ id }] = await q(`INSERT INTO patients (patient_number, full_name) VALUES ('FC-2', 'مؤقت') RETURNING id`);
    await setPatientOpeningBalance({ patientId: id, amountMinor: 1000, asOfDate: "2025-01-01", note: null, createdBy: "admin" });
    await clearPatientOpeningBalance(id, "admin", "خطأ إدخال");
    await q(`DELETE FROM patients WHERE id = $1`, [id]);
    expect(await q(`SELECT 1 FROM patient_opening_balance_history WHERE patient_id = $1`, [id])).toHaveLength(0);
  });
});

describe("P2-9 — money CHECK constraints (defence in depth)", () => {
  const payment = (amount: number, currency = "YER", kind = "payment") => q(
    `INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor, currency, exchange_rate,
                           base_amount_minor, base_currency, method, created_by)
     VALUES ('FC-' || gen_random_uuid(), $1, $2, $3, $4, $5, 1, $4, 'YER', 'cash', 't')`,
    [patientId, shiftId, kind, amount, currency],
  );

  it("rejects zero/negative payments, unknown currencies and unknown kinds", async () => {
    await expect(payment(0)).rejects.toThrow(/payments_amount_positive/);
    await expect(payment(-5)).rejects.toThrow(/payments_amount_positive/);
    await expect(payment(100, "EUR")).rejects.toThrow(/payments_currency_known/);
    await expect(payment(100, "YER", "gift")).rejects.toThrow(/payments_kind_known/);
    await expect(payment(100)).resolves.toBeDefined();
  });

  it("rejects an invoice whose discount exceeds its total or with an unknown currency", async () => {
    const invoice = (total: number, discount: number, currency = "YER") => q(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
       VALUES ('FC-INV-' || gen_random_uuid(), $1, $2, $3, $4, 't')`, [patientId, total, discount, currency],
    );
    await expect(invoice(1000, 2000)).rejects.toThrow(/invoices_amounts_sane/);
    await expect(invoice(1000, 0, "GBP")).rejects.toThrow(/invoices_currency_known/);
    await expect(invoice(1000, 100)).resolves.toBeDefined();
  });
});
