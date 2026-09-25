import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertLegacyRow } from "../helpers/legacy-row";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * اختبارات المراجعة النهائية لمالك PR #46 على PostgreSQL حقيقي — نفس إثباتات
 * ملف الـPGlite الشقيق (__tests__/p01-final-review-integrity.test.ts) لكن على
 * المحرك الحقيقي الذي يركض في CI:
 *
 *  ١) financeSummary: دفعة EUR ⇒ رفضٌ صريح (لا NaN ولا دلو undefined).
 *  ٢) commissionReport: دفعة على فاتورة SAR أُلغيت لاحقًا ⇒ الهدف SAR لا YER،
 *     والمرجع غير المحلول يُقال لا يسقط إلى الأساس.
 *  ٣) الردود الحرة بُعد عملة: سعودي يخصم السعودي، دولاري يخصم الدولار.
 *  ٤) journalEntries ودربه executiveKpis: دفعة EUR تُرفض قبل القيد.
 *
 * الترتيب مقصود: بذور الفشل (ربطٌ عبر المرضى ثم دفعة EUR) تُزرع آخرًا — الدفعات
 * append-only فلا تلوّث ما قبلها.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, financeSummary, commissionReport,
  journalEntries, executiveKpis, patientDebtReport,
} = await import("../../lib/db");
const { toCurrencyPaymentLikes, FinancialCurrencyIntegrityError } = await import("../../lib/money");
const { dbTodayISO } = await import("../../lib/reports");

const PERCENT = 30;
let TODAY = "";
let shiftId = 0;

let docA = 0;
let docB = 0;
let docC = 0;
let docD = 0;
let patA = 0;
let patB = 0;
let patC = 0;
let patD = 0;

async function seedDoctor(name: string): Promise<number> {
  const { rows: [doc] } = await getPool().query(
    `INSERT INTO parties (name, kind, commission_percent) VALUES ($1, 'doctor', $2) RETURNING id`,
    [name, String(PERCENT)],
  );
  return doc.id;
}

async function seedPatient(number: string, name: string): Promise<number> {
  const { rows: [patient] } = await getPool().query(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`,
    [number, name],
  );
  return patient.id;
}

async function seedInvoice(
  number: string, patientId: number, currency: string, netMinor: number, doctorId: number,
): Promise<number> {
  const { rows: [invoice] } = await getPool().query(
    `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, base_currency, created_at)
     VALUES ($1, $2, 'open', $3, 0, $4, NOW()) RETURNING id`,
    [number, patientId, netMinor, currency],
  );
  await getPool().query(
    `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id)
     VALUES ($1, NULL, 'حشوة', 1, $2, $2, $3)`,
    [invoice.id, netMinor, doctorId],
  );
  return invoice.id;
}

async function seedPayment(receipt: string, patientId: number, invoiceId: number | null, kind: "payment" | "refund",
  amountMinor: number, currency: string, baseAmountMinor: number): Promise<void> {
  await getPool().query(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, method)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, 'YER', 'cash')`,
    [receipt, patientId, invoiceId, shiftId, kind, amountMinor, currency, baseAmountMinor],
  );
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();

  const { rows: [shift] } = await pool.query(
    `INSERT INTO cashier_shifts (opened_by) VALUES ('p01-final-pg') RETURNING id`,
  );
  shiftId = shift.id;

  [docA, docB, docC, docD] = await Promise.all([
    seedDoctor("طبيب الملغاة السعودية"),
    seedDoctor("طبيب الرد السعودي الحر"),
    seedDoctor("طبيب الرد السعودي فوق تحصيل"),
    seedDoctor("طبيب الرد الدولاري"),
  ]);
  [patA, patB, patC, patD] = await Promise.all([
    seedPatient("P01-FR-A", "مريض الفاتورة الملغاة"),
    seedPatient("P01-FR-B", "مريض الرد السعودي الحر"),
    seedPatient("P01-FR-C", "مريض الرد السعودي فوق تحصيل"),
    seedPatient("P01-FR-D", "مريض الرد الدولاري"),
  ]);

  /* أ: فاتورة YER مفتوحة + فاتورة SAR تُدفع كاملة ثم تُلغى لاحقًا. */
  await seedInvoice("P01-FR-INV-A-YER", patA, "YER", 100000, docA);
  const sarInvoice = await seedInvoice("P01-FR-INV-A-SAR", patA, "SAR", 20000, docA);
  await seedPayment("P01-FR-PAY-A-SAR", patA, sarInvoice, "payment", 20000, "SAR", 2600000);
  await pool.query(`UPDATE invoices SET status = 'cancelled' WHERE id = $1`, [sarInvoice]);

  /* ب: فاتورة YER مسددة + ردٌّ حر سعودي. */
  const yerInvoiceB = await seedInvoice("P01-FR-INV-B-YER", patB, "YER", 100000, docB);
  await seedPayment("P01-FR-PAY-B-YER", patB, yerInvoiceB, "payment", 100000, "YER", 100000);
  await seedPayment("P01-FR-REF-B-SAR", patB, null, "refund", 5000, "SAR", 650000);

  /* ج: فاتورة SAR تحصيلها كامل + ردٌّ حر سعودي. */
  const sarInvoiceC = await seedInvoice("P01-FR-INV-C-SAR", patC, "SAR", 20000, docC);
  await seedPayment("P01-FR-PAY-C-SAR", patC, sarInvoiceC, "payment", 20000, "SAR", 2600000);
  await seedPayment("P01-FR-REF-C-SAR", patC, null, "refund", 5000, "SAR", 650000);

  /* د: فاتورة USD تحصيلها كامل + ردٌّ حر دولاري. */
  const usdInvoiceD = await seedInvoice("P01-FR-INV-D-USD", patD, "USD", 3000, docD);
  await seedPayment("P01-FR-PAY-D-USD", patD, usdInvoiceD, "payment", 3000, "USD", 1590000);
  await seedPayment("P01-FR-REF-D-USD", patD, null, "refund", 1000, "USD", 530000);

  TODAY = await dbTodayISO();
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("P-01 (المراجعة النهائية ٢) على PG حقيقي: دفعة على فاتورة أُلغيت لاحقًا", () => {
  it("الهدف عملة الفاتورة الملغاة نفسها — تحصيل السعودي لا يغطّي فواتير اليمني", async () => {
    const rows = await commissionReport(TODAY, TODAY);
    const mine = rows.filter((row) => row.doctorId === docA);
    expect(mine).toHaveLength(1);
    const yer = mine.find((row) => row.currency === "YER")!;
    expect(yer.accruedMinor).toBe(30000);
    expect(yer.earnedMinor).toBe(0);
    expect(mine.find((row) => row.currency === "SAR")).toBeUndefined();
  });
});

