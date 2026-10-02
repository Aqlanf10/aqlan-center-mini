import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (TD-REG-028 / F-05) الدفتر متعدد العملات — ONE CURRENCY UNIT PER ACCOUNTING LINE، على PostgreSQL 18.
 *
 * كل سطر قيدٍ يحمل عملته، وكل قيدٍ يتوازن **داخل كل عملة**، وميزان المراجعة وقائمة الدخل والميزانية
 * لكل عملة — ولا يُجمع ريالٌ يمني مع سعودي أو دولار أبدًا. والدفع العابر للعملات يمرّ بحساب مقاصة
 * تحويل العملات (1901) بمبلغين مسجَّلين (لا سعر مخمَّن).
 *
 * السيناريوهات 1–7 من طلب المالك + إبطال سند (L-03) + المطابقة مع كشف المريض وكشف الجهة وغرفة القيادة.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, openShift, createInvoice, recordPayment, recordExpense, voidExpense,
  setPatientOpeningBalance, createPartyOpeningPayable, partyStatement, payablesByCurrency, journalEntries,
  createManualEntry, executiveKpis, patientLedger, patientPlanCurrencies, ledgerBalancesByCurrency,
} = db;
const accounting = await import("../../lib/accounting");
const { trialBalance, incomeStatement, balanceSheet, isBalanced } = accounting;

type Currency = "YER" | "SAR" | "USD";
const RATES = { YER: 1, SAR: 140, USD: 530 } as const;
const FROM = "2000-01-01";
const TO = "2099-12-31";
const CLEARING = "1901";

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

async function balances() {
  const entries = await journalEntries(FROM, TO);
  /* القاعدة الحاكمة: كل سطرٍ بعملةٍ صريحة، وكل قيدٍ متوازنٌ داخل كل عملة. */
  for (const entry of entries) {
    for (const line of entry.lines) expect(["YER", "SAR", "USD"]).toContain((line as { currency?: string }).currency);
    expect(isBalanced(entry)).toBe(true);
  }
  return trialBalance(entries);
}

/** رصيد (حساب، عملة) — بإشارة طبيعة الحساب. */
async function bal(code: string, currency: Currency): Promise<number> {
  const rows = await balances();
  return rows.find((row) => row.code === code && (row as { currency?: string }).currency === currency)?.balanceMinor ?? 0;
}

/** ميزان كل عملة يتوازن وحده: مجموع المدين = مجموع الدائن. */
async function expectEveryCurrencyBalanced() {
  const rows = await balances();
  for (const currency of ["YER", "SAR", "USD"] as Currency[]) {
    const inCurrency = rows.filter((row) => (row as { currency?: string }).currency === currency);
    const debit = inCurrency.reduce((sum, row) => sum + row.debitMinor, 0);
    const credit = inCurrency.reduce((sum, row) => sum + row.creditMinor, 0);
    expect({ currency, debit }).toEqual({ currency, debit: credit });
  }
}

async function patient(name: string): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [name, name]);
  return row.id;
}

async function invoice(patientId: number, currency: Currency, totalMinor: number, discountMinor = 0) {
  const created = await createInvoice({
    patientId, baseCurrency: currency, discountMinor, note: null, createdBy: "doctor",
    items: [{ serviceId: null, doctorId: null, description: "خدمة", quantity: 1, unitPriceMinor: totalMinor }],
  });
  if (!created) throw new Error("invoice not created");
  return created;
}

async function pay(patientId: number, invoiceId: number | null, currency: Currency, amountMinor: number,
  extra: { kind?: "payment" | "refund"; reversalOfId?: number | null; openingCurrency?: Currency | null } = {}) {
  return recordPayment({
    patientId, invoiceId, kind: extra.kind ?? "payment", amountMinor, currency, baseCurrency: "YER",
    exchangeRate: RATES[currency], method: "cash", note: null, createdBy: "cashier",
    reversalOfId: extra.reversalOfId ?? null, openingCurrency: extra.openingCurrency ?? null,
  });
}

async function party(name: string, kind: "lab" | "supplier"): Promise<number> {
  const [row] = await q<{ id: number }>(`INSERT INTO parties (name, kind) VALUES ($1, $2) RETURNING id`, [name, kind]);
  return row.id;
}

