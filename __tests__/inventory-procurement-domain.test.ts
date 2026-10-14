import { describe, expect, it } from "vitest";
import {
  assertBaseUnitEdit, convertQuantity, InventoryDomainError, quantityAtoms, quantityText, unitConversionSnapshot,
  type UnitConversionSnapshot,
} from "../lib/inventory-domain/quantities";
import {
  allocateMinor, approveRequest, inspectIdempotency, matchSupplierInvoice, payloadIdentity,
  planInspectedReceipt, planOrderIssue, requireCurrentApproval, supplierInvoiceDuplicateKey, valuationSnapshot,
  type CommittedSourceAllocation, type InvoiceReceiptAllocation, type IssuedPurchaseOrder, type PurchaseOrder,
  type ReceiptRevision, type RequestApproval, type RequestRevision, type SupplierInvoiceRevision,
} from "../lib/inventory-domain/procurement";

const conversion = (): UnitConversionSnapshot => ({ itemId: 1, version: 1, baseUnit: "cartridge", enteredUnit: "box",
  baseUnitsPerEnteredUnit: "50", enteredPrecision: 0, basePrecision: 0 });
const request = (): RequestRevision => ({ id: "request-1", version: 1, branchId: "branch-1", requestedBy: 10,
  reason: "Synthetic training stock", proposedSupplierPartyId: 21, value: { currency: "SAR", amountMinor: 30_000 },
  lines: [{ id: "request-line-1", itemId: 1, quantity: "3", conversion: conversion() }] });
const approvalInput = (revision = request()) => ({ request: revision, state: "submitted" as const, actorId: 11,
  canApprove: true, allowedBranchIds: ["branch-1"],
  policy: { version: 1, currency: "YER" as const, limitMinor: 200_000, allowSelfApproval: false },
  selfApprovalReason: null, valuation: revision.value ? valuationSnapshot({ ...revision.value, purpose: "approval_estimate",
    rateToBase: "500", capturedAt: "2026-10-11T10:00:00Z", sourceRef: "synthetic-approval-rate-1" }) : null,
  decisions: [{ lineId: "request-line-1", quantity: "3", reason: "Approved synthetic example" }] });
const approval = (revision = request()): RequestApproval => approveRequest(approvalInput(revision));
const draftOrder = (): PurchaseOrder => ({ id: "po-1", version: 1, branchId: "branch-1", supplierPartyId: 21,
  currency: "SAR", shippingMinor: 0, discountMinor: 0,
  lines: [{ id: "order-line-1", itemId: 1, kind: "stock", quantity: "3", conversion: conversion(),
    price: { state: "known", currency: "SAR", unitPriceMinor: 10_000, reason: "Synthetic quote" },
    trackLot: true, requiresExpiry: true, minimumShelfLifeDays: 30,
    sources: [{ id: "source-1", requestId: "request-1", requestLineId: "request-line-1", baseQuantity: "150" }] }] });
const issue = (order = draftOrder(), priorAllocations: readonly CommittedSourceAllocation[] = []) => planOrderIssue({ order,
  priorAllocations, requests: [{ request: request(), approval: approval() }], supplier: { id: 21, active: true, isSupplier: true } });
const issuedOrder = (): IssuedPurchaseOrder => issue().order;
const receipt = (): ReceiptRevision => ({ id: "receipt-1", version: 1, orderId: "po-1", orderVersion: 1,
  supplierPartyId: 21, branchId: "branch-1", actualArrivalDate: "2026-10-11",
  lines: [{ orderLineId: "order-line-1", arrivedQuantity: "2", portions: [{ id: "receipt-line-1", quantity: "2",
    disposition: "accepted", lotCode: "SYNTH-LOT-1", expiryDate: "2027-11-01", locationId: "main-store",
    damaged: false, reason: "Inspected synthetic material" }] }] });
const received = () => planInspectedReceipt(issuedOrder(), receipt(), [], "2026-10-11");
const invoice = (): SupplierInvoiceRevision => ({ id: "invoice-1", version: 1, orderId: "po-1", orderVersion: 1,
  branchId: "branch-1", supplierPartyId: 21, currency: "SAR", invoiceNumber: "SYNTH-001", invoiceDate: "2026-10-11",
  missingNumberReason: null, shippingMinor: 0, discountMinor: 0,
  valuation: valuationSnapshot({ purpose: "invoice_valuation", currency: "SAR", amountMinor: 20_000,
    rateToBase: "500", capturedAt: "2026-10-11T12:00:00Z", sourceRef: "synthetic-invoice-rate-1" }),
  lines: [{ id: "invoice-line-1", orderLineId: "order-line-1", quantity: "2",
    price: { state: "known", currency: "SAR", unitPriceMinor: 10_000, reason: "Synthetic supplier invoice" },
    receiptAllocations: [{ id: "invoice-allocation-1", invoiceLineId: "invoice-line-1", receiptLineId: "receipt-line-1", baseQuantity: "100" }] }] });

