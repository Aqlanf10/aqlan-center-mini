import type { Invoice, Payment } from "./db";

/**
 * The one patient-facing statement rule, shared by the printed statement and the
 * patient portal: a cancelled invoice is not a current document, and a reversal is
 * identified by its persisted edge, never by receipt-note text.
 */

/** Current patient copy only. Never use this filter for historical/as-of balances. */
export function currentStatementInvoices<T extends Pick<Invoice, "status">>(invoices: readonly T[]): T[] {
  return invoices.filter((invoice) => invoice.status !== "cancelled");
}

export function statementPaymentLabel(
  payment: Pick<Payment, "kind" | "reversalOfId">,
  payments: readonly Pick<Payment, "id" | "receiptNumber">[],
): string {
  if (payment.kind !== "refund") return "دفعة";
  if (!payment.reversalOfId) return "استرداد";
  const original = payments.find((candidate) => candidate.id === payment.reversalOfId);
  return original ? `عكس سند ${original.receiptNumber}` : "عكس سند سابق";
}
