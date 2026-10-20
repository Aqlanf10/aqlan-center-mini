import { CURRENCIES, isCurrency, type Currency } from "./money";

/** Read-only recommendation facts. These are never a payment request, an
 * allocation instruction, a new receivable, or a replacement for source proof. */
export interface CheckoutDueSource {
  kind: "approved_agreement" | "repayment_schedule" | "legacy_opening" | "visit_invoice";
  authorityId: number;
  currency: Currency;
  invoiceId: number | null;
  openingCurrency: Currency | null;
  remainingMinor: number;
  dueNowMinor: number | null;
  available: boolean;
}
type ReviewReason = "competing_authorities" | "source_unavailable" | "unallocated_credit";
export interface CheckoutCurrencyDueRecommendation {
  currency: Currency;
  currentBalanceMinor: number;
  knownRemainingMinor: number;
  otherRemainingMinor: number;
  dueNowMinor: number | null;
  status: "verified" | "review_required";
  reasons: ReviewReason[];
  sources: CheckoutDueSource[];
}
export interface CheckoutDueRecommendation {
  patientId: number;
  visitInvoiceId: number | null;
  accountHref: string;
  /** Only the existing, exact, unscheduled visit-invoice action may remain
   * inline. Any scheduled/multiple/review source needs canonical selection. */
  collectionAction: "visit_invoice" | "account" | "none";
  currencies: CheckoutCurrencyDueRecommendation[];
}
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const minor = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const sourceKinds = ["approved_agreement", "repayment_schedule", "legacy_opening", "visit_invoice"] as const;
const sourceFields = ["kind", "authorityId", "currency", "invoiceId", "openingCurrency", "remainingMinor", "dueNowMinor", "available"] as const;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function readSource(value: unknown): value is CheckoutDueSource {
  if (!record(value) || Object.keys(value).some(key => !sourceFields.includes(key as typeof sourceFields[number]))
    || !sourceKinds.includes(value.kind as CheckoutDueSource["kind"]) || !positiveId(value.authorityId) || !isCurrency(value.currency)
    || !minor(value.remainingMinor) || value.remainingMinor < 0 || typeof value.available !== "boolean"
    || !(value.dueNowMinor === null || minor(value.dueNowMinor) && value.dueNowMinor >= 0 && value.dueNowMinor <= value.remainingMinor)) return false;
  if (!(positiveId(value.invoiceId) && value.openingCurrency === null
    || value.invoiceId === null && value.openingCurrency === value.currency)) return false;
  if (value.kind === "legacy_opening" && value.invoiceId !== null || value.kind === "visit_invoice"
    && (!positiveId(value.invoiceId) || value.authorityId !== value.invoiceId || value.dueNowMinor !== value.remainingMinor)) return false;
  return !value.available || value.dueNowMinor !== null;
}
const sourceKey = (source: CheckoutDueSource) => `${source.currency}:${source.invoiceId === null ? `opening:${source.openingCurrency}` : `invoice:${source.invoiceId}`}`;
const authorityKey = (source: CheckoutDueSource) => `${source.kind}:${source.authorityId}:${sourceKey(source)}`;
function add(a: number, b: number): number {
  if (!Number.isSafeInteger(a + b)) throw new Error("Checkout due exceeds safe minor units");
  return a + b;
}