function rejects(code: string, action: () => unknown): void {
  expect(action).toThrow(InventoryDomainError);
  try { action(); } catch (error) { expect((error as InventoryDomainError).code).toBe(code); }
}

describe("exact quantity and immutable conversion boundary", () => {
  it("preserves 3 boxes × 50 = 150, and 150 minus 2 = 148 without early rounding", () => {
    const value = convertQuantity("3", conversion());
    expect(value.baseQuantity).toBe("150");
    expect(quantityText(quantityAtoms(value.baseQuantity) - quantityAtoms("2"))).toBe("148");
    expect(value.conversion.baseUnitsPerEnteredUnit).toBe("50");
    expect(Object.isFrozen(value.conversion)).toBe(true);
  });

  it("detaches conversion snapshots from later settings edits", () => {
    const setting = { ...conversion() };
    const old = convertQuantity("3", setting);
    setting.baseUnitsPerEnteredUnit = "40";
    setting.version = 2;
    expect(old.baseQuantity).toBe("150");
    expect(old.conversion.version).toBe(1);
    expect(convertQuantity("3", setting).baseQuantity).toBe("120");
  });

  it("supports exact fractions and Arabic digits without accepting grouping ambiguity", () => {
    expect(quantityAtoms("٠٫١٢٥")).toBe(125n);
    expect(quantityText(quantityAtoms("000.1000"))).toBe("0.1");
    expect(convertQuantity("0.125", { ...conversion(), enteredPrecision: 3, basePrecision: 3,
      baseUnitsPerEnteredUnit: "2.4" }).baseQuantity).toBe("0.3");
  });

  it.each(["", " ", "1e2", ".5", "1.", "+1", "-1", "NaN", "Infinity", "1x", "1,000", "1 000", "1_000", "1.2.3", Number.NaN, Number.POSITIVE_INFINITY, 1])(
    "rejects malformed or already-floating decimal input %s", (value) => {
      rejects("invalid_decimal", () => quantityAtoms(value));
    });

  it("rejects inexact conversion instead of silently rounding toward zero", () => {
    rejects("inexact_conversion", () => convertQuantity("1", { ...conversion(), baseUnitsPerEnteredUnit: "0.0001", basePrecision: 3 }));
    rejects("quantity_precision", () => quantityAtoms("0.0001"));
    rejects("quantity_precision", () => quantityAtoms("1.5", 0));
    rejects("zero_quantity", () => quantityAtoms("0"));
    expect(quantityAtoms("0", 0, true)).toBe(0n);
  });

  it("enforces the existing NUMERIC(12,3) upper bound before persistence", () => {
    expect(quantityAtoms("999999999.999")).toBe(999_999_999_999n);
    rejects("quantity_overflow", () => quantityAtoms("1000000000"));
    rejects("quantity_overflow", () => convertQuantity("20000000", conversion()));
    rejects("quantity_overflow", () => quantityText(1_000_000_000_000n));
  });

  it("validates factor, same-unit equivalence, item identity and precision", () => {
    rejects("invalid_conversion", () => unitConversionSnapshot({ ...conversion(), baseUnitsPerEnteredUnit: "0" }));
    rejects("invalid_conversion", () => unitConversionSnapshot({ ...conversion(), baseUnit: "box", enteredUnit: "box " }));
    rejects("invalid_id", () => unitConversionSnapshot({ ...conversion(), itemId: Number.NaN }));
    rejects("invalid_precision", () => unitConversionSnapshot({ ...conversion(), basePrecision: 4 }));
    rejects("invalid_precision", () => unitConversionSnapshot({ ...conversion(), basePrecision: Number.NaN }));
  });

  it("refuses changing the meaning of units with historical movements", () => {
    expect(() => assertBaseUnitEdit("box", "piece", 0)).not.toThrow();
    expect(() => assertBaseUnitEdit("box", "box", 9)).not.toThrow();
    rejects("historical_unit_change", () => assertBaseUnitEdit("box", "piece", 1));
    rejects("invalid_history_count", () => assertBaseUnitEdit("box", "piece", Number.NaN));
  });
});

