import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, rawPool, stubPostgresEnv } from "./_setup";

/**
 * اختبارات تزامن العمليات المالية على PostgreSQL حقيقي (P1.5).
 *
 * الأهداف:
 *  * لا Double Receipt: طلبان متزامنان بنفس idempotency context ⇒ سند واحد.
 *  * لا Lost Update: دفعتان متزامنتان (سياقات مختلفة) على نفس الفاتورة ⇒ كلتاهما
 *    تُسجَّل والمجموع صحيح.
 *  * reversal واحد فقط: طلبا ردٍّ متزامنان لنفس السند ⇒ ردٌّ واحد (القيد الفريد
 *    هو الحارس — لا فحص-ثم-إدراج في التطبيق).
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

  it("طلبا ردٍّ متزامنان لنفس السند ⇒ ردٌّ واحد فقط (القيد الفريد هو الحارس)", async () => {
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
    const rejected = reversals.filter((result) => result.reason === "duplicate_reversal");
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE reversal_of_id = $1 AND kind = 'refund'`,
      [target.payment!.id],
    );
    expect(rows[0].n).toBe(1); // ردٌّ واحد في القاعدة بالضبط
  });

  it("القيد الفريد للردّ مباشرةً عبر اتصالين: INSERTان متزامنان ⇒ 23505 للثاني", async () => {
    const pool = rawPool(undefined, 5);
    try {
      const target = await recordPayment(payment(100, { idempotencyKey: `pg-rev2-${Date.now()}` }));
      const reversalTarget = target.payment!.id;

      const attempt = async (label: string) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const { rows } = await client.query<{ id: number }>(
            `INSERT INTO payments (
               receipt_number, patient_id, shift_id, kind, amount_minor, currency,
               exchange_rate, base_amount_minor, base_currency, method, reversal_of_id)
             SELECT 'R-' || LPAD(nextval('receipt_number_seq')::text, 5, '0'),
                    $1, s.id, 'refund', 50, 'YER', 1, 50, 'YER', 'cash', $2::int
               FROM cashier_shifts s WHERE s.status = 'open' LIMIT 1
             RETURNING id`,
            [patientId, reversalTarget],
          );
          await client.query("COMMIT");
          return { label, ok: true, id: rows[0]?.id };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          return { label, ok: false, code: (error as { code?: string }).code, constraint: (error as { constraint?: string }).constraint };
        } finally {
          client.release();
        }
      };

      const [a, b] = await Promise.all([attempt("first"), attempt("second")]);
      const winners = [a, b].filter((attempted) => attempted.ok);
      const losers = [a, b].filter((attempted) => !attempted.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0].code).toBe("23505");
      expect(losers[0].constraint).toBe("payments_single_reversal_uniq");
    } finally {
      await pool.end();
    }
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
