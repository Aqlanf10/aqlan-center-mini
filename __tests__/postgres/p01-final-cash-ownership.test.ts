import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * اختبارات التصحيحات المالية النهائية لـ PR #46 (المراجعة النهائية للمال) —
 * على PostgreSQL الحقيقي (المحرك الذي يركض في CI)؛ ونفس الإثباتات على
 * PGlite في __tests__/p01-final-cash-ownership.test.ts:
 *
 *  ١) الصندوق التنفيذي محاسبةٌ بالأساس: 1,500.00 ر.س @130 ⇒ حركة درج السعودي
 *     195,000 ر.ي (لا 1,950.00 ر.س)، و 120.00 $ @530 ⇒ 63,600 ر.ي (لا 636.00 $)،
 *     واليمني كما كان.
 *  ٢) التسوية المسموحة: SAR→SAR بمبلغها نفسه، و USD→فاتورة YER بالمكافئ
 *     الأساسي المسجَّل (عقد الدفعات القائم).
 *  ٣) المساعدات الخالصة: قاعدة التسوية الواحدة (أجنبي→أجنبي يُقال)، والملكية
 *     شرط حلٍّ، والخريطة الغائبة تُقال.
 *
 * بذور الفساد (الربط العابر والتسوية بين أجنبيين) في ملفٍ شقيق مخصص:
 * __tests__/p01-final-read-path-guards.test.ts — الدفعات append-only فلا تُحذف،
 * فكل سيناريو فسادٍ يعزل بنطاق تاريخٍ خاص وترتيب مرضى معكوس.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, commissionReport, patientDebtReport,
  executiveKpis,
} = await import("../../lib/db");
const {
  toCurrencyPaymentLikes, settlePaymentMinor, patientBalancesByCurrency,
  FinancialCurrencyIntegrityError,
} = await import("../../lib/money");
const { dbTodayISO } = await import("../../lib/reports");

const PERCENT = 30;
let TODAY = "";
let shiftId = 0;

let docSar = 0; // تسوية سعودية بعملتها نفسها
let docUsdToYer = 0; // دولار على فاتورة يمنية — المكافئ الأساسي المسجَّل
let patSar = 0;
let patUsdToYer = 0;

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