describe("P-01 (المراجعة النهائية ٣) على PG حقيقي: الردود الحرة بُعد عملة", () => {
  it("ردٌّ سعودي حر لا يمسّ دلو اليمني أبدًا", async () => {
    const rows = await commissionReport(TODAY, TODAY);
    const yer = rows.find((row) => row.doctorId === docB && row.currency === "YER")!;
    expect(yer.accruedMinor).toBe(30000);
    expect(yer.earnedMinor).toBe(30000);
    expect(rows.find((row) => row.doctorId === docB && row.currency !== "YER")).toBeUndefined();
  });

  it("ردٌّ سعودي حر يخصم السعودي وحده (15,000/20,000)", async () => {
    const rows = await commissionReport(TODAY, TODAY);
    const sar = rows.find((row) => row.doctorId === docC && row.currency === "SAR")!;
    expect(sar.accruedMinor).toBe(6000);
    expect(sar.earnedMinor).toBe(4500);
  });

  it("ردٌّ دولاري حر يخصم الدولار وحده (2,000/3,000)", async () => {
    const rows = await commissionReport(TODAY, TODAY);
    const usd = rows.find((row) => row.doctorId === docD && row.currency === "USD")!;
    expect(usd.accruedMinor).toBe(900);
    expect(usd.earnedMinor).toBe(600);
    expect(rows.find((row) => row.doctorId === docD && row.currency !== "USD")).toBeUndefined();
  });
});

describe("P-01 على PG حقيقي: مديونية الردود الحرة بدلو عملتها", () => {
  it("SAR/USD legacy refunds لا تعود إلى YER", async () => {
    const rows = await patientDebtReport();

    const b = rows.filter((row) => row.patientId === patB);
    expect(b.find((row) => row.currency === "YER")?.dueMinor ?? 0).toBe(0);
    expect(b.find((row) => row.currency === "SAR")?.dueMinor).toBe(5000);

    const c = rows.filter((row) => row.patientId === patC);
    expect(c.find((row) => row.currency === "SAR")?.dueMinor).toBe(5000);

    const d = rows.filter((row) => row.patientId === patD);
    expect(d.find((row) => row.currency === "USD")?.dueMinor).toBe(1000);
    expect(d.find((row) => row.currency === "YER")?.dueMinor ?? 0).toBe(0);
  });
});

describe("P-01 على PG حقيقي: غرفة القيادة بالعملات المختلطة تعمل وتفصل", () => {
  it("executiveKpis ينجح والفوترة صفٌّ لكل عملة", async () => {
    const kpis = await executiveKpis(TODAY, TODAY);
    const currencies = kpis.billingByCurrency.map((row) => row.currency).sort();
    expect(currencies).toEqual(["SAR", "USD", "YER"]);
    for (const row of kpis.billingByCurrency) {
      expect(Number.isInteger(row.netMinor)).toBe(true);
      expect(row.grossMinor).toBeGreaterThanOrEqual(row.netMinor);
    }
  });
});

