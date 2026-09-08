import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبار تاريخي لنسب إهلاك المواد بحسب **وقت الحدث** (P1-FIX-6).
 *
 * السيناريو المطلوب حرفيًّا من المراجعة المستقلة:
 *   حدث A قبل تغيّر النسبة (٢٠٪) + حدث B بعده (٣٠٪)
 *   ⇒ التقرير الشهري يحسب A بـ٢٠٪ وB بـ٣٠٪،
 *   وتغيير النسبة لاحقًا (٥٠٪) لا يغيّر النتيجتين.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const { getPool, resetPoolForTesting, ensureSchema, openShift, commissionReport, setMaterialRate } = await import("../lib/db");

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number, hour = 10): string =>
  new Date(Date.now() - days * DAY + hour * 60 * 60 * 1000).toISOString().slice(0, 10);
const daysAgoFull = (days: number, hour = 10): string =>
  new Date(Date.now() - days * DAY + hour * 60 * 60 * 1000).toISOString();

let doctorId: number;

async function insertInvoice(number: string, createdAt: string, netMinor: number): Promise<number> {
  const { rows: [invoice] } = await getPool().query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
     VALUES ($1, $2, $3, 0, 'YER', 'seed', $4::timestamptz) RETURNING id`,
    [number, (await seedPatient()).id, netMinor, createdAt],
  );
  await getPool().query(
    `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id)
     SELECT $1, s.id, 'بند', 1, $2, $2, $3
       FROM services s WHERE s.category = 'تقويم' LIMIT 1`,
    [invoice.id as number, netMinor, doctorId],
  );
  return invoice.id as number;
}

let cachedPatientId: number | null = null;
async function seedPatient(): Promise<{ id: number }> {
  if (cachedPatientId === null) {
    const { rows: [patient] } = await getPool().query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('MR-EVT', 'مريض الأحداث') RETURNING id`,
    );
    cachedPatientId = patient.id;
  }
  return { id: cachedPatientId };
}

async function insertPayment(receipt: string, amountMinor: number, createdAt: string): Promise<void> {
  const { rows: [shift] } = await getPool().query<{ id: number }>(
    `SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1`,
  );
  await getPool().query(
    `INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor, currency,
       exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
     VALUES ($1, $2, $3, 'payment', $4, 'YER', 1, $4, 'YER', 'cash', 'seed', $5::timestamptz)`,
    [receipt, (await seedPatient()).id, shift.id, amountMinor, createdAt],
  );
}

