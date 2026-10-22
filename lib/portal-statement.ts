import type { Invoice, OpeningBalance, Payment } from "./db";
import { invoiceNet, type Balance, type Currency } from "./money";
import { currentStatementInvoices, statementPaymentLabel } from "./statement-lines";

/**
 * (FIN-INT-8) What the patient portal may show of the ledger: the same current
 * documents and labels as the printed statement, and nothing internal. Staff
 * usernames, receipt and invoice notes, shifts, methods and row ids stay inside the
 * clinic; balances are passed through from the canonical calculation unchanged.
 */
export interface PortalStatementInvoice {
  invoiceNumber: string;
  createdAt: string;
  totalMinor: number;
  discountMinor: number;
  netMinor: number;
  status: "open" | "paid";
  baseCurrency: Currency;
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
  balances: Record<Currency, Balance>;
  baseCurrency: Currency;
}

export function portalStatementView(
  ledger: { invoices: readonly Invoice[]; payments: readonly Payment[]; openings: readonly OpeningBalance[] },
  balances: Record<Currency, Balance>,
  baseCurrency: Currency,
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
    balances,
    baseCurrency,
  };
}