export function buildCheckoutDueRecommendation(input: {
  patientId: number; visitInvoiceId: number | null;
  current: Partial<Record<Currency, number>>; sources: readonly CheckoutDueSource[];
}): CheckoutDueRecommendation {
  if (!positiveId(input.patientId) || !(input.visitInvoiceId === null || positiveId(input.visitInvoiceId))
    || Object.entries(input.current).some(([currency, amount]) => !isCurrency(currency) || !minor(amount))
    || !input.sources.every(readSource)) throw new Error("Invalid checkout due source");
  const seen = new Set<string>();
  for (const source of input.sources) {
    const identity = authorityKey(source);
    if (seen.has(identity) || source.kind === "visit_invoice" && source.invoiceId !== input.visitInvoiceId) throw new Error("Duplicate or mismatched checkout authority");
    seen.add(identity);
  }
  // A scheduled visit invoice is one source, not its full remaining plus its
  // scheduled due. Competing non-visit authorities are retained for review.
  const sources = input.sources.filter(source => source.kind !== "visit_invoice"
    || !input.sources.some(other => other.kind !== "visit_invoice" && sourceKey(other) === sourceKey(source)))
    .map(source => ({ ...source })).sort((a, b) => authorityKey(a).localeCompare(authorityKey(b)));
  const currencies: CheckoutCurrencyDueRecommendation[] = [];
  for (const currency of CURRENCIES) {
    const currentBalanceMinor = input.current[currency] ?? 0;
    const rows = sources.filter(source => source.currency === currency);
    if (currentBalanceMinor === 0 && rows.length === 0) continue;
    const groups = new Map<string, CheckoutDueSource[]>();
    for (const source of rows) groups.set(sourceKey(source), [...(groups.get(sourceKey(source)) ?? []), source]);
    const reasons = new Set<ReviewReason>();
    let knownRemainingMinor = 0, verifiedDue = 0;
    for (const group of groups.values()) {
      // Readers must resolve one underlying source position in the same
      // snapshot. Conflicting remaining facts are not repaired by max or sum.
      if (group.some(source => source.remainingMinor !== group[0].remainingMinor)) throw new Error("Conflicting checkout source positions");
      knownRemainingMinor = add(knownRemainingMinor, group[0].remainingMinor);
      if (group.length > 1) reasons.add("competing_authorities");
      if (group.some(source => !source.available || source.dueNowMinor === null)) reasons.add("source_unavailable");
      if (group.length === 1 && group[0].available && group[0].dueNowMinor !== null) verifiedDue = add(verifiedDue, group[0].dueNowMinor);
    }
    if (knownRemainingMinor > Math.max(0, currentBalanceMinor)) reasons.add("unallocated_credit");
    currencies.push({ currency, currentBalanceMinor, knownRemainingMinor,
      otherRemainingMinor: Math.max(0, currentBalanceMinor - knownRemainingMinor),
      dueNowMinor: reasons.size ? null : verifiedDue,
      status: reasons.size ? "review_required" : "verified", reasons: [...reasons].sort(), sources: rows });
  }
  const needsAccount = sources.some(source => source.kind !== "visit_invoice") || currencies.some(row => row.status === "review_required");
  const inline = !needsAccount && sources.some(source => source.kind === "visit_invoice" && source.remainingMinor > 0);
  const hasPosition = currencies.some(row => row.currentBalanceMinor > 0 || row.status === "review_required");
  return { patientId: input.patientId, visitInvoiceId: input.visitInvoiceId, accountHref: `/patients/${input.patientId}?tab=account`,
    collectionAction: inline ? "visit_invoice" : hasPosition || needsAccount ? "account" : "none", currencies };
}

/** Strict response validation: no fallback zero, patient/visit substitution,
 * external navigation, unknown source status, or altered aggregate action.
 * The caller displays the received server result only after it passes. */
export function readCheckoutDueRecommendation(value: unknown, patientId: number, visitInvoiceId: number | null): CheckoutDueRecommendation | null {
  if (!record(value) || value.patientId !== patientId || value.visitInvoiceId !== visitInvoiceId
    || value.accountHref !== `/patients/${patientId}?tab=account` || !Array.isArray(value.currencies)) return null;
  try {
    const current: Partial<Record<Currency, number>> = {}, sources: CheckoutDueSource[] = [];
    for (const row of value.currencies) {
      if (!record(row) || !isCurrency(row.currency) || Object.hasOwn(current, row.currency) || !minor(row.currentBalanceMinor)
        || !Array.isArray(row.sources) || !row.sources.every(readSource) || row.sources.some(source => source.currency !== row.currency)) return null;
      current[row.currency] = row.currentBalanceMinor; sources.push(...row.sources);
    }
    const verified = buildCheckoutDueRecommendation({ patientId, visitInvoiceId, current, sources });
    if (value.collectionAction !== verified.collectionAction || value.currencies.length !== verified.currencies.length) return null;
    for (const [index, row] of verified.currencies.entries()) {
      const received = value.currencies[index] as Record<string, unknown>;
      for (const field of ["currency", "currentBalanceMinor", "knownRemainingMinor", "otherRemainingMinor", "dueNowMinor", "status"] as const) {
        if (received[field] !== row[field]) return null;
      }
      if (!Array.isArray(received.reasons) || received.reasons.length !== row.reasons.length
        || received.reasons.some((reason, i) => reason !== row.reasons[i])) return null;
      const actual = received.sources as CheckoutDueSource[];
      if (actual.length !== row.sources.length || actual.some((source, i) => sourceFields.some(field => source[field] !== row.sources[i][field]))) return null;
    }
    return value as unknown as CheckoutDueRecommendation;
  } catch { return null; }
}
