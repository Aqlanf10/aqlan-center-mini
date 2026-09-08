import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات السجل المالي غير القابل للتعديل (P1.6) — حرّاس triggers على PGlite.
 *
 * المبدأ: الحدث المالي التاريخي immutable؛ التصحيح حدث معاكس صريح لا UPDATE
 * صامت. الاختبار يهاجم مباشرة عبر SQL (كما يفعل عميل خارجي/مشرف مشتت)، فالحارس
 * على مستوى القاعدة لا التطبيق.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const { getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment, recordExpense, createInventoryMovement } = await import("../lib/db");

beforeAll(async () => {
  await ensureSchema();
  await openShift({ openedBy: "append-only-test", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("حرّاس append-only على الجداول المالية", () => {
  it("UPDATE لعمود مالي في payments ⇒ مرفوض من القاعدة نفسها", async () => {
    const pool = getPool();
    const { rows: [patient] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('AO-P1', 'مريض السجل') RETURNING id`,
    );
    const { payment } = await recordPayment({
      patientId: patient.id, invoiceId: null, kind: "payment", amountMinor: 5000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test",
    });
    expect(payment).not.toBeNull();

    await expect(pool.query(`UPDATE payments SET amount_minor = 999999 WHERE id = $1`, [payment!.id]))
      .rejects.toThrow(/غير قابل للتعديل/);
    await expect(pool.query(`UPDATE payments SET base_amount_minor = 1 WHERE id = $1`, [payment!.id]))
      .rejects.toThrow(/append-only/);
    await expect(pool.query(`UPDATE payments SET currency = 'USD' WHERE id = $1`, [payment!.id]))
      .rejects.toThrow();
    await expect(pool.query(`UPDATE payments SET kind = 'refund' WHERE id = $1`, [payment!.id]))
      .rejects.toThrow();
    await expect(pool.query(`UPDATE payments SET receipt_number = 'R-00000' WHERE id = $1`, [payment!.id]))
      .rejects.toThrow();

    // القيمة لم تتغير فعليًّا
    const { rows: [row] } = await pool.query(`SELECT amount_minor, kind FROM payments WHERE id = $1`, [payment!.id]);
    expect(Number(row.amount_minor)).toBe(5000);
    expect(row.kind).toBe("payment");
  });

  it("UPDATE لعمود غير محاسبي (note) في payments ⇒ مسموح (metadata)", async () => {
    const pool = getPool();
    const { rows: [row] } = await pool.query(`SELECT id FROM payments ORDER BY id DESC LIMIT 1`);
    await pool.query(`UPDATE payments SET note = 'ملاحظة تصحيحية إدارية' WHERE id = $1`, [row.id]);
    const { rows: [after] } = await pool.query(`SELECT note, amount_minor FROM payments WHERE id = $1`, [row.id]);
    expect(after.note).toBe("ملاحظة تصحيحية إدارية");
  });

  it("UPDATE لأعمدة expenses المحاسبية ⇒ مرفوض", async () => {
    const pool = getPool();
    const { expense } = await recordExpense({
      category: "supplies" as never, partyId: null, payeeText: "مورد",
      amountMinor: 3000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      payableId: null, note: null, createdBy: "test",
    });
    expect(expense).not.toBeNull();
    await expect(pool.query(`UPDATE expenses SET amount_minor = 0 WHERE id = $1`, [expense!.id]))
      .rejects.toThrow(/append-only/);
    await expect(pool.query(`UPDATE expenses SET category = 'rent' WHERE id = $1`, [expense!.id]))
      .rejects.toThrow();
  });

  it("UPDATE لpayable_id في expenses ⇒ مسموح (رابط سير عمل قائم — موثَّق)", async () => {
    const pool = getPool();
    const { rows: [row] } = await pool.query(`SELECT id, payable_id FROM expenses ORDER BY id DESC LIMIT 1`);
    // المسار القائم: تنظيف رابط التزام المختبر عند الإلغاء (db.ts:3458/4953)
    await pool.query(`UPDATE expenses SET payable_id = NULL WHERE id = $1`, [row.id]);
    const { rows: [after] } = await pool.query(`SELECT payable_id FROM expenses WHERE id = $1`, [row.id]);
    expect(after.payable_id).toBeNull();
  });

  it("UPDATE لحركة مخزون تاريخية ⇒ مرفوض (WAC يُشتق من الحركات كاملة)", async () => {
    const pool = getPool();
    const { rows: [item] } = await pool.query(
      `INSERT INTO inventory_items (name, unit, is_active, created_by)
       VALUES ('قفازات AO', 'صندوق', TRUE, 'test') RETURNING id`,
    );
    const move = await createInventoryMovement({
      itemId: item.id, kind: "in", qty: 10, unitCostMinor: 1500, createdBy: "test",
    });
    expect(move.ok).toBe(true);

    await expect(pool.query(`UPDATE inventory_movements SET qty = 999 WHERE id = $1`, [move.ok ? move.movement.id : 0]))
      .rejects.toThrow(/متوسط التكلفة|غير قابلة للتعديل/);
    await expect(pool.query(`UPDATE inventory_movements SET unit_cost_minor = 1 WHERE id = $1`, [move.ok ? move.movement.id : 0]))
      .rejects.toThrow();
    await expect(pool.query(`UPDATE inventory_movements SET kind = 'out' WHERE id = $1`, [move.ok ? move.movement.id : 0]))
      .rejects.toThrow();
  });

  it("الردّ الصريح (refund) هو مسار التصحيح — يعمل ويُحمى من الازدواج", async () => {
    const pool = getPool();
    const { rows: [patient] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('AO-P2', 'مريض التصحيح') RETURNING id`,
    );
    const { payment } = await recordPayment({
      patientId: patient.id, invoiceId: null, kind: "payment", amountMinor: 7000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test",
    });
    const refund = await recordPayment({
      patientId: patient.id, invoiceId: null, kind: "refund", amountMinor: 7000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: "تصحيح: إلغاء القبض الخطأ", createdBy: "test", reversalOfId: payment!.id,
    });
    expect(refund.payment).not.toBeNull();

    // ردٌّ ثانٍ لنفس السند ⇒ duplicate_reversal (القيد الفريد هو الحارس)
    const second = await recordPayment({
      patientId: patient.id, invoiceId: null, kind: "refund", amountMinor: 7000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", reversalOfId: payment!.id,
    });
    expect(second.reason).toBe("duplicate_reversal");
    expect(second.payment).toBeNull();

    // ردٌّ لسند مريض آخر ⇒ invalid_invoice
    const { rows: [other] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('AO-P3', 'مريض آخر') RETURNING id`,
    );
    const crossRefund = await recordPayment({
      patientId: other.id, invoiceId: null, kind: "refund", amountMinor: 100,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", reversalOfId: payment!.id,
    });
    expect(crossRefund.reason).toBe("invalid_invoice");
  });
});
