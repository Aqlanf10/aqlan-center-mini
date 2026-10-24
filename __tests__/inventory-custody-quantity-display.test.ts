import { describe, expect, it } from "vitest";
import { custodyUsageQuantity } from "../lib/inventory-domain/presentation";

describe("custody usage option quantities", () => {
  it.each(["consumed", "returned_to_store", "approved_waste"] as const)("never advertises the quarantined reserve for %s", kind => {
    const lot = { quantity: "100", heldQuantity: "90", availableQuantity: "10", wasteQuantity: "10" };
    expect(custodyUsageQuantity(lot, kind)).toBe("10");
  });
  it("shows the wasteable expired balance without suggesting it can be consumed or returned", () => {
    const lot = { quantity: "100", heldQuantity: "0", availableQuantity: "0", wasteQuantity: "100" };
    expect(custodyUsageQuantity(lot, "approved_waste")).toBe("100");
    expect(custodyUsageQuantity(lot, "consumed")).toBe("0");
    expect(custodyUsageQuantity(lot, "returned_to_store")).toBe("0");
  });
  it("keeps incomplete tracking unavailable for every usage kind", () => {
    const lot = { quantity: "110", heldQuantity: "0", availableQuantity: "0", wasteQuantity: "0" };
    for (const kind of ["consumed", "returned_to_store", "approved_waste"] as const) expect(custodyUsageQuantity(lot, kind)).toBe("0");
  });
});
