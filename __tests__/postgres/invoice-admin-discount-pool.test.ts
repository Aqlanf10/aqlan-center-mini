import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (FIN-DISC, review 5464675830) The admin-discount and correction guards read the canonical commission report on their own
 * transaction: they never take a second pooled connection while holding the shift and invoice locks. With one pooled
 * connection, and with at least as many concurrent requests as connections, every request completes and nothing is half
 * written. Real PostgreSQL, disposable database, synthetic rows only.
 */
assertRealPostgresUrl();
stubPostgresEnv();
process.env.DB_POOL_MAX = "1";

const db = await import("../../lib/db");
const { getPool, resetPoolForTesting, ensureSchema, createInvoice, applyAdminInvoiceDiscount, correctInvoice } = db;

let doctorId = 0;
let service = 0;
let seq = 0;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await getPool().query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd) VALUES ('disc-pool', 0, 0, 0)`);
  ({ rows: [{ id: doctorId }] } = await getPool().query(`INSERT INTO parties (name, kind, commission_percent) VALUES ('د. مسبح اصطناعي', 'doctor', 50) RETURNING id`));
  ({ rows: [{ id: service }] } = await getPool().query(`INSERT INTO services (name, category, price_minor, is_active) VALUES ('خدمة', 'synthetic-pool', 100000, TRUE) RETURNING id`));
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); delete process.env.DB_POOL_MAX; });

async function invoice() {
  seq += 1;
  const { rows: [{ id: patientId }] } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض مسبح اصطناعي') RETURNING id`, [`DISC-P-${seq}`]);
  const created = await createInvoice({ patientId, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "reception",
    items: [{ serviceId: service, doctorId, description: "عمل", quantity: 1, unitPriceMinor: 100000 }] });
  return created!.id;
}
const decide = (invoiceId: number, expectedDiscount = 0) => applyAdminInvoiceDiscount({ invoiceId, additionalMinor: 10000,
  reason: "قرار الإدارة", actor: "admin1", actorRole: "admin", expected: { discountMinor: expectedDiscount, settledMinor: 0 } });
const rowsOf = async (invoiceId: number) => Number((await getPool().query(
  `SELECT COUNT(*)::int AS n FROM invoice_admin_discount_lines WHERE invoice_id = $1`, [invoiceId])).rows[0].n);

describe("no second pooled connection while the guard holds its locks", () => {
  it("DB_POOL_MAX=1: a doctor-linked discount and a guarded correction both complete", async () => {
    const id = await invoice();
    expect(await decide(id)).toMatchObject({ ok: true, afterDiscountMinor: 10000 });
    expect(await rowsOf(id)).toBe(1);
    const { rows: [item] } = await getPool().query<{ id: number }>(`SELECT id FROM invoice_items WHERE invoice_id = $1`, [id]);
    const corrected = await correctInvoice({ invoiceId: id, lines: [{ itemId: item.id, quantity: 1, unitPriceMinor: 90000 }],
      reason: "تصحيح", actor: "admin1", actorRole: "admin" });
    expect(corrected.ok).toBe(true);
  }, 60_000);

  it("DB_POOL_MAX=1: three concurrent discounts all complete, each fully written", async () => {
    const ids = [await invoice(), await invoice(), await invoice()];
    const results = await Promise.all(ids.map((id) => decide(id)));
    expect(results.every((one) => one.ok)).toBe(true);
    for (const id of ids) expect(await rowsOf(id)).toBe(1);
  }, 60_000);

  it("pool of 3 with 4 concurrent discounts (at least the pool size): all complete, each fully written", async () => {
    await resetPoolForTesting();
    process.env.DB_POOL_MAX = "3";
    const ids = [await invoice(), await invoice(), await invoice(), await invoice()];
    const results = await Promise.all(ids.map((id) => decide(id)));
    expect(results.every((one) => one.ok)).toBe(true);
    for (const id of ids) expect(await rowsOf(id)).toBe(1);
  }, 60_000);
});
