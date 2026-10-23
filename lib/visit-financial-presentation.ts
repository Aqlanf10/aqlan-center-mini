/** Absence of a direct invoice pointer establishes neither debt nor coverage. */
export const UNVERIFIED_VISIT_INVOICE_LABEL = "لا فاتورة مباشرة مثبتة";

/** Documentary identity only: current does not establish coverage or receipt status. */
export type VisitInvoiceReferenceState = "missing" | "current" | "cancelled" | "review";
