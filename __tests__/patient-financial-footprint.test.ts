import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات حارس الأثر المالي المركزي عند حذف ملف مريض (P1-FINAL-1).
 *
 * الخلل الذي كان: الحارس القديم يمنع الحذف فقط عند وجود دفعات أو حركات مخزون،
 * ثم يمحو لاحقًا الفواتير (مدفوعةً كانت أو غير مدفوعة) والرصيد الافتتاحي
 * والتزامات أعمال المعمل — فيمحي دَينًا/فاتورةً/التزامًا ماليًّا بلا دفعة سابقة.
 *
 * السيناريوهات المطلوبة من المراجعة المستقلة:
 *  A) مريض بفاتورة غير مدفوعة بلا دفعات ⇒ DENIED، الفاتورة باقية، المريض باقٍ.
 *  B) مريض برصيد افتتاحي فقط ⇒ DENIED، الرصيد باقٍ.
 *  C) مريض بأمر معمل/التزام فقط ⇒ DENIED، الالتزام والتاريخ المالي باقيان.
 *  D) مريض مكرر نظيف بلا تاريخ سريري/مالي ⇒ الحذف يبقى مسموحًا كما كان.
 *  E) العملية معاملاتيّة: ظهور الأثر المالي لا يسبقه أي حذف جزئي.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const {
  getPool, resetPoolForTesting, ensureSchema, openShift, deletePatientCascade,
  createLabOrder, recordExpense,
} = await import("../lib/db");