async function patientBuckets(patientId: number) {
  const ledger = await patientLedger(patientId);
  return ledgerBalancesByCurrency(patientId, ledger, await patientPlanCurrencies(patientId));
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("Scenario 1 — SAR invoice / SAR payment", () => {
  it("AR SAR 600, cash SAR +400, revenue SAR 1,000 — and not one YER unit moves", async () => {
    const yerRevenueBefore = await bal("4101", "YER");
    const yerArBefore = await bal("1201", "YER");
    const p = await patient("سيناريو 1");
    const inv = await invoice(p, "SAR", 100_000);
    const paid = await pay(p, inv.id, "SAR", 40_000);
    expect(paid.reason).toBeNull();

    expect(await bal("1201", "SAR")).toBe(60_000);
    expect(await bal("1102", "SAR")).toBe(40_000);
    expect(await bal("4101", "SAR")).toBe(100_000);
    expect(await bal("4101", "YER")).toBe(yerRevenueBefore);
    expect(await bal("1201", "YER")).toBe(yerArBefore);
    expect(await bal(CLEARING, "SAR")).toBe(0);

    const income = incomeStatement(await balances(), "SAR");
    expect(income.revenueMinor).toBe(100_000);
    expect(income.netProfitMinor).toBe(100_000);
    /* الكشف القانوني للمريض يطابق الدفتر في دلو عملته. */
    expect((await patientBuckets(p)).SAR.dueMinor).toBe(60_000);
    await expectEveryCurrencyBalanced();
  });
});

describe("Scenario 2 — USD invoice / YER payment", () => {
  it("is refused at creation (TD-05, no recorded USD settlement) and nothing moves in any currency", async () => {
    const p = await patient("سيناريو 2");
    const inv = await invoice(p, "USD", 50_000);
    const before = await balances();
    const refused = await pay(p, inv.id, "YER", 265_000);
    expect(refused.reason).toBe("cross_currency_not_supported");
    expect(await balances()).toEqual(before);
    expect(await bal("1201", "USD")).toBe(50_000);
    await expectEveryCurrencyBalanced();
  });
});

describe("Scenario 3 — YER invoice / SAR payment (cross-currency through clearing)", () => {
  it("AR YER falls by the recorded 56,000; SAR cash +400.00; clearing balances per currency", async () => {
    const clearingYer = await bal(CLEARING, "YER");
    const clearingSar = await bal(CLEARING, "SAR");
    const cashSar = await bal("1102", "SAR");
    const p = await patient("سيناريو 3");
    const inv = await invoice(p, "YER", 56_000);
    const paid = await pay(p, inv.id, "SAR", 40_000);
    expect(paid.reason).toBeNull();
    expect(paid.payment?.baseAmountMinor).toBe(56_000);

    expect((await patientBuckets(p)).YER.dueMinor).toBe(0);
    expect(await bal("1102", "SAR")).toBe(cashSar + 40_000);
    // 1901 أصلٌ: مدين [YER] 56,000 (استلمنا حقًّا يمنيًا محوَّلًا)، دائن [SAR] 40,000 (مقابل النقد السعودي).
    expect(await bal(CLEARING, "YER")).toBe(clearingYer + 56_000);
    expect(await bal(CLEARING, "SAR")).toBe(clearingSar - 40_000);
    // لا سطر يمني في حساب نقدٍ سعودي، ولا سطر سعودي في الذمم اليمنية.
    expect(await bal("1102", "YER")).toBe(0);
    await expectEveryCurrencyBalanced();
  });
});

describe("Scenario 4 — patient opening balance in SAR (F-06)", () => {
  it("AR SAR +2,000.00 against opening equity SAR; no revenue in any currency", async () => {
    const arSar = await bal("1201", "SAR");
    const revenueSar = await bal("4101", "SAR");
    const p = await patient("سيناريو 4");
    await setPatientOpeningBalance({
      patientId: p, currency: "SAR", amountMinor: 200_000, asOfDate: "2026-08-31",
      note: null, createdBy: "owner", reason: "رصيد ورقي",
    });
    expect(await bal("1201", "SAR")).toBe(arSar + 200_000);
    expect(await bal("3101", "SAR")).toBe(200_000);
    expect(await bal("4101", "SAR")).toBe(revenueSar);
    expect((await patientBuckets(p)).SAR.dueMinor).toBe(200_000);
    await expectEveryCurrencyBalanced();
  });
});

describe("Scenario 5 — legacy supplier debt 500.00 USD, then paid partly in YER", () => {
  let supplier = 0;
  let payableId = 0;
  let voucherId = 0;

  it("AP USD 500.00 against opening equity USD; no expense", async () => {
    supplier = await party("مورّد دولاري", "supplier");
    const created = await createPartyOpeningPayable({
      partyId: supplier, currency: "USD", amountMinor: 50_000, exchangeRate: RATES.USD, asOfDate: "2026-08-31",
      dueDate: null, reference: "INV-OLD", note: null, reason: "كشف ورقي قبل النظام", actor: "owner", actorRole: "admin",
    });
    if (!created.ok) throw new Error(created.message);
    payableId = created.value.id;
    expect(await bal("2101", "USD")).toBe(50_000);
    expect(await bal("3101", "USD")).toBe(-50_000);
    for (const currency of ["YER", "SAR", "USD"] as Currency[]) {
      expect(incomeStatement(await balances(), currency).totalExpensesMinor).toBe(0);
    }
    await expectEveryCurrencyBalanced();
  });

  it("106,000 YER settles exactly 200.00 USD: AP USD 300.00, cash YER −106,000, P&L untouched", async () => {
    const cashYer = await bal("1101", "YER");
    const clearingYer = await bal(CLEARING, "YER");
    const clearingUsd = await bal(CLEARING, "USD");
    const paid = await recordExpense({
      category: "supplier", partyId: supplier, payeeText: null, amountMinor: 106_000, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, payableId, note: null, createdBy: "cashier", rates: { ...RATES },
    });
    expect(paid.reason).toBeNull();
    voucherId = paid.expense!.id;

    expect(await bal("2101", "USD")).toBe(30_000);
    expect(await bal("1101", "YER")).toBe(cashYer - 106_000);
    expect(await bal(CLEARING, "YER")).toBe(clearingYer + 106_000);
    expect(await bal(CLEARING, "USD")).toBe(clearingUsd - 20_000);
    for (const currency of ["YER", "SAR", "USD"] as Currency[]) {
      expect(incomeStatement(await balances(), currency).totalExpensesMinor).toBe(0);
    }
    /* كشف الجهة القانوني = الدفتر، بعملة الالتزام. */
    const statement = await partyStatement(supplier);
    expect(statement.totals.find((row) => row.currency === "USD")?.remainingMinor).toBe(30_000);
    await expectEveryCurrencyBalanced();
  });

  it("voiding that voucher restores AP USD 500.00, cash YER and clearing exactly (L-03)", async () => {
    const cashYer = await bal("1101", "YER");
    const voided = await voidExpense(voucherId, { actor: "owner", actorRole: "admin", reason: "خطأ إدخال" });
    expect(voided.ok).toBe(true);
    expect(await bal("2101", "USD")).toBe(50_000);
    expect(await bal("1101", "YER")).toBe(cashYer + 106_000);
    await expectEveryCurrencyBalanced();
  });
});

describe("Scenario 6 — refunds and reversals return every currency exactly", () => {
  it("partial refund of a SAR receipt on a SAR invoice", async () => {
    const p = await patient("سيناريو 6أ");
    const inv = await invoice(p, "SAR", 50_000);
    const paid = await pay(p, inv.id, "SAR", 50_000);
    const arSar = await bal("1201", "SAR");
    const cashSar = await bal("1102", "SAR");
    const refund = await pay(p, null, "SAR", 10_000, { kind: "refund", reversalOfId: paid.payment!.id });
    expect(refund.reason).toBeNull();
    expect(await bal("1201", "SAR")).toBe(arSar + 10_000);
    expect(await bal("1102", "SAR")).toBe(cashSar - 10_000);
    expect((await patientBuckets(p)).SAR.dueMinor).toBe(10_000);
    await expectEveryCurrencyBalanced();
  });

  it("partial refund of a cross-currency SAR receipt on a YER invoice reverses both legs at the origin's rate", async () => {
    const p = await patient("سيناريو 6ب");
    const inv = await invoice(p, "YER", 56_000);
    const paid = await pay(p, inv.id, "SAR", 40_000);
    const clearingYer = await bal(CLEARING, "YER");
    const clearingSar = await bal(CLEARING, "SAR");
    const refund = await pay(p, null, "SAR", 10_000, { kind: "refund", reversalOfId: paid.payment!.id });
    expect(refund.reason).toBeNull();
    expect(refund.payment?.baseAmountMinor).toBe(14_000);
    expect(await bal(CLEARING, "SAR")).toBe(clearingSar + 10_000);
    expect(await bal(CLEARING, "YER")).toBe(clearingYer - 14_000);
    expect((await patientBuckets(p)).YER.dueMinor).toBe(14_000);
    await expectEveryCurrencyBalanced();
  });

  it("a voided direct expense leaves no expense and no cash movement in the books (L-03)", async () => {
    const cashYer = await bal("1101", "YER");
    const electricity = await bal("5502", "YER");
    const paid = await recordExpense({
      category: "electricity", partyId: null, payeeText: "مؤسسة الكهرباء", amountMinor: 5_000, currency: "YER",
      baseCurrency: "YER", exchangeRate: 1, payableId: null, note: null, createdBy: "cashier", rates: { ...RATES },
    });
    expect(paid.reason).toBeNull();
    expect(await bal("5502", "YER")).toBe(electricity + 5_000);
    const voided = await voidExpense(paid.expense!.id, { actor: "owner", actorRole: "admin", reason: "سند مكرر" });
    expect(voided.ok).toBe(true);
    expect(await bal("5502", "YER")).toBe(electricity);
    expect(await bal("1101", "YER")).toBe(cashYer);
    await expectEveryCurrencyBalanced();
  });
});

describe("Scenario 7 — manual journal currency validation (server side)", () => {
  it("refuses Dr Cash 100 SAR / Cr Revenue 100 YER even though the numbers are equal", async () => {
    await expect(createManualEntry({
      date: "2026-09-15", description: "قيد ممزوج", createdBy: "owner",
      lines: [
        { accountCode: "1102", currency: "SAR", amountMinor: 10_000, side: "debit" },
        { accountCode: "4101", currency: "YER", amountMinor: 10_000, side: "credit" },
      ],
    } as Parameters<typeof createManualEntry>[0])).rejects.toThrow(/عملة/);
    expect(await q(`SELECT id FROM journal_manual WHERE description = 'قيد ممزوج'`)).toHaveLength(0);
  });

  it("accepts a same-currency bank entry during an open shift and books its currency", async () => {
    const bankSar = await bal("1112", "SAR");
    const id = await createManualEntry({
      date: "2026-09-15", description: "تسوية سعودية", createdBy: "owner",
      lines: [
        { accountCode: "1112", currency: "SAR", amountMinor: 10_000, side: "debit" },
        { accountCode: "4101", currency: "SAR", amountMinor: 10_000, side: "credit" },
      ],
    } as Parameters<typeof createManualEntry>[0]);
    expect(id).toEqual(expect.any(Number));
    expect(await bal("1112", "SAR")).toBe(bankSar + 10_000);
    await expectEveryCurrencyBalanced();
  });

  it("historical manual lines (written before the currency column existed) are YER — the unit they were entered in", async () => {
    const [{ id }] = await q<{ id: number }>(
      `INSERT INTO journal_manual (entry_date, description, created_by) VALUES ('2026-01-10', 'قيد تاريخي', 'old') RETURNING id`);
    // إدراجٌ بلا عمود العملة — كما كتبته النسخة القديمة.
    await q(`INSERT INTO journal_manual_lines (entry_id, account_code, amount_minor, side) VALUES ($1, '5901', 700, 'debit'), ($1, '1101', 700, 'credit')`, [id]);
    const [row] = await q<{ currency: string }>(`SELECT DISTINCT currency FROM journal_manual_lines WHERE entry_id = $1`, [id]);
    expect(row.currency).toBe("YER");
    await expectEveryCurrencyBalanced();
  });
});

describe("Reconciliation — journal = patient ledgers = party statements = Executive, per currency", () => {
  it("AR, AP, expenses and cash agree across every read model", async () => {
    const rows = await balances();
    const kpis = await executiveKpis(FROM, TO);
    for (const currency of ["YER", "SAR", "USD"] as Currency[]) {
      const ledgerAr = rows.find((row) => row.code === "1201" && (row as { currency?: string }).currency === currency)?.balanceMinor ?? 0;
      const canonicalAr = kpis.receivableByCurrency.find((row) => row.currency === currency)?.dueMinor ?? 0;
      expect({ currency, ar: ledgerAr }).toEqual({ currency, ar: canonicalAr });

      const ledgerAp = ["2101", "2102", "2103", "2104", "2105"].reduce((sum, code) =>
        sum + (rows.find((row) => row.code === code && (row as { currency?: string }).currency === currency)?.balanceMinor ?? 0), 0);
      const canonicalAp = (await payablesByCurrency()).find((row) => row.currency === currency)?.dueMinor ?? 0;
      expect({ currency, ap: ledgerAp }).toEqual({ currency, ap: canonicalAp });

      const statement = incomeStatement(rows, currency);
      const execExpenses = (kpis as unknown as { expensesByCurrency: { currency: string; totalMinor: number }[] })
        .expensesByCurrency.find((row) => row.currency === currency)?.totalMinor ?? 0;
      expect({ currency, expenses: execExpenses }).toEqual({ currency, expenses: statement.totalExpensesMinor });

      const cash = (kpis as unknown as { cashMovements: { currency: string; netMinor: number }[] })
        .cashMovements.find((row) => row.currency === currency)?.netMinor ?? 0;
      const cashAccount = { YER: "1101", SAR: "1102", USD: "1103" }[currency];
      const ledgerCash = rows.find((row) => row.code === cashAccount && (row as { currency?: string }).currency === currency)?.balanceMinor ?? 0;
      expect({ currency, cash }).toEqual({ currency, cash: ledgerCash });

      /* الميزانية لكل عملة تتوازن وحدها. */
      expect(balanceSheet(rows, currency).differenceMinor).toBe(0);
    }
  });
});