describe("approval is a decision on exact content and authoritative scope", () => {
  it("keeps original request quantities and records a reasoned partial decision", () => {
    const input = approvalInput();
    input.decisions[0].quantity = "2";
    const decision = approveRequest(input);
    expect(decision.status).toBe("partially_approved");
    expect(decision.lines[0].baseQuantity).toBe("100");
    expect(input.request.lines[0].quantity).toBe("3");
    expect(decision.valueCeiling?.baseAmountMinor).toBe(150_000);
    expect(Object.isFrozen(decision.lines[0])).toBe(true);
  });

  it("rejects missing decisions, increased quantity, and unexplained partial rejection", () => {
    rejects("incomplete_decision", () => approveRequest({ ...approvalInput(), decisions: [] }));
    rejects("approval_quantity", () => approveRequest({ ...approvalInput(), decisions: [{ lineId: "request-line-1", quantity: "4", reason: "Over limit" }] }));
    rejects("reason_required", () => approveRequest({ ...approvalInput(), decisions: [{ lineId: "request-line-1", quantity: "0", reason: "" }] }));
    const rejected = approveRequest({ ...approvalInput(), decisions: [{ lineId: "request-line-1", quantity: "0", reason: "Not needed" }] });
    expect(rejected.status).toBe("rejected");
    rejects("request_not_approved", () => requireCurrentApproval(request(), rejected));
  });

  it("does not reuse approval after version, quantity, supplier or value changes", () => {
    const original = request(); const saved = approval(original);
    for (const revised of [
      { ...original, version: 2 }, { ...original, proposedSupplierPartyId: 99 },
      { ...original, value: { currency: "SAR" as const, amountMinor: 30_001 } },
      { ...original, lines: [{ ...original.lines[0], quantity: "2" }] },
    ]) rejects("stale_approval", () => requireCurrentApproval(revised, saved));
  });

  it("rejects forged branch scope, absent approval capability, and a draft transition", () => {
    rejects("approval_forbidden", () => approveRequest({ ...approvalInput(), canApprove: false }));
    rejects("approval_forbidden", () => approveRequest({ ...approvalInput(), allowedBranchIds: ["branch-2"] }));
    rejects("invalid_transition", () => approveRequest({ ...approvalInput(), state: "draft" as "submitted" }));
  });

  it("requires an explicit self-approval policy exception and reason", () => {
    const input = { ...approvalInput(), actorId: 10, selfApprovalReason: "Urgent owner exception" };
    rejects("self_approval_forbidden", () => approveRequest(input));
    rejects("reason_required", () => approveRequest({ ...input, selfApprovalReason: null,
      policy: { ...input.policy, allowSelfApproval: true } }));
    expect(approveRequest({ ...input, policy: { ...input.policy, allowSelfApproval: true } }).selfApprovalReason).toBe(input.selfApprovalReason);
  });

  it("compares original SAR value to a frozen YER policy value, never as equal currencies", () => {
    const input = approvalInput();
    rejects("approval_limit", () => approveRequest({ ...input, policy: { ...input.policy, limitMinor: 30_000 } }));
    rejects("valuation_mismatch", () => approveRequest({ ...input, valuation: { ...input.valuation!, baseAmountMinor: 30_000 } }));
    rejects("missing_valuation", () => approveRequest({ ...input, valuation: null }));
    expect(approveRequest(input).valueCeiling?.rateToBase).toBe("500");
  });

  it("allows an explicit quantity-only approval but does not turn unknown value into zero", () => {
    const revision = { ...request(), value: null };
    const decision = approveRequest(approvalInput(revision));
    expect(decision.valueCeiling).toBeNull();
    rejects("value_approval_required", () => planOrderIssue({ order: draftOrder(), priorAllocations: [],
      requests: [{ request: revision, approval: decision }], supplier: { id: 21, active: true, isSupplier: true } }));
  });
});

