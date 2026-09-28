import { describe, expect, it } from "vitest";
import { checkInvoiceAuthority } from "../lib/invoice-pricing";

/** (FIN-4) قواعد السعر والخصم على الفاتورة اليدوية — نفس سلطة الزيارة. */

const service = { priceMinor: 20_000, priceSarMinor: 5_000, priceUsdMinor: null, priceConfigured: true };
const base = { currency: "YER" as const, rates: { SAR: 140, USD: 530 }, maxDiscountPercent: 10, totalMinor: 20_000 };

describe("(FIN-4) checkInvoiceAuthority", () => {
  it("catalog price or no typed price is not an override", () => {
    const lines = [
      { description: "تبييض", service, requestedMinor: 20_000, quantity: 1, explicit: true, reason: null },
      { description: "تبييض", service, requestedMinor: 20_000, quantity: 1, explicit: false, reason: null },
    ];
    expect(checkInvoiceAuthority({ ...base, lines, role: "reception", discountMinor: 0, discountReason: null }))
      .toEqual({ ok: true, overrides: [], discount: null });
  });

  it("a lower typed price needs a reason; reception within the limit, admin beyond it", () => {
    const line = (requestedMinor: number, reason: string | null) =>
      [{ description: "تبييض", service, requestedMinor, quantity: 1, explicit: true, reason }];
    expect(checkInvoiceAuthority({ ...base, lines: line(19_000, null), role: "reception", discountMinor: 0, discountReason: null }).ok).toBe(false);
    expect(checkInvoiceAuthority({ ...base, lines: line(19_000, "طلب"), role: "reception", discountMinor: 0, discountReason: null }))
      .toMatchObject({ ok: true, overrides: [{ kind: "discount", discountPercent: 5, reason: "طلب" }] });
    expect(checkInvoiceAuthority({ ...base, lines: line(10_000, "طلب"), role: "reception", discountMinor: 0, discountReason: null }).ok).toBe(false);
    expect(checkInvoiceAuthority({ ...base, lines: line(10_000, "طلب"), role: "admin", discountMinor: 0, discountReason: null }).ok).toBe(true);
  });

  it("a foreign-currency invoice compares with the service's own price in that currency", () => {
    const lines = [{ description: "تبييض", service, requestedMinor: 4_000, quantity: 1, explicit: true, reason: "طلب" }];
    const decision = checkInvoiceAuthority({ ...base, currency: "SAR", lines, role: "reception", discountMinor: 0, discountReason: null });
    expect(decision).toEqual({ ok: false, message: "الخصم على «تبييض» 20٪ يتجاوز الحد المسموح (10٪) — يحتاج موافقة المدير." });
  });

  it("a free-text line (no service) is never compared", () => {
    const lines = [{ description: "يدوي", service: null, requestedMinor: 1, quantity: 1, explicit: true, reason: null }];
    expect(checkInvoiceAuthority({ ...base, lines, role: "reception", discountMinor: 0, discountReason: null }).ok).toBe(true);
  });

  it("an invoice discount needs a reason; its percent is against the lines' total", () => {
    const lines: never[] = [];
    expect(checkInvoiceAuthority({ ...base, lines, role: "reception", discountMinor: 1_000, discountReason: "" }))
      .toEqual({ ok: false, message: "اكتب سبب الخصم على الفاتورة." });
    expect(checkInvoiceAuthority({ ...base, lines, role: "reception", discountMinor: 2_000, discountReason: "مريض قديم" }))
      .toEqual({ ok: true, overrides: [], discount: { percent: 10, reason: "مريض قديم" } });
    expect(checkInvoiceAuthority({ ...base, lines, role: "reception", discountMinor: 2_100, discountReason: "مريض قديم" }).ok).toBe(false);
    expect(checkInvoiceAuthority({ ...base, lines, role: "admin", discountMinor: 20_000, discountReason: "إنسانية" }))
      .toEqual({ ok: true, overrides: [], discount: { percent: 100, reason: "إنسانية" } });
  });

  it("line and invoice discounts cannot stack past the limit (review): 18,000 + 1,800 off a 20,000 catalog is 19%", () => {
    const lines = [{ description: "تبييض", service, requestedMinor: 18_000, quantity: 1, explicit: true, reason: "طلب" }];
    const stacked = checkInvoiceAuthority({ ...base, totalMinor: 18_000, lines, role: "reception", discountMinor: 1_800, discountReason: "مريض قديم" });
    expect(stacked).toEqual({ ok: false, message: "مجموع الخصم (على أسعار البنود والفاتورة معًا) 19٪ يتجاوز الحد المسموح (10٪) — يحتاج موافقة المدير." });
    // خصم الفاتورة وحده على السعر الكامل حتى الحد يمرّ؛ والمدير يتجاوز.
    expect(checkInvoiceAuthority({ ...base, totalMinor: 18_000, lines, role: "admin", discountMinor: 1_800, discountReason: "مريض قديم" }).ok).toBe(true);
    const full = [{ description: "تبييض", service, requestedMinor: 20_000, quantity: 2, explicit: true, reason: null }];
    expect(checkInvoiceAuthority({ ...base, totalMinor: 40_000, lines: full, role: "reception", discountMinor: 4_000, discountReason: "مريض قديم" }).ok).toBe(true);
  });
});
