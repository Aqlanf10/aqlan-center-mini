import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signerDoctorPartyId } from "./_signer";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (FIA) سيناريوهات المطابقة المالية — ONE EVENT → ONE FINANCIAL TRUTH، على PostgreSQL 18.
 *
 * A: زيارة سريرية ← توقيع (مرة واحدة ولو نُقر مرتين) ← فاتورة ← تحصيل ← الوردية ← الدفاتر ← التقارير:
 *    الرقم نفسه في كل شاشة.
 * B: توريد مخزون 100 قفاز × 2,500 ر.ي من مورّد ← المخزون +100 ← التزام 250,000 ← كشف المورّد ←
 *    سداد 100,000 ثم الباقي ← المتبقي 0 — ولا يغيّر السداد كمية المخزون.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, openShift, closeShift, getOpenShift, setVisitProcedures, signClinicalVisit,
  recordPayment, patientLedger, patientPlanCurrencies, ledgerBalancesByCurrency, journalEntries, financeSummary,
  createInventoryMovement, partyStatement, recordExpense, getInventoryItemDetail,
} = db;
const { trialBalance, isBalanced } = await import("../../lib/accounting");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}
const today = "2000-01-01";
const far = "2099-12-31";
/* (TD-REG-028) الرصيد لـ(حساب، عملة) — السيناريوهان باليمني. */
const balanceOf = async (code: string, currency: "YER" | "SAR" | "USD" = "YER") =>
  trialBalance(await journalEntries(today, far)).find((row) => row.code === code && row.currency === currency)?.balanceMinor ?? 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("Scenario A — clinical visit → invoice → collection → shift → accounting → reports", () => {
  it("one signed visit = one invoice (double click / retry), and the same 30,000 everywhere", async () => {
    const [{ id: patientId }] = await q<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('A-1', 'مريض السيناريو أ') RETURNING id`);
    const [{ id: serviceId }] = await q<{ id: number }>(
      `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('حشوة', 30000, TRUE, TRUE, 'filling') RETURNING id`);
    const [{ id: visitId }] = await q<{ id: number }>(
      `INSERT INTO visits (patient_name, status, patient_id, arrived_at) VALUES ('مريض السيناريو أ', 'in_chair', $1, NOW()) RETURNING id`, [patientId]);
    await setVisitProcedures({
      visitId,
      procedures: [{ serviceId, toothCode: 16, surfaces: null, quantity: 1, unitPriceMinor: 30000, priceReason: null, doctorId: null, note: null, planItemId: null }],
    });

    /* نقرتان متزامنتان على «إنهاء»: توقيعٌ واحد وفاتورةٌ واحدة، والثانية «موقَّعة سلفًا». */
    const [first, second] = await Promise.all([
      signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: await signerDoctorPartyId() }),
      signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: await signerDoctorPartyId() }),
    ]);
    const reasons = [first.reason, second.reason].sort();
    expect(reasons).toEqual([null, "already_signed"].sort());
    const invoices = await q<{ id: number; total_minor: string }>(`SELECT id, total_minor::text FROM invoices WHERE patient_id = $1`, [patientId]);
    expect(invoices).toEqual([{ id: expect.any(Number), total_minor: "30000" }]);
    const invoiceId = invoices[0].id;
    /* وإعادة المحاولة بعد النجاح لا تولد فاتورة. */
    expect((await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: await signerDoctorPartyId() })).reason).toBe("already_signed");
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toHaveLength(1);

    const arBefore = await balanceOf("1201");
    const collected = await recordPayment({
      patientId, invoiceId, kind: "payment", amountMinor: 30000, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, method: "cash", note: null, createdBy: "cashier",
    });
    expect(collected.reason).toBeNull();

    /* حساب المريض: مسدَّد بعملته. */
    const ledger = await patientLedger(patientId);
    const balances = ledgerBalancesByCurrency(patientId, ledger, await patientPlanCurrencies(patientId));
    expect(balances.YER).toMatchObject({ billedMinor: 30000, collectedMinor: 30000, dueMinor: 0 });

    /* الدفاتر: الإيراد 30,000 والذمم صفرية والصندوق +30,000 — وكل قيدٍ متوازن. */
    const entries = await journalEntries(today, far);
    for (const entry of entries) expect(isBalanced(entry)).toBe(true);
    expect(await balanceOf("4101")).toBe(30000);
    expect(await balanceOf("1201")).toBe(arBefore - 30000);
    expect(await balanceOf("1201")).toBe(0);
    expect(await balanceOf("1101")).toBe(30000);

    /* التقرير المالي: قُبض 30,000 وفُوتر 30,000. */
    const summary = await financeSummary(today, far);
    expect(summary.income.baseTotalMinor).toBe(30000);
    expect(summary.invoicedByCurrency.YER).toBe(30000);

    /* الوردية: المتوقَّع في الدرج = الافتتاحي + المقبوض نقدًا − المصروف. */
    const shift = await getOpenShift();
    const closed = await closeShift({ id: shift!.id, closedBy: "cashier", counted: { YER: 30000, SAR: 0, USD: 0 }, note: null });
    expect(closed.reason).toBeNull();
    expect(closed.breakdown?.expected.YER).toBe(30000);
    expect(closed.difference).toEqual({ YER: 0, SAR: 0, USD: 0 });
    await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  });
});

describe("Scenario B — stock purchase → inventory → supplier payable → payment → accounting → reports", () => {
  it("100 gloves × 2,500 YER: stock +100, payable 250,000; paying 100,000 then 150,000 leaves 0 and never moves the stock", async () => {
    const [{ id: itemId }] = await q<{ id: number }>(
      `INSERT INTO inventory_items (name, category, unit, min_level, created_by) VALUES ('قفازات', 'other', 'علبة', 2, 't') RETURNING id`);
    const [{ id: supplierId }] = await q<{ id: number }>(`INSERT INTO parties (name, kind) VALUES ('مورد القفازات', 'supplier') RETURNING id`);

    const purchase = await createInventoryMovement({
      itemId, kind: "in", qty: 100, unitCostMinor: 2500, supplierPartyId: supplierId, supplierDueDate: "2099-01-31", createdBy: "store",
    });
    if (!purchase.ok) throw new Error(purchase.message);
    expect(purchase.balance).toBe(100);
    expect(purchase.movement).toMatchObject({ partyId: supplierId, payableId: expect.any(Number) });

    const detail = await getInventoryItemDetail(itemId);
    expect(detail?.item.balance).toBe(100);

    const statement = await partyStatement(supplierId);
    expect(statement.totals).toEqual([expect.objectContaining({ currency: "YER", owedMinor: 250_000, remainingMinor: 250_000 })]);
    const payableId = statement.payables[0].id;

    const pay = (amount: number) => recordExpense({
      category: "supplier", partyId: supplierId, payeeText: null, amountMinor: amount, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, payableId, note: null, createdBy: "cashier", rates: { YER: 1 },
    });
    expect((await pay(100_000)).reason).toBeNull();
    expect((await partyStatement(supplierId)).totals[0]).toMatchObject({ settledMinor: 100_000, remainingMinor: 150_000 });
    expect((await pay(150_000)).reason).toBeNull();
    expect((await partyStatement(supplierId)).totals[0]).toMatchObject({ settledMinor: 250_000, remainingMinor: 0 });
    expect((await pay(1)).reason).toBe("exceeds_payable");

    /* السداد لا يمسّ المخزون. */
    const after = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM inventory_movements WHERE item_id = $1`, [itemId]);
    expect(after[0].n).toBe(1);

    /* الدفاتر: الالتزام دائن الذمم 250,000 والسدادان مدينها — الذمم صفرية؛ والصندوق نقص 250,000. */
    expect(await balanceOf("2101")).toBe(0);
    const summary = await financeSummary(today, far);
    expect(summary.openingSettlements.baseTotalMinor).toBe(0);
  });
});
