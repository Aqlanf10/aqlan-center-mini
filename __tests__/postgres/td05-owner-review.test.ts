import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * مراجعة المالك لـ TD-05 على PostgreSQL حقيقي (PR #44) — الثبات المالي:
 *
 *  * فاتورة USD → دفعة USD → ردّ بreversalOfId وحده ⇒ الردّ يرث فاتورتها،
 *    ودلو الدولار يتغيّر ودلو الأساس لا يمس.
 *  * المكافئ السعودي بالكامل.
 *  * ردود جزئية متعدّدة، وإعادة محاولة idempotent، وهدف متضارب مرفوض،
 *    وسعر صرف الأصل snapshot يرثه الردّ.
 *  * الدفعة المقدَّمة على خطة أجنبية تُخزَّن بخطتها وتسوّي دلو عملتها —
 *    من مصدر الأرصدة نفسه الذي تقرأ منه الشاشات.
 */

assertRealPostgresUrl();
stubPostgresEnv();

let patientId: number;

const {
  getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment,
  patientPlanCurrencies,
} = await import("../../lib/db");
const {
  patientBalancesByCurrency, toCurrencyPaymentLikes, CLINIC_BASE_CURRENCY,
} = await import("../../lib/money");

/** أرصدة المريض من المصدر الكانوني نفسه: patientLedger + خطط المريض. */
async function balancesOf(id: number) {
  const { patientLedger } = await import("../../lib/db");
  const [{ invoices, payments, opening }, planCurrencies] = await Promise.all([
    patientLedger(id),
    patientPlanCurrencies(id),
  ]);
  return patientBalancesByCurrency(
    invoices
      .filter((invoice) => invoice.status !== "cancelled")
      .map((invoice) => ({
        totalMinor: invoice.totalMinor, discountMinor: invoice.discountMinor,
        status: invoice.status, baseCurrency: invoice.baseCurrency,
      })),
    toCurrencyPaymentLikes(
      payments.map((payment) => ({
        amountMinor: payment.amountMinor, currency: payment.currency,
        exchangeRate: payment.exchangeRate, baseAmountMinor: payment.baseAmountMinor,
        kind: payment.kind, invoiceId: payment.invoiceId, planId: payment.planId,
      })),
      new Map(invoices.map((invoice) => [invoice.id, invoice.baseCurrency])),
      planCurrencies,
    ),
    opening?.amountMinor ?? 0,
  );
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "ownrev-pg", opening: { YER: 0, SAR: 0, USD: 0 } });
  const { rows: [patient] } = await getPool().query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('OWNREV-PG-1', 'مريض المراجعة الحقيقي') RETURNING id`,
  );
  patientId = patient.id;
}, 180_000);

afterAll(async () => {
  await resetPoolForTesting();
});

async function invoiceOf(currency: "USD" | "SAR" | "YER", totalMinor: number, label: string) {
  const { rows: [invoice] } = await getPool().query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
     VALUES ($1, $2, $3, 0, $4) RETURNING id`,
    [label, patientId, totalMinor, currency],
  );
  return invoice.id;
}

