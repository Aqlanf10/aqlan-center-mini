import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * اختبارات المحاسبة الواعية بالردود على PostgreSQL حقيقي (P1-FINAL-3).
 *
 * الوحدة نفسها مغطاة في __tests__/commission-refund-aware.test.ts — هنا يُثبت
 * أن استعلام cutoff بيوم العيادة `(created_at AT TIME ZONE tz)::date <= to`
 * وربط reversal_of_id يعملان على PostgreSQL حقيقي: الجمع الفعال للدفعات،
 * وتجاهل الردود بعد cutoff، ونسبة كل دفعة أصل عند وقتها.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { getPool, resetPoolForTesting, ensureSchema, openShift, commissionReport } = await import("../../lib/db");

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number, hour = 10): string =>
  new Date(Date.now() - days * DAY + hour * 60 * 60 * 1000).toISOString().slice(0, 10);
const daysAgoFull = (days: number, hour = 10): string =>
  new Date(Date.now() - days * DAY + hour * 60 * 60 * 1000).toISOString();

const RATE_CATEGORY = "تقويم-ردود-PG";
let receiptSeq = 0;

async function seedDoctor(): Promise<number> {
  const { rows: [doctor] } = await getPool().query<{ id: number }>(
    `INSERT INTO parties (name, kind, commission_percent, is_active)
     VALUES ($1, 'doctor', 100, TRUE) RETURNING id`,
    [`د. PG-${Date.now().toString(36)}`],
  );
  return doctor.id as number;
}

async function seedPatient(label: string): Promise<number> {
  const { rows: [patient] } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name)
     VALUES ('PGR-${label}-${Date.now().toString(36)}', 'مريض ${label}') RETURNING id`,
  );
  return patient.id as number;
}

async function insertInvoice(number: string, patientId: number, doctorId: number, createdAt: string, netMinor: number): Promise<number> {
  const { rows: [invoice] } = await getPool().query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
     VALUES ($1, $2, $3, 0, 'YER', 'seed', $4::timestamptz) RETURNING id`,
    [number, patientId, netMinor, createdAt],
  );
  await getPool().query(
    `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id)
     SELECT $1, s.id, 'بند', 1, $2, $2, $3
       FROM services s WHERE s.category = $4 LIMIT 1`,
    [invoice.id as number, netMinor, doctorId, RATE_CATEGORY],
  );
  return invoice.id as number;
}

async function insertPayment(receipt: string, patientId: number, amountMinor: number, createdAt: string): Promise<number> {
  const { rows: [shift] } = await getPool().query<{ id: number }>(
    `SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1`,
  );
  const { rows: [payment] } = await getPool().query<{ id: number }>(
    `INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor, currency,
       exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
     VALUES ($1, $2, $3, 'payment', $4, 'YER', 1, $4, 'YER', 'cash', 'seed', $5::timestamptz)
     RETURNING id`,
    [receipt, patientId, shift.id, amountMinor, createdAt],
  );
  return payment.id as number;
}

async function insertRefund(receipt: string, patientId: number, amountMinor: number, reversalOfId: number, createdAt: string): Promise<number> {
  const { rows: [shift] } = await getPool().query<{ id: number }>(
    `SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1`,
  );
  const { rows: [refund] } = await getPool().query<{ id: number }>(
    `INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor, currency,
       exchange_rate, base_amount_minor, base_currency, method, created_by, created_at, reversal_of_id)
     VALUES ($1, $2, $3, 'refund', $4, 'YER', 1, $4, 'YER', 'cash', 'seed', $5::timestamptz, $6)
     RETURNING id`,
    [receipt, patientId, shift.id, amountMinor, createdAt, reversalOfId],
  );
  return refund.id as number;
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "pg-refund-aware", opening: { YER: 0, SAR: 0, USD: 0 } });
  await getPool().query(
    `INSERT INTO settings (key, value) VALUES ('finance.commission_material_rate', 'on')
     ON CONFLICT (key) DO UPDATE SET value = 'on'`,
  );
  await getPool().query(
    `INSERT INTO material_rate_history (category, rate_bp, effective_from, recorded_by)
     VALUES ($1, 2000, $2::timestamptz, 'seed'), ($1, 3000, $3::timestamptz, 'seed')`,
    [RATE_CATEGORY, daysAgoFull(40), daysAgoFull(20)],
  );
  await getPool().query(
    `INSERT INTO services (name, category, price_minor, is_active)
     VALUES ('خدمة PG للردود', $1, 100000, TRUE)`,
    [RATE_CATEGORY],
  );
}, 180_000);

