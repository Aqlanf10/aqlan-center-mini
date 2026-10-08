import { describe, expect, it } from "vitest";
import { invoiceRemainingMinor, planAdminDiscount } from "../lib/invoice-discount";

// (FIN-DISC) Admin discount on an issued invoice: pure rules shared by route, db writer and screen.
const open = { status: "open", totalMinor: 100000, discountMinor: 10000, settledMinor: 30000 };

describe("admin discount after issue", () => {
  it("reduces only the remaining amount and reports before/after", () => {
    expect(invoiceRemainingMinor(open)).toBe(60000);
    expect(planAdminDiscount(open, 20000, 10000)).toEqual({ ok: true, beforeDiscountMinor: 10000, afterDiscountMinor: 30000,
      beforeNetMinor: 90000, afterNetMinor: 70000, remainingBeforeMinor: 60000, remainingAfterMinor: 40000 });
  });
  it("allows discounting the whole remaining but never what was already paid", () => {
    expect(planAdminDiscount(open, 60000, 10000)).toMatchObject({ ok: true, remainingAfterMinor: 0, afterNetMinor: 30000 });
    expect(planAdminDiscount(open, 60001, 10000)).toEqual({ ok: false, reason: "exceeds_remaining" });
    expect(planAdminDiscount({ ...open, settledMinor: 90000 }, 1, 10000)).toEqual({ ok: false, reason: "exceeds_remaining" });
  });
  it("refuses cancelled and paid invoices, stale previews and non-positive amounts", () => {
    expect(planAdminDiscount({ ...open, status: "cancelled" }, 1, 10000)).toEqual({ ok: false, reason: "cancelled" });
    expect(planAdminDiscount({ ...open, status: "paid" }, 1, 10000)).toEqual({ ok: false, reason: "paid" });
    expect(planAdminDiscount(open, 1, 0)).toEqual({ ok: false, reason: "stale" });
    for (const amount of [0, -5, 1.5, Number.NaN]) expect(planAdminDiscount(open, amount, 10000)).toEqual({ ok: false, reason: "invalid_amount" });
  });
  it("treats a net refund on the invoice as reducing what was paid, not as extra room above the net", () => {
    expect(invoiceRemainingMinor({ ...open, settledMinor: -5000 })).toBe(90000);
    expect(planAdminDiscount({ ...open, settledMinor: -5000 }, 90001, 10000)).toEqual({ ok: false, reason: "exceeds_remaining" });
  });
});
