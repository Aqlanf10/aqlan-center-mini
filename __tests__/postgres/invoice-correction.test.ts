import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (FIN-2) تصحيح فاتورةٍ بمبلغٍ زائد على PostgreSQL حقيقي.
 *
 * كان المبلغ الزائد على المريض لا يُصحَّح من الشاشة. الآن: الأصل يُلغى (بنوده كما صدرت)،
 * وتصدر فاتورةٌ مصحَّحة بعملته وتاريخه وخطته وأطباء بنوده، والزيارة تُربط بها، والدفعات
 * لا تُمسّ — ورصيد المريض يساوي الصافي المصحَّح ناقص ما دفع. وكل ذلك وسطر تدقيقه معًا.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, correctInvoice, computeDebtRows, getInvoice,
} = await import("../../lib/db");

let patientId: number;
let doctorId: number;
let serviceId: number;
let shiftId: number;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  ({ rows: [{ id: patientId }] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('FIN2-1', 'مريض التصحيح') RETURNING id`));
  ({ rows: [{ id: doctorId }] } = await pool.query(
    `INSERT INTO parties (kind, name) VALUES ('doctor', 'د. التصحيح') RETURNING id`));
  ({ rows: [{ id: serviceId }] } = await pool.query(
    `INSERT INTO services (name, price_minor, is_active) VALUES ('تقويم — تركيب', 50000, TRUE) RETURNING id`));
  ({ rows: [{ id: shiftId }] } = await pool.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd) VALUES ('fin2', 0, 0, 0) RETURNING id`));
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

let seq = 0;
async function invoiceWithTwoLines(currency = "YER", createdAt = "2026-09-01T10:00:00Z") {
  seq += 1;
  const pool = getPool();
  const { rows: [invoice] } = await pool.query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
     VALUES ($1, $2, 70000, 0, $3, 'reception1', $4) RETURNING id`,
    [`FIN2-INV-${seq}`, patientId, currency, createdAt]);
  const { rows: items } = await pool.query<{ id: number }>(
    `INSERT INTO invoice_items (invoice_id, service_id, doctor_id, description, quantity, unit_price_minor, total_minor, source_type, source_id)
     VALUES ($1, $2, $3, 'تقويم — تركيب', 1, 50000, 50000, 'fin2_test', $4),
            ($1, NULL, $3, 'صورة بانوراما', 2, 10000, 20000, NULL, NULL)
     RETURNING id`,
    [invoice.id, serviceId, doctorId, seq]);
  return { invoiceId: invoice.id, installId: items[0].id, xrayId: items[1].id };
}

async function pay(invoiceId: number, amount: number, currency = "YER") {
  seq += 1;
  await getPool().query(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate,
                           base_amount_minor, base_currency, method, created_by)
     VALUES ($1, $2, $3, $4, 'payment', $5, $6, 1, $5, $6, 'cash', 'reception1')`,
    [`FIN2-R-${seq}`, patientId, invoiceId, shiftId, amount, currency]);
}

async function due(currency: string) {
  const rows = await computeDebtRows([patientId]);
  return rows.find((row) => row.currency === currency)?.dueMinor ?? 0;
}

