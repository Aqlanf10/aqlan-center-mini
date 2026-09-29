import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

/**
 * (BILL-1 — قرار المالك R-P0-1: «القسط وحده يفوتر») باب القبض العام حين يُختار فيه هدفًا خطةٌ ممولة
 * بالأقساط يسجّل قسطًا بفاتورته — كزر «سجّل القسط» — لا دفعةً بلا فاتورة. والخطة «حسب الإجراء»
 * بلا أقساط تبقى دفعةً على الحساب كما كانت.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض قسط عبر القبض') RETURNING id`, [`BILLH-${Date.now()}`]));
  await db.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'bill-http', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
}, 120_000);
afterAll(async () => { await db?.end(); });

async function planFor(mode: "installments" | "per_procedure", withInstallments: boolean): Promise<number> {
  const { rows: [plan] } = await db.query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, billing_mode, consent_at)
     VALUES ($1, $2, 300000, 'YER', 'active', $3, NOW()) RETURNING id`,
    [patientId, `خطة ${mode}`, mode]);
  if (withInstallments) {
    await db.query(
      `INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
       VALUES ($1, 1, '2026-09-01', 150000), ($1, 2, '2026-10-01', 150000)`, [plan.id]);
  }
  return plan.id;
}

describe("POST /api/payments with a plan target", () => {
  it("an installment plan: the general collect screen records an installment with its invoice", async () => {
    const planId = await planFor("installments", true);
    const response = await authedMutation("/api/payments", h.sessions.reception, "POST",
      JSON.stringify({ patientId, planId, amount: "150000", currency: "YER", method: "cash" }),
      { "Idempotency-Key": `bill-http-${Date.now()}` });
    expect(response.status).toBe(201);
    const payment = await response.json() as { id: number; invoiceId: number | null; planId: number | null; amountMinor: number };
    expect(payment).toMatchObject({ planId, amountMinor: 150000 });
    expect(payment.invoiceId).not.toBeNull();
    const { rows: [invoice] } = await db.query<{ plan_id: number; total_minor: string; status: string }>(
      `SELECT plan_id, total_minor::text, status FROM invoices WHERE id = $1`, [payment.invoiceId]);
    expect(invoice).toEqual({ plan_id: planId, total_minor: "150000", status: "paid" });
  });

  it("a per-procedure plan without installments stays a plain plan payment (unchanged)", async () => {
    const planId = await planFor("per_procedure", false);
    const response = await authedMutation("/api/payments", h.sessions.reception, "POST",
      JSON.stringify({ patientId, planId, amount: "20000", currency: "YER", method: "cash" }));
    expect(response.status).toBe(201);
    const payment = await response.json() as { invoiceId: number | null; planId: number | null };
    expect(payment).toMatchObject({ planId, invoiceId: null });
  });
});
