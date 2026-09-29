import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (RC-1) «إذا أخطأنا بسند قبض ما عاد نعرف نعدّله» — على PostgreSQL 18.
 *
 * السندات إلحاقية: لا تعديل ولا حذف. التصحيح = عكس المتبقي من السند الخطأ بسند ردٍّ مرتبطٍ به
 * + السند الصحيح بدله، في معاملةٍ واحدة. والمطلوب أن يبقى كل شيء متّسقًا بعده: رصيد المريض،
 * ومتوقَّع الدرج في الوردية، والدفاتر (كل عملة متوازنة) — والسند الأصلي يبقى كما هو.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, openShift, getOpenShift, createInvoice, recordPayment,
  correctPayment, patientReceiptRemainders, patientLedger, patientPlanCurrencies, ledgerBalancesByCurrency,
  journalEntries,
} = db;
const { trialBalance, isBalanced } = await import("../../lib/accounting");

type Currency = "YER" | "SAR" | "USD";
const RATES = { YER: 1, SAR: 140, USD: 530 } as const;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

async function patient(name: string): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [name, name]);
  return row.id;
}

async function invoice(patientId: number, totalMinor: number, currency: Currency = "YER") {
  const created = await createInvoice({
    patientId, baseCurrency: currency, discountMinor: 0, note: null, createdBy: "doctor",
    items: [{ serviceId: null, doctorId: null, description: "تقويم", quantity: 1, unitPriceMinor: totalMinor }],
  });
  if (!created) throw new Error("invoice not created");
  return created.id;
}

async function pay(patientId: number, invoiceId: number | null, amountMinor: number, currency: Currency = "YER") {
  const result = await recordPayment({
    patientId, invoiceId, kind: "payment", amountMinor, currency, baseCurrency: "YER",
    exchangeRate: RATES[currency], method: "cash", note: null, createdBy: "cashier",
    reversalOfId: null, openingCurrency: null,
  });
  if (result.reason !== null || !result.payment) throw new Error(`payment refused: ${result.reason}`);
  return result.payment;
}

function replacement(amountMinor: number, extra: Partial<{
  currency: Currency; invoiceId: number | null; planId: number | null; method: string; original: boolean;
}> = {}) {
  const currency = extra.currency ?? "YER";
  return {
    amountMinor, currency, exchangeRate: RATES[currency], method: extra.method ?? "cash",
    target: extra.original
      ? { kind: "original" as const }
      : { kind: "explicit" as const, invoiceId: extra.invoiceId ?? null, planId: extra.planId ?? null, openingCurrency: null },
  };
}

async function due(patientId: number, currency: Currency = "YER") {
  const ledger = await patientLedger(patientId);
  return ledgerBalancesByCurrency(patientId, ledger, await patientPlanCurrencies(patientId))[currency].dueMinor;
}

async function drawer() {
  const shift = await getOpenShift();
  if (!shift) throw new Error("no open shift");
  return shift.expected;
}

