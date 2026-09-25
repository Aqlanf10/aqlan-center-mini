import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P1-5b) Opening balances keep their currency on PostgreSQL 18: one row per
 * (patient, currency), payable in that currency, visible per bucket in the ledger,
 * the debt report and the commission engine — and never converted.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  ensureSchema, getPool, resetPoolForTesting, openShift, recordPayment, setPatientOpeningBalance,
  clearPatientOpeningBalance, patientLedger, openingMinorsOf, patientDebtReport, listOpeningBalanceHistory,
  commissionReport,
} = await import("../../lib/db");
const { patientBalancesByCurrency, toCurrencyPaymentLikes, CLINIC_BASE_CURRENCY } = await import("../../lib/money");

let patientId = 0;

async function balancesOf(id: number) {
  const { invoices, payments, openings } = await patientLedger(id);
  return patientBalancesByCurrency(
    invoices.map((invoice) => ({
      totalMinor: invoice.totalMinor, discountMinor: invoice.discountMinor, status: invoice.status, baseCurrency: invoice.baseCurrency,
    })),
    toCurrencyPaymentLikes(id, payments.map((payment) => ({
      amountMinor: payment.amountMinor, currency: payment.currency, exchangeRate: payment.exchangeRate,
      baseAmountMinor: payment.baseAmountMinor, kind: payment.kind, invoiceId: payment.invoiceId,
      planId: payment.planId, openingCurrency: payment.openingCurrency, id: payment.id,
    })), new Map(invoices.map((invoice) => [invoice.id, { patientId: id, currency: invoice.baseCurrency }])), new Map()),
    openingMinorsOf(openings),
  );
}

