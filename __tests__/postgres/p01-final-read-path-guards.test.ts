import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * حرّاس مسارات القراءة للتصحيحات المالية النهائية لـ PR #46 — على
 * PostgreSQL الحقيقي (المحرك الذي يركض في CI)؛ ونفس الإثباتات على PGlite
 * في __tests__/p01-final-read-path-guards.test.ts:
 *
 *  ١) (المراجعة النهائية للمال ٢) الربط العابر للمرضى: دفعة مريضٍ تشير لفاتورة
 *     أو خطة مريضٍ آخر **كلاهما بنشاطٍ محكومٍ غير ملغى في نطاق التقرير نفسه**
 *     ⇒ FinancialCurrencyIntegrityError في commissionReport وpatientDebtReport
 *     ومحرك التقارير (executiveFinancialReadModels/loadMovements) — لا استعارة
 *     هدف مريضٍ آخر لتسوية دفعة غيره.
 *  ٢) (المراجعة النهائية للمال ٣) التسوية بين عملتين أجنبيتين (USD→SAR و
 *     YER→SAR وSAR→خطة USD) ⇒ FinancialCurrencyIntegrityError في المسارات
 *     الثلاثة نفسها.
 *
 * الدفعات append-only (حرّاس DELETE على مستوى القاعدة) فلا تُحذف البذور —
 * فالسيناريوهات تُعزل عزلًا بنيويًا بدل الحذف:
 *   - commissionReport يُنادى بنطاق التاريخ الخاص بكل سيناريو (نطاقه: مرضى
 *     فواتيرهم المحكومة في المدى).
 *   - patientDebtReport وexecutiveFinancialReadModels يعالجان المرضى بترتيب
 *     المعرف، فبذرة كل سيناريو تُزرع على مريضٍ بمعرفٍ أدنى من بذرة السيناريو
 *     الذي قبله — فيُقال خطأُ بذرته هو أولًا ويتحقق التعليق على معرّفها.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, commissionReport, patientDebtReport,
} = await import("../../lib/db");
const { FinancialCurrencyIntegrityError } = await import("../../lib/money");
const { dbTodayISO, executiveFinancialReadModels } = await import("../../lib/reports");

const PERCENT = 30;
let TODAY = "";
let shiftId = 0;

/* المرضى بترتيب الإدراج = ترتيب المعرف تصاعديًا؛ وبذور السيناريوهات تُزرع
 * باختبارٍ لاحقٍ على مريضٍ بمعرفٍ أدنى — انظر رأس الملف. */
let patPlanPoison = 0; // سيناريو ٥: SAR على خطة USD (أدنى معرف — يُزرع أخيرًا)
let patYerSar = 0; // سيناريو ٤: YER على فاتورة SAR
let patUsdSar = 0; // سيناريو ٣: USD على فاتورة SAR
let patCrossPlanA = 0; // سيناريو ٢: دفعته مقيدة على خطة مريضٍ آخر
let patCrossPlanB = 0;
let patCrossA = 0; // سيناريو ١: دفعته تشير لفاتورة مريضٍ آخر (أعلى معرف — يُزرع أولًا)
let patCrossB = 0;

let docAll = 0;

