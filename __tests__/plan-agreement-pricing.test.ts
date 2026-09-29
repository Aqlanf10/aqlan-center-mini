import { describe, expect, it } from "vitest";
import { agreementPricedService, checkInvoiceAuthority } from "../lib/invoice-pricing";

/**
 * (FIN-5، قرار المالك TD-05) سلطة السعر على بند خطةٍ بعملة اتفاق: تُقاس فقط على سعرٍ
 * قرّره المالك بتلك العملة — لا على سعرٍ محوَّل من اليمني بسعر اليوم.
 */
const service = { priceMinor: 20000, priceSarMinor: null as number | null, priceUsdMinor: null as number | null, priceConfigured: true };
const decide = (svc: typeof service, currency: "YER" | "USD", requestedMinor: number, reason: string | null = null) =>
  checkInvoiceAuthority({
    lines: [{ description: "حشوة", service: agreementPricedService(svc, currency), requestedMinor, quantity: 1, explicit: true, reason }],
    currency, rates: { USD: 530 }, role: "reception", maxDiscountPercent: 10,
    totalMinor: requestedMinor, discountMinor: 0, discountReason: null,
  });

describe("(FIN-5) agreement-currency plan pricing", () => {
  it("base-currency plan: the catalog governs (1 instead of 20,000 is refused)", () => {
    expect(decide(service, "YER", 100, "سبب").ok).toBe(false);
  });
  it("USD plan without an owner-set USD price: the typed agreement price passes, flagged unpriced", () => {
    const result = decide(service, "USD", 100);
    expect(result).toMatchObject({ ok: true, overrides: [{ kind: "unpriced" }] });
  });
  it("USD plan with an owner-set USD price: the limit applies to that price", () => {
    const priced = { ...service, priceUsdMinor: 10000 };
    expect(decide(priced, "USD", 100, "خصم").ok).toBe(false);
    expect(decide(priced, "USD", 9500, "خصم متفق")).toMatchObject({ ok: true, overrides: [{ kind: "discount" }] });
  });
});