describe("order source allocations preserve approval quantity and value", () => {
  it("produces an issued plan with no stock, debt or cash effects", () => {
    const planned = issue();
    expect(planned.order.status).toBe("issued");
    expect(planned.totalMinor).toBe(30_000);
    expect(planned.allocations[0]).toMatchObject({ baseQuantity: "150", amountMinor: 30_000, currency: "SAR", baseAmountMinor: 150_000 });
    expect(planned.effects).toEqual({ inventoryMovements: 0, payables: 0, expenses: 0 });
  });

  it("preserves approved quantity across two sequential partial orders", () => {
    const full = draftOrder();
    const first = issue({ ...full, lines: [{ ...full.lines[0], quantity: "2", sources: [{ ...full.lines[0].sources[0], baseQuantity: "100" }] }] });
    const second = issue({ ...full, id: "po-2", lines: [{ ...full.lines[0], quantity: "1",
      sources: [{ ...full.lines[0].sources[0], id: "source-2", baseQuantity: "50" }] }] }, first.allocations);
    expect(first.totalMinor + second.totalMinor).toBe(30_000);
    expect(second.allocations[0].baseAmountMinor).toBe(50_000);
    rejects("source_overallocated", () => issue({ ...full, id: "po-3", lines: [{ ...full.lines[0], quantity: "1",
      sources: [{ ...full.lines[0].sources[0], id: "source-3", baseQuantity: "50" }] }] }, [...first.allocations, ...second.allocations]));
  });

  it("aggregates duplicate source references across separate order lines before checking approval", () => {
    const order = draftOrder();
    const first = { ...order.lines[0], quantity: "2", sources: [{ ...order.lines[0].sources[0], baseQuantity: "100" }] };
    rejects("source_overallocated", () => issue({ ...order, lines: [first, { ...first, id: "order-line-2",
      sources: [{ ...first.sources[0], id: "source-2" }] }] }));
  });

  it("rejects duplicate allocation IDs and under-specified source quantities", () => {
    const order = draftOrder();
    rejects("duplicate_source", () => issue({ ...order, lines: [{ ...order.lines[0], sources: [
      { ...order.lines[0].sources[0], baseQuantity: "75" }, { ...order.lines[0].sources[0], baseQuantity: "75" },
    ] }] }));
    rejects("source_quantity_mismatch", () => issue({ ...order, lines: [{ ...order.lines[0], sources: [
      { ...order.lines[0].sources[0], baseQuantity: "100" },
    ] }] }));
  });

  it("rejects wrong item/base unit, unapproved price increases, and unconfirmed prices", () => {
    const order = draftOrder();
    rejects("item_mismatch", () => issue({ ...order, lines: [{ ...order.lines[0], itemId: 2, conversion: { ...conversion(), itemId: 2 } }] }));
    rejects("unit_mismatch", () => issue({ ...order, lines: [{ ...order.lines[0], conversion: { ...conversion(), baseUnit: "millilitre" } }] }));
    rejects("source_budget_exceeded", () => issue({ ...order, lines: [{ ...order.lines[0],
      price: { state: "known", currency: "SAR", unitPriceMinor: 10_001, reason: "Higher quote" } }] }));
    rejects("unconfirmed_order_price", () => issue({ ...order, lines: [{ ...order.lines[0],
      price: { state: "missing", currency: "SAR", reason: "Supplier has not quoted" } }] }));
  });

  it("rejects supplier inactivity, role mismatch, foreign branches, and currency relabeling", () => {
    const input = { order: draftOrder(), priorAllocations: [], requests: [{ request: request(), approval: approval() }],
      supplier: { id: 21, active: true, isSupplier: true } };
    rejects("invalid_supplier", () => planOrderIssue({ ...input, supplier: { ...input.supplier, active: false } }));
    rejects("invalid_supplier", () => planOrderIssue({ ...input, supplier: { ...input.supplier, isSupplier: false } }));
    rejects("branch_mismatch", () => issue({ ...draftOrder(), branchId: "branch-2" }));
    rejects("currency_mismatch", () => issue({ ...draftOrder(), currency: "USD" }));
  });
});