describe("(FIN-2) correcting an overcharged invoice", () => {
  it("cancels the original, reissues the lower amount with the same doctor/service/date/currency, keeps payments, relinks the visit, audits", async () => {
    const { invoiceId, installId, xrayId } = await invoiceWithTwoLines();
    await pay(invoiceId, 20_000);
    const pool = getPool();
    const { rows: [visit] } = await pool.query<{ id: number }>(
      `INSERT INTO visits (patient_name, patient_id, invoice_id) VALUES ('مريض التصحيح', $1, $2) RETURNING id`,
      [patientId, invoiceId]);
    const dueBefore = await due("YER");

    const result = await correctInvoice({
      invoiceId, reason: "السعر المتفق عليه ٣٠٬٠٠٠ لا ٥٠٬٠٠٠", actor: "dr.aqlan", actorRole: "admin",
      lines: [{ itemId: installId, quantity: 1, unitPriceMinor: 30_000 }, { itemId: xrayId, quantity: 1, unitPriceMinor: 10_000 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.original.status).toBe("cancelled");
    expect(result.original.totalMinor).toBe(70_000);           // الأصل كما صدر
    expect(result.original.items).toHaveLength(2);
    expect(result.corrected.totalMinor).toBe(40_000);
    expect(result.corrected.baseCurrency).toBe("YER");
    expect(result.corrected.createdAt).toBe(result.original.createdAt); // في يومه وشهره
    expect(result.corrected.note).toContain(`تصحيح للفاتورة ${result.original.invoiceNumber}`);
    expect(result.corrected.items.map((item) => [item.serviceId, item.doctorId, item.quantity, item.unitPriceMinor])).toEqual([
      [serviceId, doctorId, 1, 30_000],
      [null, doctorId, 1, 10_000],
    ]);

    // الدين نزل بقدر التخفيض بالضبط، والدفعة ما زالت على الأصل تسدّد المصحَّحة.
    expect(dueBefore - (await due("YER"))).toBe(30_000);
    expect(await due("YER")).toBe(40_000 - 20_000 + (dueBefore - 50_000));
    const { rows: payments } = await pool.query(`SELECT invoice_id FROM payments WHERE invoice_id = $1`, [invoiceId]);
    expect(payments).toHaveLength(1);

    const { rows: [relinked] } = await pool.query<{ invoice_id: number }>(`SELECT invoice_id FROM visits WHERE id = $1`, [visit.id]);
    expect(relinked.invoice_id).toBe(result.corrected.id);

    const { rows: [audit] } = await pool.query<{ actor: string; actor_role: string; details: Record<string, unknown> }>(
      `SELECT actor, actor_role, details FROM audit_log WHERE action = 'invoice.correct' AND entity_id = $1`, [String(invoiceId)]);
    expect(audit.actor).toBe("dr.aqlan");
    expect(audit.actor_role).toBe("admin");
    expect(audit.details).toMatchObject({
      الفاتورة_المصححة: result.corrected.invoiceNumber, السبب: "السعر المتفق عليه ٣٠٬٠٠٠ لا ٥٠٬٠٠٠", زيارات_أعيد_ربطها: 1,
    });
    expect(String(audit.details.بنود_معدلة)).toContain("تقويم — تركيب");
  });

  it("a paid invoice (e.g. a plan installment issued with its receipt) stays paid after a reduction — not offered for collection again", async () => {
    const { invoiceId, installId } = await invoiceWithTwoLines();
    await getPool().query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [invoiceId]);
    const result = await correctInvoice({
      invoiceId, reason: "القسط أقل", actor: "dr.aqlan", actorRole: "admin",
      lines: [{ itemId: installId, quantity: 1, unitPriceMinor: 40_000 }],
    });
    expect(result.ok && result.corrected.status).toBe("paid");
  });

  it("an open invoice stays open after correction", async () => {
    const { invoiceId, installId } = await invoiceWithTwoLines();
    const result = await correctInvoice({
      invoiceId, reason: "سعر أقل", actor: "dr.aqlan", actorRole: "admin",
      lines: [{ itemId: installId, quantity: 1, unitPriceMinor: 40_000 }],
    });
    expect(result.ok && result.corrected.status).toBe("open");
  });

  it("a removed line and a foreign-currency invoice stay in their own currency bucket", async () => {
    const { invoiceId, xrayId } = await invoiceWithTwoLines("USD");
    const usdBefore = await due("USD");
    const yerBefore = await due("YER");
    const result = await correctInvoice({
      invoiceId, reason: "التركيب لم يُعمل", actor: "dr.aqlan", actorRole: "admin",
      lines: [{ itemId: xrayId, quantity: 2, unitPriceMinor: 10_000 }],
    });
    expect(result.ok && result.corrected.baseCurrency).toBe("USD");
    expect(usdBefore - (await due("USD"))).toBe(50_000);
    expect(await due("YER")).toBe(yerBefore);
  });

  it("refuses increases, no-ops and an already-cancelled invoice — nothing changes", async () => {
    const { invoiceId, installId } = await invoiceWithTwoLines();
    const count = async () => Number((await getPool().query(`SELECT COUNT(*) FROM invoices`)).rows[0].count);
    const before = await count();
    const up = await correctInvoice({
      invoiceId, reason: "زيادة", actor: "a", actorRole: "admin",
      lines: [{ itemId: installId, quantity: 1, unitPriceMinor: 60_000 }],
    });
    expect(up).toMatchObject({ ok: false, reason: "invalid" });
    expect((await getInvoice(invoiceId))!.status).toBe("open");
    expect(await count()).toBe(before);

    const ok = await correctInvoice({
      invoiceId, reason: "تصحيح", actor: "a", actorRole: "admin",
      lines: [{ itemId: installId, quantity: 1, unitPriceMinor: 40_000 }],
    });
    expect(ok.ok).toBe(true);
    const again = await correctInvoice({
      invoiceId, reason: "مرة ثانية", actor: "a", actorRole: "admin",
      lines: [{ itemId: installId, quantity: 1, unitPriceMinor: 1 }],
    });
    expect(again).toMatchObject({ ok: false, reason: "cancelled" });
  });

  it("the correction and its audit row commit together: an audit failure leaves the original untouched", async () => {
    const { invoiceId, installId } = await invoiceWithTwoLines();
    const pool = getPool();
    await pool.query(`CREATE OR REPLACE FUNCTION fin2_fail_audit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'audit unavailable'; END; $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER fin2_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fin2_fail_audit()`);
    try {
      await expect(correctInvoice({
        invoiceId, reason: "تصحيح", actor: "a", actorRole: "admin",
        lines: [{ itemId: installId, quantity: 1, unitPriceMinor: 1_000 }],
      })).rejects.toThrow();
    } finally {
      await pool.query(`DROP TRIGGER fin2_fail_audit ON audit_log`);
    }
    expect((await getInvoice(invoiceId))!.status).toBe("open");
    const { rows } = await pool.query(`SELECT 1 FROM invoices WHERE note LIKE $1`, [`%FIN2-INV-${seq}%`]);
    expect(rows).toHaveLength(0);
  });
});
