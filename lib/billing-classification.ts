import type { LegacyFinancialMode } from "./ortho-baseline";

/** The server's billing decision for one clinical work source. */
export type BillingClassification =
  | "INCLUDED"
  | "LEGACY_INCLUDED"
  | "NEW_BILLABLE"
  | "OUTSIDE_CONTRACT"
  | "NO_CHARGE";

/** BILL-1: the agreement invoices installments, so its linked sessions are included. */
export function classifyPlanSession(fundedByAgreement: boolean): BillingClassification {
  return fundedByAgreement ? "INCLUDED" : "NEW_BILLABLE";
}

/**
 * An orthodontic adjustment is a clinical record, not an invoice item. The
 * opening balance must exist in one unambiguous currency before we can say a
 * pre-system adjustment is covered by it. A paid-in-advance legacy case needs
 * no opening receivable. Other modes need an explicit billing decision; this
 * function must never infer a new invoice from the adjustment alone.
 */
export function classifyOrthoAdjustment(input: {
  legacy: boolean;
  financialMode: LegacyFinancialMode | null;
  openingCurrencies: readonly string[];
  fundedPlan: boolean;
}): BillingClassification {
  if (!input.legacy) return "OUTSIDE_CONTRACT";
  if (input.financialMode === "prepaid_included") return "LEGACY_INCLUDED";
  if (input.financialMode === "opening_balance") {
    return input.openingCurrencies.length === 1 ? "LEGACY_INCLUDED" : "OUTSIDE_CONTRACT";
  }
  if (input.financialMode === "installments" && input.fundedPlan) return "INCLUDED";
  return "OUTSIDE_CONTRACT";
}
