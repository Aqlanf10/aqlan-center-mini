import { describe, expect, it } from "vitest";
import { buildCheckoutDueRecommendation, readCheckoutDueRecommendation, type CheckoutDueSource } from "../lib/checkout-due-recommendation";

const source = (overrides: Partial<CheckoutDueSource> = {}): CheckoutDueSource => ({
  kind: "approved_agreement", authorityId: 11, currency: "SAR", invoiceId: 21, openingCurrency: null,
  remainingMinor: 750, dueNowMinor: 150, available: true, ...overrides,
});
const build = (sources: CheckoutDueSource[], current = { SAR: 750 }, visitInvoiceId: number | null = null) =>
  buildCheckoutDueRecommendation({ patientId: 7, visitInvoiceId, current, sources });

describe("source-qualified checkout recommendation, never a payment command", () => {
  it("keeps a verified zero due distinct from positive future remaining", () => {
    expect(build([source({ dueNowMinor: 0 })])).toMatchObject({ collectionAction: "account", accountHref: "/patients/7?tab=account",
      currencies: [{ currency: "SAR", currentBalanceMinor: 750, dueNowMinor: 0, status: "verified", knownRemainingMinor: 750, otherRemainingMinor: 0 }] });
  });
  it("counts multiple sources once within each currency and never turns the sum into a target", () => {
    const result = buildCheckoutDueRecommendation({ patientId: 7, visitInvoiceId: null, current: { YER: 500, SAR: 1500, USD: 1000 }, sources: [
      source({ kind: "legacy_opening", authorityId: 1, currency: "YER", invoiceId: null, openingCurrency: "YER", remainingMinor: 500, dueNowMinor: 200 }),
      source(), source({ authorityId: 12, invoiceId: 22 }),
      source({ kind: "repayment_schedule", currency: "USD", remainingMinor: 1000, dueNowMinor: 300, invoiceId: 31 }),
    ] });
    expect(result.currencies.map(row => [row.currency, row.dueNowMinor])).toEqual([["YER", 200], ["SAR", 300], ["USD", 300]]);
    expect(result.collectionAction).toBe("account");
    expect(result).not.toHaveProperty("amountMinor");
  });
  it("a visit invoice already approved or scheduled contributes only the scheduled amount", () => {
    const result = build([source(), source({ kind: "visit_invoice", authorityId: 21, dueNowMinor: 750 })], { SAR: 750 }, 21);
    expect(result.currencies[0]).toMatchObject({ dueNowMinor: 150, knownRemainingMinor: 750 });
    expect(result.currencies[0].sources).toHaveLength(1);
    expect(result.collectionAction).toBe("account");
  });
  it.each(["invoice", "opening"] as const)("competing %s authorities are review/null, even when both numbers are individually verified", kind => {
    const target = kind === "opening" ? { invoiceId: null, openingCurrency: "SAR" as const } : {};
    const result = build([source(target), source({ ...target, kind: kind === "opening" ? "legacy_opening" : "repayment_schedule", authorityId: 42, dueNowMinor: 0 })]);
    expect(result.currencies[0]).toMatchObject({ status: "review_required", dueNowMinor: null, knownRemainingMinor: 750, otherRemainingMinor: 0,
      reasons: ["competing_authorities"] });
    expect(result.collectionAction).toBe("account");
  });
  it("unavailable or stale source is not a fabricated zero and does not suppress current debt", () => {
    const result = build([source({ dueNowMinor: null, available: false })]);
    expect(result.currencies[0]).toMatchObject({ currentBalanceMinor: 750, dueNowMinor: null, status: "review_required", reasons: ["source_unavailable"] });
  });
  it("unallocated account credit requires review instead of guessing which scheduled source it settled", () => {
    expect(build([source()], { SAR: 650 }).currencies[0]).toMatchObject({ status: "review_required", dueNowMinor: null, reasons: ["unallocated_credit"] });
  });
  it("retains other unscheduled debt separately without inventing its due policy", () => {
    expect(build([source()], { SAR: 950 }).currencies[0]).toMatchObject({ dueNowMinor: 150, knownRemainingMinor: 750, otherRemainingMinor: 200 });
  });
  it("preserves an ordinary unscheduled visit invoice's exact existing collection target", () => {
    const result = build([source({ kind: "visit_invoice", authorityId: 21, dueNowMinor: 750 })], { SAR: 750 }, 21);
    expect(result).toMatchObject({ collectionAction: "visit_invoice", visitInvoiceId: 21 });
    expect(result.currencies[0].dueNowMinor).toBe(750);
  });
  it("never retains untargeted account collection when no visit invoice exists", () => {
    const result = buildCheckoutDueRecommendation({ patientId: 7, visitInvoiceId: null, current: { YER: 1000 }, sources: [] });
    expect(result).toMatchObject({ collectionAction: "account", currencies: [{ dueNowMinor: 0, otherRemainingMinor: 1000 }] });
  });
  it("does not silently duplicate a repeated authority or accept unsafe money", () => {
    expect(() => build([source(), source()])).toThrow();
    expect(() => build([source({ dueNowMinor: 751 })])).toThrow();
    expect(() => build([source({ remainingMinor: Number.MAX_SAFE_INTEGER + 1 })])).toThrow();
    expect(() => build([source({ invoiceId: null, openingCurrency: "USD" })])).toThrow();
  });
  it("strict parser binds patient and visit identity and accepts only the complete verified shape", () => {
    const result = build([source()], { SAR: 750 }, 21);
    expect(readCheckoutDueRecommendation(result, 7, 21)).toEqual(result);
    expect(readCheckoutDueRecommendation(result, 8, 21)).toBeNull();
    expect(readCheckoutDueRecommendation(result, 7, 22)).toBeNull();
    expect(readCheckoutDueRecommendation({ ...result, currencies: [{ ...result.currencies[0], dueNowMinor: undefined }] }, 7, 21)).toBeNull();
    expect(readCheckoutDueRecommendation({ ...result, accountHref: "/patients/8?tab=account" }, 7, 21)).toBeNull();
    expect(readCheckoutDueRecommendation({ ...result, collectionAction: "visit_invoice" }, 7, 21)).toBeNull();
  });
});
