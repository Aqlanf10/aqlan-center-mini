import { describe, expect, it } from "vitest";
import { canonicalPurchaseRequest, isPurchaseKey, purchaseEnvelope, isUnwrappedFinancialPurchase } from "../lib/inventory-purchase-protocol";

describe("inventory purchase canonical request v1", () => {
  it("matches the immutable golden representation, including exact original scalar types", () => {
    expect(canonicalPurchaseRequest(7, { supplierPartyId: "00042", unitCost: "100.50", qty: "1.235", kind: "in", reason: " شراء ", expiryDate: null }))
      .toBe('{"itemId":7,"operation":"inventory-purchase","purchase":{"expiryDate":null,"kind":"in","qty":"1.235","reason":" شراء ","supplierPartyId":"00042","unitCost":"100.50"},"version":1}');
  });
  it("is stable across property order but not item, field presence, null, scalar type or original text changes", () => {
    const purchase = { kind: "in", qty: 2, unitCost: "100", supplierPartyId: 42 };
    const original = canonicalPurchaseRequest(7, purchase);
    expect(canonicalPurchaseRequest(7, { supplierPartyId: 42, unitCost: "100", qty: 2, kind: "in" })).toBe(original);
    for (const change of [{ qty: "2" }, { unitCost: "100.0" }, { supplierPartyId: "42" }, { supplierPartyId: "00042" }, { reason: null }, { reason: "" }, { isReturn: false }, { expiryDate: null }]) {
      expect(canonicalPurchaseRequest(7, { ...purchase, ...change })).not.toBe(original);
    }
    expect(canonicalPurchaseRequest(8, purchase)).not.toBe(original);
  });
  it("retains nested JSON distinctions deterministically and rejects non-JSON values", () => {
    expect(canonicalPurchaseRequest(7, { b: [false, null, 1, "1"], a: { z: 2, x: 1 } }))
      .toBe('{"itemId":7,"operation":"inventory-purchase","purchase":{"a":{"x":1,"z":2},"b":[false,null,1,"1"]},"version":1}');
    for (const value of [undefined, NaN, Infinity, -Infinity, BigInt(1), () => 1]) {
      expect(() => canonicalPurchaseRequest(7, { value })).toThrow();
    }
  });
  it.each([0, -1, 1.5, 2147483648, Infinity])("rejects invalid route identity %s", itemId => {
    expect(() => canonicalPurchaseRequest(itemId, { kind: "in", qty: 1 })).toThrow();
  });
});

describe("purchase fail-closed protocol", () => {
  it("accepts UUID keys without trimming or coercion", () => {
    expect(isPurchaseKey("9c051537-1e52-4df8-8ae6-64886dffce42")).toBe(true);
    expect(isPurchaseKey("9C051537-1E52-4DF8-8AE6-64886DFFCE42")).toBe(true);
    for (const key of [null, undefined, "", " ", "same-purchase", ["9c051537-1e52-4df8-8ae6-64886dffce42"], " 9c051537-1e52-4df8-8ae6-64886dffce42", "00000000-0000-0000-0000-000000000000"]) expect(isPurchaseKey(key)).toBe(false);
  });
  it("only accepts an exact nested purchase envelope with no top-level movement kind", () => {
    const purchase = { kind: "in", qty: 1, isReturn: false };
    expect(purchaseEnvelope({ protocol: "inventory-purchase-v1", purchase })).toEqual(purchase);
    for (const value of [purchase, null, [], { protocol: "inventory-purchase-v2", purchase }, { protocol: "inventory-purchase-v1", purchase, kind: "in" }, { protocol: "inventory-purchase-v1", purchase: { ...purchase, actorUserId: 7 } }, { protocol: "inventory-purchase-v1", purchase: { ...purchase, kind: "out" } }, { protocol: "inventory-purchase-v1", purchase: { ...purchase, isReturn: true } }, { protocol: "inventory-purchase-v1", purchase: { ...purchase, visitId: 7 } }, { protocol: "inventory-purchase-v1", purchase: { ...purchase, patientId: 7 } }]) expect(purchaseEnvelope(value)).toBeNull();
  });
  it("blocks old flat financial purchases while leaving excluded callers unchanged", () => {
    for (const extra of [{ unitCost: "100" }, { unitCost: 100 }, { supplierPartyId: "42" }, { supplierPartyId: true }]) expect(isUnwrappedFinancialPurchase({ kind: "in", qty: 1, ...extra })).toBe(true);
    for (const body of [{ kind: "in", qty: 1 }, { kind: "in", unitCost: "", supplierPartyId: null }, { kind: "in", unitCost: "100", isReturn: true }, { kind: "out", unitCost: "100" }, { kind: "adjust", unitCost: "100" }]) expect(isUnwrappedFinancialPurchase(body)).toBe(false);
  });
});
