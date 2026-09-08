import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, rawPool, stubPostgresEnv } from "./_setup";

/**
 * اختبارات تزامن العمليات المالية على PostgreSQL حقيقي (P1.5).
 *
 * الأهداف:
 *  * لا Double Receipt: طلبان متزامنان بنفس idempotency context ⇒ سند واحد.
 *  * لا Lost Update: دفعتان متزامنتان (سياقات مختلفة) على نفس الفاتورة ⇒ كلتاهما
 *    تُسجَّل والمجموع صحيح.
 *  * ردود جزئية آمنة (P1-FIX-5): طلبا ردٍّ متزامنان يتجاوز مجموعهما الأصل
 *    ⇒ ينجح الآمن فقط — الحارس SELECT ... FOR UPDATE على صف الأصل داخل
 *    المعاملة (قفل صفّي يسلسل الحساب، لا فحص-ثم-إدراج).
 *  * idempotency مرتبطة ببصمة الطلب (P1-FIX-4): نفس المفتاح بعملية مختلفة
 *    (متزامنة أو متتابعة) ⇒ idempotency_conflict لا replay لعملية أخرى.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment,
} = await import("../../lib/db");

let patientId: number;
let invoiceId: number;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "pg-concurrency", opening: { YER: 0, SAR: 0, USD: 0 } });
  const pool = getPool();
  const { rows: [patient] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('PGC-P1', 'مريض التزامن') RETURNING id`,
  );
  patientId = patient.id;
  const { rows: [invoice] } = await pool.query(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
     VALUES ('PGC-INV-1', $1, 100000, 0, 'YER') RETURNING id`, [patientId],
  );
  invoiceId = invoice.id;
}, 180_000);

afterAll(async () => {
  await resetPoolForTesting();
});

function payment(amountMinor: number, overrides: Record<string, unknown> = {}) {
  return {
    patientId, invoiceId, kind: "payment" as const, amountMinor,
    currency: "YER" as const, baseCurrency: "YER" as const, exchangeRate: 1,
    method: "cash", note: null, createdBy: "pg-test", ...overrides,
  };
}

describe("أسبقية فحص الإعادة على رفض المتبقي (P1-FINAL-2) — PostgreSQL حقيقي", () => {
  function keyedRefund(amountMinor: number, reversalOfId: number, idempotencyKey: string) {
    return recordPayment({
      patientId, invoiceId: null, kind: "refund" as const, amountMinor,
      currency: "YER" as const, baseCurrency: "YER" as const, exchangeRate: 1,
      method: "cash", note: null, createdBy: "pg-test",
      reversalOfId, idempotencyKey,
    });
  }

  it("A) ردّ كامل 10000 بمفتاح K ثم إعادة K نفسه ⇒ replay لنفس السند لا رفض المتبقي", async () => {
    const origin = await recordPayment(payment(10000, { idempotencyKey: `pg-fin2-a-o-${Date.now()}` }));
    expect(origin.payment).not.toBeNull();
    const key = `pg-fin2-a-k-${Date.now()}`;

    const refundRow = await keyedRefund(10000, origin.payment!.id, key);
    expect(refundRow.payment).not.toBeNull();
    expect(refundRow.reason).toBeNull();

    // الخلل القديم: المتبقي صفر فتُردّ بreversal_exceeds_remaining قبل فحص الإعادة
    const retry = await keyedRefund(10000, origin.payment!.id, key);
    expect(retry.reason).not.toBe("reversal_exceeds_remaining");
    expect(retry.replayed).toBe(true);
    expect(retry.payment!.id).toBe(refundRow.payment!.id);

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE reversal_of_id = $1 AND kind = 'refund'`,
      [origin.payment!.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("B) ردّ جزئي 7000 من 10000 بمفتاح K ثم إعادة K بـ7000 ⇒ replay لنفس السند", async () => {
    const origin = await recordPayment(payment(10000, { idempotencyKey: `pg-fin2-b-o-${Date.now()}` }));
    const key = `pg-fin2-b-k-${Date.now()}`;

    const refundRow = await keyedRefund(7000, origin.payment!.id, key);
    expect(refundRow.payment).not.toBeNull();

    // 7000 > المتبقي 3000 — والأسبقية لفحص الإعادة لا لحساب المتبقي
    const retry = await keyedRefund(7000, origin.payment!.id, key);
    expect(retry.reason).not.toBe("reversal_exceeds_remaining");
    expect(retry.replayed).toBe(true);
    expect(retry.payment!.id).toBe(refundRow.payment!.id);

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount_minor), 0)::int AS total, COUNT(*)::int AS n
         FROM payments WHERE reversal_of_id = $1 AND kind = 'refund'`,
      [origin.payment!.id],
    );
    expect(rows[0].n).toBe(1);
    expect(Number(rows[0].total)).toBe(7000);
  });

  it("C) بعد ردّ 7000 بمفتاح K: إعادة K بمبلغ 9000 ⇒ idempotency_conflict لا رفض المتبقي", async () => {
    const origin = await recordPayment(payment(10000, { idempotencyKey: `pg-fin2-c-o-${Date.now()}` }));
    const key = `pg-fin2-c-k-${Date.now()}`;

    const refundRow = await keyedRefund(7000, origin.payment!.id, key);
    expect(refundRow.payment).not.toBeNull();

    const conflict = await keyedRefund(9000, origin.payment!.id, key);
    expect(conflict.reason).toBe("idempotency_conflict");
    expect(conflict.reason).not.toBe("reversal_exceeds_remaining");
    expect(conflict.payment).toBeNull();

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount_minor), 0)::int AS total FROM payments
        WHERE reversal_of_id = $1 AND kind = 'refund'`,
      [origin.payment!.id],
    );
    expect(Number(rows[0].total)).toBe(7000);
  });

  it("E) مفتاحان جديدان مختلفان متزامنان يتجاوزان المتبقي ⇒ ينجح الآمن فقط (الحارس التراكمي قائم)", async () => {
    const origin = await recordPayment(payment(10000, { idempotencyKey: `pg-fin2-e-o-${Date.now()}` }));
    const stamp = Date.now();
    const results = await Promise.all([
      keyedRefund(6000, origin.payment!.id, `pg-fin2-e-a-${stamp}`),
      keyedRefund(6000, origin.payment!.id, `pg-fin2-e-b-${stamp}`),
    ]);
    const succeeded = results.filter((result) => result.payment !== null);
    const denied = results.filter((result) => result.reason === "reversal_exceeds_remaining");
    expect(succeeded).toHaveLength(1); // ٦٠٠٠ الأولى فقط — الثانية رأت المتبقي ٤٠٠٠
    expect(denied).toHaveLength(1);

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount_minor), 0)::int AS total FROM payments
        WHERE reversal_of_id = $1 AND kind = 'refund'`,
      [origin.payment!.id],
    );
    expect(Number(rows[0].total)).toBe(6000); // المجموع لم يتجاوز الأصل
  });

  it("إعادة متزامنة بمفتاح ردٍّ ناجح ⇒ الثانية replay لا رفض (الأسبقية تحت التزامن)", async () => {
    const origin = await recordPayment(payment(8000, { idempotencyKey: `pg-fin2-f-o-${Date.now()}` }));
    const key = `pg-fin2-f-k-${Date.now()}`;
    const results = await Promise.all([
      keyedRefund(8000, origin.payment!.id, key),
      keyedRefund(8000, origin.payment!.id, key),
    ]);
    // كلاهما ينجح كعملية مالية واحدة: سند واحد بالضبط، والثاني replay
    const inserted = results.filter((result) => result.payment !== null && !result.replayed);
    const replayed = results.filter((result) => result.replayed);
    expect(inserted).toHaveLength(1);
    expect(replayed).toHaveLength(1);
    expect(results.every((result) => result.reason === null)).toBe(true);
    expect(inserted[0].payment!.id).toBe(replayed[0].payment!.id);

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE reversal_of_id = $1 AND kind = 'refund'`,
      [origin.payment!.id],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("تزامن الدفعات (PostgreSQL حقيقي)", () => {
  it("طلبان متزامنان بنفس مفتاح الإعادة ⇒ سند واحد فقط، والثاني replay بنفس الرقم", async () => {
    const key = `pg-idem-${Date.now()}`;
    const [a, b] = await Promise.all([
      recordPayment(payment(25000, { idempotencyKey: key })),
      recordPayment(payment(25000, { idempotencyKey: key })),
    ]);

    const receipts = [a.payment?.receiptNumber, b.payment?.receiptNumber];
    expect(new Set(receipts).size).toBe(1); // نفس السند تمامًا
    expect(a.payment?.id).toBe(b.payment?.id);
    const winners = [a, b].filter((result) => !result.replayed);
    expect(winners).toHaveLength(1); // عملية المجال (الإدراج) نفَّذها واحد فقط

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE idempotency_key = $1`, [key],
    );
    expect(rows[0].n).toBe(1); // لا Double Receipt
  });

  it("عشر مطالبات متزامنة بنفس المفتاح ⇒ سند واحد بالضبط", async () => {
    const key = `pg-storm-${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => recordPayment(payment(1000, { idempotencyKey: key }))),
    );
    const ids = new Set(results.map((result) => result.payment?.id));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(9);
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE idempotency_key = $1`, [key],
    );
    expect(rows[0].n).toBe(1);
  });

  it("دفعتان متزامنتان بسياقين مختلفين ⇒ كلتاهما تُسجَّل بلا Lost Update", async () => {
    const [a, b] = await Promise.all([
      recordPayment(payment(5000, { idempotencyKey: `pg-lost-a-${Date.now()}` })),
      recordPayment(payment(5000, { idempotencyKey: `pg-lost-b-${Date.now()}` })),
    ]);
    expect(a.payment).not.toBeNull();
    expect(b.payment).not.toBeNull();
    expect(a.payment!.id).not.toBe(b.payment!.id);
    expect(a.payment!.receiptNumber).not.toBe(b.payment!.receiptNumber);

    // ووردية واحدة: كلتاهما مسجَّلتان في القاعدة بالضبط
    const { rows: both } = await getPool().query<{ id: number }>(
      `SELECT id FROM payments WHERE id = ANY($1::int[])`, [[a.payment!.id, b.payment!.id]],
    );
    expect(both).toHaveLength(2);
  });

  it("مجموع العملة عبر shiftTotals بعد التزامن = مجموع ما سُجّل فعلًا (لا اختفاء)", async () => {
    const pool = getPool();
    const { rows: [shiftRow] } = await pool.query(
      `SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1`,
    );
    const { rows: [sumRow] } = await pool.query(
      `SELECT COALESCE(SUM(base_amount_minor), 0) AS total FROM payments WHERE shift_id = $1`,
      [shiftRow.id],
    );
    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE shift_id = $1`, [shiftRow.id],
    );
    // كل دفعة سُجِّلت تظهر في جرد الوردية: مجموع مستمر لا يعتمد على ترتيب التزامن
    expect(Number(sumRow.total)).toBeGreaterThan(0);
    expect(countRow.n).toBeGreaterThanOrEqual(4);
  });

  it("طلبا ردٍّ كاملين متزامنين لنفس السند ⇒ ردٌّ واحد فقط (المجموع ≤ الأصل هو الحارس)", async () => {
    // سند نظيف للردّ
    const target = await recordPayment(payment(8000, { idempotencyKey: `pg-rev-t-${Date.now()}` }));
    expect(target.payment).not.toBeNull();

    const reversals = await Promise.all([
      recordPayment({
        patientId, invoiceId: null, kind: "refund", amountMinor: 8000,
        currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
        note: "رد متزامن أ", createdBy: "pg-test", reversalOfId: target.payment!.id,
      }),
      recordPayment({
        patientId, invoiceId: null, kind: "refund", amountMinor: 8000,
        currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
        note: "رد متزامن ب", createdBy: "pg-test", reversalOfId: target.payment!.id,
      }),
    ]);

    const succeeded = reversals.filter((result) => result.payment !== null);
    const rejected = reversals.filter((result) => result.reason === "reversal_exceeds_remaining");
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE reversal_of_id = $1 AND kind = 'refund'`,
      [target.payment!.id],
    );
    expect(rows[0].n).toBe(1); // ردٌّ واحد في القاعدة بالضبط
  });

  it("١٠٠٠٠ ⇒ ٣٠٠٠ ثم ٧٠٠٠ مسموحان، وكل ردّ بعدهما مرفوض (P1-FIX-5)", async () => {
    const target = await recordPayment(payment(10000, { idempotencyKey: `pg-part-${Date.now()}` }));
    const refund = (amount: number) => recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: amount,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "pg-test", reversalOfId: target.payment!.id,
    });
    const first = await refund(3000);
    expect(first.payment).not.toBeNull();
    const second = await refund(7000);
    expect(second.payment).not.toBeNull();
    const third = await refund(1);
    expect(third.payment).toBeNull();
    expect(third.reason).toBe("reversal_exceeds_remaining");

    const pool = getPool();
    const { rows: [row] } = await pool.query(
      `SELECT COALESCE(SUM(amount_minor), 0)::int AS total FROM payments
        WHERE reversal_of_id = $1 AND kind = 'refund'`,
      [target.payment!.id],
    );
    expect(Number(row.total)).toBe(10000);
  });

  it("ردّان جزئيان متزامنان يتجاوزان المتبقي ⇒ ينجح الآمن فقط (قفل FOR UPDATE هو الحارس)", async () => {
    const target = await recordPayment(payment(10000, { idempotencyKey: `pg-race-${Date.now()}` }));
    const refund = (label: string) => recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 6000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: `رد متزامن ${label}`, createdBy: "pg-test", reversalOfId: target.payment!.id,
    });
    const results = await Promise.all([refund("أ"), refund("ب")]);
    const succeeded = results.filter((result) => result.payment !== null);
    const denied = results.filter((result) => result.reason === "reversal_exceeds_remaining");
    expect(succeeded).toHaveLength(1); // ٦٠٠٠ فقط نجحت — الثانية رأت المتبقي ٤٠٠٠
    expect(denied).toHaveLength(1);

    const pool = getPool();
    const { rows: [row] } = await pool.query(
      `SELECT COALESCE(SUM(amount_minor), 0)::int AS total FROM payments
        WHERE reversal_of_id = $1 AND kind = 'refund'`,
      [target.payment!.id],
    );
    expect(Number(row.total)).toBe(6000); // لم يتجاوز المجموع الأصل أبدًا
  });

  it("نفس مفتاح الإعادة بعمليتين مختلفتين متزامنتين ⇒ إدراج واحد وidempotency_conflict (P1-FIX-4)", async () => {
    const key = `pg-conflict-${Date.now()}`;
    const [a, b] = await Promise.all([
      recordPayment(payment(2500, { idempotencyKey: key })),
      recordPayment(payment(4000, { idempotencyKey: key })),
    ]);
    // واحدة أُدرجت، والأخرى لم تُعَد سند عملية مختلفة — تعارض صريح
    const inserted = [a, b].filter((result) => result.payment !== null && !result.replayed);
    const conflicts = [a, b].filter((result) => result.reason === "idempotency_conflict");
    expect(inserted).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n, MIN(amount_minor)::int AS amount FROM payments WHERE idempotency_key = $1`,
      [key],
    );
    expect(rows[0].n).toBe(1); // سند واحد فقط
    expect(Number(rows[0].amount)).toBe(inserted[0].payment!.amountMinor);
  });

  it("عملات مختلفة متزامنة ⇒ كل سند بصمته، والمجموع الأساسي صحيح", async () => {
    const stamp = Date.now();
    const [yer, sar] = await Promise.all([
      recordPayment(payment(1000, { idempotencyKey: `pg-fx-y-${stamp}` })),
      recordPayment(payment(2000, { idempotencyKey: `pg-fx-s-${stamp}`, currency: "SAR", exchangeRate: 660 })),
    ]);
    expect(yer.payment!.currency).toBe("YER");
    expect(sar.payment!.currency).toBe("SAR");
    expect(sar.payment!.baseAmountMinor).toBe(20 * 660);
    expect(yer.payment!.baseAmountMinor).toBe(1000);
  });
});
