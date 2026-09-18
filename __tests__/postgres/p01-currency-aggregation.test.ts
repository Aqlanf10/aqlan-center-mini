import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * اختبارات P-01 على PostgreSQL حقيقي (18) — التجميع المالي بكل عملة على حدة.
 *
 * نفس دليل P0-1 الذي كشف الخلل، لكن على القاعدة الحقيقية: GROUP BY base_currency
 * في financeSummary، والترتيب داخل كل عملة في topServices، والمديونية صفٌّ لكل
 * (مريض × عملة) مفوَّضة إلى المرجع الكانوني patientBalancesByCurrency، والدفع
 * يسوّي دلو عملة فاتورته وحده، وعملةٌ غير معروفة تُرفض لا تُخلط.
 *
 * PGlite كافية للمنطق؛ هذه الجولة تُثبت أن SQL التجميع نفسه يعمل كما صُمِّم
 * على المحرك الحقيقي الذي يدير الإنتاج (فروق CAST/تجميع/ترتيب لا تظهر إلا هنا).
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, financeSummary, patientDebtReport,
} = await import("../../lib/db");
const { CURRENCIES, patientBalancesByCurrency } = await import("../../lib/money");
const { buildReport, dbTodayISO, parseFilters } = await import("../../lib/reports");

const MIXED_SUM = 340000; // 180,000 YER + 150,000 SAR + 10,000 USD — المجموع الممزوج لكل البذر
const A_YER = 100000; const A_SAR = 100000; const A_USD = 10000;
const TOTAL_YER = A_YER + 80000; // مريض أ (100k) + فاتورة مريض ب اليمنية (80k)
const TOTAL_SAR = A_SAR + 50000; // مريض أ (100k) + فاتورة مريض ب السعودية (50k)

