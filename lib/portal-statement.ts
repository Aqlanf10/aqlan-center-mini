import type { Invoice, OpeningBalance, Payment, TreatmentPlan } from "./db";
import { invoiceNet, type Balance, type Currency } from "./money";
import { currentStatementInvoices, statementAgreements, statementAgreementsRequireReview, statementPaymentLabel } from "./statement-lines";
import type { HistoricalOpeningBucket } from "./statement-historical-details";

/**
 * (FIN-INT-8) What the patient portal may show of the ledger: the same current
 * documents and labels as the printed statement, and nothing internal. Staff
 * usernames, receipt and invoice notes, shifts, methods and row ids stay inside the
 * clinic; balances are passed through from the canonical calculation unchanged.
 */
/** The treatment line as printed on the statement: no line, service, doctor or lineage ids. */
export interface PortalStatementLine {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
}

export interface PortalStatementInvoice {
  invoiceNumber: string;
  createdAt: string;
  totalMinor: number;
  discountMinor: number;
  netMinor: number;
  status: "open" | "paid";
  baseCurrency: Currency;
  items: PortalStatementLine[];
}

/** An agreement as printed on the statement, in its own currency, from the canonical plan progress. */
export interface PortalStatementAgreement {
  title: string;
  currency: Currency;
  totalMinor: number;
  paidMinor: number;
  remainingMinor: number;
}

/** A previous-treatment line as printed: no document, revision, service or tooth-code ids. */
export interface PortalHistoricalLine {
  description: string;
  site: string | null;
  quantity: 1;
  /** null where none was recorded (never an invented zero). */
  unitPriceMinor: number | null;
  discountMinor: number | null;
  netMinor: number;
}

/** A historical treatment agreement exactly as the current printed statement shows it. */
export interface PortalHistoricalAgreement {
  historicalAsOf: string;
  currency: Currency;
  lines: PortalHistoricalLine[];
  grossMinor: number | null;
  discountMinor: number | null;
  agreedMinor: number;
  previouslyPaidMinor: number;
  remainingMinor: number;
}

/**
 * «العلاج السابق»: saved historical facts, not invoices or receipts. `available: false` means a stored
 * historical fact failed validation; the section is withheld (nothing guessed) while balances, invoices
 * and receipts, which never depend on it, are still shown.
 */
export type PortalHistoricalTreatment =
  | { available: true; agreements: PortalHistoricalAgreement[]; undetailed: { currency: Currency; partial: boolean }[] }
  | { available: false };

export interface PortalStatementPayment {
  receiptNumber: string;
  createdAt: string;
  amountMinor: number;
  currency: Currency;
  kind: "payment" | "refund";
  label: string;
}

export interface PortalStatement {
  agreementsRequireReview?: boolean;
  invoices: PortalStatementInvoice[];
  payments: PortalStatementPayment[];
  openings: { currency: Currency; amountMinor: number; asOfDate: string }[];
  agreements: PortalStatementAgreement[];
  historical: PortalHistoricalTreatment;
  balances: Record<Currency, Balance>;
  baseCurrency: Currency;
}

/** Same buckets the print renders (historicalOpeningBuckets), reduced to the allowed fields. */
export function portalHistoricalTreatment(buckets: readonly HistoricalOpeningBucket[] | null): PortalHistoricalTreatment {
  if (buckets === null) return { available: false };
  return {
    available: true,
    agreements: buckets.flatMap((bucket) => bucket.agreements).map((agreement) => ({
      historicalAsOf: agreement.historicalAsOf,
      currency: agreement.currency,
      lines: agreement.lines.map((line) => ({
        description: line.description, site: line.site, quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor, discountMinor: line.discountMinor, netMinor: line.netMinor,
      })),
      grossMinor: agreement.grossMinor,
      discountMinor: agreement.discountMinor,
      agreedMinor: agreement.agreedMinor,
      previouslyPaidMinor: agreement.previouslyPaidMinor,
      remainingMinor: agreement.remainingMinor,
    })),
    undetailed: buckets.filter((bucket) => bucket.openingWithoutStoredDetail)
      .map((bucket) => ({ currency: bucket.currency, partial: bucket.agreements.length > 0 })),
  };
}

export function portalStatementView(
  ledger: { invoices: readonly Invoice[]; payments: readonly Payment[]; openings: readonly OpeningBalance[] },
  balances: Record<Currency, Balance>,
  baseCurrency: Currency,
  plans: readonly Pick<TreatmentPlan, "title" | "status" | "totalFromItems" | "totalMinor" | "baseCurrency" | "progress" | "approvedAgreement">[],
  historicalBuckets: readonly HistoricalOpeningBucket[] | null,
): PortalStatement {
  return {
    ...(statementAgreementsRequireReview(plans) ? { agreementsRequireReview: true } : {}),
    invoices: currentStatementInvoices(ledger.invoices).map((invoice) => ({
      invoiceNumber: invoice.invoiceNumber,
      createdAt: invoice.createdAt,
      totalMinor: invoice.totalMinor,
      discountMinor: invoice.discountMinor,
      netMinor: invoiceNet(invoice),
      status: invoice.status === "paid" ? "paid" : "open",
      baseCurrency: invoice.baseCurrency,
      items: invoice.items.map((item) => ({
        description: item.description, quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, totalMinor: item.totalMinor,
      })),
    })),
    payments: ledger.payments.map((payment) => ({
      receiptNumber: payment.receiptNumber,
      createdAt: payment.createdAt,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      kind: payment.kind,
      label: statementPaymentLabel(payment, ledger.payments),
    })),
    openings: ledger.openings.map((opening) => ({
      currency: opening.currency, amountMinor: opening.amountMinor, asOfDate: opening.asOfDate,
    })),
    agreements: statementAgreements(plans).map((plan) => ({
      title: plan.title, currency: plan.baseCurrency, totalMinor: plan.approvedAgreement ? plan.progress.totalMinor : plan.totalMinor,
      paidMinor: plan.progress.paidMinor, remainingMinor: plan.progress.remainingMinor,
    })),
    historical: portalHistoricalTreatment(historicalBuckets),
    balances,
    baseCurrency,
  };
}
