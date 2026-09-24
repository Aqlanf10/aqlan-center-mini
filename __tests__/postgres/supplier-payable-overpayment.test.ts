import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * P0-2 — مدفوعات الموردين والمختبرات على PostgreSQL 18 الحقيقي.
 *
 * الحالات الأولى إعادة إنتاجٍ حرفية لما أثبته تدقيق الجاهزية:
 *   التزام ٥٠٬٠٠٠ ← سند ٢٠٬٠٠٠ ← سند ٩٩٩٬٩٩٩ على الالتزام نفسه قُبل (201)،
 *   وإبطال سند التزامٍ رُفض بلا أي مسار تصحيح.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, recordExpense, resetPoolForTesting, voidExpense, createPayable,
  settleLabOrdersBatch, partyStatement, openShift, closeShift, getOpenShift,
} = db;
const { SUPPLIER_PAYMENT_SETTLEMENT_SQL } = await import("../../lib/supplier-payment-schema");

type Currency = "YER" | "SAR" | "USD";

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

async function party(name: string, kind: "lab" | "supplier" | "doctor" = "supplier"): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO parties (name, kind) VALUES ($1, $2) RETURNING id`, [name, kind],
  );
  return row.id;
}

async function bill(partyId: number, amount: number, currency: Currency = "YER", rate = 1): Promise<number> {
  const payable = await createPayable({
    partyId, category: "supplier", description: "فاتورة مورد", amountMinor: amount, currency,
    baseCurrency: "YER", exchangeRate: rate, labOrderId: null, dueDate: null, createdBy: "test",
  });
  return payable!.id;
}

/** أسعار الإعدادات في هذه العيادة الاختبارية: ريال سعودي ١٤٠، دولار ٥٣٥. */
const RATES = { YER: 1, SAR: 140, USD: 535 } as const;

async function payOut(input: {
  partyId: number | null; payableId?: number | null; amount: number; currency?: Currency;
  rates?: Partial<Record<Currency, number>>; payableExchangeRate?: number; rateOverrideReason?: string;
  prepaymentReason?: string; quoteOnly?: boolean; category?: string;
}) {
  const rates = input.rates ?? RATES;
  const currency = input.currency ?? "YER";
  return recordExpense({
    category: input.category ?? "supplier", partyId: input.partyId, payeeText: input.partyId ? null : "نثريات",
    amountMinor: input.amount, currency, baseCurrency: "YER",
    exchangeRate: currency === "YER" ? 1 : (rates[currency] ?? 1),
    payableId: input.payableId ?? null, note: null, createdBy: "test", rates,
    payableExchangeRate: input.payableExchangeRate ?? null,
    rateOverrideReason: input.rateOverrideReason ?? null,
    prepaymentReason: input.prepaymentReason ?? null,
    quoteOnly: input.quoteOnly,
  });
}

async function remaining(payableId: number): Promise<number> {
  const [row] = await q<{ amount_minor: string; settled: string }>(
    `SELECT b.amount_minor,
            COALESCE((SELECT SUM(payable_settled_minor) FROM expenses WHERE payable_id = b.id), 0)::text AS settled
       FROM payables b WHERE b.id = $1`,
    [payableId],
  );
  return Number(row.amount_minor) - Number(row.settled);
}

async function patient(): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ('P02-' || nextval('patients_id_seq'), 'مريض مختبر') RETURNING id`,
  );
  return row.id;
}

/** أمر مختبر بتكلفته والتزامه — كما يولده الإرسال. */
async function labOrder(labPartyId: number, labName: string, cost: number, status = "delivered"): Promise<number> {
  const patientId = await patient();
  const [order] = await q<{ id: number }>(
    `INSERT INTO lab_orders (patient_id, lab_name, work_type, due_date, status, party_id, cost_minor, cost_currency, financial_status)
     VALUES ($1, $2, 'تاج', CURRENT_DATE, $3, $4, $5, 'YER', 'payable_created') RETURNING id`,
    [patientId, labName, status, labPartyId, cost],
  );
  const payable = await createPayable({
    partyId: labPartyId, category: "lab", description: `RX-${order.id}`, amountMinor: cost, currency: "YER",
    baseCurrency: "YER", exchangeRate: 1, labOrderId: order.id, dueDate: null, createdBy: "test",
  });
  await q(`UPDATE lab_orders SET payable_id = $1 WHERE id = $2`, [payable!.id, order.id]);
  return order.id;
}

