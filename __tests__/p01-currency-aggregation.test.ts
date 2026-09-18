import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات P-01 — التجميع المالي الصحيح للعملات (D-1).
 *
 * السيناريو الكانوني (نفس عيّنة BEFORE التي كشفت P0-1): مريضٌ واحد له ثلاث
 * فواتير: 100,000 ر.ي و100,000 ر.س و10,000 $. القديم كان يجمعها 210,000
 * «ريالًا يمنيًّا» — تزويرٌ محاسبي لا يقبله دفتر. الجديد: ثلاثة أرقام، كلٌّ
 * بدلو عملته، في كل طبقات النظام (financeSummary / topServices /
 * patientDebtReport / محرك التقارير).
 *
 * ١٧ تأكيدًا إلزاميًّا للعملات المختلطة أدناه — مرقَّمة في عناوينها. بعدها
 * رحلات إضافية: التسوية بدلوها وعقد الدفعات، والإغلاق الفاشل أمام عملةٍ
 * غير معروفة.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const {
  getPool, resetPoolForTesting, ensureSchema, financeSummary, patientDebtReport,
} = await import("../lib/db");
const {
  CLINIC_BASE_CURRENCY, CURRENCIES, patientBalancesByCurrency,
} = await import("../lib/money");
const { buildReport, dbTodayISO, parseFilters } = await import("../lib/reports");

const MIXED_SUM = 210000; // 100,000 YER + 100,000 SAR + 10,000 USD — الرقم المزوِّر
const YER_TOTAL = 100000;
const SAR_TOTAL = 100000;
const USD_TOTAL = 10000;

let TODAY = "";
let patientAId = 0;
const invoiceIdByCurrency = new Map<string, number>();

