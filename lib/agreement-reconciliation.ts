import type { Currency } from "./money";

/** Native minor units, never a base-currency conversion or a plan-total ledger. */
export interface AgreementReconciliationAmounts {
  agreedMinor: number;
  billedPrincipalMinor: number | null;
  unbilledPrincipalMinor: number | null;
  paidMinor: number | null;
  remainingMinor: number | null;
  dueNowMinor: number | null;
}
export interface AgreementReconciliationCommand {
  operationKey: string;
  expectedSourceHash: string;
  reason: string;
}
export interface AgreementReconciliationReceipt {
  id: number;
  planId: number;
  patientId: number;
  operationKey: string;
  expectedSourceHash: string;
  deltaInvoiceId: number | null;
  amounts: AgreementReconciliationAmounts;
  cashMovementMinor: 0;
}
export interface AgreementReconciliationView {
  status: "preview" | "reconciled" | "review_required";
  planId: number;
  patientId: number;
  currency: Currency;
  sourceHash: string;
  amounts: AgreementReconciliationAmounts;
  sourceInvoices: { invoiceId: number; invoiceNumber: string; principalMinor: number; settledMinor: number; remainingMinor: number }[];
  blockers: { code: string; message: string }[];
  reconciliation: AgreementReconciliationReceipt | null;
  commission: { doctorId: number; doctorName: string; percent: number; incrementalAccruedMinor: number } | null;
  canConfirm: boolean;
}
export type AgreementReconciliationResult = {
  status: "reconciled";
  replayed: boolean;
  reconciliation: AgreementReconciliationReceipt;
  /** Receipt is durable proof; failure to read a fresh projection must not erase it. */
  view: AgreementReconciliationView | null;
};
export type AgreementReconciliationAttemptStatus =
  | { state: "committed"; receipt: AgreementReconciliationReceipt }
  | { state: "rejected"; planId: number; patientId: number; operationKey: string; expectedSourceHash: string;
      requestHash: string; observedSourceHash: string; rejectedAt: string; code: "agreement_source_changed" }
  | { state: "unresolved" };

/** Exact immutable command encoding shared with browser WebCrypto SHA-256.
 * Normalize reason once before persisting the command; never trim on replay. */
export function agreementReconciliationIntentText(planId: number, command: AgreementReconciliationCommand): string {
  return JSON.stringify([planId, command.operationKey, command.expectedSourceHash, command.reason]);
}

export function reconcileAgreementAmounts(input: {
  agreedMinor: number; billedPrincipalMinor: number; paidMinor: number; duePrincipalMinor: number;
}): AgreementReconciliationAmounts {
  if (!Object.values(input).every(value => Number.isSafeInteger(value) && value >= 0)
    || input.agreedMinor <= 0 || input.billedPrincipalMinor > input.agreedMinor
    || input.paidMinor > input.billedPrincipalMinor || input.duePrincipalMinor > input.agreedMinor) {
    throw new RangeError("Agreement sources require financial review");
  }
  const remainingMinor = input.agreedMinor - input.paidMinor;
  return { agreedMinor: input.agreedMinor, billedPrincipalMinor: input.billedPrincipalMinor,
    unbilledPrincipalMinor: input.agreedMinor - input.billedPrincipalMinor, paidMinor: input.paidMinor,
    remainingMinor, dueNowMinor: Math.min(remainingMinor, Math.max(0, input.duePrincipalMinor-input.paidMinor)) };
}
