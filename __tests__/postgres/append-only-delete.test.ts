import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * اختبارات حرّاس DELETE على مستوى القاعدة (P1-FIX-3) — PostgreSQL حقيقي.
 *
 * المطلوب من المراجعة المستقلة:
 *  * SQL DELETE لدفعة ⇒ DENY.  * SQL DELETE لمصروف ⇒ DENY.
 *  * SQL DELETE لحركة مخزون ⇒ DENY.
 *  * حذف مريض له تاريخ مالي ⇒ التاريخ لا يُمحّ بصمت (رفض صريح + trigger كشبكة أمان).
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment,
  recordExpense, deletePatientCascade, createInventoryMovement,
} = await import("../../lib/db");

let patientId: number;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "pg-delete-guard", opening: { YER: 0, SAR: 0, USD: 0 } });
  const { rows: [patient] } = await getPool().query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('PGDG-P1', 'مريض الحرّاس') RETURNING id`,
  );
  patientId = patient.id;
}, 180_000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("حرّاس DELETE على PostgreSQL حقيقي (P1-FIX-3)", () => {
  it("SQL DELETE لسند دفعة (اتصال خام بمعاملة) ⇒ مرفوض من القاعدة نفسها", async () => {
    const { payment } = await recordPayment({
      patientId, invoiceId: null, kind: "payment", amountMinor: 9000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "pg-test",
    });
    expect(payment).not.toBeNull();
    const pool = getPool();
    await expect(
      pool.query(`DELETE FROM payments WHERE id = $1`, [payment!.id]),
    ).rejects.toThrow(/الحذف بDELETE ممنوع|append-only/);
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE id = $1`, [payment!.id],
    );
    expect(row.n).toBe(1);
  });

  it("SQL DELETE لسند صرف ⇒ مرفوض", async () => {
    const { expense } = await recordExpense({
      category: "misc" as never, partyId: null, payeeText: "مورد",
      amountMinor: 1500, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      payableId: null, note: null, createdBy: "pg-test",
    });
    expect(expense).not.toBeNull();
    await expect(
      getPool().query(`DELETE FROM expenses WHERE id = $1`, [expense!.id]),
    ).rejects.toThrow(/الحذف بDELETE ممنوع/);
  });

  it("SQL DELETE لحركة مخزون ⇒ مرفوض", async () => {
    const pool = getPool();
    const { rows: [item] } = await pool.query(
      `INSERT INTO inventory_items (name, unit, is_active, created_by)
       VALUES ('قفازات PG', 'صندوق', TRUE, 'pg-test') RETURNING id`,
    );
    const move = await createInventoryMovement({
      itemId: item.id, kind: "in", qty: 4, createdBy: "pg-test",
    });
    expect(move.ok).toBe(true);
    await expect(
      pool.query(`DELETE FROM inventory_movements WHERE id = $1`, [move.ok ? move.movement.id : 0]),
    ).rejects.toThrow(/الحذف بDELETE ممنوع/);
  });

  it("حذف مريض له تاريخ مالي ⇒ رفض صريح has_financial_history والدفعات باقية", async () => {
    const pool = getPool();
    const { rows: [patient] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('PGDG-P2', 'مريض له تاريخ') RETURNING id`,
    );
    await recordPayment({
      patientId: patient.id, invoiceId: null, kind: "payment", amountMinor: 12000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "pg-test",
    });

    const result = await deletePatientCascade(patient.id, { actor: "pg-admin" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("has_financial_history");

    const { rows: [payments] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE patient_id = $1`, [patient.id],
    );
    expect(payments.n).toBe(1); // التاريخ لم يُمح
    const { rows: [still] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patients WHERE id = $1`, [patient.id],
    );
    expect(still.n).toBe(1); // والملف نفسه لم يُحذف
  });

  it("حذف مريض عبر SQL مباشر (DELETE FROM patients): تتالي payments مستحيل بنيويًّا", async () => {
    // patient_id على payments بقيود RESTRICT من الأساس، وحارس DELETE هو شبكة
    // الأمان — المحاولة المباشرة من psql نفسه تُرفض.
    const pool = getPool();
    await expect(
      pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]),
    ).rejects.toThrow(); // RESTRICT أو حارس DELETE — كلاهما رفض
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patients WHERE id = $1`, [patientId],
    );
    expect(row.n).toBe(1);
  });

  it("حذف مريض نظيف (بلا تاريخ مالي/مخزوني) ⇒ يعمل كما كان", async () => {
    const pool = getPool();
    const { rows: [patient] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('PGDG-P3', 'مريض نظيف') RETURNING id`,
    );
    const result = await deletePatientCascade(patient.id, { actor: "pg-admin" });
    expect(result.ok).toBe(true);
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM patients WHERE id = $1`, [patient.id],
    );
    expect(row.n).toBe(0);
  });
});