describe("inspected partial receipts preserve quantity classification", () => {
  it("plans 100 accepted cartridges and leaves 50 with no supplier debt or cash", () => {
    const plan = received();
    expect(plan.stockEntries).toEqual([{ receiptLineId: "receipt-line-1", itemId: 1, baseQuantity: "100", locationId: "main-store", availability: "available" }]);
    expect(plan.remaining[0]).toMatchObject({ acceptedBaseQuantity: "100", remainingFulfillmentBaseQuantity: "50", remainingDeliveryBaseQuantity: "50" });
    expect(plan.financialEffects).toEqual({ payables: 0, expenses: 0 });
  });

  it("accepts the last partial shipment and rejects another attempt beyond the locked remaining total", () => {
    const first = received(); const next = receipt();
    const second = { ...next, id: "receipt-2", lines: [{ ...next.lines[0], arrivedQuantity: "1",
      portions: [{ ...next.lines[0].portions[0], id: "receipt-line-2", quantity: "1", lotCode: "SYNTH-LOT-2" }] }] };
    const closed = planInspectedReceipt(issuedOrder(), second, first.remaining, "2026-10-11");
    expect(closed.remaining[0].remainingFulfillmentBaseQuantity).toBe("0");
    rejects("overdelivery", () => planInspectedReceipt(issuedOrder(), second, closed.remaining, "2026-10-11"));
  });

  it("keeps rejected material out of stock and leaves replacement fulfillment open", () => {
    const source = receipt(); const portion = source.lines[0].portions[0];
    const inspected = { ...source, lines: [{ ...source.lines[0], portions: [
      { ...portion, quantity: "1" }, { ...portion, id: "damaged-1", quantity: "1", disposition: "rejected" as const, damaged: true, reason: "Damaged in transit" },
    ] }] };
    const plan = planInspectedReceipt(issuedOrder(), inspected, [], "2026-10-11");
    expect(plan.stockEntries.map((line) => line.baseQuantity)).toEqual(["50"]);
    expect(plan.remaining[0]).toMatchObject({ acceptedBaseQuantity: "50", rejectedBaseQuantity: "50", remainingFulfillmentBaseQuantity: "100", remainingDeliveryBaseQuantity: "100" });
  });

  it("quarantine holds delivery capacity without becoming available or fulfilled", () => {
    const source = receipt();
    const plan = planInspectedReceipt(issuedOrder(), { ...source, lines: [{ ...source.lines[0], portions: [
      { ...source.lines[0].portions[0], disposition: "quarantined", reason: "Awaiting specification confirmation" },
    ] }] }, [], "2026-10-11");
    expect(plan.stockEntries[0].availability).toBe("quarantined");
    expect(plan.remaining[0]).toMatchObject({ acceptedBaseQuantity: "0", quarantinedBaseQuantity: "100", remainingFulfillmentBaseQuantity: "150", remainingDeliveryBaseQuantity: "50" });
    rejects("overdelivery", () => planInspectedReceipt(issuedOrder(), receipt(), plan.remaining, "2026-10-11"));
  });

  it("rejects unclassified quantities, duplicate portions and excessive arrival", () => {
    const source = receipt();
    rejects("classification_mismatch", () => planInspectedReceipt(issuedOrder(), { ...source, lines: [{ ...source.lines[0],
      portions: [{ ...source.lines[0].portions[0], quantity: "1" }] }] }, [], "2026-10-11"));
    rejects("duplicate_source", () => planInspectedReceipt(issuedOrder(), { ...source, lines: [{ ...source.lines[0],
      portions: [{ ...source.lines[0].portions[0], quantity: "1" }, { ...source.lines[0].portions[0], quantity: "1" }] }] }, [], "2026-10-11"));
    rejects("overdelivery", () => planInspectedReceipt(issuedOrder(), { ...source, lines: [{ ...source.lines[0], arrivedQuantity: "4" }] }, [], "2026-10-11"));
  });

  it("rejects expired, damaged, missing-expiry and unknown-lot accepted stock", () => {
    const source = receipt();
    for (const [patch, code] of [
      [{ expiryDate: "2026-10-11" }, "expired_receipt"], [{ expiryDate: "2026-10-20" }, "expired_receipt"],
      [{ damaged: true }, "damaged_stock"], [{ expiryDate: null }, "missing_expiry"], [{ lotCode: null }, "missing_lot"],
      [{ expiryDate: "2026-02-30" }, "invalid_date"],
    ] as const) {
      rejects(code, () => planInspectedReceipt(issuedOrder(), { ...source, lines: [{ ...source.lines[0],
        portions: [{ ...source.lines[0].portions[0], ...patch }] }] }, [], "2026-10-11"));
    }
  });

  it("uses posting date for expiry even if the arrival was earlier", () => {
    const source = receipt();
    rejects("expired_receipt", () => planInspectedReceipt(issuedOrder(), { ...source, actualArrivalDate: "2026-01-01", lines: [{ ...source.lines[0],
      portions: [{ ...source.lines[0].portions[0], expiryDate: "2026-09-30" }] }] }, [], "2026-10-11"));
  });

  it("requires neither fictional expiry for non-expiry items nor stock for asset receipts", () => {
    const order = issuedOrder(); const source = receipt();
    const plan = planInspectedReceipt({ ...order, lines: [{ ...order.lines[0], requiresExpiry: false, kind: "asset" }] },
      { ...source, lines: [{ ...source.lines[0], portions: [{ ...source.lines[0].portions[0], expiryDate: null }] }] }, [], "2026-10-11");
    expect(plan.lines[0].expiryDate).toBeNull();
    expect(plan.stockEntries).toEqual([]);
  });

  it("rejects wrong supplier, branch, version and unknown order-line IDs", () => {
    rejects("supplier_mismatch", () => planInspectedReceipt(issuedOrder(), { ...receipt(), supplierPartyId: 22 }, [], "2026-10-11"));
    rejects("branch_mismatch", () => planInspectedReceipt(issuedOrder(), { ...receipt(), branchId: "branch-2" }, [], "2026-10-11"));
    rejects("stale_order", () => planInspectedReceipt(issuedOrder(), { ...receipt(), orderVersion: 2 }, [], "2026-10-11"));
    rejects("unknown_order_line", () => planInspectedReceipt(issuedOrder(), { ...receipt(), lines: [{ ...receipt().lines[0], orderLineId: "other-order-line" }] }, [], "2026-10-11"));
  });
});

