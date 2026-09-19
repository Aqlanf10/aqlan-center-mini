import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات المراجعة النهائية لمالك PR #46 — سلامة العملة في المسارات المالية
 * الأربعة التي رصدها المالك على الرأس 0efde62:
 *
 *  ١) financeSummary: عملة دفعةٍ مجهولة (EUR) ⇒ رفضٌ صريح (fail-closed) — لا
 *     مفتاح دلو undefined فيصير المجموع NaN ولا وسمٌ يمني صامت.
 *  ٢) commissionReport: هدف تسوية الدفعة من الخريطة المرجعية الشاملة (الملغاة
 *     معها) — دفعة على فاتورة SAR أُلغيت لاحقًا تبقى هدفها SAR، والمرجع
 *     الضائع يُقال لا يسقط إلى YER.
 *  ٣) الردود الحرة بُعد عملة: ردٌّ سعودي يخصم السعودي وحده، ودولاري الدولار
 *     وحده — لا خصم من دلو الأساس أبدًا.
 *  ٤) journalEntries (ودربها غرفة القيادة): عملة دفعةٍ مجهولة تُرفض قبل القيد.
 *
 * الترتيب مقصود: بذور الفشل (مراجع معلّقة ثم دفعة EUR) تُزرع آخرًا لأن الدفعات
 * append-only — فلا تلوّث ما قبلها.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const {
  getPool, resetPoolForTesting, ensureSchema, financeSummary, commissionReport,
  journalEntries, executiveKpis,
} = await import("../lib/db");
const { toCurrencyPaymentLikes, FinancialCurrencyIntegrityError } = await import("../lib/money");
const { dbTodayISO } = await import("../lib/reports");

const PERCENT = 30;
let TODAY = "";
let shiftId = 0;