const daysAgo = (n: number): string => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function seedPatient(number: string, name: string): Promise<number> {
  const { rows: [patient] } = await getPool().query(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`,
    [number, name],
  );
  return patient.id;
}

async function seedInvoiceAt(
  number: string, patientId: number, currency: string, netMinor: number, day: string,
): Promise<number> {
  const { rows: [invoice] } = await getPool().query(
    `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, base_currency, created_at)
     VALUES ($1, $2, 'open', $3, 0, $4, $5::timestamptz) RETURNING id`,
    [number, patientId, netMinor, currency, `${day}T10:00:00Z`],
  );
  await getPool().query(
    `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id)
     VALUES ($1, NULL, 'حشوة', 1, $2, $2, $3)`,
    [invoice.id, netMinor, docAll],
  );
  return invoice.id;
}

async function seedPaymentAt(
  receipt: string, patientId: number, invoiceId: number | null, planId: number | null,
  amountMinor: number, currency: string, exchangeRate: number, baseAmountMinor: number, day: string,
): Promise<number> {
  const { rows: [payment] } = await getPool().query(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, plan_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, method, created_at)
     VALUES ($1, $2, $3, $4, $5, 'payment', $6, $7, $8, $9, 'YER', 'cash', $10::timestamptz) RETURNING id`,
    [receipt, patientId, invoiceId, planId, shiftId, amountMinor, currency, exchangeRate, baseAmountMinor, `${day}T10:00:00Z`],
  );
  return payment.id;
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  // اليوم أولًا — بذور السيناريوهات تؤرَّخ بأيامٍ نسبية إليه.
  TODAY = await dbTodayISO();

  const { rows: [shift] } = await pool.query(
    `INSERT INTO cashier_shifts (opened_by) VALUES ('p01-final-guards') RETURNING id`,
  );
  shiftId = shift.id;
  const { rows: [doc] } = await pool.query(
    `INSERT INTO parties (name, kind, commission_percent) VALUES ($1, 'doctor', $2) RETURNING id`,
    ["طبيب حرّاس المسارات", String(PERCENT)],
  );
  docAll = doc.id;

  /* ترتيب الإدراج = ترتيب المعرف تصاعديًا (عكس ترتيب زرع البذور) — إدراجٌ
   * تسلسلي حتمي: Promise.all لا يضمن ترتيب المعرفات على PostgreSQL الحقيقي. */
  patPlanPoison = await seedPatient("P01-G-PLAN", "مريض الخطة الدولارية");
  patYerSar = await seedPatient("P01-G-YERSAR", "مريض اليمني على السعودي");
  patUsdSar = await seedPatient("P01-G-USDSAR", "مريض الدولار على السعودي");
  patCrossPlanA = await seedPatient("P01-G-CP-A", "مريض ربط الخطة أ");
  patCrossPlanB = await seedPatient("P01-G-CP-B", "مريض ربط الخطة ب");
  patCrossA = await seedPatient("P01-G-CI-A", "مريض ربط الفاتورة أ");
  patCrossB = await seedPatient("P01-G-CI-B", "مريض ربط الفاتورة ب");

  /* سيناريو ١ (التاريخ D-4): أ وب كلاهما بفواتير محكومة غير ملغاة في المدى —
   * بذرة الفساد: دفعة أ تشير لفاتورة ب السعودية. */
  await seedInvoiceAt("P01-G-CI-A-INV", patCrossA, "YER", 100000, daysAgo(4));
  await seedInvoiceAt("P01-G-CI-B-SAR", patCrossB, "SAR", 80000, daysAgo(4));

  /* سيناريو ٢ (D-3): أ بفاتورةٍ محكومة وب بخطةٍ سعودية — وكلاهما بالنطاق؛
   * البذرة: دفعة أ مقيدة على خطة ب. */
  await seedInvoiceAt("P01-G-CP-A-INV", patCrossPlanA, "YER", 100000, daysAgo(3));
  await seedInvoiceAt("P01-G-CP-B-INV", patCrossPlanB, "YER", 60000, daysAgo(3));
  await pool.query(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date)
     VALUES ($1, 'خطة المريئ ب العابرة', 50000, 'SAR', 'active', CURRENT_DATE)`,
    [patCrossPlanB],
  );

  /* سيناريو ٣ (D-2): فاتورة سعودية لمريضه ودفعتها بالدولار — الملكية سليمة
   * والفساد في العبور بين العملتين. */
  await seedInvoiceAt("P01-G-USDSAR-INV", patUsdSar, "SAR", 80000, daysAgo(2));

  /* سيناريو ٤ (D-1): فاتورة سعودية ودفعتها باليمني. */
  await seedInvoiceAt("P01-G-YERSAR-INV", patYerSar, "SAR", 80000, daysAgo(1));

  /* سيناريو ٥ (D-0): فاتورة يمنية وخطة دولارية لمريضه — والدفع بالسعودي على الخطة. */
  await seedInvoiceAt("P01-G-PLAN-INV", patPlanPoison, "YER", 100000, daysAgo(0));
  await pool.query(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date)
     VALUES ($1, 'خطة دولادية لأ', 30000, 'USD', 'active', CURRENT_DATE)`,
    [patPlanPoison],
  );
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

