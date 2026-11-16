import { describe, expect, it } from "vitest";
import { checkInvoiceAuthority } from "../lib/invoice-pricing";

/** M2 slice 93b (owner decision G4-1): the invoice price controls by explicit grants. The
 * role label is ignored once grants are given; never wider than the legacy admin reach. */
const service = { priceMinor: 20_000, priceSarMinor: 5_000, priceUsdMinor: null, priceConfigured: true };
const unpriced = { priceMinor: 0, priceSarMinor: null, priceUsdMinor: null, priceConfigured: false };
const base = { currency: "YER" as const, rates: { SAR: 140, USD: 530 }, maxDiscountPercent: 10, totalMinor: 20_000, requireInvoiceManualReason: true };
const none = { discount: false, discountOverride: false, increase: false };
const line = (requestedMinor: number, reason: string | null, svc: typeof service | typeof unpriced = service) =>
  [{ description: "SYN service", service: svc, requestedMinor, quantity: 1, explicit: true, reason }];
const check = (lines: ReturnType<typeof line>, grants: typeof none, extra: { discountMinor?: number; discountReason?: string | null; role?: string } = {}) =>
  checkInvoiceAuthority({ ...base, lines, role: extra.role ?? "admin", discountMinor: extra.discountMinor ?? 0, discountReason: extra.discountReason ?? null, grants });

describe("invoice price authority by grants", () => {
  it("the catalogue price needs no price grant; the admin label grants nothing once grants are given", () => {
    expect(check(line(20_000, null), none)).toEqual({ ok: true, overrides: [], discount: null });
    expect(check(line(19_000, "SYN reason"), none, { role: "admin" }).ok).toBe(false);
    expect(check(line(21_000, "SYN reason"), none, { role: "admin" }).ok).toBe(false);
  });

  it("a line discount: discounts.apply within the ceiling with a reason; override beyond it", () => {
    expect(check(line(19_000, "SYN reason"), { ...none, discount: true })).toMatchObject({ ok: true, overrides: [{ kind: "discount", discountPercent: 5 }] });
    expect(check(line(19_000, null), { ...none, discount: true }).ok).toBe(false);
    expect(check(line(10_000, "SYN reason"), { ...none, discount: true }).ok).toBe(false);
    expect(check(line(10_000, "SYN reason"), { ...none, discountOverride: true }).ok).toBe(true);
  });

  it("an increase needs price-increases.apply with a reason; a discount grant never raises", () => {
    expect(check(line(21_000, "SYN reason"), { discount: true, discountOverride: true, increase: false }).ok).toBe(false);
    expect(check(line(21_000, null), { ...none, increase: true }).ok).toBe(false);
    expect(check(line(21_000, "SYN reason"), { ...none, increase: true })).toMatchObject({ ok: true, overrides: [{ kind: "increase" }] });
  });

  it("an unpriced service keeps the invoice rule: a written reason, no extra grant", () => {
    expect(check(line(5_000, null, unpriced), none).ok).toBe(false);
    expect(check(line(5_000, "SYN reason", unpriced), none)).toMatchObject({ ok: true });
  });

  it("an invoice discount needs a reason and discounts.apply; beyond the ceiling, alone or combined, override", () => {
    expect(check(line(20_000, null), none, { discountMinor: 1_000, discountReason: "SYN reason" }).ok).toBe(false);
    expect(check(line(20_000, null), { ...none, discount: true }, { discountMinor: 1_000, discountReason: null }).ok).toBe(false);
    expect(check(line(20_000, null), { ...none, discount: true }, { discountMinor: 1_000, discountReason: "SYN reason" })).toMatchObject({ ok: true, discount: { percent: 5 } });
    expect(check(line(20_000, null), { ...none, discount: true }, { discountMinor: 4_000, discountReason: "SYN reason" }).ok).toBe(false);
    // 8% on the line and 5% on the invoice: within each alone, beyond the ceiling combined.
    const combined = checkInvoiceAuthority({ ...base, lines: line(18_400, "SYN reason"), role: "reception", totalMinor: 18_400, discountMinor: 920, discountReason: "SYN reason", grants: { ...none, discount: true } });
    expect(combined.ok).toBe(false);
    expect(checkInvoiceAuthority({ ...base, lines: line(18_400, "SYN reason"), role: "reception", totalMinor: 18_400, discountMinor: 920, discountReason: "SYN reason", grants: { ...none, discountOverride: true } }).ok).toBe(true);
  });
});