const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  await ensureSchema();
  await openShift({ openedBy: "footprint-test", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

async function seedPatient(label: string): Promise<number> {
  const { rows: [patient] } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name)
     VALUES ('FP-${label}-${Date.now().toString(36)}', 'مريض ${label}') RETURNING id`,
  );
  return patient.id as number;
}

describe("حارس الأثر المالي المركزي (P1-FINAL-1)", () => {
  it("A) فاتورة غير مدفوعة بلا دفعات ⇒ DENIED — الفاتورة دَين قائم لا يُمحى", async () => {
    const pool = getPool();
    const patientId = await seedPatient("inv");
    const { rows: [invoice] } = await pool.query<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, status)
       VALUES ('FP-INV-A', $1, 50000, 0, 'YER', 'open') RETURNING id`,
      [patientId],
    );

    const result = await deletePatientCascade(patientId, { actor: "admin" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("has_financial_history");
    expect(result.counts?.invoices).toBe(1);
    expect(result.counts?.payments).toBe(0);

    // الفاتورة بقيت والمريض بقي — لا محو لدينٍ لم يُسدَّد
    const { rows: [invRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM invoices WHERE id = $1`, [invoice.id],
    );
    expect(invRow.n).toBe(1);
    const { rows: [patRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patients WHERE id = $1`, [patientId],
    );
    expect(patRow.n).toBe(1);
  });

  it("A-2) فاتورة مدفوعة ⇒ DENIED أيضًا — مدفوعةً أو غير مدفوعة سواء", async () => {
    const pool = getPool();
    const patientId = await seedPatient("paid-inv");
    await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, status)
       VALUES ('FP-INV-A2', $1, 20000, 0, 'YER', 'paid')`,
      [patientId],
    );
    const result = await deletePatientCascade(patientId, { actor: "admin" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("has_financial_history");
    expect(result.counts?.invoices).toBe(1);
  });

  it("B) رصيد افتتاحي فقط ⇒ DENIED — الرصيد السابق على النظام مالٌ واجب التتبع", async () => {
    const pool = getPool();
    const patientId = await seedPatient("opening");
    await pool.query(
      `INSERT INTO patient_opening_balances (patient_id, amount_minor, as_of_date, created_by)
       VALUES ($1, 30000, '2025-01-01', 'test')`,
      [patientId],
    );

    const result = await deletePatientCascade(patientId, { actor: "admin" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("has_financial_history");
    expect(result.counts?.openingBalances).toBe(1);

    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patient_opening_balances WHERE patient_id = $1`,
      [patientId],
    );
    expect(row.n).toBe(1);
    const { rows: [patRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patients WHERE id = $1`, [patientId],
    );
    expect(patRow.n).toBe(1);
  });

  it("C) أمر معمل بتكلفة/التزام فقط ⇒ DENIED — الالتزام وتاريخ المعمل المالي يبقيان", async () => {
    const pool = getPool();
    const patientId = await seedPatient("lab");
    const order = await createLabOrder({
      patientId, labName: "مختبر الحارس", labPhone: null, workType: "تاج",
      details: null, sentDate: TODAY, dueDate: TODAY, note: null,
      partyId: null, costMinor: 4000, costCurrency: "YER",
      baseCurrency: "YER", exchangeRate: 1, createdBy: "test",
    });
    expect(order).not.toBeNull();

    const result = await deletePatientCascade(patientId, { actor: "admin" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("has_financial_history");
    expect(result.counts?.labOrders).toBe(1);
    expect(result.counts?.payables).toBe(1);

    // الالتزام باقٍ ومرتبط بالطلب، والطلب باقٍ ومرتبط بالمريض
    const { rows: [payRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payables WHERE id = $1`, [order!.payableId],
    );
    expect(payRow.n).toBe(1);
    const { rows: [orderRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM lab_orders WHERE id = $1`, [order!.id],
    );
    expect(orderRow.n).toBe(1);
    const { rows: [patRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patients WHERE id = $1`, [patientId],
    );
    expect(patRow.n).toBe(1);
  });

  it("C-2) التزام عبر payables.lab_order_id وصرفٌ مرتبط به ⇒ DENY — لا فصل صرفٍ عن التزامه", async () => {
    const pool = getPool();
    const patientId = await seedPatient("lab2");
    const order = await createLabOrder({
      patientId, labName: "مختبر الحارس ب", labPhone: null, workType: "جسر",
      details: null, sentDate: TODAY, dueDate: TODAY, note: null,
      partyId: null, costMinor: 6000, costCurrency: "YER",
      baseCurrency: "YER", exchangeRate: 1, createdBy: "test",
    });
    expect(order).not.toBeNull();
    // صرفٌ مرتبط بالالتزام: السجل الذي كان الحذف القديم سيفصله بصمت
    const payableId = order!.payableId ?? null;
    expect(payableId).not.toBeNull();
    const { expense } = await recordExpense({
      category: "lab" as never, partyId: null, payeeText: null,
      amountMinor: 2500, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      payableId, note: null, createdBy: "test",
    });
    expect(expense).not.toBeNull();

    const result = await deletePatientCascade(patientId, { actor: "admin" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("has_financial_history");
    expect(result.counts?.payables).toBe(1);
    expect(result.counts?.financialLinks).toBe(1);

    // الصرف بقِيَ مرتبطًا بالتزامه — لم يُفصل
    const { rows: [linkRow] } = await pool.query(
      `SELECT payable_id FROM expenses WHERE id = $1`, [expense!.id],
    );
    expect(linkRow.payable_id).toBe(payableId);
  });

  it("D) مريض مكرر نظيف بلا تاريخ سريري/مالي ⇒ الحذف يعمل كما كان", async () => {
    const pool = getPool();
    const patientId = await seedPatient("clean");
    const result = await deletePatientCascade(patientId, {
      actor: "admin", reason: "ازدواج سجل نظيف",
    });
    expect(result.ok).toBe(true);
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patients WHERE id = $1`, [patientId],
    );
    expect(row.n).toBe(0);
  });

  it("D-2) مريض سريري فقط (زيارة بلا أثر مالي) ⇒ الحذف يعمل — السريري ليس ماليًّا", async () => {
    const pool = getPool();
    const patientId = await seedPatient("clinical");
    await pool.query(
      `INSERT INTO visits (patient_id, patient_name, status, arrived_at) VALUES ($1, 'سريري', 'waiting', NOW())`,
      [patientId],
    );
    const result = await deletePatientCascade(patientId, { actor: "admin" });
    expect(result.ok).toBe(true);
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patients WHERE id = $1`, [patientId],
    );
    expect(row.n).toBe(0);
  });

  it("E) معاملاتيّة: الرفض لا يسبقه أي حذف جزئي — الزيارات والسريري كله باقٍ", async () => {
    const pool = getPool();
    const patientId = await seedPatient("tx");
    // سريري: زيارة وموعد
    const { rows: [visit] } = await pool.query<{ id: number }>(
      `INSERT INTO visits (patient_id, patient_name, status, arrived_at) VALUES ($1, 'معاملة', 'waiting', NOW()) RETURNING id`,
      [patientId],
    );
    // وأثر مالي: فاتورة غير مدفوعة — الرفض يجب ألا يمسّ الزيارة
    await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, status)
       VALUES ('FP-INV-E', $1, 10000, 0, 'YER', 'open')`,
      [patientId],
    );

    const result = await deletePatientCascade(patientId, { actor: "admin" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("has_financial_history");

    // لا حذف جزئيًّا: الزيارة باقية والموعد لو وُجد — كل شيء كما كان
    const { rows: [visitRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM visits WHERE id = $1`, [visit.id],
    );
    expect(visitRow.n).toBe(1);
    const { rows: [patRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patients WHERE id = $1`, [patientId],
    );
    expect(patRow.n).toBe(1);
  });

  it("الإحصاء التفصيلي يعيد المفاتيح السبعة كاملة", async () => {
    const pool = getPool();
    const patientId = await seedPatient("counts");
    await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, status)
       VALUES ('FP-INV-CNT', $1, 7000, 0, 'YER', 'open')`,
      [patientId],
    );
    await pool.query(
      `INSERT INTO patient_opening_balances (patient_id, amount_minor, as_of_date, created_by)
       VALUES ($1, 1000, '2025-01-01', 'test')`,
      [patientId],
    );
    const result = await deletePatientCascade(patientId, { actor: "admin" });
    expect(result.ok).toBe(false);
    expect(result.counts).toMatchObject({
      invoices: 1,
      openingBalances: 1,
      payments: 0,
      inventoryMovements: 0,
      labOrders: 0,
      payables: 0,
      financialLinks: 0,
    });
  });
});
