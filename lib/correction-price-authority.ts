import { checkInvoiceAuthority, type InvoiceAuthorityDecision, type InvoiceLineAuthorityInput } from "./invoice-pricing";
import type { PriceGrants } from "./price-authority";
import type { ForeignRates } from "./service-pricing";
import type { Currency } from "./money";

/**
 * Price and discount authority on a financial correction (canonical sessions; review request
 * 6801961109 on #483). The correction grant is not a price exception: owner decision G4-1 (price
 * changes by `finance.discounts.apply`, `finance.discounts.override`,
 * `finance.price-increases.apply`) applies to what the correction actually changes, compared with
 * the values stored under the writer's locks — not to the name of the operation and not to the
 * presence of a field in the request.
 *
 *  - A line whose unit price is unchanged (same currency, same service) is kept: it was decided
 *    and audited when it was set and is not decided again. Quantity, removal and descriptive
 *    changes are the correction's own purpose and need no price grant.
 *  - A line whose price changed (or whose service or currency changed) must end at a price the
 *    actor could have written on a new invoice: the catalogue price freely; above it by the
 *    increase grant; below it by the discount grant within `billing.max_discount_percent`, beyond
 *    it by the override grant. The correction reason is the written reason.
 *  - The invoice discount is decided when it changed: a different amount, a higher share of the
 *    total, or another currency. Removing it is free; any other changed discount must be one the
 *    actor could have given on a new invoice (with its own written reason).
 *  - A manual line without a catalogue service has no reference price and stays free, as on a new
 *    invoice (open question 3 for the owner).
 */
export interface CorrectionPriceLine {
  description: string;
  /** The catalogue service of the line after the correction; null for a manual line. */
  service: InvoiceLineAuthorityInput["service"];
  quantity: number;
  /** The unit price stored under the lock; null when the line has no stored price in this currency. */
  storedUnitMinor: number | null;
  requestedUnitMinor: number;
  serviceChanged: boolean;
}

export interface CorrectionPriceInput {
  lines: readonly CorrectionPriceLine[];
  /** Stored gross total and discount of the document, under the lock. */
  storedTotalMinor: number;
  storedDiscountMinor: number;
  /** Gross total and discount after the correction. */
  totalMinor: number;
  discountMinor: number;
  discountReason: string | null;
  /** The correction's written reason: the reason of every changed line price. */
  reason: string;
  currencyChanged: boolean;
  currency: Currency;
  rates: ForeignRates;
  maxDiscountPercent: number;
  grants: PriceGrants;
}

export interface CorrectionMoneyChanges { changedLines: boolean[]; discountChanged: boolean }

/** What the correction changes in prices and discount, by comparison with the stored values. */
export function correctionMoneyChanges(input: Pick<CorrectionPriceInput,
  "lines" | "storedTotalMinor" | "storedDiscountMinor" | "totalMinor" | "discountMinor" | "currencyChanged">): CorrectionMoneyChanges {
  const changedLines = input.lines.map(line => input.currencyChanged || line.serviceChanged || line.storedUnitMinor === null
    || line.requestedUnitMinor !== line.storedUnitMinor);
  const higherShare = BigInt(Math.max(0, input.discountMinor)) * BigInt(Math.max(0, input.storedTotalMinor))
    > BigInt(Math.max(0, input.storedDiscountMinor)) * BigInt(Math.max(0, input.totalMinor));
  const discountChanged = input.discountMinor > 0
    && (input.currencyChanged || input.discountMinor !== input.storedDiscountMinor || higherShare);
  return { changedLines, discountChanged };
}

export type CorrectionPriceDecision = InvoiceAuthorityDecision & { changes: CorrectionMoneyChanges };

export function checkCorrectionPriceAuthority(input: CorrectionPriceInput): CorrectionPriceDecision {
  const changes = correctionMoneyChanges(input);
  const lines: InvoiceLineAuthorityInput[] = input.lines.map((line, index) => changes.changedLines[index]
    ? { description: line.description, service: line.service, requestedMinor: line.requestedUnitMinor, quantity: line.quantity, explicit: true, reason: input.reason }
    // Kept: counted at its written price, never compared with the catalogue again.
    : { description: line.description, service: null, requestedMinor: line.requestedUnitMinor, quantity: line.quantity, explicit: false, reason: null });
  const decision = checkInvoiceAuthority({
    requireInvoiceManualReason: true, lines, currency: input.currency, rates: input.rates, role: "", grants: input.grants,
    maxDiscountPercent: input.maxDiscountPercent, totalMinor: input.totalMinor,
    discountMinor: changes.discountChanged ? input.discountMinor : 0, discountReason: changes.discountChanged ? input.discountReason : null,
  });
  return { ...decision, changes };
}

/** The grants a decision relied on: the actor must still hold them when the writer re-proves itself. */
export function grantsUsedByCorrection(decision: CorrectionPriceDecision, grants: PriceGrants): Array<keyof PriceGrants> {
  if (!decision.ok) return [];
  const used = new Set<keyof PriceGrants>();
  for (const override of decision.overrides) {
    // A service unpriced in this currency follows the invoice rule (a written reason), by no grant.
    if (override.kind === "unpriced") continue;
    if (override.kind === "increase") used.add("increase");
    else if (grants.discountOverride) used.add("discountOverride"); else used.add("discount");
  }
  if (decision.discount) { if (grants.discountOverride) used.add("discountOverride"); else used.add("discount"); }
  return [...used];
}
