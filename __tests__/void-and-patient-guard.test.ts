import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات إبطال المصروف بقيد معاكس (P1-FIX-3) وحماية تاريخ المريض المالي
 * عند حذف ملفه — الحذف لم يعد مسارًا؛ التصحيح أحداث صريحة.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const {
  getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment,
  recordExpense, voidExpense, deletePatientCascade, createInventoryMovement,
} = await import("../lib/db");

beforeAll(async () => {
  await ensureSchema();
  await openShift({ openedBy: "guard-test", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("إبطال سند الصرف بقيد معاكس (P1-FIX-3)", () => {
  it("voidExpense يسجّل قيدًا معاكسًا والسجل الأصلي باقٍ بلا تعديل، والمجموع يصافي", async () => {
    const { expense } = await recordExpense({
      category: "supplies" as never, partyId: null, payeeText: "مورد",
      amountMinor: 5000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      payableId: null, note: "شراء خطأ", createdBy: "test",
    });
    expect(expense).not.toBeNull();

    const voided = await voidExpense(expense!.id, {
      actor: "admin", actorRole: "admin", reason: "مسجّل خطأً — فاتورة مكررة",
    });
    expect(voided.ok).toBe(true);
    expect(voided.voidedId).toBeDefined();
    expect(voided.voidedVoucherNumber).toMatch(/^X-/);

    const pool = getPool();
    const { rows: [original] } = await pool.query(
      `SELECT amount_minor, voucher_number FROM expenses WHERE id = $1`, [expense!.id],
    );
    expect(Number(original.amount_minor)).toBe(5000); // الأصل لم يُمسّ

    const { rows: [reversal] } = await pool.query(
      `SELECT amount_minor, base_amount_minor, reversal_of_id, category, shift_id
         FROM expenses WHERE id = $1`, [voided.voidedId],
    );
    expect(Number(reversal.amount_minor)).toBe(-5000); // قيد معاكس
    expect(Number(reversal.base_amount_minor)).toBe(-5000);
    expect(reversal.reversal_of_id).toBe(expense!.id);
    expect(reversal.category).toBe(original ? "supplies" : reversal.category);
    expect(reversal.shift_id).toBe(expense!.shiftId);

    // صافي الوردية من هذا السند = صفر (كل التقارير تصافي تلقائيًّا)
    const { rows: [net] } = await pool.query(
      `SELECT COALESCE(SUM(base_amount_minor), 0)::int AS total FROM expenses WHERE reversal_of_id = $1 OR id = $1`,
      [expense!.id],
    );
    expect(Number(net.total)).toBe(0);
  });

  it("بلا سبب ⇒ missing_reason: التصحيح المالي بلا سبب مُوثَّق غير مقبول", async () => {
    const { expense } = await recordExpense({
      category: "misc" as never, partyId: null, payeeText: null,
      amountMinor: 300, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      payableId: null, note: null, createdBy: "test",
    });
    const result = await voidExpense(expense!.id, { actor: "admin", reason: "   " });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_reason");
  });

  it("إبطال السند مرتين ⇒ already_voided", async () => {
    const { expense } = await recordExpense({
      category: "misc" as never, partyId: null, payeeText: null,
      amountMinor: 800, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      payableId: null, note: null, createdBy: "test",
    });
    const first = await voidExpense(expense!.id, { actor: "admin", reason: "خطأ إدخال" });
    expect(first.ok).toBe(true);
    const second = await voidExpense(expense!.id, { actor: "admin", reason: "مرة أخرى" });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already_voided");
    // وإبطال قيد الإبطال نفسه مرفوض أيضًا
    const voidOfVoid = await voidExpense(first.voidedId!, { actor: "admin", reason: "إبطال الإبطال" });
    expect(voidOfVoid.ok).toBe(false);
    expect(voidOfVoid.reason).toBe("already_voided");
  });
});

describe("حذف مريض له تاريخ مالي/مخزوني (P1-FIX-3)", () => {
  it("مريض له دفعة ⇒ has_financial_history والدفعات باقية حرفيًّا", async () => {
    const pool = getPool();
    const { rows: [patient] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('GD-P1', 'مريض مدفوعات') RETURNING id`,
    );
    const { payment } = await recordPayment({
      patientId: patient.id, invoiceId: null, kind: "payment", amountMinor: 4000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test",
    });
    expect(payment).not.toBeNull();

    const result = await deletePatientCascade(patient.id, { actor: "admin" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("has_financial_history");
    expect(result.counts?.payments).toBe(1);

    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE patient_id = $1`, [patient.id],
    );
    expect(row.n).toBe(1); // التاريخ لم يُمح
    const { rows: [stillThere] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patients WHERE id = $1`, [patient.id],
    );
    expect(stillThere.n).toBe(1); // والملف نفسه لم يُحذف
  });

  it("مريض له حركة مخزون (مباشرة أو عبر زيارة) ⇒ has_financial_history", async () => {
    const pool = getPool();
    const { rows: [item] } = await pool.query(
      `INSERT INTO inventory_items (name, unit, is_active, created_by)
       VALUES ('قفازات حذف', 'صندوق', TRUE, 'test') RETURNING id`,
    );
    const { rows: [patient] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('GD-P2', 'مريض مخزون') RETURNING id`,
    );
    const move = await createInventoryMovement({
      itemId: item.id, kind: "in", qty: 5, createdBy: "test", patientId: patient.id,
    });
    expect(move.ok).toBe(true);

    const result = await deletePatientCascade(patient.id, { actor: "admin" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("has_financial_history");
  });

  it("مريض نظيف بلا تاريخ مالي/مخزوني ⇒ الحذف يعمل كما كان", async () => {
    const pool = getPool();
    const { rows: [patient] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('GD-P3', 'مريض نظيف') RETURNING id`,
    );
    const result = await deletePatientCascade(patient.id, { actor: "admin", reason: "ازدواج سجل" });
    expect(result.ok).toBe(true);
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patients WHERE id = $1`, [patient.id],
    );
    expect(row.n).toBe(0);
  });
});
