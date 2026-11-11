/** Owner decision 2026-11-11 (finance point 1): the doctor's percentage is taken after the invoice
 * discount. Pure tests of the exact allocation and of the engine on discounted shares. */
import { describe, expect, it } from "vitest";
import { allocateInvoiceDiscount, commissionForPatient, type CommissionInvoice } from "../lib/commission";

describe("allocateInvoiceDiscount", () => {
  it("spreads the discount in proportion, in whole units, adding up exactly", () => {
    expect(allocateInvoiceDiscount([60_000, 40_000], 20_000)).toEqual([12_000, 8_000]);
    // 1,000 over three equal lines: 334 + 333 + 333, the odd unit to the earliest line.
    expect(allocateInvoiceDiscount([10_000, 10_000, 10_000], 1_000)).toEqual([334, 333, 333]);
    // Largest remainder wins: 7/10 and 3/10 of 5 units = 3.5 and 1.5.
    expect(allocateInvoiceDiscount([7, 3], 5)).toEqual([4, 1]);
  });
  it("never discounts a line beyond its own amount and never below zero", () => {
    for (const [amounts, discount] of [[[1, 999_999], 500_000], [[3, 3, 3], 8], [[5], 4], [[100, 1], 100]] as const) {
      const parts = allocateInvoiceDiscount(amounts, discount);
      expect(parts.reduce((sum, part) => sum + part, 0)).toBe(discount);
      parts.forEach((part, index) => { expect(part).toBeGreaterThanOrEqual(0); expect(part).toBeLessThanOrEqual(amounts[index]); });
    }
  });
  it("a discount at or above the total leaves nothing; no discount changes nothing; non-positive lines take none", () => {
    expect(allocateInvoiceDiscount([60_000, 40_000], 100_000)).toEqual([60_000, 40_000]);
    expect(allocateInvoiceDiscount([60_000, 40_000], 150_000)).toEqual([60_000, 40_000]);
    expect(allocateInvoiceDiscount([60_000, 40_000], 0)).toEqual([0, 0]);
    expect(allocateInvoiceDiscount([0, -500, 40_000], 10_000)).toEqual([0, 0, 10_000]);
    expect(allocateInvoiceDiscount([], 10)).toEqual([]);
  });
  it("is exact on large amounts (no float) and refuses unsafe input", () => {
    const big = 9_000_000_000_000;
    const parts = allocateInvoiceDiscount([big, big, 1], 1_000_000_000_001);
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(1_000_000_000_001);
    expect(() => allocateInvoiceDiscount([1.5], 1)).toThrow();
    expect(() => allocateInvoiceDiscount([1], Number.NaN)).toThrow();
  });
});

describe("the engine on discounted shares", () => {
  const invoice = (shares: { doctorId: number; amountMinor: number; labCostMinor?: number }[], netMinor: number): CommissionInvoice => ({
    id: 1, netMinor, currency: "YER", createdAt: "2026-10-31T09:00:00.000Z",
    doctorShares: shares.map(share => ({ ...share, currency: "YER" as const })),
  });
  it("40% of what was collected after a 20,000 discount is 32,000, not 40,000", () => {
    const gross = [100_000];
    const parts = allocateInvoiceDiscount(gross, 20_000);
    const result = commissionForPatient([invoice([{ doctorId: 7, amountMinor: gross[0] - parts[0] }], 80_000)], { YER: 80_000, SAR: 0, USD: 0 }, new Map([[7, 40]]));
    expect(result.get(7)?.YER).toEqual({ accruedMinor: 32_000, earnedMinor: 32_000 });
  });
  it("two doctors on one discounted invoice: their bases add up to the net and neither exceeds its line", () => {
    const gross = [60_000, 40_000];
    const parts = allocateInvoiceDiscount(gross, 20_000);
    const shares = [{ doctorId: 7, amountMinor: gross[0] - parts[0] }, { doctorId: 8, amountMinor: gross[1] - parts[1] }];
    expect(shares.map(share => share.amountMinor)).toEqual([48_000, 32_000]);
    const result = commissionForPatient([invoice(shares, 80_000)], { YER: 40_000, SAR: 0, USD: 0 }, new Map([[7, 40], [8, 50]]));
    // Half collected: half of each doctor's accrued share.
    expect(result.get(7)?.YER).toEqual({ accruedMinor: 19_200, earnedMinor: 9_600 });
    expect(result.get(8)?.YER).toEqual({ accruedMinor: 16_000, earnedMinor: 8_000 });
  });
});