async function batch(partyId: number, orderIds: number[], amount: number, prepaymentReason?: string) {
  return settleLabOrdersBatch({
    partyId, orderIds, amountMinor: amount, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
    note: null, createdBy: "admin", actorRole: "admin", rates: RATES, prepaymentReason: prepaymentReason ?? null,
  });
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});

beforeEach(async () => {
  // TRUNCATE لا يطلق حرّاس الصفوف (append-only) — تنظيف قاعدة اختبارٍ معزولة فقط.
  await q(`TRUNCATE expenses, payables, lab_order_tracking, lab_orders, patients, cashier_shifts,
                    parties, audit_log RESTART IDENTITY CASCADE`);
  await q(`INSERT INTO cashier_shifts (opened_by) VALUES ('p02')`);
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("إعادة إنتاج عيوب تدقيق الجاهزية (P0-2) — يجب ألا تعود أبدًا", () => {
  it("AUDIT-P02-1: سند ٩٩٩٬٩٩٩ على التزامٍ متبقّيه ٣٠٬٠٠٠ يُرفض ولا يُسجَّل", async () => {
    const s = await party("مورد أ");
    const b = await bill(s, 50_000);
    const first = await payOut({ partyId: s, payableId: b, amount: 20_000 });
    expect(first.expense).not.toBeNull();

    const second = await payOut({ partyId: s, payableId: b, amount: 999_999 });
    expect(second.expense).toBeNull();
    expect(second.reason).toBe("exceeds_payable");
    const [{ n }] = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM expenses`);
    expect(n).toBe(1);
  });

  it("AUDIT-P02-2: سند يسدّد التزامًا يُصحَّح بقيدٍ معاكس — لا طريق مسدود", async () => {
    const s = await party("مورد ب");
    const b = await bill(s, 50_000);
    const paid = await payOut({ partyId: s, payableId: b, amount: 20_000 });
    const result = await voidExpense(paid.expense!.id, { actor: "admin", actorRole: "admin", reason: "خطأ إدخال" });
    expect(result.ok).toBe(true);
    const [{ net }] = await q<{ net: string }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::text AS net FROM expenses WHERE payable_id = $1`, [b],
    );
    expect(Number(net)).toBe(0);
  });

  it("AUDIT-P02-3: سند صرف عادي لمورد فوق رصيده المستحق يُرفض (قرار المالك: امنع دائمًا)", async () => {
    const s = await party("مورد ج");
    await bill(s, 50_000);
    const over = await payOut({ partyId: s, amount: 999_999 });
    expect(over.expense).toBeNull();
    expect(over.reason).toBe("exceeds_party_balance");
  });
});

describe("سداد فاتورة بعينها — لقطة تسوية لا تتغيّر", () => {
  it("CASE 1: المتبقي بالضبط يُقبل، ووحدةٌ واحدة بعده تُرفض", async () => {
    const s = await party("مورد ١");
    const b = await bill(s, 50_000);
    expect((await payOut({ partyId: s, payableId: b, amount: 50_000 })).expense).not.toBeNull();
    const extra = await payOut({ partyId: s, payableId: b, amount: 1 });
    expect(extra.reason).toBe("exceeds_payable");
    expect(await remaining(b)).toBe(0);
  });

  it("CASE 2 (مثال المالك): فاتورة ١٠٠ USD، دفع ٢٦٬٧٥٠ YER بسعر ٥٣٥ ⇒ سدّد ٥٠ USD وبقي ٥٠ USD، واللقطة كاملة", async () => {
    const lab = await party("مختبر الدولار", "lab");
    const b = await bill(lab, 10_000, "USD", 535);
    const { expense, quote } = await payOut({ partyId: lab, payableId: b, amount: 26_750 });
    expect(expense).not.toBeNull();
    expect(expense!.currency).toBe("YER");
    expect(expense!.amountMinor).toBe(26_750);
    expect(expense!.exchangeRate).toBe(1);
    expect(expense!.payableCurrency).toBe("USD");
    expect(expense!.payableAmountMinor).toBe(10_000);
    expect(expense!.payableExchangeRate).toBe(535);
    expect(expense!.payableSettledMinor).toBe(5_000);
    expect(quote!.rateText).toBe("1 USD = 535 YER");
    expect(quote!.payable!.remainingAfterMinor).toBe(5_000);
    expect(await remaining(b)).toBe(5_000);
  });

  it("CASE 3: تغيّر السعر غدًا (٦٠٠) لا يمسّ سند الأمس ولا المتبقي — والسداد التالي بسعره هو", async () => {
    const lab = await party("مختبر السعر", "lab");
    const b = await bill(lab, 10_000, "USD", 535);
    const first = await payOut({ partyId: lab, payableId: b, amount: 26_750 });
    const tomorrow = { YER: 1, SAR: 140, USD: 600 };
    const quote = await payOut({ partyId: lab, payableId: b, amount: 1, rates: tomorrow, quoteOnly: true });
    expect(quote.quote!.payable!.remainingBeforeMinor).toBe(5_000);
    const second = await payOut({ partyId: lab, payableId: b, amount: 30_000, rates: tomorrow });
    expect(second.expense!.payableSettledMinor).toBe(5_000);
    expect(second.expense!.payableExchangeRate).toBe(600);
    const [again] = await q<{ payable_settled_minor: string; payable_exchange_rate: string }>(
      `SELECT payable_settled_minor, payable_exchange_rate FROM expenses WHERE id = $1`, [first.expense!.id],
    );
    expect(Number(again.payable_settled_minor)).toBe(5_000);
    expect(Number(again.payable_exchange_rate)).toBe(535);
    expect(await remaining(b)).toBe(0);
  });

  it("CASE 4: اللقطة append-only على مستوى القاعدة — UPDATE مرفوض حتى من psql", async () => {
    const lab = await party("مختبر الحارس", "lab");
    const b = await bill(lab, 10_000, "USD", 535);
    const { expense } = await payOut({ partyId: lab, payableId: b, amount: 26_750 });
    for (const column of ["payable_settled_minor = 1", "payable_exchange_rate = 1", "payable_currency = 'YER'", "payable_amount_minor = 1"]) {
      await expect(q(`UPDATE expenses SET ${column} WHERE id = $1`, [expense!.id])).rejects.toThrow(/append-only/);
    }
  });

  it("CASE 5: المكافئ المحوَّل فوق المتبقي يُرفض ومعه أقصى ما يُدفع", async () => {
    const lab = await party("مختبر الحد", "lab");
    const b = await bill(lab, 10_000, "USD", 535);
    await payOut({ partyId: lab, payableId: b, amount: 26_750 });
    const over = await payOut({ partyId: lab, payableId: b, amount: 27_000 });
    expect(over.reason).toBe("exceeds_payable");
    expect(over.quote!.payable!.remainingBeforeMinor).toBe(5_000);
    const max = over.quote!.payable!.maxPaymentMinor!;
    expect(max).toBeGreaterThanOrEqual(26_750);
    expect((await payOut({ partyId: lab, payableId: b, amount: max, quoteOnly: true })).reason).toBeNull();
    expect((await payOut({ partyId: lab, payableId: b, amount: max + 3, quoteOnly: true })).reason).toBe("exceeds_payable");
  });

  it("CASE 6: عملتان أجنبيتان (SAR لفاتورة USD) — عبر سعرَي الإعدادات إلى الأساس، لا سعر ثالث", async () => {
    const s = await party("مورد الريالين");
    const b = await bill(s, 10_000, "USD", 535);
    const { expense } = await payOut({ partyId: s, payableId: b, amount: 37_500, currency: "SAR" });
    // 375 SAR × 140 = 52,500 YER ÷ 535 = 98.13 USD
    expect(expense!.payableSettledMinor).toBe(9_813);
    expect(expense!.exchangeRate).toBe(140);
    expect(expense!.baseAmountMinor).toBe(52_500);
    expect(await remaining(b)).toBe(187);
  });

  it("CASE 7: سعرٌ غائب لا يُخمَّن — الرفض برسالة", async () => {
    const s = await party("مورد بلا سعر");
    const b = await bill(s, 10_000, "USD", 535);
    const result = await payOut({ partyId: s, payableId: b, amount: 26_750, rates: { YER: 1 } });
    expect(result.reason).toBe("missing_rate");
    expect(result.expense).toBeNull();
  });

  it("CASE 8: سعرٌ يقرّه المدير يخالف الإعدادات — يُستعمل ويُحفظ ومعه السبب", async () => {
    const lab = await party("مختبر السوق", "lab");
    const b = await bill(lab, 10_000, "USD", 535);
    const { expense } = await payOut({
      partyId: lab, payableId: b, amount: 27_000, payableExchangeRate: 540, rateOverrideReason: "سعر الصرّاف الفعلي",
    });
    expect(expense!.payableExchangeRate).toBe(540);
    expect(expense!.payableSettledMinor).toBe(5_000);
    expect(expense!.rateOverrideReason).toBe("سعر الصرّاف الفعلي");
  });

  it("CASE 9: التزام جهةٍ أخرى يُرفض، والسند بلا جهة يُنسب لصاحب الالتزام", async () => {
    const a = await party("مورد أ٩");
    const other = await party("مورد ب٩");
    const b = await bill(a, 10_000);
    expect((await payOut({ partyId: other, payableId: b, amount: 1_000 })).reason).toBe("payable_party_mismatch");
    const inferred = await payOut({ partyId: null, payableId: b, amount: 1_000 });
    expect(inferred.expense!.partyId).toBe(a);
  });
});

describe("رصيد المورد/المختبر — قرار المالك: امنع دائمًا فوق المستحق", () => {
  it("CASE 10: سداد المستحق كاملًا يُقبل، وريالٌ فوقه يُرفض، والدفعة المقدمة بسببٍ تُقبل ومسجّلة", async () => {
    const s = await party("مورد ١٠");
    await bill(s, 50_000);
    expect((await payOut({ partyId: s, amount: 50_000 })).expense).not.toBeNull();
    const over = await payOut({ partyId: s, amount: 1 });
    expect(over.reason).toBe("exceeds_party_balance");
    expect(over.quote!.party!.outstandingBeforeMinor).toBe(0);
    const pre = await payOut({ partyId: s, amount: 10_000, prepaymentReason: "حجز شحنة الشهر القادم" });
    expect(pre.expense!.note).toContain("دفعة مقدمة: حجز شحنة الشهر القادم");
    expect(pre.quote!.party!.prepayment).toBe(true);
  });

  it("CASE 11: مشتريات نقدية لمورد بلا فواتير تحتاج «دفعة مقدمة» (قرار المالك)", async () => {
    const s = await party("مورد نقدي");
    expect((await payOut({ partyId: s, amount: 5_000 })).reason).toBe("exceeds_party_balance");
    expect((await payOut({ partyId: s, amount: 5_000, prepaymentReason: "شراء نقدي مباشر" })).expense).not.toBeNull();
  });

  it("CASE 12: الأطباء (العمولات) والنثريات بلا جهة لا يمسّها حارس الرصيد", async () => {
    const doctor = await party("د. عمولة", "doctor");
    expect((await payOut({ partyId: doctor, amount: 90_000, category: "commission" })).expense).not.toBeNull();
    expect((await payOut({ partyId: null, amount: 1_500, category: "other" })).expense).not.toBeNull();
  });

  it("CASE 13: رصيدٌ بعملتين — الدلاء تُحوَّل بسعر اللحظة ولا تُجمع خامًا", async () => {
    const s = await party("مورد مختلط");
    await bill(s, 10_000, "USD", 535); // 53,500 YER اليوم
    await bill(s, 20_000, "YER");
    const quote = await payOut({ partyId: s, amount: 1, quoteOnly: true });
    expect(quote.quote!.party!.outstandingBeforeMinor).toBe(73_500);
    expect((await payOut({ partyId: s, amount: 73_501 })).reason).toBe("exceeds_party_balance");
    expect((await payOut({ partyId: s, amount: 73_500 })).expense).not.toBeNull();
  });

  it("CASE 14: سندان متزامنان على متبقٍّ واحد — واحدٌ فقط يمرّ (قفل الجهة)", async () => {
    const s = await party("مورد التزامن");
    const b = await bill(s, 30_000);
    const results = await Promise.all([
      payOut({ partyId: s, payableId: b, amount: 20_000 }),
      payOut({ partyId: s, payableId: b, amount: 20_000 }),
    ]);
    expect(results.filter((r) => r.expense !== null)).toHaveLength(1);
    expect(results.filter((r) => r.reason === "exceeds_payable")).toHaveLength(1);
    expect(await remaining(b)).toBe(10_000);
  });

  it("CASE 15: المعاينة (quoteOnly) لا تكتب شيئًا وتطابق التسجيل حرفيًّا", async () => {
    const lab = await party("مختبر المعاينة", "lab");
    const b = await bill(lab, 10_000, "USD", 535);
    const preview = await payOut({ partyId: lab, payableId: b, amount: 26_750, quoteOnly: true });
    const [{ n }] = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM expenses`);
    expect(n).toBe(0);
    const real = await payOut({ partyId: lab, payableId: b, amount: 26_750 });
    expect(real.quote).toEqual(preview.quote);
  });
});

describe("مسار التصحيح — قيدٌ معاكس في وردية اليوم", () => {
  it("CASE 16: سداد مورد في وردية أُقفلت يُصحَّح في الوردية المفتوحة، ويعود المتبقي، ولا يُبطَل مرتين", async () => {
    const lab = await party("مختبر التصحيح", "lab");
    const b = await bill(lab, 10_000, "USD", 535);
    const paid = await payOut({ partyId: lab, payableId: b, amount: 26_750 });
    const closed = await getOpenShift();
    await closeShift({ id: closed!.id, closedBy: "admin", counted: { YER: 0, SAR: 0, USD: 0 }, note: null });
    expect((await voidExpense(paid.expense!.id, { actor: "admin", reason: "رقم خاطئ" })).reason).toBe("no_shift");
    const today = await openShift({ openedBy: "admin", opening: { YER: 0, SAR: 0, USD: 0 } });
    const voided = await voidExpense(paid.expense!.id, { actor: "admin", actorRole: "admin", reason: "رقم خاطئ" });
    expect(voided.ok).toBe(true);
    const [reversal] = await q<{ shift_id: number; amount_minor: string; payable_settled_minor: string; payable_exchange_rate: string }>(
      `SELECT shift_id, amount_minor, payable_settled_minor, payable_exchange_rate FROM expenses WHERE reversal_of_id = $1`,
      [paid.expense!.id],
    );
    expect(reversal.shift_id).toBe(today!.id);
    expect(Number(reversal.amount_minor)).toBe(-26_750);
    expect(Number(reversal.payable_settled_minor)).toBe(-5_000);
    expect(Number(reversal.payable_exchange_rate)).toBe(535);
    expect(await remaining(b)).toBe(10_000);
    const [{ n }] = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM expenses WHERE shift_id = $1`, [closed!.id]);
    expect(n).toBe(1);
    expect((await voidExpense(paid.expense!.id, { actor: "admin", reason: "مرة ثانية" })).reason).toBe("already_voided");
    const [audit] = await q<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'expense.void' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.details["سداد_مورد"]).toBe(true);
    expect(audit.details["وردية_القيد"]).toBe(today!.id);
  });

  it("CASE 17: النثريات في وردية مقفلة ما زالت تُمنع (السلوك القائم محفوظ)", async () => {
    const petty = await payOut({ partyId: null, amount: 1_500, category: "other" });
    const shift = await getOpenShift();
    await closeShift({ id: shift!.id, closedBy: "admin", counted: { YER: 0, SAR: 0, USD: 0 }, note: null });
    await openShift({ openedBy: "admin", opening: { YER: 0, SAR: 0, USD: 0 } });
    expect((await voidExpense(petty.expense!.id, { actor: "admin", reason: "خطأ" })).reason).toBe("closed_shift");
  });
});

