import { describe, expect, it } from "vitest";
import { planInvoiceCorrection } from "../lib/invoice-correction";

/** (FIN-2) قواعد تصحيح الفاتورة — تخفيضٌ فقط، بندٌ واحد على الأقل، ولا تصحيح بلا تغيير. */

const items = [
  { id: 1, quantity: 1, unitPriceMinor: 50_000 },
  { id: 2, quantity: 2, unitPriceMinor: 10_000 },
];

describe("(FIN-2) planInvoiceCorrection", () => {
  it("lowers a price and keeps the other line", () => {
    const plan = planInvoiceCorrection(items, [
      { itemId: 1, quantity: 1, unitPriceMinor: 30_000 },
      { itemId: 2, quantity: 2, unitPriceMinor: 10_000 },
    ], 0);
    expect(plan).toEqual({
      ok: true, totalMinor: 50_000, discountMinor: 0,
      lines: [
        { itemId: 1, quantity: 1, unitPriceMinor: 30_000, totalMinor: 30_000 },
        { itemId: 2, quantity: 2, unitPriceMinor: 10_000, totalMinor: 20_000 },
      ],
    });
  });

  it("drops a line that was never done, and lowers a quantity", () => {
    const plan = planInvoiceCorrection(items, [{ itemId: 2, quantity: 1, unitPriceMinor: 10_000 }], 0);
    expect(plan.ok && plan.totalMinor).toBe(10_000);
  });

  it("keeps the granted discount, capped at the new total", () => {
    expect(planInvoiceCorrection(items, [{ itemId: 1, quantity: 1, unitPriceMinor: 40_000 }], 5_000))
      .toMatchObject({ ok: true, totalMinor: 40_000, discountMinor: 5_000 });
    expect(planInvoiceCorrection(items, [{ itemId: 2, quantity: 1, unitPriceMinor: 3_000 }], 5_000))
      .toMatchObject({ ok: true, totalMinor: 3_000, discountMinor: 3_000 });
  });

  it("refuses an increase — a higher price or quantity is a new invoice, not a correction", () => {
    for (const line of [
      { itemId: 1, quantity: 1, unitPriceMinor: 60_000 },
      { itemId: 2, quantity: 3, unitPriceMinor: 10_000 },
    ]) {
      const plan = planInvoiceCorrection(items, [line], 0);
      expect(plan).toEqual({ ok: false, message: "التصحيح تخفيضٌ فقط — لإضافة مبلغ أصدر فاتورةً جديدة." });
    }
  });

  it("refuses no change, no lines, unknown or duplicated lines, and bad numbers", () => {
    expect(planInvoiceCorrection(items, [
      { itemId: 1, quantity: 1, unitPriceMinor: 50_000 }, { itemId: 2, quantity: 2, unitPriceMinor: 10_000 },
    ], 0).ok).toBe(false);
    expect(planInvoiceCorrection(items, [], 0).ok).toBe(false);
    expect(planInvoiceCorrection(items, [{ itemId: 9, quantity: 1, unitPriceMinor: 1 }], 0).ok).toBe(false);
    expect(planInvoiceCorrection(items, [
      { itemId: 2, quantity: 1, unitPriceMinor: 1 }, { itemId: 2, quantity: 1, unitPriceMinor: 1 },
    ], 0).ok).toBe(false);
    expect(planInvoiceCorrection(items, [{ itemId: 1, quantity: 0, unitPriceMinor: 1 }], 0).ok).toBe(false);
    expect(planInvoiceCorrection(items, [{ itemId: 1, quantity: 1.5, unitPriceMinor: 1 }], 0).ok).toBe(false);
    expect(planInvoiceCorrection(items, [{ itemId: 1, quantity: 1, unitPriceMinor: -1 }], 0).ok).toBe(false);
  });
});