afterAll(async () => {
  await resetPoolForTesting();
});

async function doctorRow(doctorId: number, from: string, to: string) {
  const rows = await commissionReport(from, to);
  return rows.find((row) => row.doctorId === doctorId);
}

describe("محاسبة المواد الواعية بالردود — PostgreSQL حقيقي (P1-FINAL-3)", () => {
  it("ردّ A كاملًا بعد B ⇒ تغطية B فقط بنسبة B (٣٠٪) لا ٢٠٪", async () => {
    const doctorId = await seedDoctor();
    const patientId = await seedPatient("full");
    await insertInvoice("PGR-INV-1", patientId, doctorId, daysAgoFull(35), 20000);
    const paymentA = await insertPayment(`PGR-R-1-A-${receiptSeq++}`, patientId, 10000, daysAgoFull(30));
    await insertPayment(`PGR-R-1-B-${receiptSeq++}`, patientId, 10000, daysAgoFull(10));
    await insertRefund(`PGR-RR-1-${receiptSeq++}`, patientId, 10000, paymentA, daysAgoFull(5));

    const row = await doctorRow(doctorId, daysAgo(45), daysAgo(0));
    expect(row).toBeDefined();
    expect(row!.earnedMinor).toBe(10000);
    expect(row!.materialRateCostMinor).toBe(3000);
  });

  it("cutoff قبل الردّ ⇒ A+B سليمان؛ cutoff بعده ⇒ أثر الردّ المرتبط", async () => {
    const doctorId = await seedDoctor();
    const patientId = await seedPatient("cutoff");
    await insertInvoice("PGR-INV-2", patientId, doctorId, daysAgoFull(35), 20000);
    const paymentA = await insertPayment(`PGR-R-2-A-${receiptSeq++}`, patientId, 10000, daysAgoFull(30));
    await insertPayment(`PGR-R-2-B-${receiptSeq++}`, patientId, 10000, daysAgoFull(10));
    await insertRefund(`PGR-RR-2-${receiptSeq++}`, patientId, 4000, paymentA, daysAgoFull(5));

    // تقرير ينتهي قبل الردّ: المحصّل ٢٠٠٠٠ والتكلفة ٢٠٪+٣٠٪
    const before = await doctorRow(doctorId, daysAgo(45), daysAgo(7));
    expect(before).toBeDefined();
    expect(before!.earnedMinor).toBe(20000);
    expect(before!.materialRateCostMinor).toBe(5000);

    // تقرير يمتد بعد الردّ: المحصّل ١٦٠٠٠ والتكلفة ٦٠٠٠×٢٠٪+١٠٠٠٠×٣٠٪
    const after = await doctorRow(doctorId, daysAgo(45), daysAgo(0));
    expect(after).toBeDefined();
    expect(after!.earnedMinor).toBe(16000);
    expect(after!.materialRateCostMinor).toBe(4200);
  });

  it("عدة ردود جزئية على الأصل نفسه ⇒ المبلغ الفعلي = الأصل − مجموعها", async () => {
    const doctorId = await seedDoctor();
    const patientId = await seedPatient("multi");
    await insertInvoice("PGR-INV-3", patientId, doctorId, daysAgoFull(35), 20000);
    const paymentA = await insertPayment(`PGR-R-3-A-${receiptSeq++}`, patientId, 10000, daysAgoFull(30));
    await insertPayment(`PGR-R-3-B-${receiptSeq++}`, patientId, 10000, daysAgoFull(10));
    await insertRefund(`PGR-RR-3-X-${receiptSeq++}`, patientId, 3000, paymentA, daysAgoFull(6));
    await insertRefund(`PGR-RR-3-Y-${receiptSeq++}`, patientId, 2000, paymentA, daysAgoFull(4));

    const row = await doctorRow(doctorId, daysAgo(45), daysAgo(0));
    expect(row).toBeDefined();
    expect(row!.earnedMinor).toBe(15000);
    expect(row!.materialRateCostMinor).toBe(4000);
  });
});
