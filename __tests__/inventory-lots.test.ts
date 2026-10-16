import { describe, expect, it } from "vitest";
import { planValidLotIssue, type LotAvailability } from "../lib/inventory-domain/lots";
const lot = (lotId: number, extra: Partial<LotAvailability> = {}): LotAvailability => ({ lotId, itemId: 1, locationId: 1, branchId: 1, sourceMovementId: lotId, receivedSequence: lotId, status: "accepted", expiryRequired: true, expiryDate: "2026-12-31", remainingQuantity: "10", reservedQuantity: "0", traceability: "recorded", ...extra });
const plan = (lots: LotAvailability[], quantity = "2") => planValidLotIssue({ itemId: 1, locationId: 1, branchId: 1, today: "2026-10-12", quantity, precision: 3, lots });
describe("P13/P14/P29 domain allocation prerequisite (persistence integration pending)", () => {
  it("skips expired, quarantined, recalled and unknown mandatory expiry lots", () => {
    expect(plan([lot(1, { expiryDate: "2000-01-01" }), lot(2, { status: "quarantined" }), lot(3, { status: "recalled" }), lot(4, { expiryDate: null }), lot(5)])).toEqual([{ lotId: 5, sourceMovementId: 5, quantity: "2", traceability: "recorded" }]);
  });
  it("does not substitute unsafe stock when total quantity suffices", () => {
    expect(() => plan([lot(1, { expiryDate: "2000-01-01" })])).toThrow("Valid unreserved stock");
  });
  it("FEFO preserves exact fractions and reservations across valid lots", () => {
    expect(plan([lot(1, { expiryDate: "2027-01-01" }), lot(2, { remainingQuantity: "2", reservedQuantity: "1.125" })], "1.5")).toEqual([
      { lotId: 2, sourceMovementId: 2, quantity: "0.875", traceability: "recorded" }, { lotId: 1, sourceMovementId: 1, quantity: "0.625", traceability: "recorded" },
    ]);
  });
  it("validates scope and duplicate rows before counting quantity", () => {
    expect(() => plan([lot(1), lot(1)])).toThrow("only once");
    expect(() => plan([lot(1, { branchId: 2 })])).toThrow("scope");
    expect(() => plan([lot(1, { reservedQuantity: "11" })])).toThrow("exceeds");
  });
  it("rejects impossible calendar dates and never invents historical traceability", () => {
    expect(() => plan([lot(1, { expiryDate: "2026-02-30" })])).toThrow("calendar date");
    expect(plan([lot(1, { traceability: "legacy_unknown", expiryDate: null, expiryRequired: false })])[0].traceability).toBe("legacy_unknown");
  });
  it("breaks equal-expiry FEFO ties deterministically by receivedSequence and allows today-expiring stock before midnight", () => {
    expect(plan([
      lot(10, { expiryDate: "2026-10-12", receivedSequence: 20, remainingQuantity: "1" }),
      lot(11, { expiryDate: "2026-10-12", receivedSequence: 5, remainingQuantity: "1" }),
    ], "2")).toEqual([
      { lotId: 11, sourceMovementId: 11, quantity: "1", traceability: "recorded" },
      { lotId: 10, sourceMovementId: 10, quantity: "1", traceability: "recorded" },
    ]);
  });
  it("enforces item precision when issuing from valid lots so whole-piece items reject fractional requests", () => {
    expect(() => planValidLotIssue({
      itemId: 1, locationId: 1, branchId: 1, today: "2026-10-12", quantity: "1.5", precision: 0, lots: [lot(1)],
    })).toThrow();
  });
});

