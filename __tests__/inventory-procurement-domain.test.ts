import { describe, expect, it } from "vitest";
import {
  assertBaseUnitEdit, convertQuantity, InventoryDomainError, quantityAtoms, quantityText, unitConversionSnapshot,
  type UnitConversionSnapshot,
} from "../lib/inventory-domain/quantities";
import {
  allocateMinor, approveRequest, inspectIdempotency, matchSupplierInvoice, payloadIdentity,
  planExcessArrivalDecision, planHistoricalReconciliation, planInspectedReceipt, planOrderAmendment, planOrderIssue,
  planQuarantineResolution, requireCurrentApproval, supplierInvoiceDuplicateKey, valuationSnapshot,
  type CommittedSourceAllocation, type InvoiceReceiptAllocation, type IssuedPurchaseOrder, type PurchaseOrder,
  type ReceiptRevision, type RequestApproval, type RequestRevision, type SupplierInvoiceRevision,
} from "../lib/inventory-domain/procurement";
import {
  DEFAULT_SAFE_INVENTORY_ERROR_MESSAGE,
  publicInventoryErrorCode,
  safeInventoryErrorMessage,
  sanitizeInventoryAuditDetails,

} from "../lib/inventory-domain/presentation";

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

describe("quarantine disposition, excess arrival decision and historical reconciliation", () => {
  const quarantinedLine = () => {
    const source = receipt();
    return planInspectedReceipt(issuedOrder(), {
      ...source,
      lines: [{
        ...source.lines[0],
        portions: [{
          ...source.lines[0].portions[0],
          disposition: "quarantined",
          reason: "Awaiting specification confirmation",
        }],
      }],
    }, [], "2026-10-11").lines[0];
  };

  it("releases quarantined stock to available without creating a duplicate receipt movement or payable", () => {
    const line = quarantinedLine();
    const order = issuedOrder();
    const resolved = planQuarantineResolution({
      id: "qres-1",
      order,
      receiptLine: line,
      priorResolutions: [],
      action: "release",
      quantity: "2",
      reason: "Certificate of analysis verified",
      resolutionDate: "2026-10-12",
    });
    expect(resolved).toMatchObject({
      action: "release",
      baseQuantity: "100",
      effectiveReceiptLine: {
        receiptLineId: line.id,
        releasedBaseQuantity: "100",
        returnedBaseQuantity: "0",
        remainingQuarantinedBaseQuantity: "0",
        effectiveLotStatus: "accepted",
      },
      stockCompensation: null,
    });
    expect(resolved.effects).toEqual({ inventoryMovements: 0, payables: 0, expenses: 0 });
  });

  it("reject_return records a compensating return movement and reopens supplier replacement delivery capacity", () => {
    const line = quarantinedLine();
    const order = issuedOrder();
    const resolved = planQuarantineResolution({
      id: "qres-2",
      order,
      receiptLine: line,
      priorResolutions: [],
      action: "reject_return",
      quantity: "2",
      reason: "Failed lab sterility test; returned to supplier",
      resolutionDate: "2026-10-12",
    });
    expect(resolved).toMatchObject({
      action: "reject_return",
      baseQuantity: "100",
      effectiveReceiptLine: {
        receiptLineId: line.id,
        releasedBaseQuantity: "0",
        returnedBaseQuantity: "100",
        remainingQuarantinedBaseQuantity: "0",
        effectiveLotStatus: "recalled",
      },
      stockCompensation: {
        itemId: 1,
        locationId: "main-store",
        baseQuantity: "100",
        movementType: "out",
        isReturn: true,
      },
    });
    expect(resolved.effects).toEqual({ inventoryMovements: 1, payables: 0, expenses: 0 });

    // After returning 100 quarantined units, a replacement shipment of 2 boxes (100 units) is accepted without overdelivery
    const projectedHistory = [{
      orderLineId: line.orderLineId,
      acceptedBaseQuantity: resolved.effectiveReceiptLine.releasedBaseQuantity,
      quarantinedBaseQuantity: resolved.effectiveReceiptLine.remainingQuarantinedBaseQuantity,
      rejectedBaseQuantity: resolved.effectiveReceiptLine.returnedBaseQuantity,
    }];
    const replacement = planInspectedReceipt(order, {
      ...receipt(),
      id: "receipt-replacement-1",
      lines: [{
        ...receipt().lines[0],
        arrivedQuantity: "2",
        portions: [{
          ...receipt().lines[0].portions[0],
          id: "receipt-line-replacement-1",
          quantity: "2",
          lotCode: "SYNTH-LOT-REPL",
        }],
      }],
    }, projectedHistory, "2026-10-13");
    expect(replacement.remaining[0]).toMatchObject({
      acceptedBaseQuantity: "100",
      rejectedBaseQuantity: "100",
      remainingFulfillmentBaseQuantity: "50",
      remainingDeliveryBaseQuantity: "50",
    });
  });

  it("blocks releasing damaged, missing-lot or expired/short-shelf-life quarantined stock and prevents over-resolution", () => {
    const line = quarantinedLine();
    const order = issuedOrder();
    rejects("damaged_stock", () => planQuarantineResolution({
      id: "qres-bad-1",
      order,
      receiptLine: { ...line, damaged: true },
      priorResolutions: [],
      action: "release",
      quantity: "1",
      reason: "Try release damaged",
      resolutionDate: "2026-10-12",
    }));
    rejects("missing_lot", () => planQuarantineResolution({
      id: "qres-bad-2",
      order,
      receiptLine: { ...line, lotCode: null },
      priorResolutions: [],
      action: "release",
      quantity: "1",
      reason: "Try release unknown lot",
      resolutionDate: "2026-10-12",
    }));
    rejects("expired_receipt", () => planQuarantineResolution({
      id: "qres-bad-3",
      order,
      receiptLine: { ...line, expiryDate: "2026-10-25" },
      priorResolutions: [],
      action: "release",
      quantity: "1",
      reason: "Try release short shelf life",
      resolutionDate: "2026-10-12",
    }));
    const partial = planQuarantineResolution({
      id: "qres-partial",
      order,
      receiptLine: line,
      priorResolutions: [],
      action: "release",
      quantity: "1",
      reason: "Partial release 1 box",
      resolutionDate: "2026-10-12",
    });
    expect(partial.effectiveReceiptLine.releasedBaseQuantity).toBe("50");
    expect(partial.effectiveReceiptLine.remainingQuarantinedBaseQuantity).toBe("50");
    rejects("quarantine_overresolved", () => planQuarantineResolution({
      id: "qres-over",
      order,
      receiptLine: line,
      action: "reject_return",
      quantity: "2",
      reason: "Exceeds remaining quarantine",
      resolutionDate: "2026-10-12",
      priorResolutions: [{
        id: partial.id,
        receiptLineId: line.id,
        action: partial.action,
        baseQuantity: partial.baseQuantity,
      }],
    }));
  });

  it("plans explicit excess arrival decisions without silently expanding purchase order capacity", () => {
    const order = issuedOrder();
    const returned = planExcessArrivalDecision({
      order,
      orderLineId: "order-line-1",
      prior: [],
      arrivedQuantity: "4",
      decision: "return_excess_to_supplier",
      reason: "Supplier shipped 4 boxes instead of 3; 1 box returned on truck",
    });
    expect(returned).toMatchObject({
      orderedBaseQuantity: "150",
      withinOrderBaseQuantity: "150",
      excessBaseQuantity: "50",
      decision: "return_excess_to_supplier",
      requiresOrderAmendment: false,
    });
    expect(returned.effects).toEqual({ inventoryMovements: 0, payables: 0, expenses: 0 });

    const held = planExcessArrivalDecision({
      order,
      orderLineId: "order-line-1",
      prior: [],
      arrivedQuantity: "4",
      decision: "hold_for_order_amendment",
      reason: "Hold excess 1 box pending formal request/order amendment",
    });
    expect(held.requiresOrderAmendment).toBe(true);
    rejects("no_excess_arrival", () => planExcessArrivalDecision({
      order,
      orderLineId: "order-line-1",
      prior: [],
      arrivedQuantity: "3",
      decision: "return_excess_to_supplier",
      reason: "Within order",
    }));
  });

  it("reconciles unallocated historical movements into explicit lot/location allocations without duplicating stock or debt", () => {
    const reconciled = planHistoricalReconciliation({
      itemId: 1,
      baseUnit: "cartridge",
      basePrecision: 0,
      conversionVersion: 1,
      requiresExpiry: false,
      locationId: "main-store",
      reason: "Opening legacy inventory reconciliation before LOT tracking",
      movements: [
        { movementId: 101, kind: "in", signedBaseQuantity: "80", alreadyAllocatedBaseQuantity: "0", expiryDate: null, unitCostMinor: null, payableId: 501 },
        { movementId: 102, kind: "out", signedBaseQuantity: "20", alreadyAllocatedBaseQuantity: "0", expiryDate: null, unitCostMinor: null, payableId: null },
      ],
    });
    expect(reconciled).toMatchObject({
      itemId: 1,
      locationId: "main-store",
      netReconciledBaseQuantity: "60",
    });
    expect(reconciled.lotsToCreate).toHaveLength(1);
    expect(reconciled.lotsToCreate[0]).toMatchObject({
      movementId: 101,
      baseQuantity: "80",
      costStatus: "missing",
      costSnapshot: {
        source: "legacy_reconciliation",
        traceability: "legacy_unknown",
        unitCostMinor: null,
        payableId: 501,
      },
    });
    expect(reconciled.allocationsToCreate).toEqual([
      { movementId: 101, sourceLotMovementId: 101, locationId: "main-store", baseQuantity: "80" },
      { movementId: 102, sourceLotMovementId: 101, locationId: "main-store", baseQuantity: "20" },
    ]);
    expect(reconciled.effects).toEqual({ inventoryMovements: 0, payables: 0, expenses: 0 });

    rejects("already_reconciled", () => planHistoricalReconciliation({
      itemId: 1,
      baseUnit: "cartridge",
      basePrecision: 0,
      conversionVersion: 1,
      requiresExpiry: false,
      locationId: "main-store",
      reason: "Attempt duplicate reconciliation",
      movements: [{ movementId: 101, kind: "in", signedBaseQuantity: "80", alreadyAllocatedBaseQuantity: "80", expiryDate: null, unitCostMinor: null, payableId: null }],
    }));
  });

  it("R07: preserves requiresExpiry=true on legacy movements without expiryDate and creates lots as quarantined", () => {
    const reconciled = planHistoricalReconciliation({
      itemId: 1,
      baseUnit: "cartridge",
      basePrecision: 0,
      conversionVersion: 1,
      requiresExpiry: true,
      locationId: "main-store",
      reason: "Legacy stock without recorded expiry must stay quarantined until inspected",
      movements: [
        { movementId: 201, kind: "in", signedBaseQuantity: "40", alreadyAllocatedBaseQuantity: "0", expiryDate: null, unitCostMinor: 500, payableId: null },
      ],
    });
    expect(reconciled.lotsToCreate).toHaveLength(1);
    expect(reconciled.lotsToCreate[0]).toMatchObject({
      movementId: 201,
      requiresExpiry: true,
      expiryDate: null,
      status: "quarantined",
    });
  });

  it("R08: rejects chronological outflow before inflow when no prior lot capacity exists, and supports mixed-state two-pass allocation", () => {
    rejects("unresolved_historical_lineage", () => planHistoricalReconciliation({
      itemId: 1,
      baseUnit: "cartridge",
      basePrecision: 0,
      conversionVersion: 1,
      requiresExpiry: true,
      locationId: "main-store",
      reason: "Outflow before inflow without existing lot capacity",
      movements: [
        { movementId: 301, kind: "out", signedBaseQuantity: "10", alreadyAllocatedBaseQuantity: "0", expiryDate: null, unitCostMinor: null, payableId: null },
        { movementId: 302, kind: "in", signedBaseQuantity: "50", alreadyAllocatedBaseQuantity: "0", expiryDate: "2027-12-01", unitCostMinor: 500, payableId: null },
      ],
    }));

    const mixedState = planHistoricalReconciliation({
      itemId: 1,
      baseUnit: "cartridge",
      basePrecision: 0,
      conversionVersion: 1,
      requiresExpiry: true,
      locationId: "main-store",
      existingLotRemainingBaseQuantity: "100",
      reason: "Mixed-state item with tracked receipt lot plus legacy unallocated movements",
      movements: [
        { movementId: 401, kind: "in", signedBaseQuantity: "20", alreadyAllocatedBaseQuantity: "0", expiryDate: "2027-12-01", unitCostMinor: 500, payableId: null },
        { movementId: 402, kind: "out", signedBaseQuantity: "5", alreadyAllocatedBaseQuantity: "0", expiryDate: null, unitCostMinor: null, payableId: null },
      ],
    });
    expect(mixedState.netReconciledBaseQuantity).toBe("15");
    expect(mixedState.lotsToCreate[0]).toMatchObject({
      movementId: 401,
      status: "accepted",
      requiresExpiry: true,
    });
    expect(mixedState.allocationsToCreate).toEqual([
      { movementId: 401, sourceLotMovementId: 401, locationId: "main-store", baseQuantity: "20" },
      { movementId: 402, sourceLotMovementId: 401, locationId: "main-store", baseQuantity: "5" },
    ]);
  });

  it("R09: enforces currentDate on quarantine release so backdated resolutionDate cannot release expired or short-shelf-life stock", () => {
    const line = quarantinedLine();
    const order = issuedOrder();
    rejects("invalid_resolution_date", () => planQuarantineResolution({
      id: "qres-future",
      order,
      receiptLine: line,
      priorResolutions: [],
      action: "release",
      quantity: "1",
      reason: "Future resolution date",
      resolutionDate: "2026-10-20",
      currentDate: "2026-10-15",
    }));

    rejects("expired_receipt", () => planQuarantineResolution({
      id: "qres-backdated-expired",
      order,
      receiptLine: { ...line, expiryDate: "2026-11-01" },
      priorResolutions: [],
      action: "release",
      quantity: "1",
      reason: "Backdated resolutionDate while currentDate is within 30-day shelf life",
      resolutionDate: "2026-09-01",
      currentDate: "2026-10-15",
    }));
  });

  it("R11: supports quarantine dispose without reopening supplier delivery and wires excessDecision into planInspectedReceipt", () => {
    const line = quarantinedLine();
    const order = issuedOrder();
    const disposed = planQuarantineResolution({
      id: "qres-dispose-1",
      order,
      receiptLine: line,
      priorResolutions: [],
      action: "dispose",
      quantity: "1",
      reason: "Safe destruction of compromised quarantine portion",
      resolutionDate: "2026-10-12",
      currentDate: "2026-10-15",
    });
    expect(disposed).toMatchObject({
      action: "dispose",
      baseQuantity: "50",
      effectiveReceiptLine: {
        receiptLineId: line.id,
        releasedBaseQuantity: "0",
        returnedBaseQuantity: "0",
        disposedBaseQuantity: "50",
        remainingQuarantinedBaseQuantity: "50",
        effectiveLotStatus: "quarantined",
      },
      stockCompensation: {
        itemId: 1,
        locationId: "main-store",
        baseQuantity: "50",
        movementType: "out",
        isReturn: false,
      },
      effects: { inventoryMovements: 1, payables: 0, expenses: 0 },
    });

    const excessReceipt = planInspectedReceipt(order, {
      ...receipt(),
      id: "receipt-excess-1",
      lines: [{
        orderLineId: "order-line-1",
        arrivedQuantity: "4",
        excessDecision: "return_excess_to_supplier",
        excessReason: "1 box returned on delivery truck",
        portions: [
          {
            ...receipt().lines[0].portions[0],
            id: "receipt-line-within-order",
            quantity: "3",
          },
          {
            ...receipt().lines[0].portions[0],
            id: "receipt-line-excess-rejected",
            quantity: "1",
            disposition: "rejected",
            reason: "1 excess box returned on delivery truck",
          },
        ],
      }],
    }, [], "2026-10-11");
    expect(excessReceipt.stockEntries).toEqual([
      { receiptLineId: "receipt-line-within-order", itemId: 1, baseQuantity: "150", locationId: "main-store", availability: "available" },
    ]);
    expect(excessReceipt.excessDecisions).toEqual([
      expect.objectContaining({
        orderLineId: "order-line-1",
        orderedBaseQuantity: "150",
        withinOrderBaseQuantity: "150",
        excessBaseQuantity: "50",
        decision: "return_excess_to_supplier",
        requiresOrderAmendment: false,
      }),
    ]);
  });

  it("R10: safeInventoryErrorMessage allowlists domain errors and blocks DSNs, constraint names, tokens and arbitrary internal messages", () => {
    expect(safeInventoryErrorMessage(new InventoryDomainError("stale_version", "Version changed"))).toContain("تغيرت نسخة المستند");
    for (const raw of [
      "connect ECONNREFUSED 10.0.0.12:5432; api_key=sk-live-987654",
      "duplicate key value violates unique constraint \"stock_lots_pkey\"",
      "Invalid Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret",
      "password authentication failed for user \"clinic_admin\"",
      "permission denied for table supplier_invoices",
      "Unrecognized internal driver stack frame at /app/node_modules/pg",
    ]) {
      const msg = safeInventoryErrorMessage(new Error(raw), raw);
      expect(msg).toBe(DEFAULT_SAFE_INVENTORY_ERROR_MESSAGE);
      expect(msg).not.toContain("10.0.0.12");
      expect(msg).not.toContain("sk-live");
      expect(msg).not.toContain("stock_lots_pkey");
      expect(msg).not.toContain("Bearer");
      expect(msg).not.toContain("clinic_admin");
    }

    const scrubbed = sanitizeInventoryAuditDetails({
      api_key: "sk-live-secret",
      access_token: "tok-123",
      privateKey: "pem-key",
      note: "Connected to postgres://admin:pass@10.0.0.12:5432/clinic with Bearer eyJhbGciOi",
      safeField: "ok",
    });
    expect(scrubbed).toEqual({
      note: "[REDACTED]",
      safeField: "ok",
    });

    // Unknown InventoryDomainError code or snake_case message never leaks raw text or unallowlisted code
    expect(safeInventoryErrorMessage(new InventoryDomainError("unknown_internal_code", "custom_snake_case_leak"))).toBe(DEFAULT_SAFE_INVENTORY_ERROR_MESSAGE);
    expect(publicInventoryErrorCode("unknown_internal_code")).toBe("invalid_inventory_operation");
    expect(publicInventoryErrorCode("order_amendment_required")).toBe("order_amendment_required");
    expect(sanitizeInventoryAuditDetails({
      reason: "Synthetic auth cookie: demo-secret-value",
      safeReason: "Inspected synthetic batch",
    })).toEqual({
      reason: "[REDACTED]",
      safeReason: "Inspected synthetic batch",
    });
  });

  it("PR338 Item 3 (R01/R10): disposedBaseQuantity reduces remaining delivery and fulfillment capacity without inflating accepted or rejected", () => {
    const order = issuedOrder(); // 3 boxes = 150 cartridges
    const afterDisposedHistory = [{
      orderLineId: "order-line-1",
      acceptedBaseQuantity: "50",
      quarantinedBaseQuantity: "0",
      rejectedBaseQuantity: "0",
      disposedBaseQuantity: "50",
    }];
    // 50 accepted + 50 disposed = 100 delivered; only 1 box (50 cartridges) remains for delivery and fulfillment
    const nextReceipt = planInspectedReceipt(order, {
      ...receipt(),
      id: "receipt-after-dispose",
      lines: [{
        orderLineId: "order-line-1",
        arrivedQuantity: "1",
        portions: [{
          ...receipt().lines[0].portions[0],
          id: "receipt-line-after-dispose",
          quantity: "1",
          lotCode: "LOT-AFTER-DISPOSE",
        }],
      }],
    }, afterDisposedHistory, "2026-10-14");
    expect(nextReceipt.remaining[0]).toEqual({
      orderLineId: "order-line-1",
      acceptedBaseQuantity: "100",
      quarantinedBaseQuantity: "0",
      rejectedBaseQuantity: "0",
      disposedBaseQuantity: "50",
      remainingFulfillmentBaseQuantity: "0",
      remainingDeliveryBaseQuantity: "0",
    });

    // Attempting another shipment after 100 accepted + 50 disposed is rejected as overdelivery
    rejects("overdelivery", () => planInspectedReceipt(order, {
      ...receipt(),
      id: "receipt-over-after-dispose",
      lines: [{
        orderLineId: "order-line-1",
        arrivedQuantity: "1",
        portions: [{
          ...receipt().lines[0].portions[0],
          id: "receipt-line-over-after-dispose",
          quantity: "1",
          lotCode: "LOT-OVER",
        }],
      }],
    }, nextReceipt.remaining, "2026-10-15"));
  });

  it("PR338 Item 4 (R01/R09): hold_for_order_amendment blocks quarantine release until planOrderAmendment increases order capacity", () => {
    const order = issuedOrder(); // version 1, 3 boxes = 150 cartridges
    const heldReceipt = planInspectedReceipt(order, {
      ...receipt(),
      id: "receipt-hold-amend",
      lines: [{
        orderLineId: "order-line-1",
        arrivedQuantity: "4",
        excessDecision: "hold_for_order_amendment",
        excessReason: "Hold 1 excess box in quarantine pending formal order amendment",
        portions: [
          {
            ...receipt().lines[0].portions[0],
            id: "rline-within-3",
            quantity: "3",
            disposition: "accepted",
            lotCode: "LOT-WITHIN-3",
          },
          {
            ...receipt().lines[0].portions[0],
            id: "rline-held-excess-1",
            quantity: "1",
            disposition: "quarantined",
            lotCode: "LOT-EXCESS-1",
            reason: "Held for formal purchase order amendment",
          },
        ],
      }],
    }, [], "2026-10-11");

    const heldLine = heldReceipt.lines.find((line) => line.id === "rline-held-excess-1")!;
    expect(heldLine).toMatchObject({
      disposition: "quarantined",
      orderVersion: 1,
      orderLineAcceptedAtReceiptBaseQuantity: "150",
      heldForOrderAmendmentBaseQuantity: "50",
    });

    // Attempting to release the held excess while order is still version 1 (150 base units) fails with order_amendment_required
    rejects("order_amendment_required", () => planQuarantineResolution({
      id: "qres-before-amend",
      order,
      receiptLine: heldLine,
      priorResolutions: [],
      orderLineAcceptedBaseQuantity: "150",
      action: "release",
      quantity: "1",
      reason: "Attempt release before order amendment",
      resolutionDate: "2026-10-12",
      currentDate: "2026-10-12",
    }));

    // Formal request + approval + order amendment to version 2 (4 boxes = 200 cartridges)
    const req2: RequestRevision = {
      ...request(),
      id: "request-amend-2",
      lines: [{ id: "request-line-amend-2", itemId: 1, quantity: "1", conversion: conversion() }],
      value: { currency: "SAR", amountMinor: 10_000 },
    };
    const app2 = approveRequest({
      ...approvalInput(req2),
      decisions: [{ lineId: "request-line-amend-2", quantity: "1", reason: "Approve additional box for excess arrival" }],
    });
    const amendedPlan = planOrderAmendment({
      currentOrder: order,
      amendedOrder: {
        ...draftOrder(),
        version: 2,
        lines: [{
          ...draftOrder().lines[0],
          quantity: "4",
          sources: [
            { id: "source-1", requestId: "request-1", requestLineId: "request-line-1", baseQuantity: "150" },
            { id: "source-2", requestId: "request-amend-2", requestLineId: "request-line-amend-2", baseQuantity: "50" },
          ],
        }],
      },
      priorReceipts: heldReceipt.remaining,
      priorAllocations: [],
      requests: [
        { request: request(), approval: approval() },
        { request: req2, approval: app2 },
      ],
      supplier: { id: 21, active: true, isSupplier: true },
      reason: "Amend PO to cover 1 excess box under approved request-amend-2",
    });
    expect(amendedPlan.order.version).toBe(2);
    expect(amendedPlan.order.lines[0].quantity).toBe("4");

    // Now releasing the held quarantine line under amendedOrder (v2, 200 base units) succeeds
    const releasedAfterAmend = planQuarantineResolution({
      id: "qres-after-amend",
      order: amendedPlan.order,
      receiptLine: heldLine,
      priorResolutions: [],
      orderLineAcceptedBaseQuantity: "150",
      action: "release",
      quantity: "1",
      reason: "Release held excess after PO amendment v2",
      resolutionDate: "2026-10-12",
      currentDate: "2026-10-12",
    });
    expect(releasedAfterAmend.effectiveReceiptLine).toMatchObject({
      releasedBaseQuantity: "50",
      remainingQuarantinedBaseQuantity: "0",
      effectiveLotStatus: "accepted",
    });
  });

  it("PR338 Round 2 Item 1 (P1): planOrderAmendment preserves historical commitment deltas across repricing, shipping/discount, FX rounding, and repeated amendments", () => {
    const pieceConv = unitConversionSnapshot({
      itemId: 1,
      version: 1,
      baseUnit: "cartridge",
      enteredUnit: "cartridge",
      baseUnitsPerEnteredUnit: "1",
      enteredPrecision: 0,
      basePrecision: 0,
    });
    const req20: RequestRevision = {
      id: "req-budget-2000",
      version: 1,
      branchId: "clinic",
      requestedBy: 12,
      reason: "Approved 20 pieces with 2000 YER ceiling",
      proposedSupplierPartyId: 21,
      value: { currency: "YER", amountMinor: 2_000 },
      lines: [{ id: "req-line-20", itemId: 1, quantity: "20", conversion: pieceConv }],
    };
    const app20 = approveRequest({
      request: req20,
      state: "submitted",
      actorId: 1,
      canApprove: true,
      allowedBranchIds: ["clinic"],
      policy: { version: 1, currency: "YER", limitMinor: 50_000, allowSelfApproval: false },
      selfApprovalReason: null,
      valuation: valuationSnapshot({
        purpose: "approval_estimate",
        currency: "YER",
        amountMinor: 2_000,
        rateToBase: "1",
        capturedAt: "2026-10-10T08:00:00Z",
        sourceRef: "yer-ceiling",
      }),
      decisions: [{ lineId: "req-line-20", quantity: "20", reason: "Approve 20 pieces at 2000 YER ceiling" }],
    });

    const initialPlan = planOrderIssue({
      order: {
        id: "order-budget-1",
        version: 1,
        branchId: "clinic",
        supplierPartyId: 21,
        currency: "YER",
        shippingMinor: 0,
        discountMinor: 0,
        lines: [{
          id: "oline-1",
          itemId: 1,
          kind: "stock",
          quantity: "10",
          conversion: pieceConv,
          price: { state: "known", currency: "YER", unitPriceMinor: 100, reason: "Initial quote 100 YER" },
          trackLot: true,
          requiresExpiry: true,
          minimumShelfLifeDays: 30,
          sources: [{ id: "src-10", requestId: req20.id, requestLineId: "req-line-20", baseQuantity: "10" }],
        }],
      },
      requests: [{ request: req20, approval: app20 }],
      priorAllocations: [],
      supplier: { id: 21, active: true, isSupplier: true },
    });
    expect(initialPlan.totalMinor).toBe(1_000);
    expect(initialPlan.allocations[0].amountMinor).toBe(1_000);

    const amendedPlan = planOrderAmendment({
      currentOrder: initialPlan.order,
      amendedOrder: {
        ...initialPlan.order,
        version: 2,
        lines: [{
          ...initialPlan.order.lines[0],
          quantity: "15",
          price: { state: "known", currency: "YER", unitPriceMinor: 120, reason: "Repriced quote 120 YER" },
          sources: [
            { id: "src-10", requestId: req20.id, requestLineId: "req-line-20", baseQuantity: "10" },
            { id: "src-5", requestId: req20.id, requestLineId: "req-line-20", baseQuantity: "5" },
          ],
        }],
      },
      requests: [{ request: req20, approval: app20 }],
      priorAllocations: initialPlan.allocations,
      priorReceipts: [],
      supplier: { id: 21, active: true, isSupplier: true },
      reason: "Amend quantity to 15 and reprice to 120 YER",
    });
    expect(amendedPlan.newAllocations).toHaveLength(1);
    expect(amendedPlan.newAllocations[0].amountMinor).toBe(800);
    const persistedAfterAmend = [...initialPlan.allocations, ...amendedPlan.newAllocations];
    expect(persistedAfterAmend.reduce((sum, a) => sum + a.amountMinor, 0)).toBe(1_800);

    rejects("source_budget_exceeded", () => planOrderIssue({
      order: {
        id: "order-budget-2",
        version: 1,
        branchId: "clinic",
        supplierPartyId: 21,
        currency: "YER",
        shippingMinor: 0,
        discountMinor: 0,
        lines: [{
          id: "oline-2",
          itemId: 1,
          kind: "stock",
          quantity: "5",
          conversion: pieceConv,
          price: { state: "known", currency: "YER", unitPriceMinor: 80, reason: "Second order 80 YER" },
          trackLot: true,
          requiresExpiry: true,
          minimumShelfLifeDays: 30,
          sources: [{ id: "src-rem-5", requestId: req20.id, requestLineId: "req-line-20", baseQuantity: "5" }],
        }],
      },
      requests: [{ request: req20, approval: app20 }],
      priorAllocations: persistedAfterAmend,
      supplier: { id: 21, active: true, isSupplier: true },
    }));

    rejects("invalid_transition", () => planOrderAmendment({
      currentOrder: amendedPlan.order,
      amendedOrder: {
        ...amendedPlan.order,
        version: 3,
        lines: [{
          ...amendedPlan.order.lines[0],
          requiresExpiry: false,
          quantity: "20",
          sources: [
            ...amendedPlan.order.lines[0].sources,
            { id: "src-last-5", requestId: req20.id, requestLineId: "req-line-20", baseQuantity: "5" },
          ],
        }],
      },
      requests: [{ request: req20, approval: app20 }],
      priorAllocations: persistedAfterAmend,
      priorReceipts: [],
      supplier: { id: 21, active: true, isSupplier: true },
      reason: "Attempt to weaken requiresExpiry during amendment",
    }));
  });

  it("PR338 Round 2 Item 6 (P2): disposing held excess arrival does not invalidate receipt history for subsequent multi-line receipts", () => {
    const multiLineOrder: IssuedPurchaseOrder = {
      ...issuedOrder(),
      lines: [
        issuedOrder().lines[0],
        {
          ...issuedOrder().lines[0],
          id: "order-line-2",
          quantity: "2",
          sources: [{ id: "source-line-2", requestId: "request-1", requestLineId: "request-line-1", baseQuantity: "100" }],
        },
      ],
    };

    const historyAfterHeldDispose = [{
      orderLineId: "order-line-1",
      acceptedBaseQuantity: "150",
      quarantinedBaseQuantity: "0",
      rejectedBaseQuantity: "0",
      disposedBaseQuantity: "50",
      disposedExcessBaseQuantity: "50",
    }];

    const line2Receipt = planInspectedReceipt(multiLineOrder, {
      ...receipt(),
      id: "receipt-line2-normal",
      lines: [{
        orderLineId: "order-line-2",
        arrivedQuantity: "2",
        portions: [
          { ...receipt().lines[0].portions[0], id: "rl2-acc", quantity: "2", disposition: "accepted", lotCode: "LOT-L2-ACC" },
        ],
      }],
    }, historyAfterHeldDispose, "2026-10-12");

    expect(line2Receipt.remaining.find((r) => r.orderLineId === "order-line-1")).toMatchObject({
      acceptedBaseQuantity: "150",
      disposedBaseQuantity: "50",
      remainingFulfillmentBaseQuantity: "0",
      remainingDeliveryBaseQuantity: "0",
    });
    expect(line2Receipt.remaining.find((r) => r.orderLineId === "order-line-2")).toMatchObject({
      acceptedBaseQuantity: "100",
      remainingFulfillmentBaseQuantity: "0",
      remainingDeliveryBaseQuantity: "0",
    });
  });

  it("Point 1 (a657 review): amending an earlier order under distributed FX rounding validates full history and preserves cumulative base deltas", () => {
    const pieceConv: UnitConversionSnapshot = {
      itemId: 1,
      version: 1,
      baseUnit: "cartridge",
      enteredUnit: "cartridge",
      baseUnitsPerEnteredUnit: "1",
      enteredPrecision: 0,
      basePrecision: 0,
    };
    const reqSar: RequestRevision = {
      id: "req-fx-sar",
      version: 1,
      branchId: "branch-1",
      requestedBy: 10,
      reason: "FX distributed rounding test",
      proposedSupplierPartyId: 21,
      value: { currency: "SAR", amountMinor: 100 },
      lines: [{ id: "req-fx-line", itemId: 1, quantity: "10", conversion: pieceConv }],
    };
    const appSar = approveRequest({
      request: reqSar,
      state: "submitted",
      actorId: 11,
      canApprove: true,
      allowedBranchIds: ["branch-1"],
      policy: { version: 1, currency: "YER", limitMinor: 200_000, allowSelfApproval: false },
      selfApprovalReason: null,
      valuation: valuationSnapshot({
        currency: "SAR",
        amountMinor: 100,
        purpose: "approval_estimate",
        rateToBase: "50",
        capturedAt: "2026-10-15T10:00:00Z",
        sourceRef: "fx-50",
      }),
      decisions: [{ lineId: "req-fx-line", quantity: "10", reason: "Approve 10 units" }],
    });

    const orderAPlan = planOrderIssue({
      order: {
        id: "po-fx-a",
        version: 1,
        branchId: "branch-1",
        supplierPartyId: 21,
        currency: "SAR",
        shippingMinor: 0,
        discountMinor: 0,
        lines: [{
          id: "line-fx-a",
          itemId: 1,
          kind: "stock",
          quantity: "1",
          conversion: pieceConv,
          price: { state: "known", currency: "SAR", unitPriceMinor: 1, reason: "1 halala" },
          trackLot: true,
          requiresExpiry: true,
          minimumShelfLifeDays: 30,
          sources: [{ id: "src-fx-a1", requestId: reqSar.id, requestLineId: "req-fx-line", baseQuantity: "1" }],
        }],
      },
      requests: [{ request: reqSar, approval: appSar }],
      priorAllocations: [],
      supplier: { id: 21, active: true, isSupplier: true },
    });
    expect(orderAPlan.allocations[0]).toMatchObject({ amountMinor: 1, baseAmountMinor: 1 });

    const orderBPlan = planOrderIssue({
      order: {
        id: "po-fx-b",
        version: 1,
        branchId: "branch-1",
        supplierPartyId: 21,
        currency: "SAR",
        shippingMinor: 0,
        discountMinor: 0,
        lines: [{
          id: "line-fx-b",
          itemId: 1,
          kind: "stock",
          quantity: "1",
          conversion: pieceConv,
          price: { state: "known", currency: "SAR", unitPriceMinor: 1, reason: "1 halala" },
          trackLot: true,
          requiresExpiry: true,
          minimumShelfLifeDays: 30,
          sources: [{ id: "src-fx-b1", requestId: reqSar.id, requestLineId: "req-fx-line", baseQuantity: "1" }],
        }],
      },
      requests: [{ request: reqSar, approval: appSar }],
      priorAllocations: orderAPlan.allocations,
      supplier: { id: 21, active: true, isSupplier: true },
    });
    expect(orderBPlan.allocations[0]).toMatchObject({ amountMinor: 1, baseAmountMinor: 0 });

    const allPrior = [...orderAPlan.allocations, ...orderBPlan.allocations];
    const amendedA = planOrderAmendment({
      currentOrder: orderAPlan.order,
      amendedOrder: {
        ...orderAPlan.order,
        version: 2,
        lines: [{
          ...orderAPlan.order.lines[0],
          quantity: "2",
          sources: [
            ...orderAPlan.order.lines[0].sources,
            { id: "src-fx-a2", requestId: reqSar.id, requestLineId: "req-fx-line", baseQuantity: "1" },
          ],
        }],
      },
      requests: [{ request: reqSar, approval: appSar }],
      priorAllocations: allPrior,
      priorReceipts: [],
      supplier: { id: 21, active: true, isSupplier: true },
      reason: "Amend earlier order A under distributed FX rounding",
    });

    expect(amendedA.newAllocations).toHaveLength(1);
    expect(amendedA.newAllocations[0]).toMatchObject({
      id: "src-fx-a2",
      amountMinor: 1,
      baseAmountMinor: 1,
    });
    const persistedTotalBase = [...allPrior, ...amendedA.newAllocations].reduce((s, a) => s + a.baseAmountMinor, 0);
    expect(persistedTotalBase).toBe(2);

    rejects("valuation_mismatch", () => planOrderAmendment({
      currentOrder: orderAPlan.order,
      amendedOrder: {
        ...orderAPlan.order,
        version: 2,
        lines: [{
          ...orderAPlan.order.lines[0],
          quantity: "2",
          sources: [
            ...orderAPlan.order.lines[0].sources,
            { id: "src-fx-a2-bad", requestId: reqSar.id, requestLineId: "req-fx-line", baseQuantity: "1" },
          ],
        }],
      },
      requests: [{ request: reqSar, approval: appSar }],
      priorAllocations: [
        orderAPlan.allocations[0],
        { ...orderBPlan.allocations[0], baseAmountMinor: 5 },
      ],
      priorReceipts: [],
      supplier: { id: 21, active: true, isSupplier: true },
      reason: "Tampered history must still fail valuation_mismatch",
    }));
  });

  it("Point 2 (a657 review): excess approved by order amendment is no longer exempt from capacity when disposed", () => {
    const pieceConv: UnitConversionSnapshot = {
      itemId: 1,
      version: 1,
      baseUnit: "cartridge",
      enteredUnit: "cartridge",
      baseUnitsPerEnteredUnit: "1",
      enteredPrecision: 0,
      basePrecision: 0,
    };
    const order10: IssuedPurchaseOrder = {
      ...issuedOrder(),
      version: 1,
      lines: [{
        ...issuedOrder().lines[0],
        id: "oline-10",
        quantity: "10",
        conversion: pieceConv,
        sources: [{ id: "src-10", requestId: "request-1", requestLineId: "request-line-1", baseQuantity: "10" }],
      }],
    };

    const rec15 = planInspectedReceipt(order10, {
      ...receipt(),
      id: "rec-15-quar",
      orderVersion: 1,
      lines: [{
        orderLineId: "oline-10",
        arrivedQuantity: "15",
        excessDecision: "hold_for_order_amendment",
        excessReason: "Hold 5 excess pending amendment",
        portions: [{
          ...receipt().lines[0].portions[0],
          id: "q-line-15",
          quantity: "15",
          disposition: "quarantined",
          lotCode: "LOT-15-Q",
        }],
      }],
    }, [], "2026-10-11");

    const qLine = rec15.lines[0];
    expect(qLine.heldForOrderAmendmentBaseQuantity).toBe("5");
    expect(qLine.orderLineHeldStartBaseQuantity).toBe("10");

    const order15: IssuedPurchaseOrder = {
      ...order10,
      version: 2,
      lines: [{
        ...order10.lines[0],
        quantity: "15",
      }],
    };

    const rel12 = planQuarantineResolution({
      id: "res-rel-12",
      order: order15,
      receiptLine: qLine,
      priorResolutions: [],
      orderLineAcceptedBaseQuantity: "0",
      action: "release",
      quantity: "12",
      reason: "Release 12 after amendment to 15",
      resolutionDate: "2026-10-12",
      currentDate: "2026-10-12",
    });
    expect(rel12.effectiveReceiptLine.remainingQuarantinedBaseQuantity).toBe("3");

    const disp3 = planQuarantineResolution({
      id: "res-disp-3",
      order: order15,
      receiptLine: qLine,
      priorResolutions: [{ id: "res-rel-12", receiptLineId: qLine.id, action: "release", baseQuantity: "12" }],
      orderLineAcceptedBaseQuantity: "12",
      action: "dispose",
      quantity: "3",
      reason: "Dispose remaining 3 locally after amendment approved all 15",
      resolutionDate: "2026-10-12",
      currentDate: "2026-10-12",
    });
    expect(disp3.effectiveReceiptLine.remainingQuarantinedBaseQuantity).toBe("0");

    const priorHistoryAfterAmendAndDispose = [{
      orderLineId: "oline-10",
      acceptedBaseQuantity: "12",
      quarantinedBaseQuantity: "0",
      rejectedBaseQuantity: "0",
      disposedBaseQuantity: "3",
      disposedExcessBaseQuantity: "0",
    }];

    rejects("overdelivery", () => planInspectedReceipt(order15, {
      ...receipt(),
      id: "rec-extra-3",
      orderVersion: 2,
      lines: [{
        orderLineId: "oline-10",
        arrivedQuantity: "3",
        portions: [{
          ...receipt().lines[0].portions[0],
          id: "acc-extra-3",
          quantity: "3",
          disposition: "accepted",
          lotCode: "LOT-EXTRA-3",
        }],
      }],
    }, priorHistoryAfterAmendAndDispose, "2026-10-13"));
  });


});