async function seedPayment(
  receipt: string, patientId: number, invoiceId: number | null,
  amountMinor: number, currency: string, exchangeRate: number, baseAmountMinor: number,
): Promise<void> {
  await getPool().query(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, method)
     VALUES ($1, $2, $3, $4, 'payment', $5, $6, $7, $8, 'YER', 'cash')`,
    [receipt, patientId, invoiceId, shiftId, amountMinor, currency, exchangeRate, baseAmountMinor],
  );
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();

  const { rows: [shift] } = await pool.query(
    `INSERT INTO cashier_shifts (opened_by) VALUES ('p01-final-cash') RETURNING id`,
  );
  shiftId = shift.id;

  [docSar, docUsdToYer] = await Promise.all([
    seedDoctor("طبيب التسوية السعودية"),
    seedDoctor("طبيب الدولار على اليمني"),
  ]);
  [patSar, patUsdToYer] = await Promise.all([
    seedPatient("P01-FC-SAR", "مريض التسوية السعودية"),
    seedPatient("P01-FC-USD-YER", "مريض الدولار على اليمني"),
  ]);

  /* س: فاتورة سعودية 2,000.00 (200,000 هللة) وتحصيل 1,500.00 (150,000) @130
   *    — تسويةً سعوديةً سعوديةً بمبلغها نفسه. */
  const sarInvoice = await seedInvoice("P01-FC-INV-SAR", patSar, "SAR", 200000, docSar);
  await seedPayment("P01-FC-PAY-SAR", patSar, sarInvoice, 150000, "SAR", 130, 195000);

  /* ص: فاتورة يمنية 63,600 وتحصيل دولاري 120.00 (12,000 سنت) @530 — مسموح
   *    بالمكافئ الأساسي المسجَّل لا بسعر اليوم. */
  const yerInvoice = await seedInvoice("P01-FC-INV-YER", patUsdToYer, "YER", 63600, docUsdToYer);
  await seedPayment("P01-FC-PAY-USD", patUsdToYer, yerInvoice, 12000, "USD", 530, 63600);

  TODAY = await dbTodayISO();
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

/* ══ ٠ — المساعد الخالص: قاعدة التسوية الواحدة (المراجعة النهائية للمال ٣) ══ */

describe("settlePaymentMinor: قاعدة التسوية الواحدة (pure)", () => {
  const sarPayment = { amountMinor: 150000, currency: "SAR" as const, baseAmountMinor: 195000, id: 1 };
  const usdPayment = { amountMinor: 12000, currency: "USD" as const, baseAmountMinor: 63600, id: 2 };
  const yerPayment = { amountMinor: 50000, currency: "YER" as const, baseAmountMinor: 50000, id: 3 };

  it("نفس العملة ⇒ بمبلغها نفسه (SAR→SAR بمبلغ amount_minor)", () => {
    expect(settlePaymentMinor(sarPayment, "SAR")).toBe(150000);
  });

  it("USD → هدف يمني ⇒ بالمكافئ الأساسي المسجَّل (base_amount_minor)", () => {
    expect(settlePaymentMinor(usdPayment, "YER")).toBe(63600);
  });

  it("YER → هدف يمني ⇒ بمبلغه (لا فرق بين المبلغ والمكافئ في الأساس)", () => {
    expect(settlePaymentMinor(yerPayment, "YER")).toBe(50000);
  });

  it("USD → هدف سعودي ⇒ FinancialCurrencyIntegrityError (لا سعر تاريخيًّا للهدف)", () => {
    expect(() => settlePaymentMinor(usdPayment, "SAR")).toThrow(FinancialCurrencyIntegrityError);
  });

  it("YER → هدف سعودي ⇒ FinancialCurrencyIntegrityError", () => {
    expect(() => settlePaymentMinor(yerPayment, "SAR")).toThrow(FinancialCurrencyIntegrityError);
  });

  it("SAR → هدف دولاري (خطة) ⇒ FinancialCurrencyIntegrityError", () => {
    expect(() => settlePaymentMinor(sarPayment, "USD")).toThrow(FinancialCurrencyIntegrityError);
  });

  it("الأرصدة نفسها: دفعة دولارية على فاتورةٍ يمنية تسوّي الأساس بمكافئها المسجَّل", () => {
    const balances = patientBalancesByCurrency(
      [{ totalMinor: 63600, discountMinor: 0, status: "open", baseCurrency: "YER" }],
      [{
        amountMinor: 12000, currency: "USD", exchangeRate: 530,
        baseAmountMinor: 63600, kind: "payment", invoiceCurrency: "YER",
      }],
      0,
    );
    expect(balances.YER.dueMinor).toBe(0);
    expect(balances.USD.dueMinor).toBe(0);
  });
});

/* ══ ١ — المساعد الخالص: الملكية والخريطة الغائبة (المراجعة ٢ + ٤) ══ */

describe("toCurrencyPaymentLikes: الملكية شرطٌ والخريطة الغائبة تُقال (pure)", () => {
  const base = {
    amountMinor: 1000, currency: "YER" as const, exchangeRate: 1,
    baseAmountMinor: 1000, kind: "payment" as const,
  };

  it("مرجع فاتورة مريضٍ آخر (وإن حُلّ عملته) ⇒ FinancialCurrencyIntegrityError", () => {
    expect(() =>
      toCurrencyPaymentLikes(
        1,
        [{ ...base, invoiceId: 5, id: 9 }],
        new Map([[5, { patientId: 2, currency: "SAR" }]]),
      ),
    ).toThrow(FinancialCurrencyIntegrityError);
  });

  it("مرجع خطة مريضٍ آخر (وإن حُلّ عملته) ⇒ FinancialCurrencyIntegrityError", () => {
    expect(() =>
      toCurrencyPaymentLikes(
        1,
        [{ ...base, invoiceId: null, planId: 7, id: 10 }],
        new Map(),
        new Map([[7, { patientId: 2, currency: "USD" }]]),
      ),
    ).toThrow(FinancialCurrencyIntegrityError);
  });

  it("دفعة مقيدة على خطة بلا خريطة خطط أصلًا ⇒ FinancialCurrencyIntegrityError (لا سقوط للأساس)", () => {
    expect(() =>
      toCurrencyPaymentLikes(1, [{ ...base, invoiceId: null, planId: 7, id: 11 }], new Map()),
    ).toThrow(FinancialCurrencyIntegrityError);
  });

  it("مرجع المالك نفسه ⇒ يُحلّ هدفه بعملته", () => {
    const likes = toCurrencyPaymentLikes(
      1,
      [{ ...base, invoiceId: 5, id: 12 }],
      new Map([[5, { patientId: 1, currency: "SAR" }]]),
    );
    expect(likes[0].invoiceCurrency).toBe("SAR");
  });
});

/* ══ ٢ — الصندوق التنفيذي محاسبةٌ بالأساس (المراجعة النهائية للمال ١) ══ */

describe("غرفة القيادة: حركة الصندوق بالعملة الأساسية — لا بعملة الدرج", () => {
  it("1,500.00 ر.س @130 ⇒ درج السعودي 195,000 ر.ي، و 120.00 $ @530 ⇒ درج الدولار 63,600 ر.ي", async () => {
    const kpis = await executiveKpis(TODAY, TODAY);
    const sar = kpis.cashMovements.find((row) => row.cashAccountCurrency === "SAR")!;
    const usd = kpis.cashMovements.find((row) => row.cashAccountCurrency === "USD")!;
    // المكافئ الأساسي المسجَّل — لا المبلغ الأجنبي بعملته أبدًا.
    expect(sar.collectedBaseMinor).toBe(195000);
    expect(sar.collectedBaseMinor).not.toBe(150000);
    expect(usd.collectedBaseMinor).toBe(63600);
    expect(usd.collectedBaseMinor).not.toBe(12000);
    // صافي الحركة بالأساس كذلك (لا خروج من درجيهما في هذا السيناريو).
    expect(sar.netBaseMinor).toBe(195000);
    expect(usd.netBaseMinor).toBe(63600);
  });

  it("درج اليمني بمبالغه الأساسية نفسها — لا مدفوعات يمنية في هذا الملف", async () => {
    const kpis = await executiveKpis(TODAY, TODAY);
    const yer = kpis.cashMovements.find((row) => row.cashAccountCurrency === "YER")!;
    expect(yer.collectedBaseMinor).toBe(0);
  });

  it("عقد الحركة أساسيٌّ صريح: أسماء الحقول تُقرأ أساسًا ولا اسم المزيج القديم", async () => {
    const kpis = await executiveKpis(TODAY, TODAY);
    expect("collections" in kpis).toBe(false);
    expect(kpis.cashMovements.every((row) =>
      "cashAccountCurrency" in row && "collectedBaseMinor" in row
      && "paidOutBaseMinor" in row && "netBaseMinor" in row)).toBe(true);
  });
});

/* ══ ٣ — التسوية المسموحة: سعودية بسعودية، ودولار على يمني بمكافئه ══ */

describe("التسوية المسموحة: نفس العملة والمكافئ الأساسي المسجَّل", () => {
  it("SAR→SAR بمبلغها: العمولة على المحصّل السعودي بمبلغه لا بمكافئه", async () => {
    const rows = await commissionReport(TODAY, TODAY);
    const sar = rows.find((row) => row.doctorId === docSar && row.currency === "SAR")!;
    // استحقاق 30% من 200,000 ومكسب 30% من 150,000 — كلها هللة سعودية.
    expect(sar.accruedMinor).toBe(60000);
    expect(sar.earnedMinor).toBe(45000);
  });

  it("USD→فاتورة YER بالمكافئ المسجَّل: العمولة على المكافئ الأساسي بالدلو اليمني", async () => {
    const rows = await commissionReport(TODAY, TODAY);
    const yer = rows.find((row) => row.doctorId === docUsdToYer && row.currency === "YER")!;
    expect(yer.accruedMinor).toBe(19080);
    expect(yer.earnedMinor).toBe(19080);
  });

  it("المديونية: الدولار على اليمني يسوّي الدلو اليمني بمكافئه المسجَّل", async () => {
    const rows = (await patientDebtReport()).filter((row) => row.patientId === patUsdToYer);
    // الفاتورة اليمنية 63,600 سُدِّدت بمكافئ 63,600 — لا صف مدين.
    expect(rows.find((row) => row.currency === "YER")?.dueMinor ?? 0).toBe(0);
    expect(rows.find((row) => row.currency === "USD")).toBeUndefined();
  });

  it("المديونية: السعودي بدلوه بمبلغه — due 50,000 هللة (500.00 ر.س)", async () => {
    const rows = (await patientDebtReport()).filter((row) => row.patientId === patSar);
    const sar = rows.find((row) => row.currency === "SAR")!;
    expect(sar.billedMinor).toBe(200000);
    expect(sar.collectedMinor).toBe(150000);
    expect(sar.dueMinor).toBe(50000);
  });
});
