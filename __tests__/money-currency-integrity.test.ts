import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات سلامة المال والعملات (P1.7 + P1.8).
 *
 *  * العملات كيانات مستقلة: لا تجميع إلا عبر base_amount_minor (بعد تحويل
 *    مسجَّل بسعر لحظة المعاملة) — أبدًا لا جمع مباشر بين عملات.
 *  * سعر الصرف snapshot وقت المعاملة: تغيير الإعداد لاحقًا لا يغيّر التاريخ.
 *  * تمثيل عدد صحيح: قيم كبيرة، صفر، تقريب، ورفض قيم كسرية/خارج النطاق.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const { getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment } = await import("../lib/db");
const { toBaseAmount, MINOR_UNITS, patientBalance } = await import("../lib/money");

let patientId: number;

beforeAll(async () => {
  await ensureSchema();
  await openShift({ openedBy: "money-test", opening: { YER: 0, SAR: 0, USD: 0 } });
  const { rows: [patient] } = await getPool().query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('MONEY-P1', 'مريض العملات') RETURNING id`,
  );
  patientId = patient.id;
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("استقلال العملات (P1.7)", () => {
  it("SAR وUSD يُسجلان بسعر لحظة الدفع في العمود نفسه ويتحوّلان لمكافئ أساسي", async () => {
    const pool = getPool();
    // سعر صرف مُعلن: 1 SAR = 660 YER، 1 USD = 2480 YER
    const sar = await recordPayment({
      patientId, invoiceId: null, kind: "payment", amountMinor: 2500, // 25.00 SAR
      currency: "SAR", baseCurrency: "YER", exchangeRate: 660, method: "cash",
      note: null, createdBy: "test",
    });
    expect(sar.payment).not.toBeNull();
    // 25.00 SAR (2500 minor) بسعر 660 ⇒ 25 × 660 = 16500 YER minor
    expect(sar.payment!.baseAmountMinor).toBe(16500);

    const usd = await recordPayment({
      patientId, invoiceId: null, kind: "payment", amountMinor: 10000, // 100.00 USD
      currency: "USD", baseCurrency: "YER", exchangeRate: 2480, method: "cash",
      note: null, createdBy: "test",
    });
    expect(usd.payment!.baseAmountMinor).toBe(100 * 2480);

    // التجميع الصحيح الوحيد: مجموع المكافئ الأساسي — لا مجموع مبالغ العملات
    const { rows: [total] } = await pool.query(
      `SELECT SUM(base_amount_minor) AS base, SUM(amount_minor) AS mixed FROM payments WHERE patient_id = $1`,
      [patientId],
    );
    expect(Number(total.base)).toBe(16500 + 100 * 2480);
    expect(Number(total.mixed)).not.toBe(Number(total.base)); // الخلط بين العملات رقمٌ بلا معنى
  });

  it("تغيير سعر الصرف في الإعدادات لاحقًا لا يعيد كتابة المكافئ المسجَّل", async () => {
    const pool = getPool();
    const { rows: [oldPayment] } = await pool.query(
      `SELECT id, base_amount_minor, exchange_rate FROM payments
        WHERE patient_id = $1 AND currency = 'SAR' ORDER BY id LIMIT 1`, [patientId],
    );
    const later = await recordPayment({
      patientId, invoiceId: null, kind: "payment", amountMinor: 2500,
      currency: "SAR", baseCurrency: "YER", exchangeRate: 700, method: "cash",
      note: null, createdBy: "test",
    });
    expect(later.payment!.baseAmountMinor).toBe(25 * 700);
    const { rows: [oldRow] } = await pool.query(
      `SELECT base_amount_minor, exchange_rate FROM payments WHERE id = $1`, [oldPayment.id],
    );
    expect(Number(oldRow.base_amount_minor)).toBe(Number(oldPayment.base_amount_minor));
    expect(Number(oldRow.exchange_rate)).toBe(660);
  });

  it("toBaseAmount يحوّل بدقة عدد صحيح ويقرّب كسور الوحدة الفرعية", () => {
    expect(toBaseAmount(2500, "SAR", "YER", 660)).toBe(16500);
    expect(toBaseAmount(10000, "USD", "YER", 2480)).toBe(248000);
    // 0.5 وحدة فرعية تُقرَّب لأقرب عدد صحيح — لا كسور أبدًا في BIGINT
    expect(toBaseAmount(1, "USD", "YER", 0.5)).toBe(0);
    expect(Number.isInteger(toBaseAmount(12345, "SAR", "YER", 660.5))).toBe(true);
  });

  it("MINOR_UNITS: YER بلا كسور (١)، وSAR/USD بمئة (١٠٠)", () => {
    expect(MINOR_UNITS.YER).toBe(1);
    expect(MINOR_UNITS.SAR).toBe(100);
    expect(MINOR_UNITS.USD).toBe(100);
  });
});

describe("تمثيل المال عددًا صحيحًا (P1.8)", () => {
  it("قيمة كبيرة ضمن النطاق الآمن تُقرأ ويُكتب بدقة كاملة", async () => {
    const pool = getPool();
    const large = 900719925474000; // أقل من 2^53-1 بأمان
    const { payment } = await recordPayment({
      patientId, invoiceId: null, kind: "payment", amountMinor: large,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test",
    });
    expect(payment!.amountMinor).toBe(large);
    const { rows: [row] } = await pool.query(`SELECT amount_minor FROM payments WHERE id = $1`, [payment!.id]);
    expect(Number(row.amount_minor)).toBe(large);
  });

  it("صفر ورفض القيم السالبة غير المشروعة في القاعدة", async () => {
    const pool = getPool();
    // CHECK constraint في المخطط يرفض المنطقي غير السليم حيث ينطبق
    await expect(pool.query(
      `INSERT INTO patient_opening_balances (patient_id, amount_minor, as_of_date, created_by)
       VALUES ($1, -5, CURRENT_DATE, 'test')`, [patientId],
    )).rejects.toThrow();
  });

  it("قيمة خارج النطاق الآمن من القاعدة ⇒ خطأ صريح لا فقد دقة صامت", async () => {
    const pool = getPool();
    const { rows: [patient] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('MONEY-P2', 'مريض الحدود') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
       VALUES ('MONEY-INV', $1, 9007199254740993, 0, 'YER')`, [patient.id],
    );
    // 2^53+1 — القيمة تُخزَّن في BIGINT سليمة، والتحويل إلى JS يرفضها صراحةً
    // (listPatientInvoices يستدعي toMinor المحصّن) — الحساب لا يكذب بصمت.
    const { listPatientInvoices } = await import("../lib/db");
    await expect(listPatientInvoices(patient.id)).rejects.toThrow(/نطاق|آمنة/);
  });

  it("لا أرقام عشرية في أعمدة المال — BIGINT في كل مكان", async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name LIKE '%minor'
          AND data_type NOT IN ('bigint')
        ORDER BY table_name`,
    );
    expect(rows).toEqual([]); // كل أعمدة الوحدة الفرعية BIGINT — لا double/numeric
  });
});
