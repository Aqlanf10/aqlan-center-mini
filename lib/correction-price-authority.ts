import { checkInvoiceAuthority, type InvoiceAuthorityDecision, type InvoiceLineAuthorityInput } from "./invoice-pricing";
import type { PriceGrants } from "./price-authority";
import type { ForeignRates } from "./service-pricing";
import type { Currency } from "./money";
import { invoiceCatalogPrice } from "./invoice-catalog-price";

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
 *  - A manual line without a catalogue service (owner decision 2026-11-11, rule 3): lowering it
 *    is a discount measured against its FIXED reference, the price recorded before its first
 *    correction, so a limit cannot be passed by splitting one reduction into several corrections.
 *    Returning it to the reference is free. Raising it above the reference, including a first
 *    price on a line recorded at zero, is a price increase: the increase grant with the
 *    correction reason, as for a catalogue line (decided 2026-11-11 under the owner's delegation).
 *    Two cases have no reference to measure against: a currency change (no fair comparison
 *    exists between two currencies without an agreed price) and a reference that cannot be
 *    proven from the correction chain. They are never allowed silently and never measured
 *    against the stored price (that would reopen stepwise reductions): they need the FULL price
 *    authority, the increase grant and the discount-override grant together. The owner has
 *    both and may give them to whom he sees fit (owner principle, 2026-11-11); the new price then
 *    becomes the line's reference.
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
  /** Manual lines only: the fixed reference (the price recorded before the line's first correction), or unknown. */
  manualReference?: { known: true; unitMinor: number } | { known: false };
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

export type CorrectionPriceDecision = InvoiceAuthorityDecision & {
  changes: CorrectionMoneyChanges;
  /** Manual lines decided against their fixed reference (a discount below it, an increase above it). */
  manualLoweredLines: number;
  /** Manual lines with no reference to measure against, accepted by the full price authority. */
  fullAuthorityLines: number;
};

const FULL_AUTHORITY = "يحتاج سلطة السعر الكاملة: صلاحية تطبيق زيادة السعر وصلاحية تجاوز حد الخصم معًا. لم يُحفظ شيء.";

export function checkCorrectionPriceAuthority(input: CorrectionPriceInput): CorrectionPriceDecision {
  const changes = correctionMoneyChanges(input);
  const full = input.grants.increase && input.grants.discountOverride;
  const refuse = (message: string): CorrectionPriceDecision => ({ ok: false, message, changes, manualLoweredLines: 0, fullAuthorityLines: 0 });
  /* Manual lines (rule 3): the fixed reference stands in for the missing catalogue price. */
  const services: InvoiceLineAuthorityInput["service"][] = [];
  let manualLoweredLines = 0, fullAuthorityLines = 0;
  for (const [index, line] of input.lines.entries()) {
    if (!changes.changedLines[index] || line.service !== null) { services.push(line.service); continue; }
    const reference = line.manualReference;
    if (input.currencyChanged || line.serviceChanged || !reference || !reference.known) {
      if (!full) return refuse(input.currencyChanged
        ? `تغيير عملة فاتورة فيها بند يدوي بلا سعر دليل «${line.description}» ${FULL_AUTHORITY}`
        : `تعذّر إثبات السعر المرجعي للبند اليدوي «${line.description}» من سلسلة التصحيح؛ تغيير سعره ${FULL_AUTHORITY}`);
      fullAuthorityLines += 1; services.push(null); continue;
    }
    if (line.requestedUnitMinor === reference.unitMinor) { services.push(null); continue; }
    // Below the reference: a discount. Above it (or a first price on a zero line): an increase.
    manualLoweredLines += 1;
    services.push({ priceMinor: reference.unitMinor, priceSarMinor: reference.unitMinor, priceUsdMinor: reference.unitMinor, priceConfigured: true });
  }
  const lines: InvoiceLineAuthorityInput[] = input.lines.map((line, index) => changes.changedLines[index]
    ? { description: line.description, service: services[index], requestedMinor: line.requestedUnitMinor, quantity: line.quantity, explicit: true, reason: input.reason }
    // Kept: counted at its written price, never compared with the catalogue again.
    : { description: line.description, service: null, requestedMinor: line.requestedUnitMinor, quantity: line.quantity, explicit: false, reason: null });
  const decision = checkInvoiceAuthority({
    requireInvoiceManualReason: true, lines, currency: input.currency, rates: input.rates, role: "", grants: input.grants,
    maxDiscountPercent: input.maxDiscountPercent, totalMinor: input.totalMinor,
    discountMinor: changes.discountChanged ? input.discountMinor : 0, discountReason: changes.discountChanged ? input.discountReason : null,
  });
  return { ...decision, changes, manualLoweredLines, fullAuthorityLines };
}

/**
 * What a correction changed in prices and discount, for the audit row of BOTH paths (owner
 * decision 2026-11-11, rule 5): previous price, new price, the reference it is measured against
 * and the reason. Descriptive only: it decides nothing and is written for new operations only.
 */
export function describeCorrectionPriceChanges(input: Pick<CorrectionPriceInput,
  "lines" | "storedTotalMinor" | "storedDiscountMinor" | "totalMinor" | "discountMinor" | "discountReason" | "reason" | "currencyChanged" | "currency">) {
  const changes = correctionMoneyChanges(input);
  const reference = (line: CorrectionPriceLine) => {
    if (line.service) { const unitMinor = invoiceCatalogPrice(line.service, input.currency); return unitMinor === null ? { kind: "none" as const, unitMinor: null } : { kind: "catalogue" as const, unitMinor }; }
    return line.manualReference?.known ? { kind: "recorded" as const, unitMinor: line.manualReference.unitMinor } : { kind: "none" as const, unitMinor: null };
  };
  return {
    reason: input.reason, currency: input.currency, currencyChanged: input.currencyChanged,
    lines: input.lines.flatMap((line, index) => changes.changedLines[index]
      ? [{ description: line.description, previousUnitMinor: line.storedUnitMinor, newUnitMinor: line.requestedUnitMinor, reference: reference(line) }] : []),
    discount: input.discountMinor !== input.storedDiscountMinor || changes.discountChanged
      ? { previousMinor: input.storedDiscountMinor, newMinor: input.discountMinor, previousTotalMinor: input.storedTotalMinor, newTotalMinor: input.totalMinor, reason: input.discountReason } : null,
  };
}

/** The grants a decision relied on: the actor must still hold them when the writer re-proves itself. */
export function grantsUsedByCorrection(decision: CorrectionPriceDecision, grants: PriceGrants): Array<keyof PriceGrants> {
  if (!decision.ok) return [];
  const used = new Set<keyof PriceGrants>();
  if (decision.fullAuthorityLines > 0) { used.add("increase"); used.add("discountOverride"); }
  for (const override of decision.overrides) {
    // A service unpriced in this currency follows the invoice rule (a written reason), by no grant.
    if (override.kind === "unpriced") continue;
    if (override.kind === "increase") used.add("increase");
    else if (grants.discountOverride) used.add("discountOverride"); else used.add("discount");
  }
  if (decision.discount) { if (grants.discountOverride) used.add("discountOverride"); else used.add("discount"); }
  return [...used];
}
