import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات semantics الردود (P1-FIX-4 + P1-FIX-5) — مستوى المكتبة على PGlite.
 * التزامن الحقيقي (ردّان متزامنان يتجاوزان المتبقي) يُثبت في
 * __tests__/postgres/ — هنا الدلالات نفسها.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const { getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment } = await import("../lib/db");

let patientId: number;

beforeAll(async () => {
  await ensureSchema();
  await openShift({ openedBy: "refund-test", opening: { YER: 0, SAR: 0, USD: 0 } });
  const { rows: [patient] } = await getPool().query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('RF-P1', 'مريض الردود') RETURNING id`,
  );
  patientId = patient.id;
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

function payment(amountMinor: number, overrides: Record<string, unknown> = {}) {
  return {
    patientId, invoiceId: null, kind: "payment" as const, amountMinor,
    currency: "YER" as const, baseCurrency: "YER" as const, exchangeRate: 1,
    method: "cash", note: null, createdBy: "test", ...overrides,
  };
}

describe("semantics الردود الجزئية (P1-FIX-5)", () => {
  it("١٠٠٠٠ ⇒ ردّ ٣٠٠٠ ثم ٧٠٠٠ مسموح، وأي ردّ بعدهما مرفوض (المجموع ≤ الأصل)", async () => {
    const original = await recordPayment(payment(10000, { idempotencyKey: "rf-origin-0001" }));
    expect(original.payment).not.toBeNull();

    const first = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 3000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: "رد جزئي أول", createdBy: "test", reversalOfId: original.payment!.id,
    });
    expect(first.payment).not.toBeNull();
    expect(first.payment!.kind).toBe("refund");

    const second = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 7000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: "رد جزئي ثانٍ", createdBy: "test", reversalOfId: original.payment!.id,
    });
    expect(second.payment).not.toBeNull();

    const third = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 1,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", reversalOfId: original.payment!.id,
    });
    expect(third.payment).toBeNull();
    expect(third.reason).toBe("reversal_exceeds_remaining");

    // عدة ردود جزئية لنفس الأصل موجودة فعلًا (لا قيد «ردّ واحد»)
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount_minor), 0)::int AS total, COUNT(*)::int AS n
         FROM payments WHERE reversal_of_id = $1 AND kind = 'refund'`,
      [original.payment!.id],
    );
    expect(rows[0].n).toBe(2);
    expect(Number(rows[0].total)).toBe(10000);
  });

  it("ردّ بلا أصل ⇒ refund_requires_origin (لا ردّ «حُرّ»)", async () => {
    const noOrigin = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 100,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test",
    });
    expect(noOrigin.payment).toBeNull();
    expect(noOrigin.reason).toBe("refund_requires_origin");
  });

  it("ردّ بعملة مختلفة عن الأصل ⇒ reversal_currency_mismatch", async () => {
    const original = await recordPayment(payment(2000, { currency: "SAR", exchangeRate: 660, idempotencyKey: "rf-xcur-0002" }));
    expect(original.payment).not.toBeNull();
    const cross = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 500,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", reversalOfId: original.payment!.id,
    });
    expect(cross.payment).toBeNull();
    expect(cross.reason).toBe("reversal_currency_mismatch");
  });

  it("الردّ لسند مريض آخر ⇒ invalid_reversal، وردّ سند ليس دفعة ⇒ invalid_reversal", async () => {
    const { rows: [stranger] } = await getPool().query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('RF-P2', 'غريب') RETURNING id`,
    );
    const mine = await recordPayment(payment(1500, { idempotencyKey: "rf-mine-0003" }));
    const crossPatient = await recordPayment({
      patientId: stranger.id, invoiceId: null, kind: "refund", amountMinor: 100,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", reversalOfId: mine.payment!.id,
    });
    expect(crossPatient.reason).toBe("invalid_reversal");

    // ردّ ردٍّ: الأصل يجب أن يكون دفعة لا ردًّا
    const refund = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 500,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", reversalOfId: mine.payment!.id,
    });
    expect(refund.payment).not.toBeNull();
    const refundOfRefund = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 100,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", reversalOfId: refund.payment!.id,
    });
    expect(refundOfRefund.reason).toBe("invalid_reversal");
  });

  it("الردّ يرث سعر صرف الأصل snapshot — تغيّر السعر الحيّ لا يغيّر سياق الردّ", async () => {
    // دفعة SAR بسعر ٦٦٠ (أساس YER: ٢٠ ريال سعوديًّا × ٦٦٠ = ١٣٢٠٠ ريال يمنيًّا)
    const original = await recordPayment(payment(2000, { currency: "SAR", exchangeRate: 660, idempotencyKey: "rf-fx-0004" }));
    expect(original.payment!.baseAmountMinor).toBe(20 * 660);
    // ردّ بعد «تغيّر السعر إلى ٧٠٠» — الطلب يمرر 700 لكن الردّ يُخزَّن بسياق الأصل 660
    const refund = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 700,
      currency: "SAR", baseCurrency: "YER", exchangeRate: 700, method: "cash",
      note: null, createdBy: "test", reversalOfId: original.payment!.id,
    });
    expect(refund.payment).not.toBeNull();
    expect(refund.payment!.exchangeRate).toBe(660);
    expect(refund.payment!.baseAmountMinor).toBe(7 * 660);
  });

  it("replay للردّ: نفس المفتاح بنفس البصمة ⇒ السند نفسه؛ ببصمة مختلفة ⇒ تعارض", async () => {
    const original = await recordPayment(payment(5000, { idempotencyKey: "rf-rep-0005" }));
    const key = "rf-replay-0006";
    const refund = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 2500,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", reversalOfId: original.payment!.id,
      idempotencyKey: key,
    });
    expect(refund.payment).not.toBeNull();
    const replayed = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 2500,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", reversalOfId: original.payment!.id,
      idempotencyKey: key,
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.payment!.id).toBe(refund.payment!.id);

    // نفس المفتاح بمبلغ مختلف ⇒ تعارض لا replay لعملية مختلفة
    const conflict = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 1000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", reversalOfId: original.payment!.id,
      idempotencyKey: key,
    });
    expect(conflict.reason).toBe("idempotency_conflict");
  });

  it("دفعة ثم ردّ بنفس المفتاح ⇒ تعارض (النوع جزء من البصمة)", async () => {
    const key = "rf-kind-0007";
    const paid = await recordPayment(payment(3300, { idempotencyKey: key }));
    expect(paid.payment).not.toBeNull();
    const asRefund = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 3300,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "test", reversalOfId: paid.payment!.id,
      idempotencyKey: key,
    });
    expect(asRefund.reason).toBe("idempotency_conflict");
  });

  it("مبلغ غير موجب ⇒ رفض صريح قبل لمس القاعدة", async () => {
    await expect(recordPayment(payment(0))).rejects.toThrow(/أكبر من صفر/);
    await expect(recordPayment(payment(-100))).rejects.toThrow(/أكبر من صفر/);
  });
});
