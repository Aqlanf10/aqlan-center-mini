import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات المحاسبة الحتمية للمواد الواعية بالردود (P1-FINAL-3).
 *
 * الخلل الذي كان: الردّ لا يستعمل reversal_of_id، ويخفض التغطية من آخر takeStack
 * بنمط LIFO — فيسرق ردُّ Payment A نسبة Payment B حين يكون A الأقدم. النموذج
 * الجديد: لكل دفعة أصلية مبلغ فعلي = الأصل − مجموع ردوده المرتبطة (≤ cutoff)،
 * وتوزيع المبالغ الفعلية FIFO (الافتتاحي أولًا ثم الفواتير بالأقدم)، وكل جزء
 * يحتفظ بطابع دفعة الأصل — فالنسبة تُحلّ وقت الدفعة الأصلية نفسها.
 *
 * سيناريوهات المراجعة المستقلة الإلزامية:
 *  1) ردّ A كاملًا بعد B ⇒ التغطية الفعلية = B فقط ⇒ نسبة ٣٠٪ لا ٢٠٪.
 *  2) ردّ A جزئيًّا ٤٠٠٠ ⇒ A الفعلي ٦٠٠٠ بـ٢٠٪ + B ١٠٠٠٠ بـ٣٠٪ ⇒ تكلفة حتمية.
 *  3) تقرير تاريخي cutoff قبل الردّ ⇒ A+B سليمان.
 *  4) cutoff بعد الردّ ⇒ أثر الردّ المرتبط يظهر.
 *  5) عدة ردود جزئية على الأصل نفسه.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const { getPool, resetPoolForTesting, ensureSchema, openShift, commissionReport } = await import("../lib/db");

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number, hour = 10): string =>
  new Date(Date.now() - days * DAY + hour * 60 * 60 * 1000).toISOString().slice(0, 10);
const daysAgoFull = (days: number, hour = 10): string =>
  new Date(Date.now() - days * DAY + hour * 60 * 60 * 1000).toISOString();

const RATE_CATEGORY = "تقويم-ردود";
let receiptSeq = 0;

/** طبيب مستقل لكل سيناريو — التقرير يجمع كل مرضى الطبيب، فالعزل بالطبيب يمنع
 * تسرب أثر سيناريو إلى تقرير سيناريو آخر (نفس دلالة المرضى المستقلين). */
async function seedDoctor(label: string): Promise<number> {
  const { rows: [doctor] } = await getPool().query<{ id: number }>(
    `INSERT INTO parties (name, kind, commission_percent, is_active)
     VALUES ($1, 'doctor', 100, TRUE) RETURNING id`,
    [`د. ${label}-${Date.now().toString(36)}`],
  );
  return doctor.id as number;
}