describe("supplier invoice matching and duplicate identity", () => {
  it("matches two accepted boxes for 200 SAR, while still planning no financial write", () => {
    const result = matchSupplierInvoice(issuedOrder(), invoice(), received().lines, []);
    expect(result.status).toBe("matched");
    expect(result.total).toEqual({ currency: "SAR", amountMinor: 20_000 });
    expect(result.lines[0]).toMatchObject({ baseQuantity: "100", matchedBaseQuantity: "100", priceDifferenceMinor: 0 });
    expect(result.effects).toEqual({ inventoryMovements: 0, payables: 0, expenses: 0 });
  });

  it("holds an invoice before arrival for matching and never manufactures stock", () => {
    const source = invoice();
    const result = matchSupplierInvoice(issuedOrder(), { ...source, lines: [{ ...source.lines[0], receiptAllocations: [] }] }, [], []);
    expect(result.status).toBe("needs_review");
    expect(result.issues).toContain("awaiting_receipt");
    expect(result.lines[0].unreceivedBaseQuantity).toBe("100");
    expect(result.effects).toEqual({ inventoryMovements: 0, payables: 0, expenses: 0 });
  });

  it("detects unit-price variance and preserves missing versus free-known prices", () => {
    const source = invoice(); const order = issuedOrder();
    const changed = matchSupplierInvoice(order, { ...source, valuation: null, lines: [{ ...source.lines[0],
      price: { state: "known", currency: "SAR", unitPriceMinor: 10_100, reason: "Changed supplier price" } }] }, received().lines, []);
    expect(changed.issues).toContain("price_variance");
    expect(changed.lines[0].priceDifferenceMinor).toBe(100);
    const missing = matchSupplierInvoice(order, { ...source, valuation: null, lines: [{ ...source.lines[0],
      price: { state: "missing", currency: "SAR", reason: "Awaiting final invoice" } }] }, received().lines, []);
    expect(missing.total).toBeNull(); expect(missing.issues).toContain("missing_price");
    const freeOrder = { ...order, lines: [{ ...order.lines[0], price: { state: "known" as const, currency: "SAR" as const, unitPriceMinor: 0, reason: "Supplier gift" } }] };
    const free = matchSupplierInvoice(freeOrder, { ...source, valuation: valuationSnapshot({ ...source.valuation!, amountMinor: 0 }),
      lines: [{ ...source.lines[0], price: freeOrder.lines[0].price }] }, received().lines, []);
    expect(free.status).toBe("matched"); expect(free.total?.amountMinor).toBe(0);
    rejects("reason_required", () => matchSupplierInvoice(freeOrder, { ...source, valuation: null,
      lines: [{ ...source.lines[0], price: { ...freeOrder.lines[0].price, reason: "" } }] }, received().lines, []));
  });

  it("estimated price is never labeled a completed actual match", () => {
    const source = invoice();
    const result = matchSupplierInvoice(issuedOrder(), { ...source, lines: [{ ...source.lines[0],
      price: { state: "estimated", currency: "SAR", unitPriceMinor: 10_000, reason: "Order provisional estimate" } }] }, received().lines, []);
    expect(result.status).toBe("needs_review"); expect(result.issues).toContain("estimated_price");
  });

  it("aggregates allocations to the same receipt across lines and historical invoices", () => {
    const source = invoice(); const row = source.lines[0].receiptAllocations[0];
    rejects("receipt_already_invoiced", () => matchSupplierInvoice(issuedOrder(), { ...source, lines: [{ ...source.lines[0], receiptAllocations: [
      { ...row, baseQuantity: "60" }, { ...row, id: "invoice-allocation-2", baseQuantity: "60" },
    ] }] }, received().lines, []));
    const prior: InvoiceReceiptAllocation = { ...row, id: "old-allocation", invoiceLineId: "old-line", baseQuantity: "50" };
    rejects("receipt_already_invoiced", () => matchSupplierInvoice(issuedOrder(), source, received().lines, [prior]));
    const first = { ...source.lines[0], quantity: "1", receiptAllocations: [{ ...row, baseQuantity: "50" }] };
    const second = { ...first, id: "invoice-line-2", receiptAllocations: [{ ...row, id: "invoice-allocation-2", invoiceLineId: "invoice-line-2", baseQuantity: "50" }] };
    const third = { ...first, id: "invoice-line-3", receiptAllocations: [{ ...row, id: "invoice-allocation-3", invoiceLineId: "invoice-line-3", baseQuantity: "50" }] };
    rejects("receipt_already_invoiced", () => matchSupplierInvoice(issuedOrder(), { ...source, lines: [first, second, third] }, received().lines, []));
  });

  it("rejects duplicate allocation IDs and receipt allocations beyond invoiced quantity", () => {
    const source = invoice(); const allocation = source.lines[0].receiptAllocations[0];
    rejects("duplicate_source", () => matchSupplierInvoice(issuedOrder(), { ...source, lines: [{ ...source.lines[0], receiptAllocations: [
      { ...allocation, baseQuantity: "50" }, { ...allocation, baseQuantity: "50" },
    ] }] }, received().lines, []));
    rejects("invoice_overallocated", () => matchSupplierInvoice(issuedOrder(), { ...source, lines: [{ ...source.lines[0], quantity: "1" }] }, received().lines, []));
  });

  it("does not match quarantine/rejected quantities or receipts owned by another supplier", () => {
    for (const disposition of ["quarantined", "rejected"] as const) {
      rejects("unaccepted_invoice_quantity", () => matchSupplierInvoice(issuedOrder(), invoice(), [{ ...received().lines[0], disposition }], []));
    }
    rejects("receipt_owner_mismatch", () => matchSupplierInvoice(issuedOrder(), invoice(), [{ ...received().lines[0], supplierPartyId: 22 }], []));
    rejects("receipt_owner_mismatch", () => matchSupplierInvoice(issuedOrder(), invoice(), [{ ...received().lines[0], branchId: "branch-2" }], []));
    rejects("currency_mismatch", () => matchSupplierInvoice(issuedOrder(), { ...invoice(), currency: "USD" }, received().lines, []));
  });

  it("does not silently accept excess invoice quantity or an unrelated valuation snapshot", () => {
    const source = invoice();
    const result = matchSupplierInvoice(issuedOrder(), { ...source, valuation: null, lines: [{ ...source.lines[0], quantity: "4" }] }, received().lines, []);
    expect(result.issues).toEqual(expect.arrayContaining(["awaiting_receipt", "invoice_exceeds_order", "missing_valuation"]));
    rejects("valuation_mismatch", () => matchSupplierInvoice(issuedOrder(), { ...source, valuation: { ...source.valuation!, purpose: "approval_estimate" } }, received().lines, []));
    rejects("valuation_mismatch", () => matchSupplierInvoice(issuedOrder(), { ...source, valuation: { ...source.valuation!, baseAmountMinor: 1 } }, received().lines, []));
  });

  it("normalizes supplier invoice identity within the explicit supplier/calendar-year policy", () => {
    expect(supplierInvoiceDuplicateKey(21, "  synth-００１ ", "2026-10-11", null)).toBe(supplierInvoiceDuplicateKey(21, "SYNTH-001", "2026-01-01", null));
    expect(supplierInvoiceDuplicateKey(21, "A-1", "2026-10-11", null)).not.toBe(supplierInvoiceDuplicateKey(22, "A-1", "2026-10-11", null));
    expect(supplierInvoiceDuplicateKey(21, "A-1", "2026-10-11", null)).not.toBe(supplierInvoiceDuplicateKey(21, "A-1", "2027-10-11", null));
    expect(supplierInvoiceDuplicateKey(21, "A-01", "2026-10-11", null)).not.toBe(supplierInvoiceDuplicateKey(21, "A-1", "2026-10-11", null));
    rejects("reason_required", () => supplierInvoiceDuplicateKey(21, null, "2026-10-11", null));
  });

  it("keeps unnumbered invoice duplicate review explicit", () => {
    const result = matchSupplierInvoice(issuedOrder(), { ...invoice(), invoiceNumber: null, missingNumberReason: "Supplier issued an unnumbered document" }, received().lines, []);
    expect(result.duplicateKey).toBeNull(); expect(result.issues).toContain("missing_invoice_number");
  });

  it("allocates invoice shipping/discount once and retains cumulative-header review gate", () => {
    const source = invoice();
    const result = matchSupplierInvoice(issuedOrder(), { ...source, shippingMinor: 101, discountMinor: 7,
      valuation: valuationSnapshot({ ...source.valuation!, amountMinor: 20_094 }) }, received().lines, []);
    expect(result.charges).toEqual([{ invoiceLineId: "invoice-line-1", shippingMinor: 101, discountMinor: 7 }]);
    expect(result.total?.amountMinor).toBe(20_094);
    expect(result.issues).toContain("header_charge_review");
  });
});