beforeAll(async () => {
  await ensureSchema();
  const pool = getPool();
  const { rows: [shift] } = await pool.query(
    `INSERT INTO cashier_shifts (opened_by) VALUES ('p01-unit') RETURNING id`,
  );
  void shift; // وردية مفتوحة إن احتاجتها رحلات الدفعات لاحقًا

  const { rows: [patient] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('P01-UNIT-A', 'مريض P-01 أ') RETURNING id`,
  );
  patientAId = patient.id;

  const seeds: { number: string; currency: string; totalMinor: number }[] = [
    { number: "P01-INV-YER", currency: "YER", totalMinor: YER_TOTAL },
    { number: "P01-INV-SAR", currency: "SAR", totalMinor: SAR_TOTAL },
    { number: "P01-INV-USD", currency: "USD", totalMinor: USD_TOTAL },
  ];
  for (const seed of seeds) {
    const { rows: [invoice] } = await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, base_currency, created_at)
       VALUES ($1, $2, 'open', $3, 0, $4, NOW()) RETURNING id`,
      [seed.number, patientAId, seed.totalMinor, seed.currency],
    );
    invoiceIdByCurrency.set(seed.currency, invoice.id);
    await pool.query(
      `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor)
       VALUES ($1, NULL, 'تنظيف', 1, $2, $2)`,
      [invoice.id, seed.totalMinor],
    );
  }

  TODAY = await dbTodayISO();
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

/* ══════════════ financeSummary — ٦ تأكيدات ══════════════ */

describe("P-01 (١–٦): financeSummary بكل عملة على حدة", () => {
  it("١ · المفوتر ثلاثة دلاب لا رقمًا واحدًا: {YER:100000, SAR:100000, USD:10000}", async () => {
    const summary = await financeSummary(TODAY, TODAY);
    expect(summary.invoicedByCurrency).toEqual({ YER: YER_TOTAL, SAR: SAR_TOTAL, USD: USD_TOTAL });
  });

  it("٢ · العدد المختلط invoicedMinor حُذف من العقد كليًّا", async () => {
    const summary = await financeSummary(TODAY, TODAY);
    expect("invoicedMinor" in summary).toBe(false);
  });

  it("٣ · لا 210,000 في الحمولة كلها — رقم P0-1 الممزوج لا وجود له", async () => {
    const summary = await financeSummary(TODAY, TODAY);
    expect(JSON.stringify(summary)).not.toContain(String(MIXED_SUM));
  });

  it("٤ · عدد الفواتير 3 والمريض واحد — المريض بعملتين مريضٌ واحد لا اثنان", async () => {
    const summary = await financeSummary(TODAY, TODAY);
    expect(summary.invoiceCount).toBe(3);
    expect(summary.patientCount).toBe(1);
  });

  it("٥ · الخدمات الأكثر: ثلاثة صفوف — صفٌّ لكل عملة، لا صفٌّ واحد ممزوج", async () => {
    const summary = await financeSummary(TODAY, TODAY);
    expect(summary.topServices).toHaveLength(3);
    expect(new Set(summary.topServices.map((service) => service.currency))).toEqual(new Set(CURRENCIES));
  });

  it("٦ · صف الخدمة بعملته ومجموعه دلوها — لا المجموع الممزوج ولا ترتيبٌ عبر العملات", async () => {
    const summary = await financeSummary(TODAY, TODAY);
    for (const service of summary.topServices) {
      expect(service.name).toBe("تنظيف");
      expect(service.count).toBe(1);
      if (service.currency === "YER") expect(service.totalMinor).toBe(YER_TOTAL);
      if (service.currency === "SAR") expect(service.totalMinor).toBe(SAR_TOTAL);
      if (service.currency === "USD") expect(service.totalMinor).toBe(USD_TOTAL);
      expect(service.totalMinor).not.toBe(MIXED_SUM);
    }
  });
});

/* ══════════════ patientDebtReport — ٥ تأكيدات ══════════════ */

describe("P-01 (٧–١١): patientDebtReport صفٌّ لكل (مريض × عملة)", () => {
  it("٧ · المدين بثلاث عملات: ثلاثة صفوف — صفٌّ لكل عملة", async () => {
    const rows = await patientDebtReport();
    const forA = rows.filter((row) => row.patientId === patientAId);
    expect(forA).toHaveLength(3);
    expect(new Set(forA.map((row) => row.currency))).toEqual(new Set(CURRENCIES));
  });

  it("٨ · كل صف: مفطوره = مستحققه = دلو عملته (بلا دفعات ولا افتتاحي)", async () => {
    const rows = (await patientDebtReport()).filter((row) => row.patientId === patientAId);
    const byCurrency = new Map(rows.map((row) => [row.currency, row]));
    expect(byCurrency.get("YER")).toMatchObject({ billedMinor: YER_TOTAL, dueMinor: YER_TOTAL });
    expect(byCurrency.get("SAR")).toMatchObject({ billedMinor: SAR_TOTAL, dueMinor: SAR_TOTAL });
    expect(byCurrency.get("USD")).toMatchObject({ billedMinor: USD_TOTAL, dueMinor: USD_TOTAL });
  });

  it("٩ · لا صف بـ210,000 — وكل صف موسوم بعملةٍ معروفة", async () => {
    const rows = (await patientDebtReport()).filter((row) => row.patientId === patientAId);
    for (const row of rows) {
      expect(CURRENCIES).toContain(row.currency);
      expect(row.dueMinor).not.toBe(MIXED_SUM);
      expect(row.billedMinor).not.toBe(MIXED_SUM);
    }
  });

  it("١٠ · التفويض الكانوني: مستحق كل صف = رصيد patientBalancesByCurrency لدلو عملته", async () => {
    const expected = patientBalancesByCurrency(
      [
        { totalMinor: YER_TOTAL, discountMinor: 0, status: "open", baseCurrency: "YER" },
        { totalMinor: SAR_TOTAL, discountMinor: 0, status: "open", baseCurrency: "SAR" },
        { totalMinor: USD_TOTAL, discountMinor: 0, status: "open", baseCurrency: "USD" },
      ],
      [],
      0,
    );
    const rows = (await patientDebtReport()).filter((row) => row.patientId === patientAId);
    for (const row of rows) {
      expect(row.dueMinor).toBe(expected[row.currency as keyof typeof expected].dueMinor);
    }
  });

  it("١١ · العتبة داخل كل عملة: 50,000 تُسقط الدولار (10k) وتُبقي اليمني والسعودي", async () => {
    const rows = await patientDebtReport(50000);
    const forA = rows.filter((row) => row.patientId === patientAId);
    // الرقم الممزوج 210,000 كان سيتجاوز العتبة فيُظهر صفًّا واحدًا ممزوجًا؛
    // الدلو الدولاري (10,000) وحده دونها فيسقط — داخل عملته لا فوق مزيج.
    expect(forA.map((row) => row.currency).sort()).toEqual(["SAR", "YER"]);
  });
});

/* ══════════════ محرك التقارير — ٦ تأكيدات ══════════════ */

function todayFilters() {
  return parseFilters(new URLSearchParams({ preset: "today" }), TODAY);
}

describe("P-01 (١٢–١٤): التقرير اليومي بكل عملة دلوها", () => {
  it("١٢ · بطاقات المفوتر بعملاتها: invoiced وinvoiced-SAR وinvoiced-USD", async () => {
    const daily = await buildReport("daily", todayFilters());
    const kpi = (key: string) => daily.kpis.find((k) => k.key === key);
    expect(kpi("invoiced")).toMatchObject({ minor: YER_TOTAL, currency: "YER" });
    expect(kpi("invoiced-SAR")).toMatchObject({ minor: SAR_TOTAL, currency: "SAR" });
    expect(kpi("invoiced-USD")).toMatchObject({ minor: USD_TOTAL, currency: "USD" });
  });

  it("١٣ · لا بطاقة مالية قيمتها 210,000 — المزيج لا يعود من أي نافذة", async () => {
    const daily = await buildReport("daily", todayFilters());
    for (const kpi of daily.kpis) {
      expect(kpi.minor ?? 0).not.toBe(MIXED_SUM);
      expect(kpi.count ?? 0).not.toBe(MIXED_SUM);
    }
  });

  it("١٤ · الصفوف بعملتها — فاتورةٌ بعملتها وأعمدة المال تقرأ عملة الصف", async () => {
    const daily = await buildReport("daily", todayFilters());
    const rowsForA = (daily.rows ?? []).filter((row) => row.patientId === patientAId);
    expect(rowsForA).toHaveLength(3);
    const totalByCurrency = new Map(rowsForA.map((row) => [String(row.currency), Number(row.totalMinor)]));
    expect(totalByCurrency.get("YER")).toBe(YER_TOTAL);
    expect(totalByCurrency.get("SAR")).toBe(SAR_TOTAL);
    expect(totalByCurrency.get("USD")).toBe(USD_TOTAL);
    for (const column of daily.columns ?? []) {
      if (column.type === "money") expect(column.currencyKey).toBe("currency");
    }
  });
});

describe("P-01 (١٥–١٧): المديونية والأعمار في المحرك — بلا مزيج", () => {
  it("١٥ · المديونية: الإجمالي ثلاثة دلاب (total وtotal-SAR وtotal-USD)", async () => {
    const debt = await buildReport("debt", todayFilters());
    const kpi = (key: string) => debt.kpis.find((k) => k.key === key);
    expect(kpi("total")).toMatchObject({ minor: YER_TOTAL, currency: "YER" });
    expect(kpi("total-SAR")).toMatchObject({ minor: SAR_TOTAL, currency: "SAR" });
    expect(kpi("total-USD")).toMatchObject({ minor: USD_TOTAL, currency: "USD" });
  });

  it("١٦ · المديونية: صفٌّ لكل (مريض × عملة) برصيد دلوها وحده", async () => {
    const debt = await buildReport("debt", todayFilters());
    const rowsForA = (debt.rows ?? []).filter((row) => row.patientId === patientAId);
    expect(rowsForA).toHaveLength(3);
    const balanceByCurrency = new Map(rowsForA.map((row) => [String(row.currency), Number(row.balanceMinor)]));
    expect(balanceByCurrency.get("YER")).toBe(YER_TOTAL);
    expect(balanceByCurrency.get("SAR")).toBe(SAR_TOTAL);
    expect(balanceByCurrency.get("USD")).toBe(USD_TOTAL);
  });

  it("١٧ · الأعمار: الحالي (٠–٣٠) بكل عملة دلوها — لا مجموع ممزوج", async () => {
    const aging = await buildReport("aging", todayFilters());
    const kpi = (key: string) => aging.kpis.find((k) => k.key === key);
    expect(kpi("b0")).toMatchObject({ minor: YER_TOTAL, currency: "YER" });
    expect(kpi("b0-SAR")).toMatchObject({ minor: SAR_TOTAL, currency: "SAR" });
    expect(kpi("b0-USD")).toMatchObject({ minor: USD_TOTAL, currency: "USD" });
    for (const kpi of aging.kpis) {
      expect(kpi.minor ?? 0).not.toBe(MIXED_SUM);
    }
  });
});

/* ══════════════ رحلات إضافية — التسوية وعقد الدفعات ══════════════ */

describe("P-01 إضافي: التسوية بدلوها — دفعةٌ لا تُطفئ دلو عملةٍ أخرى", () => {
  let patientBId = 0;

  beforeAll(async () => {
    const pool = getPool();
    const { rows: [patientB] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('P01-UNIT-B', 'مريض P-01 ب') RETURNING id`,
    );
    patientBId = patientB.id;

    // افتتاحي أساسي قديم — يدخل دلو الأساس وحده.
    await pool.query(
      `INSERT INTO patient_opening_balances (patient_id, amount_minor, as_of_date) VALUES ($1, 25000, '2025-01-10')`,
      [patientBId],
    );

    const { rows: [yerInvoice] } = await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, base_currency, created_at)
       VALUES ('P01-B-INV-YER', $1, 'open', 80000, 0, 'YER', NOW()) RETURNING id`,
      [patientBId],
    );
    const { rows: [sarInvoice] } = await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, base_currency, created_at)
       VALUES ('P01-B-INV-SAR', $1, 'open', 50000, 0, 'SAR', NOW()) RETURNING id`,
      [patientBId],
    );

    const { rows: [shift] } = await pool.query(
      `SELECT id FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1`,
    );

    // دفعة سعودية على فاتورتها السعودية — تسوّي دلوها بمبلغها نفسه.
    await pool.query(
      `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, method, created_by, created_at)
       VALUES ('P01-B-REC-SAR', $1, $2, $3, 'payment', 20000, 'SAR', 140, 2800000, 'cash', 'p01', NOW())`,
      [patientBId, sarInvoice.id, shift.id],
    );
    // دفعة يمنية على الحساب (بلا فاتورة) — تسوّي دلو الأساس وحده.
    await pool.query(
      `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, method, created_by, created_at)
       VALUES ('P01-B-REC-YER', $1, NULL, $2, 'payment', 30000, 'YER', 1, 30000, 'cash', 'p01', NOW())`,
      [patientBId, shift.id],
    );
  }, 60000);

  it("الدفعة السعودية تسوّي دلو السعودي وحده: SAR due=30,000 وYER لا يمسّها", async () => {
    const rows = (await patientDebtReport()).filter((row) => row.patientId === patientBId);
    const byCurrency = new Map(rows.map((row) => [row.currency, row]));
    // YER: فاتورة 80,000 + افتتاحي 25,000 (دلوً منفصلًا) − دفعة 30,000 = 75,000.
    // المفطور فواتيرِ دلوها وحدها؛ الافتتاحي عمودٌ مستقل بدلو الأساس.
    expect(byCurrency.get("YER")).toMatchObject({
      billedMinor: 80000, openingMinor: 25000, collectedMinor: 30000, dueMinor: 75000,
    });
    // SAR: فاتورة 50,000 − دفعة 20,000 = 30,000 (بمبلغها لا بمكافئها)
    expect(byCurrency.get("SAR")).toMatchObject({
      billedMinor: 50000, openingMinor: 0, collectedMinor: 20000, dueMinor: 30000,
    });
  });

  it("عقد الدفعات قائم: المقبوض بعملاته والمكافئ الأساسي المسجَّل يُجمع حلالًا", async () => {
    const summary = await financeSummary(TODAY, TODAY);
    expect(summary.income.byCurrency).toEqual({ YER: 30000, SAR: 20000, USD: 0 });
    // المكافئ المسجَّل بسعر يوم الدفعة: 30,000 يمني + 2,800,000 مكافئ السعودي.
    expect(summary.income.baseTotalMinor).toBe(30000 + 2800000);
  });

  it("اليومي: المحصّل بعملاته — collected=30,000 وcollected-SAR=20,000", async () => {
    const daily = await buildReport("daily", todayFilters());
    expect(daily.kpis.find((k) => k.key === "collected")).toMatchObject({ minor: 30000, currency: "YER" });
    expect(daily.kpis.find((k) => k.key === "collected-SAR")).toMatchObject({ minor: 20000, currency: "SAR" });
  });
});

/* ══════════════ رحلة إضافية — الإغلاق الفاشل ══════════════ */

describe("P-01 إضافي: عملة غير معروفة تُرفض لا تُخلط", () => {
  it("فاتورة بعملة EUR في التجميع المالي ⇒ رفضٌ صريح (fail-closed)", async () => {
    const pool = getPool();
    const { rows: [invoice] } = await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, base_currency, created_at)
       VALUES ('P01-INV-EUR', $1, 'open', 12345, 0, 'EUR', NOW()) RETURNING id`,
      [patientAId],
    );
    try {
      await expect(financeSummary(TODAY, TODAY)).rejects.toThrow("عملة فاتورة غير معروفة");
    } finally {
      // إزالة بذرة الفشل — لا تلوّث ما بعدها.
      await pool.query(`DELETE FROM invoices WHERE id = $1`, [invoice.id]);
    }
  });
});
