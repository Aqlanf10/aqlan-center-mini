import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات idempotency الدفعات (P1.5) — مستوى المكتبة (متسلسل).
 * التزامن الحقيقي (اتصالان متزامنان) يُثبت في __tests__/postgres/ — هنا نثبت
 * الدلالات: نفس المفتاح ⇒ نفس السند، مفاتيح مختلفة ⇒ سندان، الردّ الواحد،
 * ومفتاح غير صالح ⇒ رفض صريح.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const { getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment } = await import("../lib/db");

let patientId: number;

beforeAll(async () => {
  await ensureSchema();
  await openShift({ openedBy: "idem-test", opening: { YER: 0, SAR: 0, USD: 0 } });
  const { rows: [patient] } = await getPool().query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('IDEM-P1', 'مريض الإعادة') RETURNING id`,
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

describe("idempotency الدفعات", () => {
  it("نفس المفتاح مرتين ⇒ السند نفسه يعاد كreplay، لا سند ثانٍ", async () => {
    const key = "idem-alpha-0001";
    const first = await recordPayment(payment(10000, { idempotencyKey: key }));
    expect(first.payment).not.toBeNull();
    expect(first.replayed).toBeFalsy();

    const second = await recordPayment(payment(10000, { idempotencyKey: key }));
    expect(second.payment).not.toBeNull();
    expect(second.replayed).toBe(true);
    expect(second.payment!.id).toBe(first.payment!.id);
    expect(second.payment!.receiptNumber).toBe(first.payment!.receiptNumber);

    const pool = getPool();
    const { rows: [count] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE idempotency_key = $1`, [key],
    );
    expect(count.n).toBe(1);
  });

  it("بلا مفتاح (الوضع القائم) ⇒ سندان مستقلان — توافق رجعي كامل", async () => {
    const first = await recordPayment(payment(1000));
    const second = await recordPayment(payment(1000));
    expect(first.payment!.id).not.toBe(second.payment!.id);
  });

  it("مفاتيح مختلفة لنفس العملية ⇒ سندان (المفتاح يحدد العملية لا المريض)", async () => {
    const a = await recordPayment(payment(500, { idempotencyKey: "idem-beta-0002" }));
    const b = await recordPayment(payment(500, { idempotencyKey: "idem-gamma-0003" }));
    expect(a.payment!.id).not.toBe(b.payment!.id);
  });

  it("نفس المفتاح بمحتوى مختلف ⇒ تعارض idempotency_conflict لا replay لعملية مختلفة (P1-FIX-4)", async () => {
    const key = "idem-delta-0004";
    const first = await recordPayment(payment(2000, { idempotencyKey: key }));
    // «إعادة إرسال» بمبلغ مغاير: المفتاح مرتبط ببصمة الطلب الكانونية —
    // عملية مختلفة ⇒ 409 تعارض، ولا يُعاد سند العملية الأولى كأنه طلبها.
    const conflict = await recordPayment(payment(9999, { idempotencyKey: key }));
    expect(conflict.payment).toBeNull();
    expect(conflict.replayed).toBeFalsy();
    expect(conflict.reason).toBe("idempotency_conflict");
    const pool = getPool();
    const { rows: [row] } = await pool.query(
      `SELECT amount_minor FROM payments WHERE idempotency_key = $1`, [key],
    );
    expect(Number(row.amount_minor)).toBe(2000); // السجل الأول لم يُمسّ
  });

  it("نفس المفتاح بممثّل مختلف ⇒ تعارض (المفتاح مرتبط بالممثّل — actor-scoped)", async () => {
    const key = "idem-actor-0006";
    const first = await recordPayment(payment(1500, { idempotencyKey: key, createdBy: "cashier-a" }));
    expect(first.payment).not.toBeNull();
    const other = await recordPayment(payment(1500, { idempotencyKey: key, createdBy: "cashier-b" }));
    expect(other.payment).toBeNull();
    expect(other.reason).toBe("idempotency_conflict");
  });

  it("نفس المفتاح بمريض مختلف أو عملة مختلفة ⇒ تعارض (بصمة الطلب كاملة)", async () => {
    const key = "idem-scope-0007";
    await recordPayment(payment(1200, { idempotencyKey: key }));
    const otherPatient = await recordPayment(payment(1200, { idempotencyKey: key, patientId: patientId + 1 }));
    expect(otherPatient.reason).toBe("idempotency_conflict");
    const otherCurrency = await recordPayment(payment(1200, { idempotencyKey: key, currency: "SAR", exchangeRate: 660 }));
    expect(otherCurrency.reason).toBe("idempotency_conflict");
  });

  it("مفتاح غير صالح ⇒ رفض صريح قبل لمس القاعدة (fail closed)", async () => {
    await expect(recordPayment(payment(100, { idempotencyKey: "قصير" }))).rejects.toThrow(/Idempotency-Key/);
    await expect(recordPayment(payment(100, { idempotencyKey: "x".repeat(200) }))).rejects.toThrow();
    await expect(recordPayment(payment(100, { idempotencyKey: "bad key with spaces" }))).rejects.toThrow();
  });

  it("فشل لا وردية ⇒ لا استهلاك للمفتاح (المفتاح يُستهلك عند النجاح فقط)", async () => {
    const pool = getPool();
    // أغلق الوردية المفتوحة مؤقتًا بمحاكاة: نستخدم مريضًا مستحيل الملكية لا —
    // الطريق الأنظف: فحص مباشر أن no_shift لا يترك مفتاحًا معلّقًا.
    // (إغلاق الوردية يفتّت fixtures الاختبارات الأخرى؛ نستخدم مريضًا جديدًا مع
    // invoice لشخص آخر → invalid_invoice: يثبت نفس المبدأ بلا وردية.)
    const key = "idem-epsilon-0005";
    const { rows: [stranger] } = await pool.query(
      `INSERT INTO patients (patient_number, full_name) VALUES ('IDEM-P2', 'غريب') RETURNING id`,
    );
    const { rows: [invoice] } = await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
       VALUES ('IDEM-INV-1', $1, 100, 0, 'YER') RETURNING id`, [stranger.id],
    );
    const failed = await recordPayment(
      payment(100, { invoiceId: invoice.id, idempotencyKey: key }),
    );
    expect(failed.reason).toBe("invalid_invoice");
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE idempotency_key = $1`, [key],
    );
    expect(row.n).toBe(0);
    // وبعد زوال السبب: المفتاح يعمل لأول مرة فعلًا
    const ok = await recordPayment(payment(100, { idempotencyKey: key }));
    expect(ok.payment).not.toBeNull();
    expect(ok.replayed).toBeFalsy();
  });
});