/* ── عمال السيناريوهات: طبيبٌ لكل سيناريو فيُعزل كل تأكيدٍ بدلوِّه ── */
let docA = 0; // دفعة على فاتورة SAR أُلغيت لاحقًا
let docB = 0; // ردٌّ حر سعودي فوق تحصيل يمني
let docC = 0; // ردٌّ حر سعودي فوق تحصيل سعودي
let docD = 0; // ردٌّ حر دولاري فوق تحصيل دولاري
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
  await ensureSchema();
  const pool = getPool();

  const { rows: [shift] } = await pool.query(
    `INSERT INTO cashier_shifts (opened_by) VALUES ('p01-final-review') RETURNING id`,
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

  /* أ: فاتورة YER مفتوحة (100,000) + فاتورة SAR (20,000) تُدفع كاملة ثم
   *    تُلغى لاحقًا — الدفعة واقعة تاريخية وهدفها عملة فاتورتها الملغاة. */
  await seedInvoice("P01-FR-INV-A-YER", patA, "YER", 100000, docA);
  const sarInvoice = await seedInvoice("P01-FR-INV-A-SAR", patA, "SAR", 20000, docA);
  await seedPayment("P01-FR-PAY-A-SAR", patA, sarInvoice, "payment", 20000, "SAR", 2600000);
  await pool.query(`UPDATE invoices SET status = 'cancelled' WHERE id = $1`, [sarInvoice]);

  /* ب: فاتورة YER (100,000) مسددة كاملة + ردٌّ حر سعودي (5,000) بلا أصل ولا
   *    مرجع — القديم كان يخصمه من دلو اليمني فينقص تغطيته؛ المحرم المطلق. */
  const yerInvoiceB = await seedInvoice("P01-FR-INV-B-YER", patB, "YER", 100000, docB);
  await seedPayment("P01-FR-PAY-B-YER", patB, yerInvoiceB, "payment", 100000, "YER", 100000);
  await seedPayment("P01-FR-REF-B-SAR", patB, null, "refund", 5000, "SAR", 650000);

  /* ج: فاتورة SAR (20,000) تحصيل 20,000 + ردٌّ حر سعودي 5,000 — الخصم من
   *    دلو السعودي وحده: التغطية 15,000/20,000. */
  const sarInvoiceC = await seedInvoice("P01-FR-INV-C-SAR", patC, "SAR", 20000, docC);
  await seedPayment("P01-FR-PAY-C-SAR", patC, sarInvoiceC, "payment", 20000, "SAR", 2600000);
  await seedPayment("P01-FR-REF-C-SAR", patC, null, "refund", 5000, "SAR", 650000);

  /* د: فاتورة USD (3,000) تحصيل 3,000 + ردٌّ حر دولاري 1,000 — الدولاري وحده. */
  const usdInvoiceD = await seedInvoice("P01-FR-INV-D-USD", patD, "USD", 3000, docD);
  await seedPayment("P01-FR-PAY-D-USD", patD, usdInvoiceD, "payment", 3000, "USD", 1590000);
  await seedPayment("P01-FR-REF-D-USD", patD, null, "refund", 1000, "USD", 530000);

  TODAY = await dbTodayISO();
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

/* ══ ٠ — العقد الكانوني: المرجع الضائع يُقال لا يُسقط إلى الأساس ══ */

describe("toCurrencyPaymentLikes: المراجع غير المحلولة تُقال (pure)", () => {
  const base = {
    amountMinor: 1000, currency: "YER" as const, exchangeRate: 1,
    baseAmountMinor: 1000, kind: "payment" as const,
  };

  it("مرجع فاتورة غير صفري غائب عن الخريطة ⇒ FinancialCurrencyIntegrityError", () => {
    expect(() =>
      toCurrencyPaymentLikes([{ ...base, invoiceId: 999, id: 42 }], new Map()),
    ).toThrow(FinancialCurrencyIntegrityError);
  });

  it("مرجع خطة غير صفري غائب عن الخريطة ⇒ FinancialCurrencyIntegrityError", () => {
    expect(() =>
      toCurrencyPaymentLikes([{ ...base, invoiceId: null, planId: 88, id: 43 }], new Map(), new Map()),
    ).toThrow(FinancialCurrencyIntegrityError);
  });

  it("المرجع الصفري (على الحساب) يبقى بدلو الأساس كما كان", () => {
    const likes = toCurrencyPaymentLikes([{ ...base, invoiceId: null }], new Map());
    expect(likes[0].invoiceCurrency).toBeNull();
  });
});

/* ══ ١ — دفعة على فاتورة أُلغيت لاحقًا: هدفها عملتها لا الأساس ══ */

describe("العمولة: دفعة على فاتورة SAR أُلغيت لاحقًا ⇒ الهدف SAR لا YER", () => {
  it("لا فشل ولا سقوط إلى الأساس: تحصيل السعودي لا يغطّي فواتير اليمني", async () => {
    const rows = await commissionReport(TODAY, TODAY);
    const mine = rows.filter((row) => row.doctorId === docA);
    // صفٌّ يمني واحد فقط: الاستحقاق 30% من 100,000 والمستحق صفر — دفعة السعودي
    // سُوّيت بدلو السعودي (فواتيره الملغاة خارج التوزيع) فلم تلمس اليمني.
    expect(mine).toHaveLength(1);
    const yer = mine.find((row) => row.currency === "YER")!;
    expect(yer.accruedMinor).toBe(30000);
    expect(yer.earnedMinor).toBe(0);
    // لا صف سعودي: الفاتورة الملغاة ليست في التوزيع ولا صرف بعملتها.
    expect(mine.find((row) => row.currency === "SAR")).toBeUndefined();
  });
});

/* ══ ٢ — الردود الحرة: بُعد العملة لا خصم الأساس ══ */

describe("العمولة: الردود الحرة بدلو عملتها حصرًا", () => {
  it("ردٌّ سعودي حر فوق تحصيل يمني ⇒ لا يمسّ دلو اليمني أبدًا", async () => {
    const rows = await commissionReport(TODAY, TODAY);
    const mine = rows.filter((row) => row.doctorId === docB);
    const yer = mine.find((row) => row.currency === "YER")!;
    // التغطية كاملة (100,000/100,000) — الرد السعودي لم يُخصم من اليمني.
    expect(yer.accruedMinor).toBe(30000);
    expect(yer.earnedMinor).toBe(30000);
    expect(mine.find((row) => row.currency === "SAR")).toBeUndefined();
  });

  it("ردٌّ سعودي حر فوق تحصيل سعودي ⇒ يخصم السعودي وحده (15,000/20,000)", async () => {
    const rows = await commissionReport(TODAY, TODAY);
    const sar = rows.find((row) => row.doctorId === docC && row.currency === "SAR")!;
    expect(sar.accruedMinor).toBe(6000);
    expect(sar.earnedMinor).toBe(4500);
  });

  it("ردٌّ دولاري حر فوق تحصيل دولاري ⇒ يخصم الدولار وحده (2,000/3,000)", async () => {
    const rows = await commissionReport(TODAY, TODAY);
    const usd = rows.find((row) => row.doctorId === docD && row.currency === "USD")!;
    expect(usd.accruedMinor).toBe(900);
    expect(usd.earnedMinor).toBe(600);
    // ولا صف يمني ولا سعودي لهذا الطبيب — الدلاء لم تُمسّ.
    expect(rows.find((row) => row.doctorId === docD && row.currency !== "USD")).toBeUndefined();
  });
});

/* ══ ٣ — غرفة القيادة بالعملات المختلطة قبل بذور الفشل: تعمل وتفصل ══ */

describe("غرفة القيادة: عملات مختلطة ⇒ صفوف لكل عملة (بلا مزج)", () => {
  it("executiveKpis ينجح والفوترة بكل عملة بدلوها", async () => {
    const kpis = await executiveKpis(TODAY, TODAY);
    const currencies = kpis.billingByCurrency.map((row) => row.currency).sort();
    expect(currencies).toEqual(["SAR", "USD", "YER"]);
    for (const row of kpis.billingByCurrency) {
      expect(Number.isInteger(row.netMinor)).toBe(true);
      expect(row.grossMinor).toBeGreaterThanOrEqual(row.netMinor);
    }
  });
});

/* ══ ٤ — المراجع الضائعة: فساد ربط يُقال (يفسد العمولة بعدها — لذا آخرًا) ══ */

describe("العمولة: مرجع دفعة ضائع ⇒ fail-closed", () => {
  /* القيود الخارجية تمنع مرجعًا لصفٍّ غير موجود أصلًا، فالفساد الواقعي هو ربطٌ
   * عبر المرضى: الدفعة تشير لفاتورة/خطة مريضٍ آخر — خريطة مريضها لا تحلّها
   * فيُقال المرجع لا يُسقط إلى الأساس. */
  it("دفعة تُشير لفاتورة مريضٍ آخر ⇒ FinancialCurrencyIntegrityError", async () => {
    const pool = getPool();
    const { rows: [patient] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('P01-FR-DANGLE-INV', 'مريض مرجع الفاتورة الضائع') RETURNING id`,
    );
    // فاتورة المريض نفسه — ليكون ضمن نطاق التقرير — والربط الفاسد لفاتورة غيره.
    await seedInvoice("P01-FR-INV-DANGLE", patient.id, "YER", 1000, docA);
    const { rows: [other] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('P01-FR-DANGLE-INV-O', 'المريض الآخر') RETURNING id`,
    );
    const otherInvoice = await seedInvoice("P01-FR-INV-DANGLE-O", other.id, "SAR", 1000, docA);
    // فاتورة المريض الآخر ملغاة: صاحبها خارج نطاق التقرير (لا فواتير محكومة
    // في المدى) فلا تدخل خريطة مريض الدفعة — والربط يبقى فسادًا يُقال.
    await getPool().query(`UPDATE invoices SET status = 'cancelled' WHERE id = $1`, [otherInvoice]);
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

/* ══ ٥ — دفعة EUR: الإغلاق الفاشل في كل المسارات المالية (البذرة آخرًا) ══ */

describe("دفعة بعملة EUR ⇒ كل المسارات المالية تُغلق فاشلة", () => {
  it("financeSummary ⇒ FinancialCurrencyIntegrityError (لا NaN ولا دلو undefined)", async () => {
    const pool = getPool();
    const { rows: [patient] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('P01-FR-EUR', 'مريض اليورو') RETURNING id`,
    );
    await seedPayment("P01-FR-PAY-EUR", patient.id, null, "payment", 777, "EUR", 777);
    await expect(financeSummary(TODAY, TODAY)).rejects.toThrow(FinancialCurrencyIntegrityError);
  });

  it("journalEntries (الدفتر المشتق) ⇒ FinancialCurrencyIntegrityError", async () => {
    await expect(journalEntries(TODAY, TODAY)).rejects.toThrow(FinancialCurrencyIntegrityError);
  });

  it("executiveKpis (غرفة القيادة عبر الدفتر) ⇒ FinancialCurrencyIntegrityError", async () => {
    await expect(executiveKpis(TODAY, TODAY)).rejects.toThrow(FinancialCurrencyIntegrityError);
  });
});