describe("مراجعة المالك على PostgreSQL: الردّ يرث هدف الأصل", () => {
  it("فاتورة USD → دفعة USD → ردّ بreversalOfId بلا invoiceId ⇒ يرث فاتورتها ودلو الأساس لا يمس", async () => {
    const invoiceId = await invoiceOf("USD", 300000, "OWNREV-PG-USD-1");
    const paid = await recordPayment({
      patientId, invoiceId, kind: "payment", amountMinor: 120000,
      currency: "USD", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 530,
      method: "cash", note: null, createdBy: "ownrev-pg",
    });
    expect(pedNull(paid.reason)).toBeNull();

    const before = await balancesOf(patientId);
    expect(before.USD.dueMinor).toBe(300000 - 120000);
    expect(before.YER.dueMinor).toBe(0);

    const refunded = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 40000,
      currency: "USD", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 999, /* سعر اليوم مختلف */
      method: "cash", note: null, createdBy: "ownrev-pg", reversalOfId: paid.payment!.id,
    });
    expect(pedNull(refunded.reason)).toBeNull();
    expect(refunded.payment!.invoiceId).toBe(invoiceId);
    /* سعر الأصل 530 هو الموروث — لا سعر اليوم 999. */
    expect(refunded.payment!.exchangeRate).toBe(530);
    expect(refunded.payment!.baseAmountMinor).toBe(400 * 530);

    const after = await balancesOf(patientId);
    expect(after.USD.dueMinor).toBe(300000 - 120000 + 40000);
    expect(after.USD.collectedMinor).toBe(120000 - 40000);
    expect(after.YER.dueMinor).toBe(0);
    expect(after.YER.collectedMinor).toBe(0);
  });

  it("المكافئ السعودي: ردّ بلا invoiceId يرث فاتورة SAR ويبقي دلو الأساس صفرًا", async () => {
    const invoiceId = await invoiceOf("SAR", 200000, "OWNREV-PG-SAR-1");
    const paid = await recordPayment({
      patientId, invoiceId, kind: "payment", amountMinor: 90000,
      currency: "SAR", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 140,
      method: "cash", note: null, createdBy: "ownrev-pg",
    });
    expect(pedNull(paid.reason)).toBeNull();

    const refunded = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 30000,
      currency: "SAR", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 140,
      method: "cash", note: null, createdBy: "ownrev-pg", reversalOfId: paid.payment!.id,
    });
    expect(pedNull(refunded.reason)).toBeNull();
    expect(refunded.payment!.invoiceId).toBe(invoiceId);

    const after = await balancesOf(patientId);
    expect(after.SAR.collectedMinor).toBe(90000 - 30000);
    expect(after.YER.collectedMinor).toBe(0);
  });

  it("ردود جزئية متعددة + إعادة محاولة idempotent + تجاوز المجموع مرفوض", async () => {
    const invoiceId = await invoiceOf("USD", 500000, "OWNREV-PG-USD-2");
    const paid = await recordPayment({
      patientId, invoiceId, kind: "payment", amountMinor: 100000,
      currency: "USD", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 530,
      method: "cash", note: null, createdBy: "ownrev-pg",
    });
    expect(pedNull(paid.reason)).toBeNull();

    const r1 = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 25000,
      currency: "USD", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 530,
      method: "cash", note: null, createdBy: "ownrev-pg",
      reversalOfId: paid.payment!.id, idempotencyKey: "ownrev-pg-refund-1",
    });
    expect(pedNull(r1.reason)).toBeNull();

    const replay = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 25000,
      currency: "USD", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 530,
      method: "cash", note: null, createdBy: "ownrev-pg",
      reversalOfId: paid.payment!.id, idempotencyKey: "ownrev-pg-refund-1",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.payment!.id).toBe(r1.payment!.id);

    const r2 = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 60000,
      currency: "USD", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 530,
      method: "cash", note: null, createdBy: "ownrev-pg",
      reversalOfId: paid.payment!.id,
    });
    expect(pedNull(r2.reason)).toBeNull();

    const beyond = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 15001,
      currency: "USD", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 530,
      method: "cash", note: null, createdBy: "ownrev-pg",
      reversalOfId: paid.payment!.id,
    });
    expect(beyond.reason).toBe("reversal_exceeds_remaining");

    const { rows: [sums] } = await getPool().query<{ refunded: string; n: number }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::text AS refunded, COUNT(*)::int AS n
         FROM payments WHERE reversal_of_id = $1 AND kind = 'refund'`,
      [paid.payment!.id],
    );
    expect(sums.n).toBe(2);
    expect(Number(sums.refunded)).toBe(85000);
  });

  it("هدفٌ صريح يخالف فاتورة الأصل ⇒ reversal_target_conflict", async () => {
    const invoiceId = await invoiceOf("USD", 80000, "OWNREV-PG-USD-3");
    const otherInvoiceId = await invoiceOf("YER", 90000, "OWNREV-PG-YER-3");
    const paid = await recordPayment({
      patientId, invoiceId, kind: "payment", amountMinor: 80000,
      currency: "USD", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 530,
      method: "cash", note: null, createdBy: "ownrev-pg",
    });
    expect(pedNull(paid.reason)).toBeNull();

    const conflicting = await recordPayment({
      patientId, invoiceId: otherInvoiceId, kind: "refund", amountMinor: 10000,
      currency: "USD", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 530,
      method: "cash", note: null, createdBy: "ownrev-pg", reversalOfId: paid.payment!.id,
    });
    expect(conflicting.payment).toBeNull();
    expect(conflicting.reason).toBe("reversal_target_conflict");
  });
});

describe("مراجعة المالك على PostgreSQL: الدفع المقدَّم على خطة أجنبية", () => {
  it("دفعة USD بلا فاتورة وبخطة دولارية ⇒ تُخزَّن بخطتها وتسوّي دلو الدولار", async () => {
    const { rows: [plan] } = await getPool().query<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date)
       VALUES ($1, 'تقويم دولاري PG', 500000, 'USD', 'active', CURRENT_DATE) RETURNING id`,
      [patientId],
    );

    const before = await balancesOf(patientId);
    const usdBefore = before.USD.dueMinor;

    const paid = await recordPayment({
      patientId, invoiceId: null, planId: plan.id, kind: "payment", amountMinor: 50000,
      currency: "USD", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 530,
      method: "cash", note: null, createdBy: "ownrev-pg",
    });
    expect(pedNull(paid.reason)).toBeNull();
    expect(paid.payment!.planId).toBe(plan.id);
    expect(paid.payment!.invoiceId).toBeNull();

    const after = await balancesOf(patientId);
    expect(after.USD.collectedMinor).toBe(before.USD.collectedMinor + 50000);
    expect(after.USD.dueMinor).toBe(usdBefore - 50000);
    /* دلو الأساس لم يتحرك بمليم — الدفعة الدولارية لم تُقيَّد عليه بصمت. */
    expect(after.YER.collectedMinor).toBe(before.YER.collectedMinor);
  });

  it("ردُّ الدفعة المقدَّمة يرث خطتها — لا فاتورة ولا دلو أساس", async () => {
    const { rows: [plan] } = await getPool().query<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date)
       VALUES ($1, 'تقويم سعودي PG', 300000, 'SAR', 'active', CURRENT_DATE) RETURNING id`,
      [patientId],
    );
    const paid = await recordPayment({
      patientId, invoiceId: null, planId: plan.id, kind: "payment", amountMinor: 40000,
      currency: "SAR", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 140,
      method: "cash", note: null, createdBy: "ownrev-pg",
    });
    expect(pedNull(paid.reason)).toBeNull();

    const refunded = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 15000,
      currency: "SAR", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 140,
      method: "cash", note: null, createdBy: "ownrev-pg", reversalOfId: paid.payment!.id,
    });
    expect(pedNull(refunded.reason)).toBeNull();
    expect(refunded.payment!.planId).toBe(plan.id);
    expect(refunded.payment!.invoiceId).toBeNull();
    expect(refunded.payment!.exchangeRate).toBe(140);
  });

  it("الدفع الأجنبي بلا فاتورةٍ ولا خطة ⇒ foreign_on_account_requires_target — ولا سند خلفه", async () => {
    const before = await balancesOf(patientId);
    const rejected = await recordPayment({
      patientId, invoiceId: null, kind: "payment", amountMinor: 10000,
      currency: "USD", baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 530,
      method: "cash", note: null, createdBy: "ownrev-pg",
    });
    expect(rejected.payment).toBeNull();
    expect(rejected.reason).toBe("foreign_on_account_requires_target");

    const after = await balancesOf(patientId);
    expect(after.USD.collectedMinor).toBe(before.USD.collectedMinor);
    expect(after.YER.collectedMinor).toBe(before.YER.collectedMinor);
  });
});

/** مساعد قراءة السبب — يبقي expect صريحًا في الاختبارات أعلاه. */
function pedNull(reason: string | null): string | null {
  return reason;
}
