import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/** (FIN-DISC) Admin discount on an issued invoice, on real PostgreSQL with the real writer. */
assertRealPostgresUrl();
stubPostgresEnv();

const { getPool, resetPoolForTesting, ensureSchema, applyAdminInvoiceDiscount, computeDebtRows, setInvoiceStatus } = await import("../../lib/db");

let patientId = 0;
let shiftId = 0;
let seq = 0;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  ({ rows: [{ id: patientId }] } = await pool.query(`INSERT INTO patients (patient_number, full_name) VALUES ('DISC-1', 'مريض الخصم') RETURNING id`));
  ({ rows: [{ id: shiftId }] } = await pool.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd) VALUES ('disc', 0, 0, 0) RETURNING id`));
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function invoice(total = 100000, currency = "YER") {
  seq += 1;
  const { rows: [row] } = await getPool().query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
     VALUES ($1, $2, $3, 0, $4, 'reception1') RETURNING id`, [`DISC-INV-${seq}`, patientId, total, currency]);
  await getPool().query(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
    VALUES ($1, 'علاج', 1, $2, $2)`, [row.id, total]);
  return row.id;
}
async function pay(invoiceId: number, amount: number, kind: "payment" | "refund" = "payment") {
  seq += 1;
  await getPool().query(`INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate,
      base_amount_minor, base_currency, method, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'YER', 1, $6, 'YER', 'cash', 'reception1')`,
    [`DISC-R-${seq}`, patientId, invoiceId, shiftId, kind, amount]);
}
const due = async () => (await computeDebtRows([patientId])).find((row) => row.currency === "YER")?.dueMinor ?? 0;
const state = async (id: number) => (await getPool().query(
  `SELECT discount_minor::int AS discount, status, total_minor::int AS total FROM invoices WHERE id = $1`, [id])).rows[0];
const apply = (invoiceId: number, additionalMinor: number, expectedDiscountMinor: number | null, reason = "قرار الإدارة") =>
  applyAdminInvoiceDiscount({ invoiceId, additionalMinor, expectedDiscountMinor, reason, actor: "admin1", actorRole: "admin" });

describe("(FIN-DISC) admin discount on an issued invoice", () => {
  it("reduces the invoice net and the patient's due once, keeps items/payments, and audits the decision", async () => {
    const id = await invoice();
    await pay(id, 30000);
    const before = await due();
    const items = (await getPool().query(`SELECT * FROM invoice_items WHERE invoice_id = $1`, [id])).rows;
    const result = await apply(id, 20000, 0);
    expect(result).toMatchObject({ ok: true, afterDiscountMinor: 20000, remainingAfterMinor: 50000 });
    expect(await state(id)).toEqual({ discount: 20000, status: "open", total: 100000 });
    expect(await due()).toBe(before - 20000);
    expect((await getPool().query(`SELECT * FROM invoice_items WHERE invoice_id = $1`, [id])).rows).toEqual(items);
    expect((await getPool().query(`SELECT COUNT(*)::int AS n FROM payments WHERE invoice_id = $1`, [id])).rows[0].n).toBe(1);
    const { rows: [audit] } = await getPool().query(`SELECT actor, details FROM audit_log WHERE action = 'invoice.discount' AND entity_id = $1`, [String(id)]);
    expect(audit.actor).toBe("admin1");
    expect(audit.details.السبب).toBe("قرار الإدارة");
  });

  it("never discounts what was already paid, and a refusal changes nothing", async () => {
    const id = await invoice();
    await pay(id, 70000);
    const before = await due();
    expect(await apply(id, 30001, 0)).toMatchObject({ ok: false, reason: "exceeds_remaining" });
    expect(await state(id)).toMatchObject({ discount: 0 });
    expect(await due()).toBe(before);
    expect((await getPool().query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'invoice.discount' AND entity_id = $1`, [String(id)])).rows[0].n).toBe(0);
    expect(await apply(id, 30000, 0)).toMatchObject({ ok: true, remainingAfterMinor: 0 });
  });

  it("refuses cancelled and paid invoices, a stale expected discount, and a short reason", async () => {
    const cancelled = await invoice();
    await setInvoiceStatus(cancelled, "cancelled", { actor: "admin1", actorRole: "admin" });
    expect(await apply(cancelled, 1000, 0)).toMatchObject({ ok: false, reason: "cancelled" });
    const paid = await invoice();
    await setInvoiceStatus(paid, "paid", { actor: "admin1", actorRole: "admin" });
    expect(await apply(paid, 1000, 0)).toMatchObject({ ok: false, reason: "paid" });
    const stale = await invoice();
    expect(await apply(stale, 1000, 0)).toMatchObject({ ok: true });
    expect(await apply(stale, 1000, 0)).toMatchObject({ ok: false, reason: "stale" }); // a resubmitted form cannot double-apply
    expect(await state(stale)).toMatchObject({ discount: 1000 });
    expect(await apply(stale, 1000, 1000, "  ")).toMatchObject({ ok: false, reason: "reason" });
  });

  it("serializes two concurrent decisions on the same invoice: exactly one applies", async () => {
    const id = await invoice();
    const results = await Promise.all([apply(id, 10000, 0), apply(id, 10000, 0)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === "stale")).toHaveLength(1);
    expect(await state(id)).toMatchObject({ discount: 10000 });
  });
});