/* المساران العالميان (المديونية ومحرك التقارير) يعالجان المرضى بترتيب
 * المعرف — فأدنى معرفٍ فيه بذرة هو الذي يُقال أولًا. رسالة المحرك للخطة
 * العابرة تختلف عن رسالة الأرصدة (خطة ليست من حركات مريضها) فلكل مسارٍ إبرته. */
async function assertGlobalReportsRejectWith(debtNeedle: string, engineNeedle: string): Promise<void> {
  await expect(patientDebtReport()).rejects.toThrow(FinancialCurrencyIntegrityError);
  await expect(patientDebtReport()).rejects.toThrow(debtNeedle);
  await expect(executiveFinancialReadModels(TODAY, TODAY)).rejects.toThrow(FinancialCurrencyIntegrityError);
  await expect(executiveFinancialReadModels(TODAY, TODAY)).rejects.toThrow(engineNeedle);
}

/* ══ ٠ — خط الأساس: كل المسارات سليمة قبل أي بذرة ══ */

describe("خط الأساس: المسارات الثلاثة سليمة قبل أي بذرة فساد", () => {
  it("العمولة والمديونية ومحرك التقارير تعمل بلا أي خطأ سلامة", async () => {
    await expect(commissionReport(daysAgo(5), TODAY)).resolves.toBeTruthy();
    await expect(patientDebtReport()).resolves.toBeTruthy();
    await expect(executiveFinancialReadModels(TODAY, TODAY)).resolves.toBeTruthy();
  });
});

/* ══ ١ — الربط العابر للمرضى: فاتورة (المراجعة النهائية للمال ٢) ══ */

describe("دفعة مريض أ تشير لفاتورة مريض ب (كلاهما بنشاطٍ محكومٍ في النطاق) ⇒ fail-closed", () => {
  it("commissionReport بنطاق السيناريو يرفض ربطًا عابرًا لا يستعير عملة فاتورة ب", async () => {
    const pool = getPool();
    const { rows: [{ id: bInvoice }] } = await pool.query(
      `SELECT id FROM invoices WHERE patient_id = $1 AND base_currency = 'SAR' LIMIT 1`,
      [patCrossB],
    );
    const poisonId = await seedPaymentAt(
      "P01-G-POISON-CI", patCrossA, bInvoice, null, 1000, "SAR", 130, 1300, daysAgo(4),
    );
    // نطاق اليوم D-4: مرضى السيناريو وحدهم (أ وب) — البذرة تُقال باسمها.
    await expect(commissionReport(daysAgo(4), daysAgo(4)))
      .rejects.toThrow(FinancialCurrencyIntegrityError);
    await expect(commissionReport(daysAgo(4), daysAgo(4)))
      .rejects.toThrow(`#${poisonId} → فاتورة #${bInvoice}`);
  });

  it("patientDebtReport ومحرك التقارير يرفضان الربط العابر (لا تُسوّى بعملة فاتورة ب)", async () => {
    // بذرة السيناريو الأول على مريضٍ بمعرفٍ أعلى من كل البذور اللاحقة — هي
    // الوحيدة الآن فيُقال خطؤها باسمها.
    await assertGlobalReportsRejectWith("فاتورة مريضٍ آخر", "فاتورة مريضٍ آخر");
  });
});

/* ══ ٢ — الربط العابر للمرضى: خطة (المراجعة النهائية للمال ٢) ══ */

describe("دفعة مريض أ مقيدة على خطة مريئ ب (ب في النطاق) ⇒ fail-closed", () => {
  it("كل المسارات الثلاثة ترفض ربط الخطة العابر — كلٌّ باسم بذرته", async () => {
    const pool = getPool();
    const { rows: [{ id: bPlan }] } = await pool.query(
      `SELECT id FROM treatment_plans WHERE patient_id = $1 LIMIT 1`,
      [patCrossPlanB],
    );
    const poisonId = await seedPaymentAt(
      "P01-G-POISON-CP", patCrossPlanA, null, bPlan, 1000, "SAR", 130, 1300, daysAgo(3),
    );
    // commissionReport بنطاق D-3: مرضى السيناريو (أ وب) وحدهم.
    await expect(commissionReport(daysAgo(3), daysAgo(3)))
      .rejects.toThrow(FinancialCurrencyIntegrityError);
    await expect(commissionReport(daysAgo(3), daysAgo(3)))
      .rejects.toThrow(`#${poisonId} → خطة #${bPlan}`);
    // والمساران العالميان: بذرة هذا السيناريو على معرفٍ أدنى من بذرة السيناريو
    // الأول فتُقال هي أولًا باسمها — ورسالة المحرك: الخطة ليست من حركات مريضها.
    await assertGlobalReportsRejectWith("خطة مريضٍ آخر", "ليست من حركات مريضها");
  });
});

