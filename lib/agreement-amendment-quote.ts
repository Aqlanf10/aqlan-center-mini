/**
 * Domain contract for future append-only treatment-agreement amendments.
 *
 * This is deliberately a pure quote: it does not record debt, change an
 * approved plan, alter an invoice or authorize a commission. Only an atomic
 * command with owned-source, cash and ledger checks may post the adjustment.
 */
import type { Currency } from "./money";

export type AmendmentCommissionState = "pending_cost_evidence";
export type AgreementAmendmentQuote = {
  currency: Currency;
  previousServiceId: number;
  selectedServiceId: number;
  quantity: number;
  previousUnitPriceMinor: number;
  selectedUnitPriceMinor: number;
  oldTreatmentMinor: number;
  newTreatmentMinor: number;
  previousAgreementMinor: number;
  revisedAgreementMinor: number;
  deltaMinor: number;
  verifiedPaymentsMinor: number;
  verifiedRefundsMinor: number;
  settledMinor: number;
  remainingMinor: number;
  creditMinor: number;
  commissionState: AmendmentCommissionState;
  /**
   * Existing invoice and clinical history are immutable; this is a proposal
   * for an additional version, not an instruction to rewrite old items.
   */
  financialEventKind: "agreement_delta";
};
export type AgreementAmendmentProposal = {
  currency: Currency;
  quantity: number;
  previousServiceId: number;
  /** Explicit service selector, including on price-only amendments. */
  selectedServiceId: number;
  previousUnitPriceMinor: number;
  selectedUnitPriceMinor: number;
  /** Current net agreement value, inclusive of existing discount and revisions. */
  previousAgreementMinor: number;
  /** Actual credited receipts in the native agreement currency, not patient credit. */
  verifiedPaymentsMinor: number;
  /** Actual refunds applied to this exact source, not presumed reusable credit. */
  verifiedRefundsMinor: number;
  reason: string;
};

const amount = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const positive = (n: number): boolean => Number.isSafeInteger(n) && n > 0;
function sum(a: number, b: number): number {
  const n = a + b;
  if (!Number.isSafeInteger(n)) throw new RangeError("Agreement value exceeds safe monetary units.");
  return n;
}
function multiply(a: number, b: number): number {
  const n = a * b;
  if (!Number.isSafeInteger(n)) throw new RangeError("Treatment price exceeds safe monetary units.");
  return n;
}

/**
 * Quote ONLY from verified, same-source, same-currency settlement amounts.
 * A new service ID is never inferred from reason text or price.
 */
export function quoteAgreementAmendment(p: AgreementAmendmentProposal): AgreementAmendmentQuote {
  if (!["YER", "SAR", "USD"].includes(p.currency)) throw new TypeError("Invalid agreement currency.");
  if (!positive(p.previousServiceId) || !positive(p.selectedServiceId))
    throw new TypeError("An explicit selected service ID is required.");
  if (!positive(p.quantity) || !amount(p.previousUnitPriceMinor) || !amount(p.selectedUnitPriceMinor) ||
    !amount(p.previousAgreementMinor) || !amount(p.verifiedPaymentsMinor) || !amount(p.verifiedRefundsMinor))
    throw new TypeError("Invalid verified amendment amounts.");
  if (p.reason.trim().length < 3 || p.reason.trim().length > 300)
    throw new TypeError("A documented amendment reason is required.");
  const oldTreatmentMinor = multiply(p.quantity, p.previousUnitPriceMinor);
  const newTreatmentMinor = multiply(p.quantity, p.selectedUnitPriceMinor);
  const deltaMinor = sum(newTreatmentMinor, -oldTreatmentMinor);
  if (!deltaMinor && p.previousServiceId === p.selectedServiceId)
    throw new TypeError("The amendment has no changed service or price.");
  const revisedAgreementMinor = sum(p.previousAgreementMinor, deltaMinor);
  if (revisedAgreementMinor < 0) throw new RangeError("Amendment would create negative principal.");
  if (p.verifiedRefundsMinor > p.verifiedPaymentsMinor)
    throw new RangeError("Refunds exceed verified source payments.");
  const settledMinor = sum(p.verifiedPaymentsMinor, -p.verifiedRefundsMinor);
  const open = sum(revisedAgreementMinor, -settledMinor);
  return {
    currency: p.currency,
    previousServiceId: p.previousServiceId,
    selectedServiceId: p.selectedServiceId,
    quantity: p.quantity,
    previousUnitPriceMinor: p.previousUnitPriceMinor,
    selectedUnitPriceMinor: p.selectedUnitPriceMinor,
    oldTreatmentMinor,
    newTreatmentMinor,
    previousAgreementMinor: p.previousAgreementMinor,
    revisedAgreementMinor,
    deltaMinor,
    verifiedPaymentsMinor: p.verifiedPaymentsMinor,
    verifiedRefundsMinor: p.verifiedRefundsMinor,
    settledMinor,
    remainingMinor: Math.max(0, open),
    creditMinor: Math.max(0, -open),
    commissionState: "pending_cost_evidence",
    financialEventKind: "agreement_delta",
  };
}
