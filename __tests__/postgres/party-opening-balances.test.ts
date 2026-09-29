import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (FIA-1) السيناريو C الإلزامي — ديون المعامل والموردين السابقة لبدء النظام، على PostgreSQL 18.
 *
 * قبل النظام: مختبر A = 300,000 ر.ي، مورّد B = 1,000 ر.س، مورّد C = 500 $.
 * بعد الإدخال: الكشوف والذمم (لكل عملة) بالأرقام نفسها، وقائمة دخل الفترة **لا تتغيّر**.
 * ثم سداد 100,000 ر.ي للمختبر A: الدَّين 300,000، المسدَّد 100,000، المتبقي 200,000، الصندوق
 * ينقص 100,000 — ومصروف الفترة الناتج عن هذا الدَّين القديم = 0.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, openShift, recordExpense, partyStatement, payablesByCurrency,
  createPartyOpeningPayable, adjustPartyOpeningPayable, createPartyOpeningAdvance, voidPartyOpeningAdvance,
  journalEntries, financeSummary, listPartyOpenings, createPayable,
} = db;
const { trialBalance, incomeStatement, isBalanced } = await import("../../lib/accounting");

type Currency = "YER" | "SAR" | "USD";
const RATES = { YER: 1, SAR: 140, USD: 530 } as const;
const AS_OF = "2026-08-31";
const PERIOD_FROM = "2026-09-01";
const PERIOD_TO = "2099-12-31";

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

async function party(name: string, kind: "lab" | "supplier"): Promise<number> {
  const [row] = await q<{ id: number }>(`INSERT INTO parties (name, kind) VALUES ($1, $2) RETURNING id`, [name, kind]);
  return row.id;
}