const pay = (input: Partial<Parameters<typeof recordPayment>[0]>) => recordPayment({
  patientId, invoiceId: null, kind: "payment", amountMinor: 1, currency: "YER",
  baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 1, method: "cash", note: null, createdBy: "ob-test",
  ...input,
});

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await ensureSchema(); // the migration body is idempotent on an existing schema
  await openShift({ openedBy: "ob-test", opening: { YER: 0, SAR: 0, USD: 0 } });
  const { rows: [patient] } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ('OB-1', 'رصيد بعملاته') RETURNING id`);
  patientId = patient.id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("opening balance currency", () => {
  it("keeps a YER and a SAR opening side by side, each with its own history", async () => {
    await setPatientOpeningBalance({ patientId, amountMinor: 100000, asOfDate: "2026-09-01", note: null, createdBy: "ob-test" });
    const sar = await setPatientOpeningBalance({
      patientId, currency: "SAR", amountMinor: 79300, asOfDate: "2026-09-01", note: "تقويم", createdBy: "ob-test",
    });
    expect(sar).toMatchObject({ currency: "SAR", amountMinor: 79300 });
    const { openings } = await patientLedger(patientId);
    expect(openings.map((row) => [row.currency, row.amountMinor])).toEqual([["SAR", 79300], ["YER", 100000]]);
    const history = await listOpeningBalanceHistory(patientId);
    expect(history.map((row) => row.currency).sort()).toEqual(["SAR", "YER"]);
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_constraint WHERE conname = 'patient_opening_balances_pkey'`);
    expect(rows[0].n).toBe("1");
  });

  it("a SAR payment on the SAR opening settles the SAR bucket; YER is untouched", async () => {
    const result = await pay({ amountMinor: 50000, currency: "SAR", exchangeRate: 425, openingCurrency: "SAR" });
    expect(result.reason).toBeNull();
    expect(result.payment?.openingCurrency).toBe("SAR");
    const balances = await balancesOf(patientId);
    expect(balances.SAR.dueMinor).toBe(29300);
    expect(balances.YER.dueMinor).toBe(100000);

    const debts = (await patientDebtReport()).filter((row) => row.patientId === patientId);
    expect(debts.map((row) => [row.currency, row.dueMinor, row.openingMinor]).sort()).toEqual([
      ["SAR", 29300, 79300], ["YER", 100000, 100000],
    ]);
  });

  it("refuses a foreign payment against a missing or other-currency opening, and more than one target", async () => {
    expect((await pay({ amountMinor: 100, currency: "USD", exchangeRate: 1600, openingCurrency: "USD" })).reason)
      .toBe("invalid_opening_target");
    expect((await pay({ amountMinor: 100, currency: "USD", exchangeRate: 1600, openingCurrency: "SAR" })).reason)
      .toBe("cross_currency_not_supported");
    const { rows: [invoice] } = await getPool().query<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
       VALUES ('OB-INV-1', $1, 5000, 0, 'SAR') RETURNING id`, [patientId]);
    expect((await pay({ amountMinor: 100, currency: "SAR", exchangeRate: 425, invoiceId: invoice.id, openingCurrency: "SAR" })).reason)
      .toBe("multiple_payment_targets");
  });

  it("the database itself refuses an opening target combined with an invoice", async () => {
    const { rows: [shift] } = await getPool().query<{ id: number }>(`SELECT id FROM cashier_shifts WHERE status = 'open'`);
    const { rows: [invoice] } = await getPool().query<{ id: number }>(`SELECT id FROM invoices WHERE invoice_number = 'OB-INV-1'`);
    await expect(getPool().query(
      `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate,
                             base_amount_minor, base_currency, method, created_by, opening_currency)
       VALUES ('R-OB-X', $1, $2, $3, 'payment', 100, 'SAR', 425, 42500, 'YER', 'cash', 't', 'SAR')`,
      [patientId, invoice.id, shift.id],
    )).rejects.toThrow(/payments_opening_currency_check/);
  });

  it("a refund of an opening payment inherits its target", async () => {
    const { payment } = await pay({ amountMinor: 10000, currency: "SAR", exchangeRate: 425, openingCurrency: "SAR" });
    const refund = await recordPayment({
      patientId, invoiceId: null, kind: "refund", amountMinor: 4000, currency: "SAR",
      baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 425, method: "cash", note: null, createdBy: "ob-test",
      reversalOfId: payment!.id,
    });
    expect(refund.reason).toBeNull();
    expect(refund.payment?.openingCurrency).toBe("SAR");
    // 29,300 remaining opening + the 5,000 SAR invoice from the previous case − 10,000 paid + 4,000 refunded.
    expect((await balancesOf(patientId)).SAR.dueMinor).toBe(29300 + 5000 - 10000 + 4000);
  });

  it("clearing one currency leaves the other", async () => {
    expect(await clearPatientOpeningBalance(patientId, "ob-test", "تصحيح", "YER")).toBe(true);
    const { openings } = await patientLedger(patientId);
    expect(openings.map((row) => row.currency)).toEqual(["SAR"]);
  });

  it("a SAR payment on a SAR opening earns no commission; the same payment on a SAR invoice does", async () => {
    const { rows: [doctor] } = await getPool().query<{ id: number }>(
      `INSERT INTO parties (name, kind, commission_percent) VALUES ('د. عمولة الرصيد', 'doctor', 50) RETURNING id`);
    const { rows: [other] } = await getPool().query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('OB-2', 'رصيد وعمولة') RETURNING id`);
    await setPatientOpeningBalance({ patientId: other.id, currency: "SAR", amountMinor: 20000, asOfDate: "2026-09-01", note: null, createdBy: "ob-test" });
    const { rows: [invoice] } = await getPool().query<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
       VALUES ('OB-INV-2', $1, 20000, 0, 'SAR', 't') RETURNING id`, [other.id]);
    await getPool().query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor, doctor_id)
       VALUES ($1, 'تقويم', 1, 20000, 20000, $2)`, [invoice.id, doctor.id]);
    const earned = async () => (await commissionReport("2026-01-01", "2030-01-01"))
      .filter((row) => row.doctorId === doctor.id && row.currency === "SAR")
      .reduce((sum, row) => sum + row.earnedMinor, 0);

    const onOpening = await recordPayment({
      patientId: other.id, invoiceId: null, openingCurrency: "SAR", kind: "payment", amountMinor: 20000, currency: "SAR",
      baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 425, method: "cash", note: null, createdBy: "ob-test",
    });
    expect(onOpening.reason).toBeNull();
    expect(await earned()).toBe(0);

    const onInvoice = await recordPayment({
      patientId: other.id, invoiceId: invoice.id, kind: "payment", amountMinor: 20000, currency: "SAR",
      baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 425, method: "cash", note: null, createdBy: "ob-test",
    });
    expect(onInvoice.reason).toBeNull();
    expect(await earned()).toBe(10000);
  });
});

