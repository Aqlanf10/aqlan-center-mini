import { CLINIC_BASE_CURRENCY, patientBalancesByCurrency, toCurrencyPaymentLikes } from "./money";
import { openingMinorsOf, type Invoice, type OpeningBalance, type Payment, type TreatmentPlan } from "./db";
import { planLedgerSummary } from "./plans";

/**
 * The patient account's money body, shared by the legacy route and the canonical read
 * (M2 slice 88) so both compute the same balances from the same snapshot rows.
 *
 * (TD-05) Balances by independent currency: every agreement currency has its bucket;
 * a payment settles its invoice's bucket when linked, its plan's when posted to it (paid
 * before billing), otherwise the base bucket — never one number mixing currencies.
 */
export function buildPatientLedgerPayload(input: {
  patientId: number; invoices: Invoice[]; payments: Payment[]; openings: OpeningBalance[]; plans: TreatmentPlan[];
}) {
  const { patientId: id, invoices, payments, openings, plans } = input;
  const balances = patientBalancesByCurrency(
    invoices.map((invoice) => ({
      totalMinor: invoice.totalMinor,
      discountMinor: invoice.discountMinor,
      status: invoice.status,
      baseCurrency: invoice.baseCurrency,
    })),
    toCurrencyPaymentLikes(
      id,
      payments.map((payment) => ({
        settlementAllocation: payment.settlementAllocation,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        exchangeRate: payment.exchangeRate,
        baseAmountMinor: payment.baseAmountMinor,
        kind: payment.kind,
        invoiceId: payment.invoiceId,
        planId: payment.planId,
        openingCurrency: payment.openingCurrency,
      })),
      // The reference carries its owner; this account's documents belong to this patient.
      new Map(invoices.map((invoice) => [invoice.id, { patientId: id, currency: invoice.baseCurrency }])),
      new Map(plans.map((plan) => [plan.id, { patientId: id, currency: plan.baseCurrency }])),
    ),
    openingMinorsOf(openings),
  );
  return {
    invoices, payments,
    // (P1-5b) opening: the base-currency row for legacy readers; openings: every currency.
    opening: openings.find((row) => row.currency === CLINIC_BASE_CURRENCY) ?? null, openings,
    // The single base-bucket view kept for readers of one field.
    balance: balances[CLINIC_BASE_CURRENCY], balances, baseCurrency: CLINIC_BASE_CURRENCY,
    // A plan is an agreement, not a debt; the account that hides one looks broken.
    plans: plans.map(planLedgerSummary),
  };
}