let TODAY = "";
let patientAId = 0;
let patientBId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();

  const { rows: [shift] } = await pool.query(
    `INSERT INTO cashier_shifts (opened_by) VALUES ('p01-pg') RETURNING id`,
  );

  const { rows: [patientA] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('P01-PG-A', 'مريض P-01 الحقيقي أ') RETURNING id`,
  );
  patientAId = patientA.id;
  const seeds: { number: string; currency: string; totalMinor: number }[] = [
    { number: "P01-PG-INV-YER", currency: "YER", totalMinor: A_YER },
    { number: "P01-PG-INV-SAR", currency: "SAR", totalMinor: A_SAR },
    { number: "P01-PG-INV-USD", currency: "USD", totalMinor: A_USD },
  ];
  for (const seed of seeds) {
    const { rows: [invoice] } = await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, base_currency, created_at)
       VALUES ($1, $2, 'open', $3, 0, $4, NOW()) RETURNING id`,
      [seed.number, patientAId, seed.totalMinor, seed.currency],
    );
    await pool.query(
      `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor)
       VALUES ($1, NULL, 'تنظيف', 1, $2, $2)`,
      [invoice.id, seed.totalMinor],
    );
  }

  // مريض ب: افتتاحي + فاتورة يمنية + فاتورة سعودية + دفعة سعودية على فاتورتها.
  const { rows: [patientB] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('P01-PG-B', 'مريض P-01 الحقيقي ب') RETURNING id`,
  );
  patientBId = patientB.id;
  await pool.query(
    `INSERT INTO patient_opening_balances (patient_id, amount_minor, as_of_date) VALUES ($1, 25000, '2025-01-10')`,
    [patientBId],
  );
  const { rows: [yerInvoice] } = await pool.query(
    `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, base_currency, created_at)
     VALUES ('P01-PG-B-INV-YER', $1, 'open', 80000, 0, 'YER', NOW()) RETURNING id`,
    [patientBId],
  );
  const { rows: [sarInvoice] } = await pool.query(
    `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, base_currency, created_at)
     VALUES ('P01-PG-B-INV-SAR', $1, 'open', 50000, 0, 'SAR', NOW()) RETURNING id`,
    [patientBId],
  );
  await pool.query(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, method, created_by, created_at)
     VALUES ('P01-PG-B-REC-SAR', $1, $2, $3, 'payment', 20000, 'SAR', 140, 2800000, 'cash', 'p01', NOW())`,
    [patientBId, sarInvoice.id, shift.id],
  );
  await pool.query(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, method, created_by, created_at)
     VALUES ('P01-PG-B-REC-YER', $1, $2, $3, 'payment', 30000, 'YER', 1, 30000, 'cash', 'p01', NOW())`,
    [patientBId, yerInvoice.id, shift.id],
  );

  TODAY = await dbTodayISO();
}, 180_000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("P-01 على PostgreSQL حقيقي: financeSummary بعملاتها", () => {
  it("المفوتر ثلاثة دلاب {YER:180000, SAR:150000, USD:10000} — والعدد الممزوج حُذف", async () => {
    const summary = await financeSummary(TODAY, TODAY);
    expect(summary.invoicedByCurrency).toEqual({ YER: TOTAL_YER, SAR: TOTAL_SAR, USD: A_USD });
    expect("invoicedMinor" in summary).toBe(false);
    expect(JSON.stringify(summary)).not.toContain(String(MIXED_SUM));
    // عدد المرضى المميزين عبر العملات: مريضان (لا مجموع أعدادٍ لكل عملة).
    expect(summary.patientCount).toBe(2);
  });

  it("الخدمات الأكثر: صفٌّ لكل عملة بعملتها — GROUP BY description, base_currency", async () => {
    const summary = await financeSummary(TODAY, TODAY);
    expect(summary.topServices).toHaveLength(3);
    expect(new Set(summary.topServices.map((service) => service.currency))).toEqual(new Set(CURRENCIES));
    for (const service of summary.topServices) {
      expect(service.totalMinor).not.toBe(MIXED_SUM);
    }
  });
});

describe("P-01 على PostgreSQL حقيقي: المديونية بكل (مريض × عملة)", () => {
  it("مريض الثلاث عملات ثلاثة صفوف، ومستحق كل صف = المرجع الكانوني لدلوها", async () => {
    const rows = (await patientDebtReport()).filter((row) => row.patientId === patientAId);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.currency))).toEqual(new Set(CURRENCIES));

    const expected = patientBalancesByCurrency(
      [
        { totalMinor: A_YER, discountMinor: 0, status: "open", baseCurrency: "YER" },
        { totalMinor: A_SAR, discountMinor: 0, status: "open", baseCurrency: "SAR" },
        { totalMinor: A_USD, discountMinor: 0, status: "open", baseCurrency: "USD" },
      ],
      [],
      0,
    );
    for (const row of rows) {
      expect(row.dueMinor).toBe(expected[row.currency as keyof typeof expected].dueMinor);
      expect(row.dueMinor).not.toBe(MIXED_SUM);
    }
  });

  it("الدفعة السعودية على فاتورتها تسوّي دلو السعودي وحده — بلا اقتراضٍ بين الدلاء", async () => {
    const rows = (await patientDebtReport()).filter((row) => row.patientId === patientBId);
    const byCurrency = new Map(rows.map((row) => [row.currency, row]));
    // YER: 80,000 فاتورة + 25,000 افتتاحي − 30,000 دفعة (على فاتورتها اليمنية) = 75,000
    expect(byCurrency.get("YER")).toMatchObject({
      billedMinor: 80000, openingMinor: 25000, collectedMinor: 30000, dueMinor: 75000,
    });
    // SAR: 50,000 − 20,000 = 30,000
    expect(byCurrency.get("SAR")).toMatchObject({
      billedMinor: 50000, openingMinor: 0, collectedMinor: 20000, dueMinor: 30000,
    });
  });
});

describe("P-01 على PostgreSQL حقيقي: محرك التقارير", () => {
  it("اليومي: بطاقات المفوتر والمحصّل بعملاتها — لا بطاقة ممزوجة", async () => {
    const filters = parseFilters(new URLSearchParams({ preset: "today" }), TODAY);
    const daily = await buildReport("daily", filters);
    const kpi = (key: string) => daily.kpis.find((k) => k.key === key);
    expect(kpi("invoiced")).toMatchObject({ minor: TOTAL_YER, currency: "YER" });
    expect(kpi("invoiced-SAR")).toMatchObject({ minor: TOTAL_SAR, currency: "SAR" });
    expect(kpi("invoiced-USD")).toMatchObject({ minor: A_USD, currency: "USD" });
    // محصّل اليوم: يمني 30,000 (دفعة مريض ب على فاتورته) وسعودي 20,000.
    expect(kpi("collected")).toMatchObject({ minor: 30000, currency: "YER" });
    expect(kpi("collected-SAR")).toMatchObject({ minor: 20000, currency: "SAR" });
    for (const kpiItem of daily.kpis) {
      expect(kpiItem.minor ?? 0).not.toBe(MIXED_SUM);
    }
  });

  it("عملة فاتورة غير معروفة تُرفض صريحًا — لا تُسقط بصمتٍ ولا تُخلط", async () => {
    const pool = getPool();
    const { rows: [invoice] } = await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, base_currency, created_at)
       VALUES ('P01-PG-INV-EUR', $1, 'open', 12345, 0, 'EUR', NOW()) RETURNING id`,
      [patientAId],
    );
    try {
      await expect(financeSummary(TODAY, TODAY)).rejects.toThrow("عملة فاتورة غير معروفة");
    } finally {
      await pool.query(`DELETE FROM invoices WHERE id = $1`, [invoice.id]);
    }
  });
});
