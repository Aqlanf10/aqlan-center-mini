import type { Invoice, OpeningBalance, Payment, TreatmentPlan } from "./db";
import { invoiceNet, type Balance, type Currency } from "./money";
import { currentStatementInvoices, statementAgreements, statementPaymentLabel } from "./statement-lines";

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

export interface PortalStatementPayment {
  receiptNumber: string;
  createdAt: string;
  amountMinor: number;
  currency: Currency;
  kind: "payment" | "refund";
  label: string;
}

export interface PortalStatement {
  invoices: PortalStatementInvoice[];
  payments: PortalStatementPayment[];
  openings: { currency: Currency; amountMinor: number; asOfDate: string }[];
  agreements: PortalStatementAgreement[];
  balances: Record<Currency, Balance>;
  baseCurrency: Currency;
}

export function portalStatementView(
  ledger: { invoices: readonly Invoice[]; payments: readonly Payment[]; openings: readonly OpeningBalance[] },
  balances: Record<Currency, Balance>,
  baseCurrency: Currency,
  plans: readonly Pick<TreatmentPlan, "title" | "status" | "totalFromItems" | "totalMinor" | "baseCurrency" | "progress">[],
): PortalStatement {
  return {
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
      title: plan.title, currency: plan.baseCurrency, totalMinor: plan.totalMinor,
      paidMinor: plan.progress.paidMinor, remainingMinor: plan.progress.remainingMinor,
    })),
    balances,
    baseCurrency,
  };
}