async function opening(partyId: number, amountMinor: number, currency: Currency, reference: string | null = null) {
  const result = await createPartyOpeningPayable({
    partyId, currency, amountMinor, exchangeRate: RATES[currency], asOfDate: AS_OF, dueDate: null,
    reference, note: null, reason: "كشف حساب ورقي قبل بدء النظام", actor: "owner", actorRole: "admin",
  });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

async function pay(partyId: number, payableId: number | null, amountMinor: number, currency: Currency = "YER", prepaymentReason: string | null = null) {
  return recordExpense({
    category: "supplier", partyId, payeeText: null, amountMinor, currency, baseCurrency: "YER",
    exchangeRate: RATES[currency], payableId, note: null, createdBy: "cashier", rates: { ...RATES },
    prepaymentReason,
  });
}

async function periodIncome() {
  const entries = await journalEntries(PERIOD_FROM, PERIOD_TO);
  for (const entry of entries) expect(isBalanced(entry)).toBe(true);
  return incomeStatement(trialBalance(entries));
}

async function totalsOf(partyId: number) {
  return (await partyStatement(partyId)).totals;
}

let labA = 0;
let supplierB = 0;
let supplierC = 0;
let labAPayable = 0;
let supplierBPayable = 0;
let supplierCPayable = 0;
let expensesBefore = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 1_000_000, SAR: 0, USD: 0 } });
  labA = await party("مختبر الأمل", "lab");
  supplierB = await party("مورّد B", "supplier");
  supplierC = await party("مورّد C", "supplier");
  /* مصروف تشغيلي عادي في الفترة — ليُرى أن قائمة الدخل تحمل مصروفها ولا شيء من الدين القديم. */
  const ordinary = await createPayable({
    partyId: supplierB, category: "supplier", description: "فاتورة مواد الفترة", amountMinor: 50_000,
    currency: "YER", baseCurrency: "YER", exchangeRate: 1, labOrderId: null, dueDate: null, createdBy: "t",
  });
  expect(ordinary).not.toBeNull();
  expensesBefore = (await periodIncome()).totalExpensesMinor;
  expect(expensesBefore).toBe(50_000);
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(FIA-1) Scenario C — legacy lab/supplier debts before go-live", () => {
  it("entering 300,000 YER / 1,000 SAR / 500 USD shows the same numbers per currency and leaves the period P&L untouched", async () => {
    labAPayable = (await opening(labA, 300_000, "YER", "كشف حتى أغسطس")).id;
    supplierBPayable = (await opening(supplierB, 100_000, "SAR")).id;
    supplierCPayable = (await opening(supplierC, 50_000, "USD")).id;

    expect(await totalsOf(labA)).toEqual([expect.objectContaining({ currency: "YER", owedMinor: 300_000, remainingMinor: 300_000, openingOwedMinor: 300_000 })]);
    expect((await totalsOf(supplierB)).find((row) => row.currency === "SAR"))
      .toMatchObject({ owedMinor: 100_000, remainingMinor: 100_000, openingOwedMinor: 100_000 });
    expect(await totalsOf(supplierC)).toEqual([expect.objectContaining({ currency: "USD", owedMinor: 50_000, remainingMinor: 50_000 })]);

    /* الذمم لكل عملة (غرفة القيادة): كل عملةٍ في دلوها — لا 350,500 ممزوجة. */
    expect(await payablesByCurrency()).toEqual([
      { currency: "YER", dueMinor: 300_000 + 50_000 },
      { currency: "SAR", dueMinor: 100_000 },
      { currency: "USD", dueMinor: 50_000 },
    ]);

    /* قائمة دخل الفترة الحالية كما هي: الدَّين القديم ليس مصروفًا. */
    const after = await periodIncome();
    expect(after.totalExpensesMinor).toBe(expensesBefore);

    /* والقيد الافتتاحي في دفاتر يوم «حتى»: مدين رأس المال والأرصدة الافتتاحية، دائن الذمم — متوازن. */
    const openingEntries = (await journalEntries(AS_OF, AS_OF)).filter((entry) => entry.source === "opening_payable");
    expect(openingEntries).toHaveLength(3);
    const lab = openingEntries.find((entry) => entry.reference === `OP-${labAPayable}`)!;
    expect(lab.lines).toEqual([
      { accountCode: "3101", amountMinor: 300_000, side: "debit" },
      { accountCode: "2101", amountMinor: 300_000, side: "credit" },
    ]);
    const openingIncome = incomeStatement(trialBalance(await journalEntries(AS_OF, AS_OF)));
    expect(openingIncome.totalExpensesMinor).toBe(0);
  });

  it("paying 100,000 YER against Lab A: settled 100,000, remaining 200,000, cash −100,000, period expense from the old debt = 0", async () => {
    const cashBefore = trialBalance(await journalEntries("2000-01-01", PERIOD_TO)).find((row) => row.code === "1101")?.balanceMinor ?? 0;
    const summaryBefore = await financeSummary(PERIOD_FROM, PERIOD_TO);

    const paid = await pay(labA, labAPayable, 100_000);
    expect(paid.reason).toBeNull();

    expect((await totalsOf(labA))[0]).toMatchObject({ owedMinor: 300_000, settledMinor: 100_000, remainingMinor: 200_000 });
    const cashAfter = trialBalance(await journalEntries("2000-01-01", PERIOD_TO)).find((row) => row.code === "1101")?.balanceMinor ?? 0;
    expect(cashAfter).toBe(cashBefore - 100_000);

    /* الدفاتر: السداد مدين الذمم دائن الصندوق — قائمة الدخل لا تتحرك. */
    expect((await periodIncome()).totalExpensesMinor).toBe(expensesBefore);

    /* الملخص اليومي/الشهري: خرج من الصندوق (في الصافي) وليس «مصروفًا» للفترة. */
    const summaryAfter = await financeSummary(PERIOD_FROM, PERIOD_TO);
    expect(summaryAfter.expenses.baseTotalMinor).toBe(summaryBefore.expenses.baseTotalMinor);
    expect(summaryAfter.openingSettlements).toEqual({ baseTotalMinor: 100_000, count: 1 });
    expect(summaryAfter.netMinor).toBe(summaryBefore.netMinor - 100_000);
  });

  it("overpaying the old debt is refused like any payable; a cross-currency payment keeps the liability currency", async () => {
    const over = await pay(labA, labAPayable, 250_000);
    expect(over.reason).toBe("exceeds_payable");

    /* 26,500 ر.ي على دَين دولاري: يُسدَّد 50 $ بلقطة السعر — والدَّين يبقى دولاريًّا. */
    const cross = await pay(supplierC, supplierCPayable, 26_500, "YER");
    expect(cross.reason).toBeNull();
    const [snapshot] = await q<{ payable_currency: string; payable_settled_minor: string; currency: string; amount_minor: string }>(
      `SELECT payable_currency, payable_settled_minor::text, currency, amount_minor::text FROM expenses WHERE id = $1`, [cross.expense!.id]);
    expect(snapshot).toEqual({ payable_currency: "USD", payable_settled_minor: "5000", currency: "YER", amount_minor: "26500" });
    const cTotals = await totalsOf(supplierC);
    expect(cTotals.find((row) => row.currency === "USD")).toMatchObject({ owedMinor: 50_000, settledMinor: 5_000, remainingMinor: 45_000 });
    expect(cTotals.find((row) => row.currency === "YER")).toMatchObject({ paidMinor: 26_500 });
  });

  it("corrections are append-only: who entered 300,000, who corrected it, why, and to what — never below what was paid", async () => {
    const below = await adjustPartyOpeningPayable({ payableId: labAPayable, newAmountMinor: 50_000, reason: "خطأ", actor: "owner", actorRole: "admin" });
    expect(below).toMatchObject({ ok: false, status: 400 });

    const corrected = await adjustPartyOpeningPayable({
      payableId: labAPayable, newAmountMinor: 280_000, reason: "الكشف الصحيح 280 ألفًا", actor: "owner", actorRole: "admin",
    });
    expect(corrected).toMatchObject({ ok: true, value: { amountMinor: 280_000, originalAmountMinor: 300_000, remainingMinor: 180_000 } });

    const { adjustments } = await listPartyOpenings();
    expect(adjustments).toEqual([expect.objectContaining({ payableId: labAPayable, deltaMinor: -20_000, reason: "الكشف الصحيح 280 ألفًا", createdBy: "owner" })]);
    const audit = await q<{ action: string; actor: string }>(
      `SELECT action, actor FROM audit_log WHERE entity = 'payable' AND entity_id = $1 ORDER BY id`, [String(labAPayable)]);
    expect(audit).toEqual([{ action: "party_opening.create", actor: "owner" }, { action: "party_opening.adjust", actor: "owner" }]);

    /* القيد الافتتاحي يتبع القيمة المصحَّحة (بسعرها الأصلي)، والدخل لا يتحرك. */
    const entry = (await journalEntries(AS_OF, AS_OF)).find((row) => row.reference === `OP-${labAPayable}`)!;
    expect(entry.lines[1]).toEqual({ accountCode: "2101", amountMinor: 280_000, side: "credit" });
    expect((await periodIncome()).totalExpensesMinor).toBe(expensesBefore);
  });

  it("no silent edit or delete: the database itself refuses them", async () => {
    await expect(q(`UPDATE payables SET amount_minor = 1 WHERE id = $1`, [labAPayable])).rejects.toThrow(/لا يُعدَّل صامتًا/);
    await expect(q(`DELETE FROM payables WHERE id = $1`, [supplierBPayable])).rejects.toThrow(/لا يُحذف/);
    await expect(q(`UPDATE payable_adjustments SET delta_minor = 1`)).rejects.toThrow(/إلحاقي/);
    await expect(q(`DELETE FROM payable_adjustments`)).rejects.toThrow(/إلحاقي/);
    /* الوصف والاستحقاق ليسا مالًا — يُحدَّثان بلا حرج (نفس الحارس لا يمنعهما). */
    await q(`UPDATE payables SET due_date = '2026-12-31' WHERE id = $1`, [supplierBPayable]);
  });

  it("a duplicate entry (double click) is refused", async () => {
    const again = await createPartyOpeningPayable({
      partyId: supplierB, currency: "SAR", amountMinor: 100_000, exchangeRate: 140, asOfDate: AS_OF, dueDate: null,
      reference: null, note: null, reason: "إعادة", actor: "owner", actorRole: "admin",
    });
    expect(again).toMatchObject({ ok: false, status: 409 });
  });

  it("an opening advance (credit with the supplier) is its own thing: it lowers what we owe in its currency, and voids with a reason", async () => {
    const advance = await createPartyOpeningAdvance({
      partyId: supplierB, currency: "SAR", amountMinor: 20_000, exchangeRate: 140, asOfDate: AS_OF,
      reference: null, note: null, reason: "دفعة مقدمة قبل النظام", actor: "owner", actorRole: "admin",
    });
    if (!advance.ok) throw new Error(advance.message);
    const sar = async () => (await payablesByCurrency()).find((row) => row.currency === "SAR")?.dueMinor;
    expect(await sar()).toBe(80_000);
    expect((await totalsOf(supplierB)).find((row) => row.currency === "SAR")).toMatchObject({ openingAdvanceMinor: 20_000 });
    const entry = (await journalEntries(AS_OF, AS_OF)).find((row) => row.reference === `OA-${advance.value.id}`)!;
    expect(entry.lines).toEqual([
      { accountCode: "2101", amountMinor: 20_000 * 140 / 100, side: "debit" },
      { accountCode: "3101", amountMinor: 20_000 * 140 / 100, side: "credit" },
    ]);

    await expect(q(`DELETE FROM party_opening_advances WHERE id = $1`, [advance.value.id])).rejects.toThrow(/لا يُحذف/);
    const voided = await voidPartyOpeningAdvance({ id: advance.value.id, reason: "أُدخل خطأً", actor: "owner", actorRole: "admin" });
    expect(voided).toMatchObject({ ok: true, value: { voidReason: "أُدخل خطأً", voidedBy: "owner" } });
    expect(await sar()).toBe(100_000);
    expect(await voidPartyOpeningAdvance({ id: advance.value.id, reason: "مرة ثانية", actor: "owner", actorRole: "admin" }))
      .toMatchObject({ ok: false, status: 409 });
  });

  it("a doctor's commission is untouched by legacy supplier debt (no doctor party, no invoice, no revenue)", async () => {
    const [counts] = await q<{ invoices: number; lab_orders: number; inventory: number }>(
      `SELECT (SELECT COUNT(*) FROM invoices)::int AS invoices, (SELECT COUNT(*) FROM lab_orders)::int AS lab_orders,
              (SELECT COUNT(*) FROM inventory_movements)::int AS inventory`);
    /* لا فاتورة وهمية ولا أمر مختبر وهمي ولا شراء وهمي. */
    expect(counts).toEqual({ invoices: 0, lab_orders: 0, inventory: 0 });
  });
});