describe("تسوية المختبر المجمّعة", () => {
  it("CASE 18: تُسدَّد مرّة واحدة؛ لا أوامر مختبرٍ آخر ولا ملغاة؛ والإبطال يعيدها غير مسدّدة", async () => {
    const lab = await party("مختبر الدفعة", "lab");
    const other = await party("مختبر آخر", "lab");
    const a = await labOrder(lab, "مختبر الدفعة", 10_000);
    const b2 = await labOrder(lab, "مختبر الدفعة", 10_000);
    const foreign = await labOrder(other, "مختبر آخر", 5_000);
    const cancelled = await labOrder(lab, "مختبر الدفعة", 3_000, "cancelled");

    expect(await batch(lab, [a, foreign], 15_000)).toMatchObject({ ok: false, reason: "orders_invalid", orderIds: [foreign] });
    expect(await batch(lab, [a, cancelled], 13_000)).toMatchObject({ ok: false, reason: "orders_cancelled", orderIds: [cancelled] });
    expect(await batch(lab, [a, b2], 999_999)).toMatchObject({ ok: false, reason: "exceeds_party_balance" });

    const settled = await batch(lab, [a, b2], 20_000);
    expect(settled.ok).toBe(true);
    expect(await batch(lab, [a], 10_000)).toMatchObject({ ok: false, reason: "orders_already_paid", orderIds: [a] });

    if (!settled.ok) throw new Error("unreachable");
    const voided = await voidExpense(settled.expense.id, { actor: "admin", actorRole: "admin", reason: "مبلغ خاطئ" });
    expect(voided.reopenedLabOrderIds).toEqual([a, b2]);
    const statuses = await q<{ financial_status: string }>(
      `SELECT financial_status FROM lab_orders WHERE id = ANY($1::int[]) ORDER BY id`, [[a, b2]],
    );
    expect(statuses.map((row) => row.financial_status)).toEqual(["payable_created", "payable_created"]);
    expect((await batch(lab, [a, b2], 20_000)).ok).toBe(true);
  });

  it("CASE 19: كشف حساب الجهة يعرض المسدَّد والمتبقي لكل فاتورة بعملتها", async () => {
    const lab = await party("مختبر الكشف", "lab");
    const b = await bill(lab, 10_000, "USD", 535);
    await payOut({ partyId: lab, payableId: b, amount: 26_750 });
    const statement = await partyStatement(lab);
    expect(statement.payables[0]).toMatchObject({ currency: "USD", amountMinor: 10_000, settledMinor: 5_000, remainingMinor: 5_000 });
  });
});