beforeAll(async () => {
  await ensureSchema();
  await getPool().query("DELETE FROM material_rate_history WHERE category = 'تقويم'");
  await getPool().query("DELETE FROM material_rates WHERE category = 'تقويم'");
  await openShift({ openedBy: "event-time-test", opening: { YER: 0, SAR: 0, USD: 0 } });

  const { rows: [doctor] } = await getPool().query(
    `INSERT INTO parties (name, kind, commission_percent, is_active)
     VALUES ('د. أحداث', 'doctor', 100, TRUE) RETURNING id`,
  );
  doctorId = doctor.id;
  await getPool().query(
    `INSERT INTO services (name, category, price_minor, is_active)
     VALUES ('خدمة تقويم للاختبار', 'تقويم', 100000, TRUE)`,
  );
  await getPool().query(
    `INSERT INTO settings (key, value) VALUES ('finance.commission_material_rate', 'on')
     ON CONFLICT (key) DO UPDATE SET value = 'on'`,
  );
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("نسبة إهلاك المواد بحسب وقت الحدث (P1-FIX-6)", () => {
  it("حدث قبل تغيّر النسبة يُحسب بنسبته القديمة وحدث بعده بالجديدة، وتغيير لاحق لا يمسّهما", async () => {
    // ١) النسبة ٢٠٪ سارية من ٤٠ يومًا (قبل كل الأحداث)
    await getPool().query(
      `INSERT INTO material_rate_history (category, rate_bp, effective_from, recorded_by)
       VALUES ('تقويم', 2000, $1::timestamptz, 'seed')`,
      [daysAgoFull(40)],
    );

    // ٢) فاتورة A (٣٠ يومًا) غطّتها دفعة A في يومها — حين كانت النسبة ٢٠٪
    await insertInvoice("MR-EVT-INV-A", daysAgoFull(30), 100000);
    await insertPayment("MR-EVT-R-A", 100000, daysAgoFull(30));

    // ٣) تغيّر النسبة إلى ٣٠٪ من ٢٠ يومًا
    await getPool().query(
      `INSERT INTO material_rate_history (category, rate_bp, effective_from, recorded_by)
       VALUES ('تقويم', 3000, $1::timestamptz, 'seed')`,
      [daysAgoFull(20)],
    );

    // ٤) فاتورة B (١٠ أيام) غطّتها دفعة B في يومها — حين كانت النسبة ٣٠٪
    await insertInvoice("MR-EVT-INV-B", daysAgoFull(10), 100000);
    await insertPayment("MR-EVT-R-B", 100000, daysAgoFull(10));

    const from = daysAgo(45);
    const to = daysAgo(0);
    const rows = await commissionReport(from, to);
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // المفوتَر ٢٠٠٠٠٠ والمحصّل ٢٠٠٠٠٠ بنسبة طبيب ١٠٠٪
    expect(row.accruedMinor).toBe(200000);
    expect(row.earnedMinor).toBe(200000);
    // إهلاك المواد: ١٠٠٠٠٠×٢٠٪ + ١٠٠٠٠٠×٣٠٪ = ٥٠٠٠٠ — كل حدث بنسبته وقت وقوعه
    expect(row.materialRateCostMinor).toBe(50000);
    expect(row.netEarnedMinor).toBe(150000);
    expect(row.materialRateApplied).toBe(true);

    // ٥) النسبة تتغيّر «الآن» إلى ٥٠٪ — التقرير لا يتغيّر: A بقيت ٢٠٪ وB بقيت ٣٠٪
    await setMaterialRate({ category: "تقويم", rateBp: 5000, actor: "seed" });
    const afterChange = await commissionReport(from, to);
    expect(afterChange[0].materialRateCostMinor).toBe(50000);
    expect(afterChange[0].netEarnedMinor).toBe(150000);

    // ٦) وتقرير يمتد بعد التغيير فقط يرى الأحداث الجديدة بالنسبة الجديدة:
    //    تغطية الأحداث القديمة خرجت من المدى فلا إهلاك عليها هنا.
    const recentOnly = await commissionReport(daysAgo(5), daysAgo(0));
    // لا فواتير للمدقق نفسه داخل المدى القصير ⇒ لا صف له أصلًا
    expect(recentOnly.find((row) => row.doctorId === doctorId)).toBeUndefined();
  });

  it("المدى القديم كاملًا (قبل التسجيل) ⇒ غير مقيَّم — لا تقدير بصفر صامت", async () => {
    // نسبة مسجَّلة من ٤٠ يومًا؛ حدث قبلها بـ٥٠ يومًا غير مقيَّم
    const { rows: [patient] } = await getPool().query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('MR-EVT-2', 'مريض قديم') RETURNING id`,
    );
    const { rows: [shift] } = await getPool().query<{ id: number }>(
      `SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1`,
    );
    await getPool().query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
       VALUES ('MR-EVT-INV-OLD', $1, 100000, 0, 'YER', 'seed', $2::timestamptz)`,
      [patient.id, daysAgoFull(50)],
    );
    await getPool().query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor, doctor_id)
       VALUES ((SELECT id FROM invoices WHERE invoice_number = 'MR-EVT-INV-OLD'), 'بند', 1, 100000, 100000, $1)`,
      [doctorId],
    );
    await getPool().query(
      `INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor, currency,
         exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
       VALUES ('MR-EVT-R-OLD', $1, $2, 'payment', 100000, 'YER', 1, 100000, 'YER', 'cash', 'seed', $3::timestamptz)`,
      [patient.id, shift.id, daysAgoFull(50)],
    );
    const rows = await commissionReport(daysAgo(60), daysAgo(45));
    const old = rows.find((row) => row.doctorId === doctorId);
    expect(old).toBeDefined();
    // مغطّى بلا نسبة مسجَّلة وقت الحدث ⇒ unrated لا cost بصفر صامت
    expect(old!.unratedCoveredMinor).toBe(100000);
    expect(old!.materialRateCostMinor).toBe(0);
  });
});