describe("P-01 (المراجعة النهائية ٢) على PG حقيقي: مرجع غير محلول ⇒ fail-closed", () => {
  /* القيود الخارجية تمنع مرجعًا لصفٍّ غير موجود، فالفساد الواقعي هو ربطٌ عبر
   * المرضى: دفعة تشير لفاتورة/خطة مريضٍ آخر خارج نطاق التقرير. */
  it("دفعة تُشير لفاتورة مريضٍ آخر (ملغاة) ⇒ FinancialCurrencyIntegrityError", async () => {
    const pool = getPool();
    const { rows: [patient] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('P01-FR-DANGLE-INV', 'مريض مرجع الفاتورة الضائع') RETURNING id`,
    );
    await seedInvoice("P01-FR-INV-DANGLE", patient.id, "YER", 1000, docA);
    const { rows: [other] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('P01-FR-DANGLE-INV-O', 'المريض الآخر') RETURNING id`,
    );
    const otherInvoice = await seedInvoice("P01-FR-INV-DANGLE-O", other.id, "SAR", 1000, docA);
    await pool.query(`UPDATE invoices SET status = 'cancelled' WHERE id = $1`, [otherInvoice]);
    await seedPayment("P01-FR-PAY-DANGLE-INV", patient.id, otherInvoice, "payment", 1000, "YER", 1000);
    await expect(commissionReport(TODAY, TODAY)).rejects.toThrow(FinancialCurrencyIntegrityError);
  });

  it("دفعة مقيدة على خطة مريضٍ آخر ⇒ FinancialCurrencyIntegrityError", async () => {
    const pool = getPool();
    const { rows: [patient] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('P01-FR-DANGLE-PLAN', 'مريض مرجع الخطة الضائع') RETURNING id`,
    );
    await seedInvoice("P01-FR-INV-DANGLE-2", patient.id, "YER", 1000, docA);
    const { rows: [other] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('P01-FR-DANGLE-PLAN-O', 'مريض الخطة الآخر') RETURNING id`,
    );
    const { rows: [plan] } = await pool.query(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date)
       VALUES ($1, 'خطة المريض الآخر', 5000, 'SAR', 'active', CURRENT_DATE) RETURNING id`,
      [other.id],
    );
    await pool.query(
      `INSERT INTO payments (receipt_number, patient_id, invoice_id, plan_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, method)
       VALUES ('P01-FR-PAY-DANGLE-PLAN', $1, NULL, $2, $3, 'payment', 1000, 'SAR', 1, 1000, 'YER', 'cash')`,
      [patient.id, plan.id, shiftId],
    );
    await expect(commissionReport(TODAY, TODAY)).rejects.toThrow(FinancialCurrencyIntegrityError);
  });
});

describe("P-01 (المراجعة النهائية ١/٤) على PG حقيقي: دفعة EUR تُغلق كل المسارات", () => {
  it("financeSummary ⇒ FinancialCurrencyIntegrityError", async () => {
    const pool = getPool();
    const { rows: [patient] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('P01-FR-EUR', 'مريض اليورو') RETURNING id`,
    );
    // صفٌّ قديمٌ سبق قيد العملة (NOT VALID يُبقيه) — القراءة يجب أن تُغلق فاشلةً عليه.
    await insertLegacyRow(pool, "payments", "payments_currency_known",
      () => seedPayment("P01-FR-PAY-EUR", patient.id, null, "payment", 777, "EUR", 777));
    await expect(financeSummary(TODAY, TODAY)).rejects.toThrow(FinancialCurrencyIntegrityError);
  });

  it("journalEntries (الدفتر المشتق) ⇒ FinancialCurrencyIntegrityError", async () => {
    await expect(journalEntries(TODAY, TODAY)).rejects.toThrow(FinancialCurrencyIntegrityError);
  });

  it("executiveKpis (غرفة القيادة عبر الدفتر) ⇒ FinancialCurrencyIntegrityError", async () => {
    await expect(executiveKpis(TODAY, TODAY)).rejects.toThrow(FinancialCurrencyIntegrityError);
  });

  it("toCurrencyPaymentLikes: مرجع غير محلول يُقال (pure)", () => {
    const base = {
      amountMinor: 1000, currency: "YER" as const, exchangeRate: 1,
      baseAmountMinor: 1000, kind: "payment" as const,
    };
    expect(() =>
      toCurrencyPaymentLikes(1, [{ ...base, invoiceId: 999, id: 42 }], new Map()),
    ).toThrow(FinancialCurrencyIntegrityError);
    expect(() =>
      toCurrencyPaymentLikes(1, [{ ...base, invoiceId: null, planId: 88, id: 43 }], new Map(), new Map()),
    ).toThrow(FinancialCurrencyIntegrityError);
  });
});