describe("الهجرة 0013 — بذر حتمي للسندات القديمة", () => {
  it("CASE 20: السندات المرتبطة بلا لقطة تُبذر بالقاعدة الموثّقة، والتكرار لا يغيّر شيئًا", async () => {
    const s = await party("مورد قديم");
    const yerBill = await bill(s, 50_000);
    const usdBill = await bill(s, 10_000, "USD", 530);
    const [shift] = await q<{ id: number }>(`SELECT id FROM cashier_shifts WHERE status = 'open'`);
    const legacy = async (payableId: number, amount: number, currency: Currency, rate: number, base: number) => {
      const [row] = await q<{ id: number }>(
        `INSERT INTO expenses (voucher_number, category, party_id, shift_id, amount_minor, currency, exchange_rate,
                               base_amount_minor, base_currency, payable_id, created_by)
         VALUES ('L-' || nextval('voucher_number_seq'), 'supplier', $1, $2, $3, $4, $5, $6, 'YER', $7, 'legacy') RETURNING id`,
        [s, shift.id, amount, currency, rate, base, payableId],
      );
      return row.id;
    };
    const same = await legacy(yerBill, 20_000, "YER", 1, 20_000);
    const usdPaidInUsd = await legacy(usdBill, 3_000, "USD", 540, 16_200);
    const usdPaidInYer = await legacy(usdBill, 26_500, "YER", 1, 26_500);
    const yerPaidInUsd = await legacy(yerBill, 1_000, "USD", 540, 5_400);

    await q(SUPPLIER_PAYMENT_SETTLEMENT_SQL);
    const read = async () => q<{ id: number; payable_currency: string; payable_settled_minor: string; payable_exchange_rate: string }>(
      `SELECT id, payable_currency, payable_settled_minor::text, payable_exchange_rate::text FROM expenses ORDER BY id`,
    );
    const first = await read();
    const byId = new Map(first.map((row) => [row.id, row]));
    expect(Number(byId.get(same)!.payable_settled_minor)).toBe(20_000);
    expect(Number(byId.get(usdPaidInUsd)!.payable_settled_minor)).toBe(3_000);
    expect(Number(byId.get(usdPaidInUsd)!.payable_exchange_rate)).toBe(540);
    // فاتورة دولار دُفعت بالريال: سعر الفاتورة المسجّل عليها (٥٣٠) — الوحيد الموجود.
    expect(Number(byId.get(usdPaidInYer)!.payable_settled_minor)).toBe(5_000);
    expect(Number(byId.get(usdPaidInYer)!.payable_exchange_rate)).toBe(530);
    // فاتورة ريال دُفعت بالدولار: المكافئ الأساسي المحفوظ للسند.
    expect(Number(byId.get(yerPaidInUsd)!.payable_settled_minor)).toBe(5_400);
    expect(byId.get(yerPaidInUsd)!.payable_currency).toBe("YER");

    await q(SUPPLIER_PAYMENT_SETTLEMENT_SQL);
    expect(await read()).toEqual(first);
  });
});