/* ══ ٣ — التسوية بين أجنبيين: USD على فاتورة SAR (المراجعة النهائية للمال ٣) ══ */

describe("دفعة USD على فاتورة SAR ⇒ fail-closed في كل المسارات", () => {
  it("كل المسارات ترفض التسوية الأجنبية بأجنبية — باسم بذرتها", async () => {
    const pool = getPool();
    const { rows: [{ id: ownSarInvoice }] } = await pool.query(
      `SELECT id FROM invoices WHERE patient_id = $1 AND base_currency = 'SAR' LIMIT 1`,
      [patUsdSar],
    );
    const poisonId = await seedPaymentAt(
      "P01-G-POISON-USDSAR", patUsdSar, ownSarInvoice, null, 2000, "USD", 530, 10600, daysAgo(2),
    );
    await expect(commissionReport(daysAgo(2), daysAgo(2)))
      .rejects.toThrow(FinancialCurrencyIntegrityError);
    await expect(commissionReport(daysAgo(2), daysAgo(2)))
      .rejects.toThrow(`#${poisonId}: USD → SAR`);
    await assertGlobalReportsRejectWith(`#${poisonId}: USD → SAR`, `#${poisonId}: USD → SAR`);
  });
});

/* ══ ٤ — التسوية بين أجنبيين: YER على فاتورة SAR ══ */

describe("دفعة YER على فاتورة SAR ⇒ fail-closed في كل المسارات", () => {
  it("المكافئ الأساسي ليس مبلغًا سعوديًا — فالتسوية تُقال باسم بذرتها", async () => {
    const pool = getPool();
    const { rows: [{ id: ownSarInvoice }] } = await pool.query(
      `SELECT id FROM invoices WHERE patient_id = $1 AND base_currency = 'SAR' LIMIT 1`,
      [patYerSar],
    );
    const poisonId = await seedPaymentAt(
      "P01-G-POISON-YERSAR", patYerSar, ownSarInvoice, null, 50000, "YER", 1, 50000, daysAgo(1),
    );
    await expect(commissionReport(daysAgo(1), daysAgo(1)))
      .rejects.toThrow(FinancialCurrencyIntegrityError);
    await expect(commissionReport(daysAgo(1), daysAgo(1)))
      .rejects.toThrow(`#${poisonId}: YER → SAR`);
    await assertGlobalReportsRejectWith(`#${poisonId}: YER → SAR`, `#${poisonId}: YER → SAR`);
  });
});

/* ══ ٥ — التسوية بين أجنبيين: SAR على خطة USD ══ */

describe("دفعة SAR على خطة USD ⇒ fail-closed في كل المسارات", () => {
  it("لا سعر تاريخيًّا للدولار على الخطة — فالتسوية تُقال باسم بذرتها", async () => {
    const pool = getPool();
    const { rows: [{ id: usdPlan }] } = await pool.query(
      `SELECT id FROM treatment_plans WHERE patient_id = $1 LIMIT 1`,
      [patPlanPoison],
    );
    const poisonId = await seedPaymentAt(
      "P01-G-POISON-SARPLAN", patPlanPoison, null, usdPlan, 5000, "SAR", 130, 6500, daysAgo(0),
    );
    await expect(commissionReport(daysAgo(0), daysAgo(0)))
      .rejects.toThrow(FinancialCurrencyIntegrityError);
    await expect(commissionReport(daysAgo(0), daysAgo(0)))
      .rejects.toThrow(`#${poisonId}: SAR → USD`);
    await assertGlobalReportsRejectWith(`#${poisonId}: SAR → USD`, `#${poisonId}: SAR → USD`);
  });
});
