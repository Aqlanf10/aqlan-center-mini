import { describe, expect, it } from "vitest";
import { checkPlanAgreementPricing } from "../lib/plan-agreement-pricing";

const item = { quantity: 1, unitPriceMinor: 30000, sessionCount: 1 };
const check = (input: Partial<Parameters<typeof checkPlanAgreementPricing>[0]> = {}) => checkPlanAgreementPricing({
  currency: "SAR", pricingMode: "agreed", total: "200", items: [item],
  installments: [{ amountMinor: 10000 }, { amountMinor: 10000 }], ...input,
});

describe("creation agreement amount containment", () => {
  it.each([undefined, "items", "agreed"])("rejects the 300 SAR item / 200 SAR agreement under mode %s", (pricingMode) => {
    expect(check({ pricingMode })).toMatchObject({ ok: false, code: "agreement_pricing_unsupported" });
  });
  it("also rejects an explicit uplift without changing item weights", () => {
    expect(check({ total: "400" })).toMatchObject({ ok: false, code: "agreement_pricing_unsupported" });
    expect(item).toEqual({ quantity: 1, unitPriceMinor: 30000, sessionCount: 1 });
  });
  it.each([undefined, "", null])("preserves legacy absent total %s and a partial schedule", (total) => {
    expect(check({ pricingMode: undefined, total, installments: [{ amountMinor: 10000 }] })).toEqual({ ok: true });
  });
  it.each([undefined, "items", "agreed"])("allows equal item agreements with a partial schedule in %s", (pricingMode) => {
    expect(check({ pricingMode, total: "300", installments: [{ amountMinor: 10000 }] })).toEqual({ ok: true });
  });
  it.each(["SAR", "USD", "YER"] as const)("compares rounded minor units in %s without a tolerance", (currency) => {
    const total = currency === "YER" ? "30000.4" : "300.004";
    expect(check({ currency, total })).toEqual({ ok: true });
    const difference = currency === "YER" ? "30000.6" : "300.006";
    expect(check({ currency, total: difference })).toMatchObject({ ok: false, code: "agreement_pricing_unsupported" });
  });
  it("uses existing Arabic amount parsing", () => {
    expect(check({ total: "٣٠٠٫٠٠" })).toEqual({ ok: true });
  });
  it("compares empty-item agreed amounts to the saved schedule principal", () => {
    expect(check({ items: [], total: "300", installments: [{ amountMinor: 10000 }] }))
      .toMatchObject({ ok: false, code: "agreement_pricing_unsupported" });
    expect(check({ items: [], total: "200" })).toEqual({ ok: true });
  });
  it.each([undefined, null, "", 0, "0", "-1", "invalid", "1e2", "9007199254740992"])("requires a positive agreed amount (%s)", (total) => {
    expect(check({ total })).toMatchObject({ ok: false, code: "invalid_agreement_total" });
  });
  it.each(["fixed", "schedule", "", null, false])("does not silently accept unknown pricing mode %s", (pricingMode) => {
    expect(check({ pricingMode, total: "300" })).toMatchObject({ ok: false, code: "agreement_pricing_unsupported" });
  });
  it("refuses declared item pricing with no items rather than changing its basis", () => {
    expect(check({ pricingMode: "items", items: [], total: undefined })).toMatchObject({ ok: false, code: "agreement_pricing_unsupported" });
  });
  it("matches engine rounding and refuses an unsafe computed sum", () => {
    expect(check({ total: "300", items: [{ ...item, quantity: 1.4, unitPriceMinor: 30000.4 }] })).toEqual({ ok: true });
    expect(check({ total: "300", items: [{ ...item, quantity: Number.MAX_SAFE_INTEGER }] }))
      .toMatchObject({ ok: false, code: "agreement_pricing_unsupported" });
  });
});
