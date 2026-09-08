import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * اختبارات حارس الأثر المالي المركزي على PostgreSQL حقيقي (P1-FINAL-1).
 *
 * نفس سيناريوهات المراجعة المستقلة (A/B/C/D) — على قاعدة حقيقية لا PGlite،
 * لأن الحارس استعلام SQL واحد معقّد (سبعة استعلامات فرعية) وترتيبه داخل
 * المعاملة قبل أي DELETE هو نفسه الضمان الذي يُختبر هنا.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, openShift, deletePatientCascade,
} = await import("../../lib/db");

const TODAY = new Date().toISOString().slice(0, 10);

async function seedPatient(label: string): Promise<number> {
  const { rows: [patient] } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name)
     VALUES ('PGF-${label}-${Date.now().toString(36)}', 'مريض ${label}') RETURNING id`,
  );
  return patient.id as number;
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "pg-footprint", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("حارس الأثر المالي المركزي — PostgreSQL حقيقي (P1-FINAL-1)", () => {
  it("A) فاتورة غير مدفوعة بلا دفعات ⇒ DENIED والفاتورة والمريض باقيان", async () => {
    const pool = getPool();
    const patientId = await seedPatient("inv");
    const { rows: [invoice] } = await pool.query<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, status)
       VALUES ('PGF-INV-A', $1, 50000, 0, 'YER', 'open') RETURNING id`,
      [patientId],
    );

    const result = await deletePatientCascade(patientId, { actor: "admin" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("has_financial_history");
    expect(result.counts?.invoices).toBe(1);
    expect(result.counts?.payments).toBe(0);

    const { rows: [invRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM invoices WHERE id = $1`, [invoice.id],
    );
    expect(invRow.n).toBe(1);
    const { rows: [patRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patients WHERE id = $1`, [patientId],
    );
    expect(patRow.n).toBe(1);
  });

  it("B) رصيد افتتاحي فقط ⇒ DENIED والرصيد باقٍ", async () => {
    const pool = getPool();
    const patientId = await seedPatient("opening");
    await pool.query(
      `INSERT INTO patient_opening_balances (patient_id, amount_minor, as_of_date, created_by)
       VALUES ($1, 30000, '2025-01-01', 'pg-test')`,
      [patientId],
    );

    const result = await deletePatientCascade(patientId, { actor: "admin" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("has_financial_history");
    expect(result.counts?.openingBalances).toBe(1);

    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patient_opening_balances WHERE patient_id = $1`,
      [patientId],
    );
    expect(row.n).toBe(1);
  });

  it("C) أمر معمل بتكلفة/التزام فقط ⇒ DENIED والالتزام والتاريخ المالي يبقيان", async () => {
    const pool = getPool();
    const patientId = await seedPatient("lab");

    // التزام مرتبط بأمر معمل المريض — عبر الاتجاهين كما في المخطط الفعلي
    const { rows: [party] } = await pool.query<{ id: number }>(
      `INSERT INTO parties (name, kind, is_active) VALUES ('مختبر PGF', 'lab', TRUE) RETURNING id`,
    );
    const { rows: [order] } = await pool.query<{ id: number }>(
      `INSERT INTO lab_orders (patient_id, lab_name, work_type, sent_date, due_date, cost_minor, cost_currency)
       VALUES ($1, 'مختبر PGF', 'تاج', $2::date, $2::date, 4000, 'YER') RETURNING id`,
      [patientId, TODAY],
    );
    const { rows: [payable] } = await pool.query<{ id: number }>(
      `INSERT INTO payables (party_id, category, description, amount_minor, currency,
         exchange_rate, base_amount_minor, base_currency, lab_order_id, created_by)
       VALUES ($1, 'lab', 'تاج PGF', 4000, 'YER', 1, 4000, 'YER', $2, 'pg-test') RETURNING id`,
      [party.id, order.id],
    );
    await pool.query(`UPDATE lab_orders SET payable_id = $1 WHERE id = $2`, [payable.id, order.id]);

    const result = await deletePatientCascade(patientId, { actor: "admin" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("has_financial_history");
    expect(result.counts?.labOrders).toBe(1);
    expect(result.counts?.payables).toBe(1);

    // الالتزام باقٍ والطلب باقٍ والمريض باقٍ
    const { rows: [payRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payables WHERE id = $1`, [payable.id],
    );
    expect(payRow.n).toBe(1);
    const { rows: [orderRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM lab_orders WHERE id = $1`, [order.id],
    );
    expect(orderRow.n).toBe(1);
    const { rows: [patRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patients WHERE id = $1`, [patientId],
    );
    expect(patRow.n).toBe(1);
  });

  it("D) مريض مكرر نظيف بلا تاريخ ⇒ الحذف يعمل كما كان", async () => {
    const pool = getPool();
    const patientId = await seedPatient("clean");
    const result = await deletePatientCascade(patientId, {
      actor: "admin", reason: "ازدواج سجل نظيف",
    });
    expect(result.ok).toBe(true);
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patients WHERE id = $1`, [patientId],
    );
    expect(row.n).toBe(0);
  });

  it("E) معاملاتيّة: الرفض لا يمسّ السريري — الزيارة باقية بعد الرفض", async () => {
    const pool = getPool();
    const patientId = await seedPatient("tx");
    const { rows: [visit] } = await pool.query<{ id: number }>(
      `INSERT INTO visits (patient_id, patient_name, status, arrived_at)
       VALUES ($1, 'معاملة', 'waiting', NOW()) RETURNING id`,
      [patientId],
    );
    await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, status)
       VALUES ('PGF-INV-E', $1, 10000, 0, 'YER', 'open')`,
      [patientId],
    );

    const result = await deletePatientCascade(patientId, { actor: "admin" });
    expect(result.ok).toBe(false);
    const { rows: [visitRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM visits WHERE id = $1`, [visit.id],
    );
    expect(visitRow.n).toBe(1);
  });
});