describe("exact money, valuation and idempotent payload boundaries", () => {
  it("conserves every minor unit and breaks equal remainders by stable destination ID", () => {
    expect(allocateMinor(5, [{ id: "c", weight: "1" }, { id: "b", weight: "1" }, { id: "a", weight: "1" }])).toEqual([
      { id: "c", amountMinor: 1 }, { id: "b", amountMinor: 2 }, { id: "a", amountMinor: 2 },
    ]);
    for (let amount = 0; amount < 200; amount += 1) {
      const result = allocateMinor(amount, [{ id: "one", weight: "12345678901234567890" }, { id: "two", weight: "7" }, { id: "three", weight: "0" }]);
      expect(result.reduce((sum, line) => sum + line.amountMinor, 0)).toBe(amount);
      expect(result[2].amountMinor).toBe(0);
    }
  });

  it("rejects fractional/negative/NaN/overflow money and invalid weights", () => {
    for (const amount of [0.1, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      rejects("invalid_money", () => allocateMinor(amount, [{ id: "a", weight: "1" }]));
    }
    rejects("zero_weight", () => allocateMinor(1, [{ id: "a", weight: "0" }]));
    rejects("invalid_weight", () => allocateMinor(1, [{ id: "a", weight: "1.2" }]));
    rejects("duplicate_source", () => allocateMinor(1, [{ id: "a", weight: "1" }, { id: "a", weight: "2" }]));
  });

  it("freezes the invoice FX purpose/rate and respects currency minor units", () => {
    const snapshot = valuationSnapshot({ purpose: "invoice_valuation", currency: "SAR", amountMinor: 20_000,
      rateToBase: "500.000", sourceRef: "frozen-rate", capturedAt: "2026-10-11T10:00:00Z" });
    expect(snapshot).toMatchObject({ baseAmountMinor: 100_000, baseCurrency: "YER", rateToBase: "500" });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(valuationSnapshot({ ...snapshot, amountMinor: 1, rateToBase: "50" }).baseAmountMinor).toBe(1);
    rejects("invalid_rate", () => valuationSnapshot({ ...snapshot, currency: "YER" }));
    rejects("money_overflow", () => valuationSnapshot({ ...snapshot, amountMinor: Number.MAX_SAFE_INTEGER, rateToBase: "1000" }));
    rejects("invalid_timestamp", () => valuationSnapshot({ ...snapshot, capturedAt: "2026-10-11T24:00:00Z" }));
  });

  it("replays the same scope/key/content while changed content conflicts", () => {
    const first = inspectIdempotency("branch-1:receipt", "key-1", { quantity: "2", order: "po-1" }, null);
    expect(first.kind).toBe("new");
    const previous = { scope: "branch-1:receipt", key: "key-1", identity: first.identity, resultId: "receipt-1" };
    expect(inspectIdempotency(previous.scope, previous.key, { order: "po-1", quantity: "2" }, previous)).toMatchObject({ kind: "replay", resultId: "receipt-1" });
    rejects("idempotency_conflict", () => inspectIdempotency(previous.scope, previous.key, { quantity: "3", order: "po-1" }, previous));
    rejects("operation_scope_mismatch", () => inspectIdempotency("branch-2:receipt", previous.key, { quantity: "2", order: "po-1" }, previous));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0.25, -0, undefined, new Date(), { value: undefined }, [undefined], Array(1)])(
    "rejects ambiguous/non-JSON identity input %s", (payload) => { rejects("invalid_payload", () => payloadIdentity(payload)); });

  it("preserves array order, normal object key order independence and rejects cyclic payloads", () => {
    expect(payloadIdentity({ b: 2, a: 1 })).toBe(payloadIdentity({ a: 1, b: 2 }));
    expect(payloadIdentity([1, 2])).not.toBe(payloadIdentity([2, 1]));
    const cycle: { child?: unknown } = {}; cycle.child = cycle;
    rejects("invalid_payload", () => payloadIdentity(cycle));
  });
});