async function seedPatient(label: string): Promise<number> {
  const { rows: [patient] } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name)
     VALUES ('RA-${label}-${Date.now().toString(36)}', 'مريض ${label}') RETURNING id`,
  );
  return patient.id as number;
}

async function insertInvoice(
  number: string, patientId: number, doctorId: number, createdAt: string, netMinor: number,
): Promise<number> {
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

async function insertPayment(
  receipt: string, patientId: number, amountMinor: number, createdAt: string,
): Promise<number> {
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

async function insertRefund(
  receipt: string, patientId: number, amountMinor: number,
  reversalOfId: number, createdAt: string,
): Promise<number> {
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
  await ensureSchema();
  await openShift({ openedBy: "refund-aware-test", opening: { YER: 0, SAR: 0, USD: 0 } });
  await getPool().query(
    `INSERT INTO settings (key, value) VALUES ('finance.commission_material_rate', 'on')
     ON CONFLICT (key) DO UPDATE SET value = 'on'`,
  );
  // نسب إهلاك المواد لفئة الاختبار: ٢٠٪ من ٤٠ يومًا، ثم ٣٠٪ من ٢٠ يومًا
  await getPool().query(
    `INSERT INTO material_rate_history (category, rate_bp, effective_from, recorded_by)
     VALUES ($1, 2000, $2::timestamptz, 'seed'), ($1, 3000, $3::timestamptz, 'seed')`,
    [RATE_CATEGORY, daysAgoFull(40), daysAgoFull(20)],
  );
  // خدمة بفئة لها تاريخ نسب — بنود الفواتير تحمل الفئة عبر service_id
  await getPool().query(
    `INSERT INTO services (name, category, price_minor, is_active)
     VALUES ('خدمة واعية بالردود', $1, 100000, TRUE)`,
    [RATE_CATEGORY],
  );
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

/** يحل صف الطبيب من تقرير العمولة. */
async function doctorRow(doctorId: number, from: string, to: string) {
  const rows = await commissionReport(from, to);
  return rows.find((row) => row.doctorId === doctorId);
}

describe("محاسبة المواد الواعية بالردود (P1-FINAL-3)", () => {
  it("١) ردّ A كاملًا بعد B ⇒ التغطية الفعلية B فقط ⇒ النسبة ٣٠٪ لا ٢٠٪", async () => {
    const doctorId = await seedDoctor("كامل");
    const patientId = await seedPatient("full");
    // فاتورة سعة ٢٠٠٠٠ منذ ٣٥ يومًا
    await insertInvoice("RA-INV-1", patientId, doctorId, daysAgoFull(35), 20000);
    // A = ١٠٠٠٠ منذ ٣٠ يومًا (النسبة حينها ٢٠٪)، B = ١٠٠٠٠ منذ ١٠ أيام (٣٠٪)
    const paymentA = await insertPayment(`RA-R-1-A-${receiptSeq++}`, patientId, 10000, daysAgoFull(30));
    await insertPayment(`RA-R-1-B-${receiptSeq++}`, patientId, 10000, daysAgoFull(10));
    // ردّ A كاملًا منذ ٥ أيام — بعد B
    await insertRefund(`RA-RR-1-${receiptSeq++}`, patientId, 10000, paymentA, daysAgoFull(5));

    const row = await doctorRow(doctorId, daysAgo(45), daysAgo(0));
    expect(row).toBeDefined();
    // المحصّل الفعلي = B فقط = ١٠٠٠٠
    expect(row!.earnedMinor).toBe(10000);
    // نسبة B التاريخية ٣٠٪ — لا نسبة A (٢٠٪) التي كان يسرقها نموذج LIFO
    expect(row!.materialRateCostMinor).toBe(3000);
    expect(row!.netEarnedMinor).toBe(7000);
  });

  it("٢) ردّ A جزئيًّا ٤٠٠٠ ⇒ A الفعلي ٦٠٠٠ بـ٢٠٪ + B ١٠٠٠٠ بـ٣٠٪ ⇒ ٤٢٠٠ حتميًّا", async () => {
    const doctorId = await seedDoctor("جزئي");
    const patientId = await seedPatient("partial");
    await insertInvoice("RA-INV-2", patientId, doctorId, daysAgoFull(35), 20000);
    const paymentA = await insertPayment(`RA-R-2-A-${receiptSeq++}`, patientId, 10000, daysAgoFull(30));
    await insertPayment(`RA-R-2-B-${receiptSeq++}`, patientId, 10000, daysAgoFull(10));
    await insertRefund(`RA-RR-2-${receiptSeq++}`, patientId, 4000, paymentA, daysAgoFull(5));

    const row = await doctorRow(doctorId, daysAgo(45), daysAgo(0));
    expect(row).toBeDefined();
    expect(row!.earnedMinor).toBe(16000); // ٦٠٠٠ + ١٠٠٠٠
    // ٦٠٠٠×٢٠٪ + ١٠٠٠٠×٣٠٪ = ١٢٠٠ + ٣٠٠٠ = ٤٢٠٠ — لا نسبة مخلوطة من LIFO
    expect(row!.materialRateCostMinor).toBe(4200);
    expect(row!.netEarnedMinor).toBe(11800);
  });

  it("٣) تقرير تاريخي cutoff قبل الردّ ⇒ A+B سليمان كأن الردّ لم يقع", async () => {
    const doctorId = await seedDoctor("تاريخي");
    const patientId = await seedPatient("cutoff-before");
    await insertInvoice("RA-INV-3", patientId, doctorId, daysAgoFull(35), 20000);
    const paymentA = await insertPayment(`RA-R-3-A-${receiptSeq++}`, patientId, 10000, daysAgoFull(30));
    await insertPayment(`RA-R-3-B-${receiptSeq++}`, patientId, 10000, daysAgoFull(10));
    // ردّ منذ ٥ أيام — التقرير ينتهي قبل ٧ أيام: الردّ مستقبلي فيُتجاهل
    await insertRefund(`RA-RR-3-${receiptSeq++}`, patientId, 10000, paymentA, daysAgoFull(5));

    const row = await doctorRow(doctorId, daysAgo(45), daysAgo(7));
    expect(row).toBeDefined();
    // A وB كلاهما قبل cutoff ⇒ المحصّل ٢٠٠٠٠ والتكلفة ١٠٠٠٠×٢٠٪+١٠٠٠٠×٣٠٪
    expect(row!.earnedMinor).toBe(20000);
    expect(row!.materialRateCostMinor).toBe(5000);
    expect(row!.netEarnedMinor).toBe(15000);
  });

  it("٤) cutoff بعد الردّ ⇒ أثر الردّ المرتبط يظهر", async () => {
    const doctorId = await seedDoctor("لاحق");
    const patientId = await seedPatient("cutoff-after");
    await insertInvoice("RA-INV-4", patientId, doctorId, daysAgoFull(35), 20000);
    const paymentA = await insertPayment(`RA-R-4-A-${receiptSeq++}`, patientId, 10000, daysAgoFull(30));
    await insertPayment(`RA-R-4-B-${receiptSeq++}`, patientId, 10000, daysAgoFull(10));
    await insertRefund(`RA-RR-4-${receiptSeq++}`, patientId, 4000, paymentA, daysAgoFull(5));

    const row = await doctorRow(doctorId, daysAgo(45), daysAgo(0));
    expect(row).toBeDefined();
    expect(row!.earnedMinor).toBe(16000);
    expect(row!.materialRateCostMinor).toBe(4200);
  });

  it("٥) عدة ردود جزئية على الأصل نفسه ⇒ الأصل الفعلي ٥٠٠٠ بـ٢٠٪", async () => {
    const doctorId = await seedDoctor("متعدد");
    const patientId = await seedPatient("multi");
    await insertInvoice("RA-INV-5", patientId, doctorId, daysAgoFull(35), 20000);
    const paymentA = await insertPayment(`RA-R-5-A-${receiptSeq++}`, patientId, 10000, daysAgoFull(30));
    await insertPayment(`RA-R-5-B-${receiptSeq++}`, patientId, 10000, daysAgoFull(10));
    await insertRefund(`RA-RR-5-X-${receiptSeq++}`, patientId, 3000, paymentA, daysAgoFull(6));
    await insertRefund(`RA-RR-5-Y-${receiptSeq++}`, patientId, 2000, paymentA, daysAgoFull(4));

    const row = await doctorRow(doctorId, daysAgo(45), daysAgo(0));
    expect(row).toBeDefined();
    expect(row!.earnedMinor).toBe(15000); // ٥٠٠٠ + ١٠٠٠٠
    // ٥٠٠٠×٢٠٪ + ١٠٠٠٠×٣٠٪ = ١٠٠٠ + ٣٠٠٠ = ٤٠٠٠
    expect(row!.materialRateCostMinor).toBe(4000);
  });

  it("٦) فاتورتان: ردّ A يحرّر فاتورة أقدم فتتحرك تغطية B إليها — وB يحتفظ بنسبة B", async () => {
    const doctorId = await seedDoctor("فاتورتان");
    const patientId = await seedPatient("two-invoices");
    // فاتورتان من ١٠٠٠٠: الأولى منذ ٣٥ يومًا، الثانية منذ ٨ أيام
    await insertInvoice("RA-INV-6-1", patientId, doctorId, daysAgoFull(35), 10000);
    await insertInvoice("RA-INV-6-2", patientId, doctorId, daysAgoFull(8), 10000);
    const paymentA = await insertPayment(`RA-R-6-A-${receiptSeq++}`, patientId, 10000, daysAgoFull(30));
    await insertPayment(`RA-R-6-B-${receiptSeq++}`, patientId, 10000, daysAgoFull(10));
    // ردّ A كاملًا بعد B: A الفعلي صفر، فتغطي B الفاتورة القديمة كاملة — بنسبة B (٣٠٪)
    await insertRefund(`RA-RR-6-${receiptSeq++}`, patientId, 10000, paymentA, daysAgoFull(5));

    const row = await doctorRow(doctorId, daysAgo(45), daysAgo(0));
    expect(row).toBeDefined();
    expect(row!.earnedMinor).toBe(10000);
    // نموذج LIFO القديم كان سيفكّ تغطية B الأخيرة (الفاتورة الثانية) فتبقى
    // تغطية A القديمة بنسبة ٢٠٪ = ٢٠٠٠. الصحيح: تغطية B بنسبة B = ٣٠٠٠.
    expect(row!.materialRateCostMinor).toBe(3000);
  });
});
