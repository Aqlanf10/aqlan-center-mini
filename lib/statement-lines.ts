import type { Invoice, Payment, TreatmentPlan } from "./db";

/**
 * The one patient-facing statement rule, shared by the printed statement and the
 * patient portal: a cancelled invoice is not a current document, and a reversal is
 * identified by its persisted edge, never by receipt-note text.
 */

/** Current patient copy only. Never use this filter for historical/as-of balances. */
export function currentStatementInvoices<T extends Pick<Invoice, "status">>(invoices: readonly T[]): T[] {
  return invoices.filter((invoice) => invoice.status !== "cancelled");
}

/**
 * Agreements shown on the patient copy: active plans whose total is an agreed amount rather
 * than the sum of their items. Their totals, paid and remaining come from the canonical plan
 * progress as-is; nothing is derived by adding agreement totals to invoices.
 */
export function statementAgreements<T extends Pick<TreatmentPlan, "status" | "totalFromItems"> & Partial<Pick<TreatmentPlan, "approvedAgreement">>>(plans: readonly T[]): T[] {
  return plans.filter((plan) => plan.status === "active" && !plan.totalFromItems && plan.approvedAgreement?.available !== false);
}

/** Unverified approval amounts are withheld, not presented as a settled agreement. */
export function statementAgreementsRequireReview(plans: readonly (Pick<TreatmentPlan, "status" | "totalFromItems"> & Partial<Pick<TreatmentPlan, "approvedAgreement">>)[]): boolean {
  return plans.some(plan => plan.status === "active" && plan.approvedAgreement?.available === false);
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
