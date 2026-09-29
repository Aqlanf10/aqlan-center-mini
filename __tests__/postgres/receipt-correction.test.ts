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
  currency: Currency; invoiceId: number | null; idempotencyKey: string | null; method: string;
}> = {}) {
  const currency = extra.currency ?? "YER";
  return {
    amountMinor, currency, exchangeRate: RATES[currency], method: extra.method ?? "cash",
    invoiceId: extra.invoiceId ?? null, planId: null, openingCurrency: null, note: null,
    idempotencyKey: extra.idempotencyKey ?? null,
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

  it("the same correction retried with its idempotency key returns the first result — no second receipt", async () => {
    const p = await patient("إعادة الطلب");
    const inv = await invoice(p, 50_000);
    const wrong = await pay(p, inv, 20_000);
    const request = { paymentId: wrong.id, reason: "مبلغ خطأ", actor: "admin", replacement: replacement(2_000, { invoiceId: inv, idempotencyKey: "rc-test-key-0001" }) };
    const first = await correctPayment(request);
    const again = await correctPayment(request);
    expect(first.reason).toBeNull();
    expect(again.reason).toBeNull();
    if (first.reason !== null || again.reason !== null) return;
    expect(again.replacement?.id).toBe(first.replacement?.id);
    expect(again.reversal?.id).toBe(first.reversal?.id);
    expect(await due(p)).toBe(48_000);

    // والمفتاح نفسه لتصحيح سندٍ آخر تعارضٌ صريح — لا يُعكس ذلك السند.
    const other = await pay(p, inv, 1_000);
    const conflict = await correctPayment({ ...request, paymentId: other.id });
    expect(conflict.reason).toBe("idempotency_conflict");
    expect((await patientReceiptRemainders(p))[other.id]).toBe(1_000);
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
