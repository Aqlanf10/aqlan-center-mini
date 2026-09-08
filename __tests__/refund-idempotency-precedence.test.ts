import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات أسبقية idempotency على رفض المتبقي (P1-FINAL-2).
 *
 * الخلل الذي كان: ردٌّ ناجح ← إعادة المحاولة بالمفتاح نفسه ← الكود يفحص
 * «المبلغ المُردّ سابقًا / المتبقي» أولًا ← يُردّ بreversal_exceeds_remaining
 * ← فحص الإعادة لا يُبلغ أبدًا — idempotency مكسور للردود الكاملة وفوق النصف.
 *
 * الترتيب الصحيح داخل المعاملة (المطبَّق الآن):
 *  قفل الأصل → سياق العملة/السعر → البصمة الكانونية → فحص المفتاح فورًا
 *  (replay / idempotency_conflict) → فقط لمفتاح جديد: المتبقي والإدراج.
 *
 * A) 10000 ⇒ ردّ 10000 بمفتاح K ⇒ إعادة K نفسه بـ10000 ⇒ replay لنفس السند
 *    NOT reversal_exceeds_remaining.
 * B) 10000 ⇒ ردّ 7000 بمفتاح K ⇒ إعادة K بـ7000 ⇒ replay لنفس السند.
 * C) بعد ردّ 7000 بـK: إعادة K بمبلغ 9000 ⇒ idempotency_conflict
 *    وليس reversal_exceeds_remaining.
 * (النسخة PostgreSQL الحقيقية لهذه + تزامن مفتاحين جديدين في
 *  __tests__/postgres/payment-concurrency.test.ts)
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const { getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment } = await import("../lib/db");

let patientId: number;

beforeAll(async () => {
  await ensureSchema();
  await openShift({ openedBy: "refund-precedence", opening: { YER: 0, SAR: 0, USD: 0 } });
  const { rows: [patient] } = await getPool().query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('RP-P1', 'مريض أسبقية الإعادة') RETURNING id`,
  );
  patientId = patient.id;
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

function refund(amountMinor: number, reversalOfId: number, idempotencyKey: string) {
  return recordPayment({
    patientId, invoiceId: null, kind: "refund" as const, amountMinor,
    currency: "YER" as const, baseCurrency: "YER" as const, exchangeRate: 1,
    method: "cash", note: null, createdBy: "test",
    reversalOfId, idempotencyKey,
  });
}

describe("أسبقية فحص الإعادة على رفض المتبقي (P1-FINAL-2)", () => {
  it("A) ردّ كامل 10000 بمفتاح K ثم إعادة K نفسه ⇒ replay لنفس السند لا رفض المتبقي", async () => {
    const origin = await recordPayment({
      patientId, invoiceId: null, kind: "payment", amountMinor: 10000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", idempotencyKey: "rp-origin-a-0001",
    });
    expect(origin.payment).not.toBeNull();

    const key = "rp-full-0002";
    const refundRow = await refund(10000, origin.payment!.id, key);
    expect(refundRow.payment).not.toBeNull();
    expect(refundRow.reason).toBeNull();

    // الإعادة بالمفتاح نفسه والمبلغ نفسه — الخلل القديم كان يردّ هنا
    // بreversal_exceeds_remaining قبل بلوغ فحص الإعادة
    const retry = await refund(10000, origin.payment!.id, key);
    expect(retry.reason).not.toBe("reversal_exceeds_remaining");
    expect(retry.replayed).toBe(true);
    expect(retry.payment).not.toBeNull();
    expect(retry.payment!.id).toBe(refundRow.payment!.id);

    // السند واحد في القاعدة لا ردّان
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE reversal_of_id = $1 AND kind = 'refund'`,
      [origin.payment!.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("B) ردّ جزئي 7000 من 10000 بمفتاح K ثم إعادة K بـ7000 ⇒ replay لنفس السند", async () => {
    const origin = await recordPayment({
      patientId, invoiceId: null, kind: "payment", amountMinor: 10000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", idempotencyKey: "rp-origin-b-0003",
    });
    expect(origin.payment).not.toBeNull();

    const key = "rp-partial-0004";
    const refundRow = await refund(7000, origin.payment!.id, key);
    expect(refundRow.payment).not.toBeNull();

    // 7000 > المتبقي 3000: الخلل القديم كان يردّ بreversal_exceeds_remaining
    const retry = await refund(7000, origin.payment!.id, key);
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
    const origin = await recordPayment({
      patientId, invoiceId: null, kind: "payment", amountMinor: 10000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", idempotencyKey: "rp-origin-c-0005",
    });
    expect(origin.payment).not.toBeNull();

    const key = "rp-conflict-0006";
    const refundRow = await refund(7000, origin.payment!.id, key);
    expect(refundRow.payment).not.toBeNull();

    // مبلغ مختلف بالمفتاح نفسه = عملية مختلفة = تعارض، ويُبلَّغ قبل أي حساب متبقي
    const conflict = await refund(9000, origin.payment!.id, key);
    expect(conflict.reason).toBe("idempotency_conflict");
    expect(conflict.reason).not.toBe("reversal_exceeds_remaining");
    expect(conflict.payment).toBeNull();

    // ولا أثر للعملية المرفوضة: مجموع الردود ما زال 7000
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount_minor), 0)::int AS total FROM payments
        WHERE reversal_of_id = $1 AND kind = 'refund'`,
      [origin.payment!.id],
    );
    expect(Number(rows[0].total)).toBe(7000);
  });

  it("مفتاح جديد بمبلغ يتجاوز المتبقي ⇒ reversal_exceeds_remaining كما كان (الحارس سليم)", async () => {
    const origin = await recordPayment({
      patientId, invoiceId: null, kind: "payment", amountMinor: 10000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", idempotencyKey: "rp-origin-d-0007",
    });
    const first = await refund(6000, origin.payment!.id, "rp-new-d-0008");
    expect(first.payment).not.toBeNull();

    // مفتاح مختلف فعلًا: الوصول لحساب المتبقي سليم — 5000 > 4000 ⇒ رفض
    const overRefund = await refund(5000, origin.payment!.id, "rp-new-d-0009");
    expect(overRefund.payment).toBeNull();
    expect(overRefund.reason).toBe("reversal_exceeds_remaining");
  });
});