/** رصيد (حساب، عملة) من الدفاتر — وكل قيدٍ متوازنٌ داخل كل عملة. */
async function book(code: string, currency: Currency) {
  const entries = await journalEntries("2000-01-01", "2099-12-31");
  for (const entry of entries) expect(isBalanced(entry)).toBe(true);
  const rows = trialBalance(entries);
  for (const c of ["YER", "SAR", "USD"] as Currency[]) {
    const inCurrency = rows.filter((row) => row.currency === c);
    expect(inCurrency.reduce((sum, row) => sum + row.debitMinor, 0))
      .toBe(inCurrency.reduce((sum, row) => sum + row.creditMinor, 0));
  }
  return rows.find((row) => row.code === code && row.currency === currency)?.balanceMinor ?? 0;
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(RC-1) correcting a wrong receipt", () => {
  it("wrong amount: reverses it and issues the right one — patient, drawer and books all end as if the right one was entered", async () => {
    const p = await patient("سند بمبلغ خطأ");
    const inv = await invoice(p, 100_000);
    const drawerBefore = await drawer();
    const cashBefore = await book("1101", "YER");
    const arBefore = await book("1201", "YER");

    const wrong = await pay(p, inv, 50_000); // كُتب 50,000 والمقبوض 5,000
    const result = await correctPayment({
      paymentId: wrong.id, reason: "كُتب 50,000 والمقبوض 5,000", actor: "admin",
      replacement: replacement(5_000, { invoiceId: inv }),
    });
    expect(result.reason).toBeNull();
    if (result.reason !== null) return;
    expect(result.reversal).toMatchObject({ kind: "refund", amountMinor: 50_000, currency: "YER", invoiceId: inv });
    expect(result.replacement).toMatchObject({ kind: "payment", amountMinor: 5_000, currency: "YER", invoiceId: inv });
    expect(result.reversal?.note).toContain(wrong.receiptNumber);

    expect(await due(p)).toBe(95_000);
    expect((await drawer()).YER - drawerBefore.YER).toBe(5_000);
    expect(await book("1101", "YER") - cashBefore).toBe(5_000);
    expect(await book("1201", "YER") - arBefore).toBe(-5_000); // الفاتورة قبل اللقطة: الذمم تنقص بالمقبوض الصحيح وحده

    // السند الخطأ باقٍ كما سُجّل — ظاهرٌ معكوسًا لا ممسوحًا — ولا يقبل تصحيحًا ثانيًا.
    const [original] = await q<{ amount_minor: string }>(`SELECT amount_minor FROM payments WHERE id = $1`, [wrong.id]);
    expect(Number(original.amount_minor)).toBe(50_000);
    const remaining = await patientReceiptRemainders(p);
    expect(remaining[wrong.id]).toBeUndefined();
    expect(remaining[result.replacement!.id]).toBe(5_000);
  });

  it("void: a receipt for money that never came in — reversed alone, the debt returns, the drawer is back where it was", async () => {
    const p = await patient("سند لم يقع");
    const inv = await invoice(p, 40_000);
    const drawerBefore = await drawer();
    const wrong = await pay(p, inv, 40_000);
    expect(await due(p)).toBe(0);

    const result = await correctPayment({ paymentId: wrong.id, reason: "سُجّل لمريضٍ آخر", actor: "admin", replacement: null });
    expect(result.reason).toBeNull();
    if (result.reason !== null) return;
    expect(result.replacement).toBeNull();
    expect(await due(p)).toBe(40_000);
    expect((await drawer()).YER).toBe(drawerBefore.YER);
  });

  it("wrong currency: 100 SAR recorded on a YER invoice when 14,000 YER was paid — SAR drawer back to zero effect", async () => {
    const p = await patient("سند بعملة خطأ");
    const inv = await invoice(p, 30_000);
    const drawerBefore = await drawer();
    const sarCashBefore = await book("1102", "SAR");
    const wrong = await pay(p, inv, 10_000, "SAR");
    expect(await due(p)).toBe(30_000 - 14_000);

    const result = await correctPayment({
      paymentId: wrong.id, reason: "دُفع بالريال اليمني", actor: "admin",
      replacement: replacement(14_000, { invoiceId: inv }),
    });
    expect(result.reason).toBeNull();
    expect(await due(p)).toBe(16_000);
    const after = await drawer();
    expect(after.SAR - drawerBefore.SAR).toBe(0);
    expect(after.YER - drawerBefore.YER).toBe(14_000);
    expect(await book("1102", "SAR")).toBe(sarCashBefore);
  });

  it("a partly refunded receipt: only what is left of it is reversed", async () => {
    const p = await patient("سند مردود جزئيًا");
    const inv = await invoice(p, 60_000);
    const wrong = await pay(p, inv, 30_000);
    const refund = await recordPayment({
      patientId: p, invoiceId: null, kind: "refund", amountMinor: 10_000, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, method: "cash", note: null, createdBy: "admin", reversalOfId: wrong.id, openingCurrency: null,
    });
    expect(refund.reason).toBeNull();
    expect((await patientReceiptRemainders(p))[wrong.id]).toBe(20_000);

    const result = await correctPayment({ paymentId: wrong.id, reason: "الباقي لم يُقبض", actor: "admin", replacement: null });
    expect(result.reason).toBeNull();
    if (result.reason !== null) return;
    expect(result.reversal?.amountMinor).toBe(20_000);
    expect(await due(p)).toBe(60_000);
  });

  it("two corrections of the same receipt at once (double click): exactly one goes through", async () => {
    const p = await patient("نقرتان");
    const inv = await invoice(p, 50_000);
    const drawerBefore = await drawer();
    const wrong = await pay(p, inv, 50_000);
    const [a, b] = await Promise.all([
      correctPayment({ paymentId: wrong.id, reason: "مبلغ خطأ", actor: "admin", replacement: replacement(5_000, { invoiceId: inv }) }),
      correctPayment({ paymentId: wrong.id, reason: "مبلغ خطأ", actor: "admin", replacement: replacement(5_000, { invoiceId: inv }) }),
    ]);
    expect([a.reason, b.reason].sort()).toEqual(["already_reversed", null].sort());
    const [{ n }] = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM payments WHERE reversal_of_id = $1`, [wrong.id]);
    expect(n).toBe(1);
    expect(await due(p)).toBe(45_000);
    expect((await drawer()).YER - drawerBefore.YER).toBe(5_000);
  });

  it("the same correction retried with its idempotency key returns the first result — any change to it is a conflict", async () => {
    const p = await patient("إعادة الطلب");
    const inv = await invoice(p, 50_000);
    const other = await invoice(p, 9_000);
    const wrong = await pay(p, inv, 20_000);
    const request = {
      paymentId: wrong.id, reason: "مبلغ خطأ", actor: "admin", idempotencyKey: "rc-test-key-0001",
      replacement: replacement(2_000, { invoiceId: inv }),
    };
    const first = await correctPayment(request);
    const again = await correctPayment(request);
    expect(first.reason).toBeNull();
    expect(again.reason).toBeNull();
    if (first.reason !== null || again.reason !== null) return;
    expect(again.replayed).toBe(true);
    expect(again.replacement?.id).toBe(first.replacement?.id);
    expect(again.reversal?.id).toBe(first.reversal?.id);
    expect(await due(p)).toBe(48_000 + 9_000);

    // المفتاح نفسه بطلبٍ مختلف — فاتورةٌ أخرى، طريقةٌ أخرى، سببٌ آخر، سندٌ آخر — تعارضٌ صريح.
    for (const changed of [
      { ...request, replacement: replacement(2_000, { invoiceId: other }) },
      { ...request, replacement: replacement(2_000, { invoiceId: inv, method: "transfer" }) },
      { ...request, reason: "سببٌ آخر" },
      { ...request, paymentId: (await pay(p, inv, 1_000)).id },
    ]) {
      expect((await correctPayment(changed)).reason).toBe("idempotency_conflict");
    }
    const [{ n }] = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM payments WHERE note = $1`, [`بدل السند ${wrong.receiptNumber}`]);
    expect(n).toBe(1);
  });

  it("a void retried with its idempotency key returns the first reversal — not «already reversed»", async () => {
    const p = await patient("إبطال معاد");
    const inv = await invoice(p, 8_000);
    const wrong = await pay(p, inv, 8_000);
    const request = { paymentId: wrong.id, reason: "لم يُقبض", actor: "admin", idempotencyKey: "rc-test-void-0001", replacement: null };
    const first = await correctPayment(request);
    const again = await correctPayment(request);
    if (first.reason !== null || again.reason !== null) throw new Error(`${first.reason}/${again.reason}`);
    expect(again.replayed).toBe(true);
    expect(again.reversal?.id).toBe(first.reversal?.id);
    expect(await due(p)).toBe(8_000);
  });

  it("an installment receipt corrected «as the original» keeps its plan — the plan still counts it as paid", async () => {
    const p = await patient("قسط خطة");
    const [{ id: planId }] = await q<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status) VALUES ($1, 'تقويم', 300000, 'YER', 'active') RETURNING id`, [p]);
    const [{ id: installInvoice }] = await q<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, plan_id)
       VALUES ('RC-PLAN-INV', $1, 30000, 0, 'YER', 'cashier', $2) RETURNING id`, [p, planId]);
    const [shift] = await q<{ id: number }>(`SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1`);
    const [{ id: installmentId }] = await q<{ id: number }>(
      `INSERT INTO payments (receipt_number, patient_id, invoice_id, plan_id, shift_id, kind, amount_minor, currency, exchange_rate,
                             base_amount_minor, base_currency, method, created_by)
       VALUES ('RC-PLAN-R', $1, $2, $3, $4, 'payment', 30000, 'YER', 1, 30000, 'YER', 'cash', 'cashier') RETURNING id`,
      [p, installInvoice, planId, shift.id]);
    const planPaid = async () => Number((await q<{ s: string }>(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'refund' THEN -amount_minor ELSE amount_minor END), 0)::text AS s
         FROM payments WHERE plan_id = $1 AND currency = 'YER'`, [planId]))[0].s);
    expect(await planPaid()).toBe(30_000);

    const result = await correctPayment({
      paymentId: installmentId, reason: "المقبوض 25,000", actor: "admin", replacement: replacement(25_000, { original: true }),
    });
    expect(result.reason).toBeNull();
    if (result.reason !== null) return;
    expect(result.replacement).toMatchObject({ invoiceId: installInvoice, planId, amountMinor: 25_000 });
    expect(await planPaid()).toBe(25_000);
    // والهدف المزدوج يبقى حكرًا على الموروث: من يطلبه صراحةً يُرفض كما كان.
    const again = await pay(p, installInvoice, 1_000);
    expect((await correctPayment({
      paymentId: again.id, reason: "هدفان", actor: "admin", replacement: replacement(1_000, { invoiceId: installInvoice, planId }),
    })).reason).toBe("multiple_payment_targets");
  });

  it("the audit line is written in the same transaction — a correction never stands without it", async () => {
    const p = await patient("تدقيق ذري");
    const inv = await invoice(p, 5_000);
    const wrong = await pay(p, inv, 5_000);
    const result = await correctPayment({ paymentId: wrong.id, reason: "تجربة التدقيق", actor: "admin", actorRole: "admin", replacement: null });
    expect(result.reason).toBeNull();
    const audit = await q<{ actor: string; details: Record<string, unknown> }>(
      `SELECT actor, details FROM audit_log WHERE action = 'payment.correct' AND entity_id = $1`, [String(wrong.id)]);
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ السبب: "تجربة التدقيق", المبلغ_المعكوس: 5_000, الطريقة: "إبطال" });

    // سطر تدقيقٍ يتعذّر (قيدٌ يرفض الإدراج) يُسقط التصحيح كله.
    const victim = await pay(p, inv, 1_000);
    await q(`ALTER TABLE audit_log ADD CONSTRAINT rc_test_block CHECK (action <> 'payment.correct') NOT VALID`);
    try {
      await expect(correctPayment({ paymentId: victim.id, reason: "لا يثبت", actor: "admin", replacement: null })).rejects.toThrow();
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT rc_test_block`);
    }
    expect((await patientReceiptRemainders(p))[victim.id]).toBe(1_000);
  });

  it("a refused replacement undoes the reversal too — all or nothing", async () => {
    const p = await patient("كل شيء أو لا شيء");
    const inv = await invoice(p, 50_000);
    const drawerBefore = await drawer();
    const wrong = await pay(p, inv, 20_000);
    // سندٌ بعملة أجنبية على الحساب بلا هدف مرفوض — فلا يبقى العكس وحده.
    const refused = await correctPayment({
      paymentId: wrong.id, reason: "عملة خطأ", actor: "admin", replacement: replacement(100, { currency: "USD" }),
    });
    expect(refused.reason).toBe("foreign_on_account_requires_target");
    expect((await patientReceiptRemainders(p))[wrong.id]).toBe(20_000);
    expect(await due(p)).toBe(30_000);
    expect((await drawer()).YER - drawerBefore.YER).toBe(20_000);
  });

  it("refuses what cannot be corrected: a refund row, an unknown receipt, a missing reason", async () => {
    const p = await patient("رفوض");
    const inv = await invoice(p, 10_000);
    const paid = await pay(p, inv, 10_000);
    const voided = await correctPayment({ paymentId: paid.id, reason: "لم يقع", actor: "admin", replacement: null });
    if (voided.reason !== null) throw new Error(voided.reason);
    expect((await correctPayment({ paymentId: voided.reversal!.id, reason: "سبب", actor: "admin", replacement: null })).reason)
      .toBe("not_a_receipt");
    expect((await correctPayment({ paymentId: 999_999, reason: "سبب", actor: "admin", replacement: null })).reason).toBe("not_found");
    const fresh = await pay(p, null, 1_000);
    expect((await correctPayment({ paymentId: fresh.id, reason: "  ", actor: "admin", replacement: null })).reason).toBe("missing_reason");
  });
});
