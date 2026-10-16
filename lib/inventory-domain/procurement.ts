/** Pure procurement plans only. No database, ledger, payment or permission writer.
 * Every authorizer, revision and prior allocation must come from locked server
 * reads. A plan is not evidence that a transaction was committed.
 */
import { CLINIC_BASE_CURRENCY, MINOR_UNITS, requireCurrency, type Currency } from "../money";
import {
  convertQuantity, decimalRatio, invariant, positiveId, quantityAtoms, quantityText,
  unitConversionSnapshot, type UnitConversionSnapshot,
} from "./quantities";

export interface MoneyAmount { readonly currency: Currency; readonly amountMinor: number }
export type UnitPrice =
  | { readonly state: "missing"; readonly currency: Currency; readonly reason: string }
  | { readonly state: "known" | "estimated"; readonly currency: Currency; readonly unitPriceMinor: number; readonly reason: string };

export function minorAmount(value: unknown): number {
  invariant(typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "invalid_money", "Money must be nonnegative safe integer minor units");
  return value;
}

function safeMinor(value: bigint): number {
  invariant(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), "money_overflow", "Amount exceeds safe minor units");
  return Number(value);
}

function roundRatio(numerator: bigint, denominator: bigint): bigint {
  invariant(numerator >= 0n && denominator > 0n, "invalid_ratio", "Expected a nonnegative exact ratio");
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function identifier(value: unknown, name: string): asserts value is string {
  invariant(typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 120,
    "invalid_identifier", `${name} is required and must be bounded text`);
}

function reason(value: unknown): asserts value is string {
  invariant(typeof value === "string" && value.trim().length > 0 && value.length <= 2_000,
    "reason_required", "A bounded explicit reason is required");
}

function dateOnly(value: unknown): asserts value is string {
  invariant(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), "invalid_date", "Use an ISO calendar date");
  const time = Date.parse(`${value}T00:00:00.000Z`);
  invariant(Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value,
    "invalid_date", "Invalid calendar date");
}

function timestamp(value: string): void {
  invariant(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value),
    "invalid_timestamp", "A UTC timestamp is required");
  dateOnly(value.slice(0, 10));
  const time = Date.parse(value);
  invariant(Number.isFinite(time) && new Date(time).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z")),
    "invalid_timestamp", "Invalid UTC timestamp");
}

function unique<T>(values: readonly T[], key: (value: T) => string, name: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    identifier(id, name);
    invariant(!result.has(id), "duplicate_source", `Duplicate ${name}: ${id}`);
    result.set(id, value);
  }
  return result;
}

function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Canonical strict JSON, deliberately not a lossy JS stringify/replacer. The
 * persistence adapter may hash this text but must version the algorithm. Numbers
 * are safe integers; quantities/rates must already be normalized decimal text.
 */
export function payloadIdentity(value: unknown): string {
  const parents = new Set<object>();
  function canonical(input: unknown, depth: number): string {
    invariant(depth <= 32, "invalid_payload", "Payload is too deeply nested");
    if (input === null || typeof input === "boolean" || typeof input === "string") return JSON.stringify(input);
    if (typeof input === "number") {
      invariant(Number.isSafeInteger(input) && !Object.is(input, -0), "invalid_payload", "Payload numbers must be safe integers");
      return String(input);
    }
    invariant(typeof input === "object" && input !== null, "invalid_payload", "Payload contains a non-JSON value");
    invariant(!parents.has(input), "invalid_payload", "Payload is cyclic");
    parents.add(input);
    let result: string;
    if (Array.isArray(input)) {
      invariant(Object.keys(input).length === input.length, "invalid_payload", "Sparse arrays or array properties are not accepted");
      result = `[${input.map((entry) => canonical(entry, depth + 1)).join(",")}]`;
    } else {
      invariant(Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null,
        "invalid_payload", "Payload must contain plain JSON objects");
      invariant(Object.getOwnPropertySymbols(input).length === 0, "invalid_payload", "Symbol properties are not accepted");
      result = `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
    }
    parents.delete(input);
    return result;
  }
  const identity = `inventory-json-v1:${canonical(value, 0)}`;
  invariant(identity.length <= 1_000_000, "invalid_payload", "Payload is too large");
  return identity;
}

export interface OperationRecord {
  readonly scope: string; readonly key: string; readonly identity: string; readonly resultId: string;
}

export function inspectIdempotency(scope: string, key: string, payload: unknown, previous: OperationRecord | null):
  { readonly kind: "new"; readonly identity: string } |
  { readonly kind: "replay"; readonly identity: string; readonly resultId: string } {
  identifier(scope, "operation scope");
  identifier(key, "idempotency key");
  const identity = payloadIdentity(payload);
  if (!previous) return Object.freeze({ kind: "new", identity });
  invariant(previous.scope === scope && previous.key === key, "operation_scope_mismatch", "Operation lookup has the wrong scope/key");
  invariant(previous.identity === identity, "idempotency_conflict", "The same operation key cannot identify changed content");
  identifier(previous.resultId, "operation result");
  return Object.freeze({ kind: "replay", identity, resultId: previous.resultId });
}

export interface ValuationSnapshot extends MoneyAmount {
  readonly purpose: "approval_estimate" | "invoice_valuation";
  readonly baseCurrency: Currency;
  /** Existing money convention: YER major units for one foreign major unit. */
  readonly rateToBase: string;
  readonly baseAmountMinor: number;
  readonly capturedAt: string;
  readonly sourceRef: string;
}

export function valuationSnapshot(input: Omit<ValuationSnapshot, "baseCurrency" | "baseAmountMinor">): ValuationSnapshot {
  const currency = requireCurrency(input.currency, "procurement valuation", input.sourceRef);
  minorAmount(input.amountMinor);
  invariant(input.purpose === "approval_estimate" || input.purpose === "invoice_valuation", "invalid_valuation_purpose", "Valuation purpose is required");
  timestamp(input.capturedAt);
  identifier(input.sourceRef, "valuation source");
  const rate = decimalRatio(input.rateToBase);
  invariant(rate.numerator > 0n, "invalid_rate", "The valuation rate must be positive");
  invariant(currency !== CLINIC_BASE_CURRENCY || rate.numerator === rate.denominator,
    "invalid_rate", "The clinic base currency rate must equal one");
  const baseAmountMinor = safeMinor(roundRatio(BigInt(input.amountMinor) * rate.numerator * BigInt(MINOR_UNITS[CLINIC_BASE_CURRENCY]),
    rate.denominator * BigInt(MINOR_UNITS[currency])));
  return Object.freeze({ purpose: input.purpose, currency, amountMinor: input.amountMinor,
    baseCurrency: CLINIC_BASE_CURRENCY, baseAmountMinor, rateToBase: rate.canonical,
    capturedAt: input.capturedAt, sourceRef: input.sourceRef });
}

function validateValuation(snapshot: ValuationSnapshot): void {
  const calculated = valuationSnapshot(snapshot);
  invariant(snapshot.baseCurrency === calculated.baseCurrency && snapshot.baseAmountMinor === calculated.baseAmountMinor,
    "valuation_mismatch", "Valuation snapshot does not match its exact original amount and rate");
}

/** Largest remainder, stable ties by source id; all calculations use bigint.
 * Use the same function separately for shipping and discount and save its policy.
 */
export function allocateMinor(totalMinor: number, weights: readonly { readonly id: string; readonly weight: string }[]):
  ReadonlyArray<{ readonly id: string; readonly amountMinor: number }> {
  minorAmount(totalMinor);
  unique(weights, (row) => row.id, "allocation id");
  invariant(weights.length > 0, "empty_allocation", "An allocation needs destinations");
  const parsed = weights.map((row) => {
    invariant(typeof row.weight === "string" && /^\d{1,40}$/.test(row.weight), "invalid_weight", "Weights must be bounded nonnegative integer text");
    return { id: row.id, weight: BigInt(row.weight) };
  });
  const sum = parsed.reduce((total, row) => total + row.weight, 0n);
  invariant(sum > 0n || totalMinor === 0, "zero_weight", "A nonzero amount cannot be allocated to zero weights");
  if (sum === 0n) return freeze(parsed.map((row) => ({ id: row.id, amountMinor: 0 })));
  const rows = parsed.map((row) => ({ id: row.id, minor: BigInt(totalMinor) * row.weight / sum,
    remainder: BigInt(totalMinor) * row.weight % sum }));
  let left = BigInt(totalMinor) - rows.reduce((total, row) => total + row.minor, 0n);
  const ranked = [...rows].sort((a, b) => a.remainder === b.remainder ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    : a.remainder > b.remainder ? -1 : 1);
  for (const row of ranked) { if (left === 0n) break; row.minor += 1n; left -= 1n; }
  return freeze(rows.map((row) => ({ id: row.id, amountMinor: safeMinor(row.minor) })));
}

function priceTotal(price: UnitPrice, quantity: string, currency: Currency): number | null {
  requireCurrency(price.currency, "unit price", "procurement");
  invariant(price.currency === currency, "currency_mismatch", "Unit price and document currency differ");
  invariant(["known", "estimated", "missing"].includes(price.state), "invalid_price_state", "Explicit cost state is required");
  if (price.state === "missing") { reason(price.reason); return null; }
  minorAmount(price.unitPriceMinor);
  if (price.unitPriceMinor === 0 || price.state === "estimated") reason(price.reason);
  return safeMinor(roundRatio(BigInt(price.unitPriceMinor) * quantityAtoms(quantity), 1_000n));
}

export interface RequestLine {
  readonly id: string; readonly itemId: number; readonly quantity: string;
  readonly conversion: UnitConversionSnapshot;
}
export interface RequestRevision {
  readonly id: string; readonly version: number; readonly branchId: string; readonly requestedBy: number;
  readonly reason: string; readonly proposedSupplierPartyId: number | null;
  readonly value: MoneyAmount | null; readonly lines: readonly RequestLine[];
}
export interface RequestApproval {
  readonly requestId: string; readonly requestVersion: number; readonly requestIdentity: string;
  readonly branchId: string; readonly actorId: number; readonly policyVersion: number;
  readonly selfApprovalReason: string | null; readonly status: "approved" | "partially_approved" | "rejected";
  readonly valueCeiling: ValuationSnapshot | null;
  readonly lines: ReadonlyArray<{ readonly lineId: string; readonly itemId: number; readonly baseQuantity: string; readonly reason: string }>;
}

export function validateRequest(request: RequestRevision): void {
  identifier(request.id, "request id"); identifier(request.branchId, "branch id");
  positiveId(request.version, "request version"); positiveId(request.requestedBy, "requester");
  reason(request.reason);
  if (request.proposedSupplierPartyId !== null) positiveId(request.proposedSupplierPartyId, "supplier");
  if (request.value) { requireCurrency(request.value.currency, "request value", request.id); minorAmount(request.value.amountMinor); }
  invariant(request.lines.length > 0, "empty_request", "A request must have lines");
  unique(request.lines, (line) => line.id, "request line");
  for (const line of request.lines) {
    positiveId(line.itemId, "request item");
    invariant(line.conversion.itemId === line.itemId, "item_mismatch", "Conversion belongs to a different item");
    convertQuantity(line.quantity, line.conversion);
  }
}

export function approveRequest(input: {
  readonly request: RequestRevision; readonly state: "submitted" | "in_review";
  readonly actorId: number; readonly canApprove: boolean; readonly allowedBranchIds: readonly string[];
  readonly policy: { readonly version: number; readonly currency: Currency; readonly limitMinor: number; readonly allowSelfApproval: boolean };
  readonly selfApprovalReason: string | null; readonly valuation: ValuationSnapshot | null;
  readonly decisions: readonly { readonly lineId: string; readonly quantity: string; readonly reason: string }[];
}): RequestApproval {
  const { request } = input;
  validateRequest(request);
  invariant(input.state === "submitted" || input.state === "in_review", "invalid_transition", "Only a submitted request can be approved");
  positiveId(input.actorId, "approval actor"); positiveId(input.policy.version, "approval policy version");
  invariant(input.canApprove === true && input.allowedBranchIds.includes(request.branchId), "approval_forbidden", "Approval authority does not cover this branch");
  if (input.actorId === request.requestedBy) {
    invariant(input.policy.allowSelfApproval === true, "self_approval_forbidden", "Policy does not authorize self approval");
    reason(input.selfApprovalReason);
  }
  minorAmount(input.policy.limitMinor);
  invariant(input.policy.currency === CLINIC_BASE_CURRENCY, "unsupported_policy_currency", "This policy uses explicit YER approval limits");
  if (request.value) {
    invariant(input.valuation !== null, "missing_valuation", "A monetary request needs a fixed approval valuation");
    validateValuation(input.valuation);
    invariant(input.valuation.purpose === "approval_estimate" && input.valuation.currency === request.value.currency
      && input.valuation.amountMinor === request.value.amountMinor, "valuation_mismatch", "Approval must value this request's exact original amount");
    invariant(input.valuation.baseAmountMinor <= input.policy.limitMinor, "approval_limit", "Request exceeds the authorized currency-valued approval limit");
  } else invariant(input.valuation === null, "valuation_mismatch", "An unknown request value cannot be silently replaced by a valuation");
  const decisions = unique(input.decisions, (line) => line.lineId, "approval decision");
  invariant(decisions.size === request.lines.length, "incomplete_decision", "Every requested line needs an explicit decision");
  let all = true; let any = false;
  const lines = request.lines.map((line) => {
    const decision = decisions.get(line.id);
    invariant(decision, "incomplete_decision", "Approval decision is missing");
    const original = quantityAtoms(convertQuantity(line.quantity, line.conversion).baseQuantity);
    const approved = quantityAtoms(convertQuantity(decision.quantity, line.conversion, true).baseQuantity, 3, true);
    invariant(approved <= original, "approval_quantity", "Approved quantity exceeds the requested quantity");
    if (approved !== original) { all = false; reason(decision.reason); }
    if (approved > 0n) any = true;
    return { lineId: line.id, itemId: line.itemId, baseQuantity: quantityText(approved), reason: decision.reason };
  });
  return freeze({ requestId: request.id, requestVersion: request.version, requestIdentity: payloadIdentity(request),
    branchId: request.branchId, actorId: input.actorId, policyVersion: input.policy.version,
    selfApprovalReason: input.selfApprovalReason, status: all ? "approved" : any ? "partially_approved" : "rejected",
    valueCeiling: input.valuation ? { ...input.valuation } : null, lines });
}

export function requireCurrentApproval(request: RequestRevision, approval: RequestApproval): void {
  validateRequest(request);
  invariant(approval.requestId === request.id && approval.requestVersion === request.version
    && approval.requestIdentity === payloadIdentity(request) && approval.branchId === request.branchId,
    "stale_approval", "Approval does not authorize this exact request revision/content");
  invariant(approval.status === "approved" || approval.status === "partially_approved", "request_not_approved", "The request is not approved");
  positiveId(approval.actorId, "approval actor"); positiveId(approval.policyVersion, "approval policy version");
  const lines = unique(approval.lines, (line) => line.lineId, "approved line");
  invariant(lines.size === request.lines.length, "incomplete_decision", "Approval does not cover the exact request lines");
  for (const requested of request.lines) {
    const approved = lines.get(requested.id);
    invariant(approved && approved.itemId === requested.itemId, "item_mismatch", "Approval line belongs to a different item");
    invariant(quantityAtoms(approved.baseQuantity, requested.conversion.basePrecision, true)
      <= quantityAtoms(convertQuantity(requested.quantity, requested.conversion).baseQuantity),
    "approval_quantity", "Stored approval exceeds requested quantity");
  }
  if (approval.valueCeiling !== null) {
    validateValuation(approval.valueCeiling);
    invariant(request.value && approval.valueCeiling.purpose === "approval_estimate"
      && approval.valueCeiling.currency === request.value.currency && approval.valueCeiling.amountMinor === request.value.amountMinor,
    "valuation_mismatch", "Stored value approval differs from the approved request");
  }
}

export interface SourceAllocation {
  readonly id: string; readonly requestId: string; readonly requestLineId: string; readonly baseQuantity: string;
}
export interface CommittedSourceAllocation extends SourceAllocation {
  readonly currency: Currency; readonly amountMinor: number; readonly baseAmountMinor: number;
}
export interface PurchaseOrderLine {
  readonly id: string; readonly itemId: number; readonly kind: "stock" | "non_stock" | "asset";
  readonly quantity: string; readonly conversion: UnitConversionSnapshot; readonly price: UnitPrice;
  readonly trackLot: boolean; readonly requiresExpiry: boolean; readonly minimumShelfLifeDays: number;
  readonly sources: readonly SourceAllocation[];
}
export interface PurchaseOrder {
  readonly id: string; readonly version: number; readonly branchId: string; readonly supplierPartyId: number;
  readonly currency: Currency; readonly shippingMinor: number; readonly discountMinor: number;
  readonly lines: readonly PurchaseOrderLine[];
}
export interface IssuedPurchaseOrder extends PurchaseOrder { readonly status: "issued" }

function validateOrder(order: PurchaseOrder): void {
  identifier(order.id, "order id"); identifier(order.branchId, "order branch");
  positiveId(order.version, "order version"); positiveId(order.supplierPartyId, "order supplier");
  requireCurrency(order.currency, "purchase order", order.id);
  minorAmount(order.shippingMinor); minorAmount(order.discountMinor);
  invariant(order.lines.length > 0, "empty_order", "Order needs lines");
  unique(order.lines, (line) => line.id, "order line");
  for (const line of order.lines) {
    positiveId(line.itemId, "order item");
    invariant(["stock", "non_stock", "asset"].includes(line.kind), "invalid_item_kind", "Invalid item kind");
    invariant(line.conversion.itemId === line.itemId, "item_mismatch", "Conversion belongs to a different item");
    convertQuantity(line.quantity, line.conversion);
    priceTotal(line.price, line.quantity, order.currency);
    invariant(typeof line.trackLot === "boolean" && typeof line.requiresExpiry === "boolean", "invalid_tracking", "Tracking policy must be explicit");
    invariant(Number.isSafeInteger(line.minimumShelfLifeDays) && line.minimumShelfLifeDays >= 0 && line.minimumShelfLifeDays <= 36_500,
      "invalid_shelf_life", "Minimum shelf life must be bounded whole days");
  }
}

const NO_FINANCIAL_EFFECT = Object.freeze({ inventoryMovements: 0, payables: 0, expenses: 0 });

/** A validated issuance plan, still requiring a permissioned atomic transaction.
 * Supplier active/kind checks belong to the parties owner, never a numeric-id guess.
 */
export function planOrderIssue(input: {
  readonly order: PurchaseOrder;
  readonly requests: readonly { readonly request: RequestRevision; readonly approval: RequestApproval }[];
  readonly priorAllocations: readonly CommittedSourceAllocation[];
  readonly supplier: { readonly id: number; readonly active: boolean; readonly isSupplier: boolean };
}): { readonly order: IssuedPurchaseOrder; readonly allocations: readonly CommittedSourceAllocation[];
  readonly totalMinor: number; readonly effects: typeof NO_FINANCIAL_EFFECT } {
  const { order } = input;
  validateOrder(order);
  invariant(input.supplier.id === order.supplierPartyId && input.supplier.active === true && input.supplier.isSupplier === true,
    "invalid_supplier", "A new order requires this active supplier from parties");
  const requests = unique(input.requests, (row) => row.request.id, "request");
  for (const { request, approval } of requests.values()) {
    requireCurrentApproval(request, approval);
    invariant(request.branchId === order.branchId, "branch_mismatch", "Order and request branches differ");
    invariant(request.proposedSupplierPartyId === null || request.proposedSupplierPartyId === order.supplierPartyId,
      "supplier_mismatch", "Supplier choice is outside the approved request");
    invariant(approval.valueCeiling !== null, "value_approval_required", "A quantity-only approval cannot authorize a supplier order");
    validateValuation(approval.valueCeiling);
    invariant(approval.valueCeiling.currency === order.currency, "currency_mismatch", "Order currency requires a matching approved value snapshot");
  }
  const historical = unique(input.priorAllocations, (row) => row.id, "prior allocation");
  const cumulativeQty = new Map<string, bigint>();
  const cumulativeMoney = new Map<string, bigint>();
  const priorBaseMoney = new Map<string, bigint>();
  const sourceKey = (row: SourceAllocation) => JSON.stringify([row.requestId, row.requestLineId]);
  for (const row of historical.values()) {
    identifier(row.requestId, "allocation request"); identifier(row.requestLineId, "allocation line");
    const owner = requests.get(row.requestId);
    invariant(owner, "unknown_prior_source", "Prior source allocation is outside the supplied request scope");
    invariant(row.currency === owner.approval.valueCeiling!.currency, "currency_mismatch", "Prior allocation currency differs from the approved source");
    const key = sourceKey(row);
    cumulativeQty.set(key, (cumulativeQty.get(key) ?? 0n) + quantityAtoms(row.baseQuantity));
    cumulativeMoney.set(row.requestId, (cumulativeMoney.get(row.requestId) ?? 0n) + BigInt(minorAmount(row.amountMinor)));
    priorBaseMoney.set(row.requestId, (priorBaseMoney.get(row.requestId) ?? 0n) + BigInt(minorAmount(row.baseAmountMinor)));
  }
  for (const [requestId, amount] of cumulativeMoney) {
    const ceiling = requests.get(requestId)!.approval.valueCeiling!;
    invariant(amount <= BigInt(ceiling.amountMinor), "source_budget_exceeded", "Historical order value exceeds the approved budget");
    invariant(BigInt(valuationSnapshot({ ...ceiling, amountMinor: safeMinor(amount) }).baseAmountMinor) === priorBaseMoney.get(requestId),
      "valuation_mismatch", "Historical source valuation does not reconcile to its fixed rate");
  }
  const totals = order.lines.map((line) => {
    invariant(line.price.state === "known", "unconfirmed_order_price", "Issued orders require a known approved quote price");
    return { id: line.id, amountMinor: priceTotal(line.price, line.quantity, order.currency)! };
  });
  const subtotal = totals.reduce((total, row) => total + BigInt(row.amountMinor), 0n);
  invariant(BigInt(order.discountMinor) <= subtotal, "excess_discount", "Discount exceeds line value");
  const weights = totals.map((row) => ({ id: row.id, weight: String(row.amountMinor) }));
  // Explicit equal weights for an entirely free/gift order; save this policy with the plan.
  if (subtotal === 0n) for (const row of weights) row.weight = "1";
  const shipping = new Map(allocateMinor(order.shippingMinor, weights).map((row) => [row.id, row.amountMinor]));
  const discounts = new Map(allocateMinor(order.discountMinor, weights).map((row) => [row.id, row.amountMinor]));
  const allocationIds = new Set<string>();
  const allocations: CommittedSourceAllocation[] = [];
  for (const line of order.lines) {
    invariant(line.sources.length > 0, "missing_sources", "Every order line must allocate approved request quantities");
    const base = quantityAtoms(convertQuantity(line.quantity, line.conversion).baseQuantity);
    const sourceQuantities = line.sources.map((source) => quantityAtoms(source.baseQuantity));
    invariant(sourceQuantities.reduce((sum, qty) => sum + qty, 0n) === base,
      "source_quantity_mismatch", "Request allocations must exactly equal the order line quantity");
    const total = BigInt(totals.find((row) => row.id === line.id)!.amountMinor)
      + BigInt(shipping.get(line.id)!) - BigInt(discounts.get(line.id)!);
    const portions = new Map(allocateMinor(safeMinor(total), line.sources.map((source, index) => ({ id: source.id, weight: String(sourceQuantities[index]) })))
      .map((row) => [row.id, row.amountMinor]));
    for (const source of line.sources) {
      identifier(source.id, "source allocation id");
      invariant(!allocationIds.has(source.id) && !historical.has(source.id), "duplicate_source", "Source allocation id was already used");
      allocationIds.add(source.id);
      const owner = requests.get(source.requestId);
      invariant(owner, "unapproved_source", "Source request is not approved in this scope");
      const approved = owner.approval.lines.find((row) => row.lineId === source.requestLineId);
      const requested = owner.request.lines.find((row) => row.id === source.requestLineId);
      invariant(approved && requested && approved.itemId === line.itemId, "item_mismatch", "Order source belongs to a different item or line");
      invariant(requested.conversion.baseUnit === line.conversion.baseUnit && requested.conversion.basePrecision === line.conversion.basePrecision,
        "unit_mismatch", "Order source base unit differs from approval");
      const key = sourceKey(source);
      const quantity = (cumulativeQty.get(key) ?? 0n) + quantityAtoms(source.baseQuantity);
      invariant(quantity <= quantityAtoms(approved.baseQuantity, 3, true), "source_overallocated", "Combined order allocations exceed approved quantity");
      cumulativeQty.set(key, quantity);
      const ceiling = owner.approval.valueCeiling!;
      const amount = portions.get(source.id)!;
      cumulativeMoney.set(source.requestId, (cumulativeMoney.get(source.requestId) ?? 0n) + BigInt(amount));
      invariant(cumulativeMoney.get(source.requestId)! <= BigInt(ceiling.amountMinor), "source_budget_exceeded", "Combined issued value exceeds the fixed approved budget");
      allocations.push({ ...source, baseQuantity: quantityText(quantityAtoms(source.baseQuantity)),
        currency: order.currency, amountMinor: amount, baseAmountMinor: 0 });
    }
  }
  // Convert a source request's cumulative value once, then apportion its new
  // rounded base delta. Splitting a source cannot erase sub-YER value or budget.
  for (const requestId of new Set(allocations.map((row) => row.requestId))) {
    const ceiling = requests.get(requestId)!.approval.valueCeiling!;
    const baseTotal = BigInt(valuationSnapshot({ ...ceiling, amountMinor: safeMinor(cumulativeMoney.get(requestId)!) }).baseAmountMinor);
    const delta = safeMinor(baseTotal - (priorBaseMoney.get(requestId) ?? 0n));
    const group = allocations.filter((row) => row.requestId === requestId);
    const baseParts = new Map(allocateMinor(delta, group.map((row) => ({ id: row.id, weight: String(row.amountMinor) })))
      .map((row) => [row.id, row.amountMinor]));
    for (let index = 0; index < allocations.length; index += 1) {
      if (allocations[index].requestId === requestId) allocations[index] = { ...allocations[index], baseAmountMinor: baseParts.get(allocations[index].id)! };
    }
  }
  const resultOrder = { ...order, status: "issued" as const,
    lines: order.lines.map((line) => ({ ...line, conversion: unitConversionSnapshot(line.conversion),
      price: { ...line.price }, sources: line.sources.map((source) => ({ ...source })) })) };
  return freeze({ order: resultOrder, allocations,
    totalMinor: safeMinor(subtotal + BigInt(order.shippingMinor) - BigInt(order.discountMinor)), effects: NO_FINANCIAL_EFFECT });
}

/** Plans an explicit purchase order amendment (version N -> N+1) backed by
 * approved purchase request sources. Preserves existing lines and source
 * allocations append-only and computes the incremental source allocations.
 */
export function planOrderAmendment(input: {
  readonly currentOrder: IssuedPurchaseOrder;
  readonly amendedOrder: PurchaseOrder;
  readonly requests: readonly { readonly request: RequestRevision; readonly approval: RequestApproval }[];
  readonly priorAllocations: readonly CommittedSourceAllocation[];
  readonly priorReceipts?: readonly PriorInspectedQuantity[];
  readonly supplier: { readonly id: number; readonly active: boolean; readonly isSupplier: boolean };
  readonly reason: string;
}): {
  readonly order: IssuedPurchaseOrder;
  readonly allocations: readonly CommittedSourceAllocation[];
  readonly newAllocations: readonly CommittedSourceAllocation[];
  readonly totalMinor: number;
  readonly effects: typeof NO_FINANCIAL_EFFECT;
} {
  validateOrder(input.currentOrder);
  invariant(input.currentOrder.status === "issued", "order_not_issued", "Only an issued order can be amended");
  validateOrder(input.amendedOrder);
  reason(input.reason);
  invariant(
    input.amendedOrder.id === input.currentOrder.id && input.amendedOrder.version === input.currentOrder.version + 1,
    "stale_version",
    "Order amendment must increment the current order version by one",
  );
  invariant(
    input.amendedOrder.branchId === input.currentOrder.branchId &&
      input.amendedOrder.supplierPartyId === input.currentOrder.supplierPartyId &&
      input.amendedOrder.currency === input.currentOrder.currency,
    "invalid_transition",
    "Order amendment cannot change branch, supplier, or currency",
  );
  const amendedLinesById = unique(input.amendedOrder.lines, (line) => line.id, "amended order line");
  const priorReceiptsByLine = unique(input.priorReceipts ?? [], (row) => row.orderLineId, "prior receipt total");
  const currentSourceIds = new Set<string>();
  for (const currentLine of input.currentOrder.lines) {
    const amendedLine = amendedLinesById.get(currentLine.id);
    invariant(amendedLine, "invalid_transition", "Order amendment cannot remove existing order lines");
    invariant(
      amendedLine.itemId === currentLine.itemId &&
        amendedLine.kind === currentLine.kind &&
        amendedLine.conversion.baseUnit === currentLine.conversion.baseUnit &&
        amendedLine.conversion.basePrecision === currentLine.conversion.basePrecision,
      "item_mismatch",
      "Order amendment cannot alter an existing line's item or base unit",
    );
    invariant(
      amendedLine.conversion.version === currentLine.conversion.version &&
        amendedLine.conversion.enteredUnit === currentLine.conversion.enteredUnit &&
        amendedLine.conversion.enteredPrecision === currentLine.conversion.enteredPrecision &&
        decimalRatio(amendedLine.conversion.baseUnitsPerEnteredUnit).numerator *
          decimalRatio(currentLine.conversion.baseUnitsPerEnteredUnit).denominator ===
          decimalRatio(currentLine.conversion.baseUnitsPerEnteredUnit).numerator *
            decimalRatio(amendedLine.conversion.baseUnitsPerEnteredUnit).denominator,
      "invalid_transition",
      "Order amendment cannot alter an existing line's unit conversion",
    );
    invariant(
      (!currentLine.trackLot || amendedLine.trackLot) &&
        (!currentLine.requiresExpiry || amendedLine.requiresExpiry) &&
        amendedLine.minimumShelfLifeDays >= currentLine.minimumShelfLifeDays,
      "invalid_transition",
      "Order amendment cannot weaken lot tracking, expiry requirement, or minimum shelf life on an existing line",
    );
    const currentBaseAtoms = quantityAtoms(convertQuantity(currentLine.quantity, currentLine.conversion).baseQuantity);
    const amendedBaseAtoms = quantityAtoms(convertQuantity(amendedLine.quantity, amendedLine.conversion).baseQuantity);
    invariant(amendedBaseAtoms >= currentBaseAtoms, "invalid_transition", "Order amendment cannot reduce ordered line quantity");
    const rec = priorReceiptsByLine.get(currentLine.id);
    if (rec) {
      const recAccepted = quantityAtoms(rec.acceptedBaseQuantity ?? "0", 3, true);
      const recDisposed = quantityAtoms(rec.disposedBaseQuantity ?? "0", 3, true);
      const recDisposedExcess =
        rec.disposedExcessBaseQuantity !== undefined
          ? quantityAtoms(rec.disposedExcessBaseQuantity, 3, true)
          : recAccepted + recDisposed > currentBaseAtoms && recAccepted <= currentBaseAtoms
            ? recAccepted + recDisposed - currentBaseAtoms
            : 0n;
      const recWithinOrderDisposed = recDisposed > recDisposedExcess ? recDisposed - recDisposedExcess : 0n;
      const committedAtoms = recAccepted + recWithinOrderDisposed;
      invariant(amendedBaseAtoms >= committedAtoms, "invalid_transition", "Amended quantity cannot be below already accepted/disposed quantity");
    }
    const amendedSourcesById = unique(amendedLine.sources, (s) => s.id, "amended line source");
    for (const currentSource of currentLine.sources) {
      currentSourceIds.add(currentSource.id);
      const preserved = amendedSourcesById.get(currentSource.id);
      invariant(
        preserved &&
          preserved.requestId === currentSource.requestId &&
          preserved.requestLineId === currentSource.requestLineId &&
          quantityAtoms(preserved.baseQuantity) === quantityAtoms(currentSource.baseQuantity),
        "invalid_transition",
        "Order amendment must preserve all previously committed source allocations",
      );
    }
  }
  const externalPriorAllocations = input.priorAllocations.filter((row) => !currentSourceIds.has(row.id));
  const providedCurrentAllocations = input.priorAllocations.filter((row) => currentSourceIds.has(row.id));
  const currentOrderAllocations =
    providedCurrentAllocations.length === currentSourceIds.size
      ? providedCurrentAllocations
      : (() => {
          const baseline = planOrderIssue({
            order: input.currentOrder,
            requests: input.requests,
            priorAllocations: externalPriorAllocations,
            supplier: input.supplier,
          });
          return baseline.allocations.map(
            (row) => providedCurrentAllocations.find((p) => p.id === row.id) ?? row,
          );
        })();
  const fullPlan = planOrderIssue({
    order: input.amendedOrder,
    requests: input.requests,
    priorAllocations: externalPriorAllocations,
    supplier: input.supplier,
  });
  const rawNewAllocations = fullPlan.allocations.filter((row) => !currentSourceIds.has(row.id));
  invariant(rawNewAllocations.length > 0, "invalid_transition", "Order amendment must add at least one new approved source allocation");
  const requestsById = unique(input.requests, (row) => row.request.id, "approved request");
  const currentAllocationsById = new Map(currentOrderAllocations.map((row) => [row.id, row]));
  const newAllocationsById = new Map<string, CommittedSourceAllocation>();
  const involvedRequestIds = new Set(fullPlan.allocations.map((row) => row.requestId));
  for (const requestId of involvedRequestIds) {
    const ceiling = requestsById.get(requestId)!.approval.valueCeiling!;
    const externalMoney = externalPriorAllocations
      .filter((row) => row.requestId === requestId)
      .reduce((sum, row) => sum + BigInt(minorAmount(row.amountMinor)), 0n);
    const externalBase = externalPriorAllocations
      .filter((row) => row.requestId === requestId)
      .reduce((sum, row) => sum + BigInt(minorAmount(row.baseAmountMinor)), 0n);
    const persistedCurrentMoney = currentOrderAllocations
      .filter((row) => row.requestId === requestId)
      .reduce((sum, row) => sum + BigInt(minorAmount(row.amountMinor)), 0n);
    const persistedCurrentBase = currentOrderAllocations
      .filter((row) => row.requestId === requestId)
      .reduce((sum, row) => sum + BigInt(minorAmount(row.baseAmountMinor)), 0n);
    const targetOrderMoney = fullPlan.allocations
      .filter((row) => row.requestId === requestId)
      .reduce((sum, row) => sum + BigInt(minorAmount(row.amountMinor)), 0n);
    const deltaMoney = targetOrderMoney - persistedCurrentMoney;
    invariant(
      deltaMoney >= 0n,
      "invalid_transition",
      "Order amendment cannot reduce previously committed source allocation value",
    );
    invariant(
      externalMoney + persistedCurrentMoney + deltaMoney <= BigInt(ceiling.amountMinor),
      "source_budget_exceeded",
      "Combined issued value exceeds the fixed approved budget",
    );
    const targetCumulativeBase = BigInt(
      valuationSnapshot({
        ...ceiling,
        amountMinor: safeMinor(externalMoney + persistedCurrentMoney + deltaMoney),
      }).baseAmountMinor,
    );
    const deltaBase = targetCumulativeBase - externalBase - persistedCurrentBase;
    invariant(
      deltaBase >= 0n,
      "invalid_transition",
      "Order amendment cannot reduce previously committed base currency valuation",
    );
    const newGroup = rawNewAllocations.filter((row) => row.requestId === requestId);
    if (newGroup.length === 0) {
      invariant(
        deltaMoney === 0n && deltaBase === 0n,
        "invalid_transition",
        "Order amendment cannot alter the monetary commitment of a request without a new source allocation for that request",
      );
      continue;
    }
    const rawNewTotal = newGroup.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n);
    const moneyWeights = newGroup.map((row) => ({
      id: row.id,
      weight: rawNewTotal > 0n ? String(row.amountMinor) : String(quantityAtoms(row.baseQuantity)),
    }));
    const moneyParts = new Map(
      allocateMinor(safeMinor(deltaMoney), moneyWeights).map((row) => [row.id, row.amountMinor]),
    );
    const baseWeights = newGroup.map((row) => ({
      id: row.id,
      weight: deltaMoney > 0n ? String(moneyParts.get(row.id)!) : String(quantityAtoms(row.baseQuantity)),
    }));
    const baseParts = new Map(
      allocateMinor(safeMinor(deltaBase), baseWeights).map((row) => [row.id, row.amountMinor]),
    );
    for (const row of newGroup) {
      newAllocationsById.set(row.id, {
        ...row,
        amountMinor: moneyParts.get(row.id)!,
        baseAmountMinor: baseParts.get(row.id)!,
      });
    }
  }
  const newAllocations = rawNewAllocations.map((row) => newAllocationsById.get(row.id)!);
  const allocations = fullPlan.allocations.map(
    (row) => currentAllocationsById.get(row.id) ?? newAllocationsById.get(row.id)!,
  );
  return freeze({
    order: fullPlan.order,
    allocations,
    newAllocations,
    totalMinor: fullPlan.totalMinor,
    effects: NO_FINANCIAL_EFFECT,
  });
}

export type InspectionDisposition = "accepted" | "quarantined" | "rejected";
export interface InspectionPortion {
  readonly id: string; readonly quantity: string; readonly disposition: InspectionDisposition;
  readonly lotCode: string | null; readonly expiryDate: string | null; readonly locationId: string;
  readonly damaged: boolean; readonly reason: string;
}
export interface ReceiptRevision {
  readonly id: string; readonly version: number; readonly orderId: string; readonly orderVersion: number;
  readonly supplierPartyId: number; readonly branchId: string; readonly actualArrivalDate: string;
  readonly lines: ReadonlyArray<{
    readonly orderLineId: string;
    readonly arrivedQuantity: string;
    readonly excessDecision?: ExcessArrivalAction | null;
    readonly excessReason?: string | null;
    readonly portions: readonly InspectionPortion[];
  }>;
}
export interface PriorInspectedQuantity {
  readonly orderLineId: string; readonly acceptedBaseQuantity: string;
  readonly quarantinedBaseQuantity: string; readonly rejectedBaseQuantity: string;
  readonly disposedBaseQuantity?: string;
  readonly disposedExcessBaseQuantity?: string;
}
export interface InspectedReceiptLine {
  readonly id: string; readonly receiptId: string; readonly orderId: string; readonly orderVersion: number;
  readonly orderLineId: string; readonly itemId: number; readonly supplierPartyId: number; readonly branchId: string;
  readonly baseQuantity: string; readonly enteredQuantity: string; readonly conversion: UnitConversionSnapshot;
  readonly disposition: InspectionDisposition; readonly lotCode: string | null;
  readonly expiryDate: string | null; readonly locationId: string; readonly reason: string;
  readonly orderLineAcceptedAtReceiptBaseQuantity?: string;
  readonly heldForOrderAmendmentBaseQuantity?: string;
}
export interface ReceiptPlan {
  readonly receiptId: string; readonly receiptVersion: number;
  readonly lines: readonly InspectedReceiptLine[];
  readonly stockEntries: ReadonlyArray<{ readonly receiptLineId: string; readonly itemId: number;
    readonly baseQuantity: string; readonly locationId: string; readonly availability: "available" | "quarantined" }>;
  readonly remaining: ReadonlyArray<{ readonly orderLineId: string; readonly acceptedBaseQuantity: string;
    readonly quarantinedBaseQuantity: string; readonly rejectedBaseQuantity: string;
    readonly disposedBaseQuantity: string;
    readonly remainingFulfillmentBaseQuantity: string; readonly remainingDeliveryBaseQuantity: string }>;
  readonly excessDecisions: readonly ExcessArrivalDecisionPlan[];
  readonly financialEffects: { readonly payables: 0; readonly expenses: 0 };
}

/** Expiry is checked at posting, not the backdated arrival date. Rejected items
 * remain documented outside usable stock; quarantined material is segregated.
 */
export function planInspectedReceipt(order: IssuedPurchaseOrder, receipt: ReceiptRevision,
  prior: readonly PriorInspectedQuantity[], postingDate: string): ReceiptPlan {
  validateOrder(order);
  invariant(order.status === "issued", "order_not_issued", "Receipt requires an issued order");
  identifier(receipt.id, "receipt id"); positiveId(receipt.version, "receipt version");
  invariant(receipt.orderId === order.id && receipt.orderVersion === order.version, "stale_order", "Receipt targets a different order revision");
  invariant(receipt.branchId === order.branchId, "branch_mismatch", "Receipt and order branches differ");
  invariant(receipt.supplierPartyId === order.supplierPartyId, "supplier_mismatch", "Receipt and order suppliers differ");
  dateOnly(receipt.actualArrivalDate); dateOnly(postingDate);
  invariant(receipt.actualArrivalDate <= postingDate, "future_arrival", "Actual arrival cannot be after posting");
  const previous = unique(prior, (row) => row.orderLineId, "prior receipt total");
  const incoming = unique(receipt.lines, (line) => line.orderLineId, "incoming order line");
  invariant(incoming.size > 0, "empty_receipt", "Receipt must classify at least one line");
  const orderLines = new Map(order.lines.map((line) => [line.id, line]));
  for (const key of [...previous.keys(), ...incoming.keys()]) {
    invariant(orderLines.has(key), "unknown_order_line", "Receipt references a line outside this order");
  }
  const ids = new Set<string>();
  const lines: InspectedReceiptLine[] = [];
  const stockEntries: ReceiptPlan["stockEntries"][number][] = [];
  const remaining: ReceiptPlan["remaining"][number][] = [];
  const excessDecisions: ExcessArrivalDecisionPlan[] = [];
  for (const orderLine of order.lines) {
    const ordered = quantityAtoms(convertQuantity(orderLine.quantity, orderLine.conversion).baseQuantity);
    const old = previous.get(orderLine.id);
    let accepted = quantityAtoms(old?.acceptedBaseQuantity ?? "0", 3, true);
    let quarantined = quantityAtoms(old?.quarantinedBaseQuantity ?? "0", 3, true);
    let rejected = quantityAtoms(old?.rejectedBaseQuantity ?? "0", 3, true);
    const disposed = quantityAtoms(old?.disposedBaseQuantity ?? "0", 3, true);
    const disposedExcess =
      old?.disposedExcessBaseQuantity !== undefined
        ? quantityAtoms(old.disposedExcessBaseQuantity, 3, true)
        : accepted + disposed > ordered && accepted <= ordered
          ? accepted + disposed - ordered
          : 0n;
    const withinOrderDisposed = disposed > disposedExcess ? disposed - disposedExcess : 0n;
    invariant(accepted + withinOrderDisposed <= ordered, "invalid_receipt_history", "Existing receipts exceed the order's accepted capacity");
    const remainingDelivery = ordered > accepted + quarantined + withinOrderDisposed ? ordered - accepted - quarantined - withinOrderDisposed : 0n;
    const current = incoming.get(orderLine.id);
    if (current) {
      const arrived = quantityAtoms(convertQuantity(current.arrivedQuantity, orderLine.conversion).baseQuantity);
      let excessAtoms = 0n;
      if (arrived > remainingDelivery) {
        invariant(
          Boolean(current.excessDecision),
          "overdelivery",
          "Arrival exceeds remaining delivery capacity; obtain an order revision first",
        );
        const decisionPlan = planExcessArrivalDecision({
          order,
          orderLineId: orderLine.id,
          prior,
          arrivedQuantity: current.arrivedQuantity,
          decision: current.excessDecision!,
          reason: current.excessReason ?? "",
        });
        excessDecisions.push(decisionPlan);
        excessAtoms = arrived - remainingDelivery;
      }
      invariant(current.portions.length > 0, "unclassified_receipt", "Every arrived quantity must be inspected");
      let classified = 0n;
      let currentAccepted = 0n;
      let currentQuarantined = 0n;
      let currentRejected = 0n;
      const linePortions: Array<{
        portion: InspectionPortion;
        converted: ReturnType<typeof convertQuantity>;
        amount: bigint;
      }> = [];
      for (const portion of current.portions) {
        identifier(portion.id, "receipt portion"); identifier(portion.locationId, "receipt location");
        invariant(!ids.has(portion.id), "duplicate_source", "Receipt portion id is duplicated"); ids.add(portion.id);
        invariant(["accepted", "quarantined", "rejected"].includes(portion.disposition), "invalid_disposition", "Inspection disposition is invalid");
        invariant(typeof portion.damaged === "boolean", "invalid_inspection", "Damage classification is required");
        const converted = convertQuantity(portion.quantity, orderLine.conversion);
        const amount = quantityAtoms(converted.baseQuantity);
        classified += amount;
        if (portion.expiryDate !== null) dateOnly(portion.expiryDate);
        if (portion.lotCode !== null) identifier(portion.lotCode, "manufacturer lot");
        if (portion.disposition === "accepted") {
          invariant(!portion.damaged, "damaged_stock", "Damaged material cannot become available stock");
          invariant(!orderLine.trackLot || portion.lotCode !== null, "missing_lot", "This item requires a manufacturer lot");
          invariant(!orderLine.requiresExpiry || portion.expiryDate !== null, "missing_expiry", "This item requires a known expiry date");
          if (portion.expiryDate !== null) {
            const days = (Date.parse(`${portion.expiryDate}T00:00:00.000Z`) - Date.parse(`${postingDate}T00:00:00.000Z`)) / 86_400_000;
            invariant(days > 0 && days >= orderLine.minimumShelfLifeDays, "expired_receipt", "Accepted material fails the posting-date shelf-life policy");
          }
          accepted += amount;
          currentAccepted += amount;
        } else {
          reason(portion.reason);
          if (portion.disposition === "quarantined") {
            quarantined += amount;
            currentQuarantined += amount;
          } else {
            rejected += amount;
            currentRejected += amount;
          }
        }
        linePortions.push({ portion, converted, amount });
      }
      invariant(classified === arrived, "classification_mismatch", "Accepted + quarantined + rejected must equal exactly what arrived");
      invariant(currentAccepted <= remainingDelivery && accepted + withinOrderDisposed <= ordered, "overdelivery", "Accepted quantity cannot exceed remaining ordered delivery capacity");
      if (excessAtoms > 0n) {
        if (current.excessDecision === "return_excess_to_supplier") {
          invariant(
            currentRejected >= excessAtoms && currentAccepted + currentQuarantined <= remainingDelivery,
            "overdelivery",
            "Excess quantity marked for supplier return must be classified as rejected",
          );
        } else {
          invariant(
            currentQuarantined >= excessAtoms,
            "overdelivery",
            "Excess quantity held for order amendment must be isolated in quarantine",
          );
        }
      }
      const withinOrderQuarantineCap = remainingDelivery > currentAccepted ? remainingDelivery - currentAccepted : 0n;
      let seenQuarantineAtoms = 0n;
      const acceptedAndDisposedAfterReceiptText = quantityText(accepted + withinOrderDisposed);
      for (const { portion, converted, amount } of linePortions) {
        let heldForAmendmentText: string | undefined;
        let acceptedAtReceiptText: string | undefined;
        if (portion.disposition === "quarantined") {
          acceptedAtReceiptText = acceptedAndDisposedAfterReceiptText;
          const prevSeen = seenQuarantineAtoms;
          seenQuarantineAtoms += amount;
          if (excessAtoms > 0n && current.excessDecision === "hold_for_order_amendment") {
            const nonHeldStart = prevSeen < withinOrderQuarantineCap ? prevSeen : withinOrderQuarantineCap;
            const nonHeldEnd = seenQuarantineAtoms < withinOrderQuarantineCap ? seenQuarantineAtoms : withinOrderQuarantineCap;
            const heldAtomsForPortion = amount - (nonHeldEnd - nonHeldStart);
            heldForAmendmentText = quantityText(heldAtomsForPortion);
          } else {
            heldForAmendmentText = "0";
          }
        }
        lines.push({
          id: portion.id,
          receiptId: receipt.id,
          orderId: order.id,
          orderVersion: order.version,
          orderLineId: orderLine.id,
          itemId: orderLine.itemId,
          supplierPartyId: order.supplierPartyId,
          branchId: order.branchId,
          baseQuantity: converted.baseQuantity,
          enteredQuantity: converted.enteredQuantity,
          conversion: converted.conversion,
          disposition: portion.disposition,
          lotCode: portion.lotCode,
          expiryDate: portion.expiryDate,
          locationId: portion.locationId,
          reason: portion.reason,
          ...(acceptedAtReceiptText !== undefined ? { orderLineAcceptedAtReceiptBaseQuantity: acceptedAtReceiptText } : {}),
          ...(heldForAmendmentText !== undefined ? { heldForOrderAmendmentBaseQuantity: heldForAmendmentText } : {}),
        });
        if (orderLine.kind === "stock" && portion.disposition !== "rejected") {
          stockEntries.push({
            receiptLineId: portion.id,
            itemId: orderLine.itemId,
            baseQuantity: converted.baseQuantity,
            locationId: portion.locationId,
            availability: portion.disposition === "accepted" ? "available" : "quarantined",
          });
        }
      }
    }
    remaining.push({ orderLineId: orderLine.id, acceptedBaseQuantity: quantityText(accepted),
      quarantinedBaseQuantity: quantityText(quarantined), rejectedBaseQuantity: quantityText(rejected),
      disposedBaseQuantity: quantityText(disposed),
      remainingFulfillmentBaseQuantity: quantityText(ordered > accepted + withinOrderDisposed ? ordered - accepted - withinOrderDisposed : 0n),
      remainingDeliveryBaseQuantity: quantityText(ordered > accepted + quarantined + withinOrderDisposed ? ordered - accepted - quarantined - withinOrderDisposed : 0n) });
  }
  return freeze({ receiptId: receipt.id, receiptVersion: receipt.version, lines, stockEntries, remaining,
    excessDecisions, financialEffects: { payables: 0 as const, expenses: 0 as const } });
}

export interface InvoiceReceiptAllocation {
  readonly id: string; readonly invoiceLineId: string; readonly receiptLineId: string; readonly baseQuantity: string;
}
export interface SupplierInvoiceLine {
  readonly id: string; readonly orderLineId: string; readonly quantity: string; readonly price: UnitPrice;
  readonly receiptAllocations: readonly InvoiceReceiptAllocation[];
}
export interface SupplierInvoiceRevision {
  readonly id: string; readonly version: number; readonly orderId: string; readonly orderVersion: number;
  readonly branchId: string; readonly supplierPartyId: number; readonly currency: Currency;
  readonly invoiceNumber: string | null; readonly invoiceDate: string; readonly missingNumberReason: string | null;
  readonly shippingMinor: number; readonly discountMinor: number; readonly valuation: ValuationSnapshot | null;
  readonly lines: readonly SupplierInvoiceLine[];
}
export type MatchIssue = "awaiting_receipt" | "price_variance" | "missing_price" | "estimated_price" | "invoice_exceeds_order"
  | "missing_valuation" | "missing_invoice_number" | "header_charge_review";
export interface InvoiceMatchPlan {
  readonly invoiceId: string; readonly invoiceVersion: number; readonly identity: string;
  readonly duplicateKey: string | null; readonly status: "matched" | "needs_review";
  readonly issues: readonly MatchIssue[];
  readonly lines: ReadonlyArray<{ readonly invoiceLineId: string; readonly baseQuantity: string;
    readonly matchedBaseQuantity: string; readonly unreceivedBaseQuantity: string;
    readonly priceDifferenceMinor: number | null; readonly lineTotalMinor: number | null; readonly issues: readonly MatchIssue[] }>;
  readonly total: MoneyAmount | null;
  readonly charges: ReadonlyArray<{ readonly invoiceLineId: string; readonly shippingMinor: number; readonly discountMinor: number }>;
  /** There is no payable creation API here. Finance must approve and post exactly
   * one existing payable, then call the unchanged supplier payment engine. */
  readonly effects: typeof NO_FINANCIAL_EFFECT;
}

/** Policy v1: supplier + calendar invoice year + NFKC/uppercase/collapsed-space
 * number. Punctuation and leading zeroes remain significant. Missing numbers
 * require a reason and manual duplicate review, never a fabricated unique number.
 */
export function supplierInvoiceDuplicateKey(supplierPartyId: number, invoiceNumber: string | null,
  invoiceDate: string, missingNumberReason: string | null): string | null {
  positiveId(supplierPartyId, "invoice supplier"); dateOnly(invoiceDate);
  if (invoiceNumber === null) { reason(missingNumberReason); return null; }
  invariant(typeof invoiceNumber === "string" && invoiceNumber.length <= 120, "invalid_invoice_number", "Invoice number is too long");
  const normalized = invoiceNumber.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
  identifier(normalized, "supplier invoice number");
  return `supplier-invoice-v1:${JSON.stringify([supplierPartyId, invoiceDate.slice(0, 4), normalized])}`;
}

/** Receipt inputs must be persisted posted receipt lines, selected and locked by
 * the server. Prior allocations exclude this invoice and include all active
 * posted invoices net explicit reversal allocations. This function never marks
 * goods received just because an invoice exists.
 */
export function matchSupplierInvoice(order: IssuedPurchaseOrder, invoice: SupplierInvoiceRevision,
  postedReceiptLines: readonly InspectedReceiptLine[], priorAllocations: readonly InvoiceReceiptAllocation[]): InvoiceMatchPlan {
  validateOrder(order);
  invariant(order.status === "issued", "order_not_issued", "Invoice matching needs an issued order");
  identifier(invoice.id, "supplier invoice id"); positiveId(invoice.version, "invoice version");
  invariant(invoice.orderId === order.id && invoice.orderVersion === order.version, "stale_order", "Invoice targets another order revision");
  invariant(invoice.branchId === order.branchId, "branch_mismatch", "Invoice branch differs from order branch");
  invariant(invoice.supplierPartyId === order.supplierPartyId, "supplier_mismatch", "Invoice supplier differs from order supplier");
  requireCurrency(invoice.currency, "supplier invoice", invoice.id);
  invariant(invoice.currency === order.currency, "currency_mismatch", "Invoice currency differs from the approved order");
  minorAmount(invoice.shippingMinor); minorAmount(invoice.discountMinor);
  const duplicateKey = supplierInvoiceDuplicateKey(invoice.supplierPartyId, invoice.invoiceNumber, invoice.invoiceDate, invoice.missingNumberReason);
  invariant(invoice.lines.length > 0, "empty_invoice", "Invoice needs lines");
  unique(invoice.lines, (line) => line.id, "invoice line");
  const receipts = unique(postedReceiptLines, (line) => line.id, "posted receipt line");
  const prior = unique(priorAllocations, (row) => row.id, "prior invoicing allocation");
  const orders = new Map(order.lines.map((line) => [line.id, line]));
  const allocatedReceipt = new Map<string, bigint>();
  const allocatedOrder = new Map<string, bigint>();
  const checkReceipt = (receiptLineId: string): InspectedReceiptLine => {
    const receipt = receipts.get(receiptLineId);
    invariant(receipt, "unknown_receipt", "Invoice allocation references an unknown posted receipt");
    invariant(receipt.orderId === order.id && receipt.supplierPartyId === invoice.supplierPartyId
      && receipt.branchId === invoice.branchId, "receipt_owner_mismatch", "Receipt belongs to another order, supplier or branch");
    // Earlier order revisions remain valid historical receipts when the current
    // order retains the same line/item/base unit. Future revisions are invalid.
    positiveId(receipt.orderVersion, "receipt order version");
    invariant(receipt.orderVersion <= order.version, "stale_order", "Receipt is from a future order revision");
    const source = orders.get(receipt.orderLineId);
    invariant(source && source.itemId === receipt.itemId, "item_mismatch", "Receipt item does not match the order");
    const conversion = unitConversionSnapshot(receipt.conversion);
    invariant(conversion.itemId === receipt.itemId && conversion.baseUnit === source.conversion.baseUnit,
      "unit_mismatch", "Receipt base unit differs from the order");
    invariant(receipt.disposition === "accepted", "unaccepted_invoice_quantity", "Only accepted inspected quantities may be matched");
    quantityAtoms(receipt.baseQuantity);
    return receipt;
  };
  for (const row of prior.values()) {
    const receipt = checkReceipt(row.receiptLineId);
    const qty = quantityAtoms(row.baseQuantity);
    const total = (allocatedReceipt.get(receipt.id) ?? 0n) + qty;
    invariant(total <= quantityAtoms(receipt.baseQuantity), "receipt_already_invoiced", "Historical invoice allocations exceed accepted receipt quantity");
    allocatedReceipt.set(receipt.id, total);
    allocatedOrder.set(receipt.orderLineId, (allocatedOrder.get(receipt.orderLineId) ?? 0n) + qty);
  }
  const seenAllocationIds = new Set(prior.keys());
  const issues = new Set<MatchIssue>();
  if (duplicateKey === null) issues.add("missing_invoice_number");
  // Quantity allocations alone do not prove how earlier invoices used header
  // charges. Until finance supplies cumulative charge allocations, require review.
  if (invoice.shippingMinor !== 0 || invoice.discountMinor !== 0 || order.shippingMinor !== 0 || order.discountMinor !== 0) {
    issues.add("header_charge_review");
  }
  const lines: InvoiceMatchPlan["lines"][number][] = [];
  for (const line of invoice.lines) {
    const source = orders.get(line.orderLineId);
    invariant(source, "unknown_order_line", "Invoice references an order line outside this order");
    const base = quantityAtoms(convertQuantity(line.quantity, source.conversion).baseQuantity);
    const lineIssues = new Set<MatchIssue>();
    const lineTotalMinor = priceTotal(line.price, line.quantity, invoice.currency);
    if (line.price.state === "missing" || source.price.state === "missing") lineIssues.add("missing_price");
    if (line.price.state === "estimated" || source.price.state === "estimated") lineIssues.add("estimated_price");
    const priceDifferenceMinor = line.price.state === "missing" || source.price.state === "missing"
      ? null : line.price.unitPriceMinor - source.price.unitPriceMinor;
    if (priceDifferenceMinor !== null && priceDifferenceMinor !== 0) lineIssues.add("price_variance");
    let matched = 0n;
    for (const allocation of line.receiptAllocations) {
      identifier(allocation.id, "invoice receipt allocation");
      invariant(!seenAllocationIds.has(allocation.id), "duplicate_source", "Invoice receipt allocation id already exists");
      seenAllocationIds.add(allocation.id);
      invariant(allocation.invoiceLineId === line.id, "invoice_line_mismatch", "Allocation belongs to another invoice line");
      const receipt = checkReceipt(allocation.receiptLineId);
      invariant(receipt.orderLineId === source.id, "item_mismatch", "Invoice allocation references a different order line");
      const qty = quantityAtoms(allocation.baseQuantity, source.conversion.basePrecision);
      matched += qty;
      const total = (allocatedReceipt.get(receipt.id) ?? 0n) + qty;
      invariant(total <= quantityAtoms(receipt.baseQuantity), "receipt_already_invoiced", "Combined invoice allocations exceed accepted receipt quantity");
      allocatedReceipt.set(receipt.id, total);
    }
    invariant(matched <= base, "invoice_overallocated", "Receipt allocation exceeds invoice quantity");
    if (matched < base) lineIssues.add("awaiting_receipt");
    const billed = (allocatedOrder.get(source.id) ?? 0n) + base;
    allocatedOrder.set(source.id, billed);
    if (billed > quantityAtoms(convertQuantity(source.quantity, source.conversion).baseQuantity)) lineIssues.add("invoice_exceeds_order");
    lineIssues.forEach((issue) => issues.add(issue));
    lines.push({ invoiceLineId: line.id, baseQuantity: quantityText(base), matchedBaseQuantity: quantityText(matched),
      unreceivedBaseQuantity: quantityText(base - matched), priceDifferenceMinor, lineTotalMinor, issues: [...lineIssues] });
  }
  const hasMissingPrice = lines.some((line) => line.lineTotalMinor === null);
  let total: MoneyAmount | null = null;
  const charges: InvoiceMatchPlan["charges"][number][] = [];
  if (!hasMissingPrice) {
    const subtotal = lines.reduce((sum, line) => sum + BigInt(line.lineTotalMinor!), 0n);
    invariant(BigInt(invoice.discountMinor) <= subtotal, "excess_discount", "Invoice discount exceeds line value");
    total = { currency: invoice.currency, amountMinor: safeMinor(subtotal + BigInt(invoice.shippingMinor) - BigInt(invoice.discountMinor)) };
    const weights = lines.map((line) => ({ id: line.invoiceLineId, weight: subtotal === 0n ? "1" : String(line.lineTotalMinor) }));
    const shipping = new Map(allocateMinor(invoice.shippingMinor, weights).map((row) => [row.id, row.amountMinor]));
    const discounts = new Map(allocateMinor(invoice.discountMinor, weights).map((row) => [row.id, row.amountMinor]));
    for (const line of lines) charges.push({ invoiceLineId: line.invoiceLineId,
      shippingMinor: shipping.get(line.invoiceLineId)!, discountMinor: discounts.get(line.invoiceLineId)! });
  }
  if (invoice.valuation === null) issues.add("missing_valuation");
  else {
    validateValuation(invoice.valuation);
    invariant(invoice.valuation.purpose === "invoice_valuation" && invoice.valuation.currency === invoice.currency
      && total !== null && invoice.valuation.amountMinor === total.amountMinor,
      "valuation_mismatch", "Invoice valuation must match the final invoice total and its purpose");
  }
  return freeze({ invoiceId: invoice.id, invoiceVersion: invoice.version, identity: payloadIdentity(invoice), duplicateKey,
    status: issues.size === 0 ? "matched" : "needs_review", issues: [...issues], lines, total, charges, effects: NO_FINANCIAL_EFFECT });
}

export type QuarantineResolutionAction = "release" | "reject_return" | "dispose";
export interface PriorQuarantineResolution {
  readonly id: string;
  readonly receiptLineId: string;
  readonly action: QuarantineResolutionAction;
  readonly baseQuantity: string;
}
export interface QuarantineResolutionInput {
  readonly id: string;
  readonly order: IssuedPurchaseOrder;
  readonly receiptLine: InspectedReceiptLine & { readonly damaged?: boolean };
  readonly priorResolutions: readonly PriorQuarantineResolution[];
  readonly orderLineAcceptedBaseQuantity?: string;
  readonly action: QuarantineResolutionAction;
  readonly quantity: string;
  readonly reason: string;
  readonly resolutionDate: string;
  readonly currentDate?: string;
}
export interface QuarantineResolutionPlan {
  readonly id: string;
  readonly receiptLineId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly itemId: number;
  readonly action: QuarantineResolutionAction;
  readonly enteredQuantity: string;
  readonly baseQuantity: string;
  readonly reason: string;
  readonly resolutionDate: string;
  readonly effectiveReceiptLine: {
    readonly receiptLineId: string;
    readonly releasedBaseQuantity: string;
    readonly returnedBaseQuantity: string;
    readonly disposedBaseQuantity: string;
    readonly remainingQuarantinedBaseQuantity: string;
    readonly effectiveLotStatus: "accepted" | "quarantined" | "recalled";
  };
  readonly stockCompensation: null | {
    readonly itemId: number;
    readonly locationId: string;
    readonly baseQuantity: string;
    readonly movementType: "out";
    readonly isReturn: boolean;
    readonly reason: string;
  };
  readonly effects: { readonly inventoryMovements: 0 | 1; readonly payables: 0; readonly expenses: 0 };
}

/** Resolves quarantined receipt quantities via append-only evidence.
 * - "release" transitions quarantined stock to accepted usable stock after
 *   verifying non-damaged state, LOT, expiry, minimum shelf-life policy at
 *   both resolutionDate and currentDate, and purchase order capacity / order
 *   amendment requirements, without creating a duplicate 'in' movement.
 * - "reject_return" rejects and returns quarantined stock to the supplier,
 *   restoring order delivery capacity for a replacement shipment and planning a
 *   single compensating 'out' return movement for stock items.
 * - "dispose" records safe disposal of damaged/expired quarantined stock and
 *   plans a single compensating 'out' (non-return) movement so disposed units
 *   are removed from clinic stock without creating payables or expenses.
 */
export function planQuarantineResolution(input: QuarantineResolutionInput): QuarantineResolutionPlan {
  validateOrder(input.order);
  invariant(input.order.status === "issued", "order_not_issued", "Quarantine resolution requires an issued order");
  identifier(input.id, "quarantine resolution id");
  reason(input.reason);
  dateOnly(input.resolutionDate);
  const effectiveCurrentDate = input.currentDate ?? input.resolutionDate;
  dateOnly(effectiveCurrentDate);
  invariant(
    input.resolutionDate <= effectiveCurrentDate,
    "invalid_resolution_date",
    "Quarantine resolution date cannot be in the future",
  );
  invariant(
    input.action === "release" || input.action === "reject_return" || input.action === "dispose",
    "invalid_quarantine_action",
    "Quarantine resolution action must be release, reject_return, or dispose",
  );
  const { receiptLine } = input;
  identifier(receiptLine.id, "quarantine receipt line");
  invariant(
    receiptLine.orderId === input.order.id && receiptLine.supplierPartyId === input.order.supplierPartyId
      && receiptLine.branchId === input.order.branchId,
    "receipt_owner_mismatch",
    "Quarantine receipt line belongs to another order, supplier, or branch",
  );
  invariant(receiptLine.orderVersion <= input.order.version, "stale_order", "Quarantine receipt line is from a future order version");
  invariant(receiptLine.disposition === "quarantined", "not_quarantined", "Only a quarantined receipt line can be resolved");
  const orderLine = input.order.lines.find((line) => line.id === receiptLine.orderLineId);
  invariant(orderLine && orderLine.itemId === receiptLine.itemId, "item_mismatch", "Quarantine receipt line item does not match the order line");
  const conversion = unitConversionSnapshot(receiptLine.conversion);
  invariant(
    conversion.itemId === orderLine.itemId && conversion.baseUnit === orderLine.conversion.baseUnit
      && conversion.basePrecision === orderLine.conversion.basePrecision,
    "unit_mismatch",
    "Quarantine receipt line base unit differs from the order line",
  );
  const prior = unique(input.priorResolutions, (row) => row.id, "prior quarantine resolution");
  invariant(!prior.has(input.id), "duplicate_source", "Quarantine resolution id already exists");
  let releasedAtoms = 0n;
  let returnedAtoms = 0n;
  let disposedAtoms = 0n;
  for (const row of prior.values()) {
    invariant(row.receiptLineId === receiptLine.id, "receipt_line_mismatch", "Prior resolution belongs to a different receipt line");
    invariant(
      row.action === "release" || row.action === "reject_return" || row.action === "dispose",
      "invalid_quarantine_action",
      "Invalid prior quarantine action",
    );
    const qty = quantityAtoms(row.baseQuantity, conversion.basePrecision);
    if (row.action === "release") releasedAtoms += qty;
    else if (row.action === "reject_return") returnedAtoms += qty;
    else disposedAtoms += qty;
  }
  const originalQuarantined = quantityAtoms(receiptLine.baseQuantity, conversion.basePrecision);
  const converted = convertQuantity(input.quantity, conversion);
  const currentAtoms = quantityAtoms(converted.baseQuantity, conversion.basePrecision);
  invariant(
    releasedAtoms + returnedAtoms + disposedAtoms + currentAtoms <= originalQuarantined,
    "quarantine_overresolved",
    "Quarantine resolution exceeds the remaining quarantined quantity",
  );
  if (input.action === "release") {
    invariant(receiptLine.damaged !== true, "damaged_stock", "Damaged material cannot be released from quarantine to available stock");
    invariant(!orderLine.trackLot || receiptLine.lotCode !== null, "missing_lot", "This item requires a manufacturer lot before quarantine release");
    invariant(!orderLine.requiresExpiry || receiptLine.expiryDate !== null, "missing_expiry", "This item requires a known expiry date before quarantine release");
    if (receiptLine.expiryDate !== null) {
      dateOnly(receiptLine.expiryDate);
      const daysAtResolution = (Date.parse(`${receiptLine.expiryDate}T00:00:00.000Z`) - Date.parse(`${input.resolutionDate}T00:00:00.000Z`)) / 86_400_000;
      const daysAtCurrent = (Date.parse(`${receiptLine.expiryDate}T00:00:00.000Z`) - Date.parse(`${effectiveCurrentDate}T00:00:00.000Z`)) / 86_400_000;
      invariant(
        daysAtResolution > 0 &&
          daysAtResolution >= orderLine.minimumShelfLifeDays &&
          daysAtCurrent > 0 &&
          daysAtCurrent >= orderLine.minimumShelfLifeDays,
        "expired_receipt",
        "Quarantined material fails the current-date or resolution-date shelf-life policy",
      );
    }
    const orderedAtoms = quantityAtoms(
      convertQuantity(orderLine.quantity, orderLine.conversion).baseQuantity,
      conversion.basePrecision,
    );
    const heldAtoms = quantityAtoms(
      receiptLine.heldForOrderAmendmentBaseQuantity ?? "0",
      conversion.basePrecision,
      true,
    );
    const nonHeldQuarantinedAtoms =
      originalQuarantined > heldAtoms ? originalQuarantined - heldAtoms : 0n;
    if (heldAtoms > 0n && releasedAtoms + currentAtoms > nonHeldQuarantinedAtoms) {
      invariant(
        input.order.version > receiptLine.orderVersion,
        "order_amendment_required",
        "Excess quantity held for order amendment cannot be released before an approved order amendment",
      );
    }
    const baselineOrderAcceptedAtoms =
      input.orderLineAcceptedBaseQuantity !== undefined
        ? quantityAtoms(input.orderLineAcceptedBaseQuantity, conversion.basePrecision, true)
        : quantityAtoms(
            receiptLine.orderLineAcceptedAtReceiptBaseQuantity ?? "0",
            conversion.basePrecision,
            true,
          ) + releasedAtoms;
    invariant(
      baselineOrderAcceptedAtoms + currentAtoms <= orderedAtoms,
      heldAtoms > 0n ? "order_amendment_required" : "overdelivery",
      "Quarantine release would exceed the purchase order's approved quantity",
    );
    releasedAtoms += currentAtoms;
  } else if (input.action === "reject_return") {
    returnedAtoms += currentAtoms;
  } else {
    disposedAtoms += currentAtoms;
  }
  const remainingAtoms = originalQuarantined - releasedAtoms - returnedAtoms - disposedAtoms;
  const effectiveLotStatus: "accepted" | "quarantined" | "recalled" =
    remainingAtoms > 0n ? "quarantined" : releasedAtoms > 0n ? "accepted" : "recalled";
  const stockCompensation = (input.action === "reject_return" || input.action === "dispose") && orderLine.kind === "stock"
    ? {
        itemId: orderLine.itemId,
        locationId: receiptLine.locationId,
        baseQuantity: converted.baseQuantity,
        movementType: "out" as const,
        isReturn: input.action === "reject_return",
        reason:
          input.action === "reject_return"
            ? `Quarantine rejection return ${input.id}: ${input.reason}`
            : `Quarantine disposal ${input.id}: ${input.reason}`,
      }
    : null;
  return freeze({
    id: input.id,
    receiptLineId: receiptLine.id,
    orderId: input.order.id,
    orderLineId: orderLine.id,
    itemId: orderLine.itemId,
    action: input.action,
    enteredQuantity: converted.enteredQuantity,
    baseQuantity: converted.baseQuantity,
    reason: input.reason,
    resolutionDate: input.resolutionDate,
    effectiveReceiptLine: {
      receiptLineId: receiptLine.id,
      releasedBaseQuantity: quantityText(releasedAtoms),
      returnedBaseQuantity: quantityText(returnedAtoms),
      disposedBaseQuantity: quantityText(disposedAtoms),
      remainingQuarantinedBaseQuantity: quantityText(remainingAtoms),
      effectiveLotStatus,
    },
    stockCompensation,
    effects: {
      inventoryMovements: stockCompensation ? (1 as const) : (0 as const),
      payables: 0 as const,
      expenses: 0 as const,
    },
  });
}

export type ExcessArrivalAction = "return_excess_to_supplier" | "hold_for_order_amendment";
export interface ExcessArrivalDecisionPlan {
  readonly orderId: string;
  readonly orderLineId: string;
  readonly itemId: number;
  readonly decision: ExcessArrivalAction;
  readonly reason: string;
  readonly orderedBaseQuantity: string;
  readonly withinOrderBaseQuantity: string;
  readonly excessBaseQuantity: string;
  readonly requiresOrderAmendment: boolean;
  readonly effects: typeof NO_FINANCIAL_EFFECT;
}

/** Explicit decision plan when an arrived shipment exceeds remaining order delivery capacity.
 * Never silently accepts overdelivery into usable stock or inflates payables.
 */
export function planExcessArrivalDecision(input: {
  readonly order: IssuedPurchaseOrder;
  readonly orderLineId: string;
  readonly prior: readonly PriorInspectedQuantity[];
  readonly arrivedQuantity: string;
  readonly decision: ExcessArrivalAction;
  readonly reason: string;
}): ExcessArrivalDecisionPlan {
  validateOrder(input.order);
  invariant(input.order.status === "issued", "order_not_issued", "Excess arrival decision requires an issued order");
  reason(input.reason);
  invariant(
    input.decision === "return_excess_to_supplier" || input.decision === "hold_for_order_amendment",
    "invalid_excess_decision",
    "Excess arrival decision must be return_excess_to_supplier or hold_for_order_amendment",
  );
  const orderLine = input.order.lines.find((line) => line.id === input.orderLineId);
  invariant(orderLine, "unknown_order_line", "Excess arrival references a line outside this order");
  const previous = unique(input.prior, (row) => row.orderLineId, "prior receipt total").get(orderLine.id);
  const ordered = quantityAtoms(convertQuantity(orderLine.quantity, orderLine.conversion).baseQuantity);
  const accepted = quantityAtoms(previous?.acceptedBaseQuantity ?? "0", 3, true);
  const quarantined = quantityAtoms(previous?.quarantinedBaseQuantity ?? "0", 3, true);
  const disposed = quantityAtoms(previous?.disposedBaseQuantity ?? "0", 3, true);
  const disposedExcess =
    previous?.disposedExcessBaseQuantity !== undefined
      ? quantityAtoms(previous.disposedExcessBaseQuantity, 3, true)
      : accepted + disposed > ordered && accepted <= ordered
        ? accepted + disposed - ordered
        : 0n;
  const withinOrderDisposed = disposed > disposedExcess ? disposed - disposedExcess : 0n;
  invariant(accepted + withinOrderDisposed <= ordered, "invalid_receipt_history", "Existing receipts exceed the order's accepted capacity");
  const remainingDelivery = ordered > accepted + quarantined + withinOrderDisposed ? ordered - accepted - quarantined - withinOrderDisposed : 0n;
  const arrived = quantityAtoms(convertQuantity(input.arrivedQuantity, orderLine.conversion).baseQuantity);
  invariant(arrived > remainingDelivery, "no_excess_arrival", "Arrived quantity does not exceed remaining order delivery capacity");
  return freeze({
    orderId: input.order.id,
    orderLineId: orderLine.id,
    itemId: orderLine.itemId,
    decision: input.decision,
    reason: input.reason,
    orderedBaseQuantity: quantityText(ordered),
    withinOrderBaseQuantity: quantityText(remainingDelivery),
    excessBaseQuantity: quantityText(arrived - remainingDelivery),
    requiresOrderAmendment: input.decision === "hold_for_order_amendment",
    effects: NO_FINANCIAL_EFFECT,
  });
}

export interface LegacyMovementRecord {
  readonly movementId: number;
  readonly kind: "in" | "out" | "adjust";
  readonly signedBaseQuantity: string;
  readonly alreadyAllocatedBaseQuantity: string;
  readonly existingLotRemainingBaseQuantity?: string;
  readonly expiryDate: string | null;
  readonly unitCostMinor: number | null;
  readonly payableId: number | null;
}
export interface HistoricalReconciliationPlan {
  readonly itemId: number;
  readonly locationId: string;
  readonly reason: string;
  readonly netReconciledBaseQuantity: string;
  readonly lotsToCreate: ReadonlyArray<{
    readonly movementId: number;
    readonly itemId: number;
    readonly locationId: string;
    readonly baseQuantity: string;
    readonly expiryDate: string | null;
    readonly requiresExpiry: boolean;
    readonly status: "accepted" | "quarantined";
    readonly costStatus: "known" | "missing";
    readonly costSnapshot: {
      readonly source: "legacy_reconciliation";
      readonly traceability: "legacy_unknown";
      readonly conversion: UnitConversionSnapshot;
      readonly requiresExpiry: boolean;
      readonly unitCostMinor: number | null;
      readonly payableId: number | null;
      readonly reason: string;
    };
  }>;
  readonly allocationsToCreate: ReadonlyArray<{
    readonly movementId: number;
    readonly sourceLotMovementId: number;
    readonly locationId: string;
    readonly baseQuantity: string;
  }>;
  readonly effects: typeof NO_FINANCIAL_EFFECT;
}

/** Plans allocation of historical unallocated inventory_movements to an active
 * clinic store location without creating duplicate movements, payables, or
 * fabricated costs/LOT codes.
 *
 * Boundary note on `existingLotRemainingBaseQuantity` vs `alreadyAllocatedBaseQuantity` (R08):
 * - In database-backed reconciliation (`reconcileHistoricalMovements`), the server
 *   passes `existingLotRemainingBaseQuantity` on each positive movement from the
 *   actual remaining `stock_lots` balance in the store. That value already reflects
 *   any outflows allocated to that lot, so no secondary FIFO deduction is applied.
 * - In pure unit-test callers that omit `existingLotRemainingBaseQuantity`, the
 *   planner falls back to `alreadyAllocatedBaseQuantity` and deducts already-allocated
 *   negative outflows FIFO from already-allocated positive capacity.
 */
export function planHistoricalReconciliation(input: {
  readonly itemId: number;
  readonly baseUnit: string;
  readonly basePrecision: 0 | 1 | 2 | 3;
  readonly conversionVersion: number;
  readonly requiresExpiry?: boolean;
  readonly existingLotRemainingBaseQuantity?: string;
  readonly locationId: string;
  readonly reason: string;
  readonly movements: readonly LegacyMovementRecord[];
}): HistoricalReconciliationPlan {
  positiveId(input.itemId, "item id");
  identifier(input.locationId, "reconciliation location");
  reason(input.reason);
  const requiresExpiry = input.requiresExpiry ?? true;
  const topLevelExistingRemainingAtoms =
    input.existingLotRemainingBaseQuantity !== undefined
      ? quantityAtoms(input.existingLotRemainingBaseQuantity, input.basePrecision, true)
      : 0n;
  const conversion = unitConversionSnapshot({
    itemId: input.itemId,
    version: input.conversionVersion,
    baseUnit: input.baseUnit,
    enteredUnit: input.baseUnit,
    baseUnitsPerEnteredUnit: "1",
    enteredPrecision: input.basePrecision,
    basePrecision: input.basePrecision,
  });
  invariant(input.movements.length > 0, "empty_reconciliation", "At least one historical movement is required");
  const seen = new Set<number>();
  const positiveBuckets: Array<{
    movementId: number;
    remainingAtoms: bigint;
    unallocatedInitialAtoms: bigint;
    expiryDate: string | null;
    unitCostMinor: number | null;
    payableId: number | null;
    needsNewLot: boolean;
  }> = [];
  const negativeMovements: Array<{ movementId: number; neededAtoms: bigint }> = [];
  let alreadyAllocatedNegativeAtoms = 0n;
  for (const row of input.movements) {
    positiveId(row.movementId, "historical movement id");
    invariant(!seen.has(row.movementId), "duplicate_source", `Duplicate historical movement: ${row.movementId}`);
    seen.add(row.movementId);
    invariant(["in", "out", "adjust"].includes(row.kind), "invalid_movement_kind", "Invalid historical movement kind");
    if (row.expiryDate !== null) dateOnly(row.expiryDate);
    if (row.unitCostMinor !== null) minorAmount(row.unitCostMinor);
    if (row.payableId !== null) positiveId(row.payableId, "historical payable id");
    const isNegative = row.kind === "out" || (row.kind === "adjust" && row.signedBaseQuantity.startsWith("-"));
    const magnitudeText = row.signedBaseQuantity.startsWith("-") ? row.signedBaseQuantity.slice(1) : row.signedBaseQuantity;
    const magnitudeAtoms = quantityAtoms(magnitudeText, input.basePrecision, true);
    const allocatedAtoms = quantityAtoms(row.alreadyAllocatedBaseQuantity, input.basePrecision, true);
    invariant(allocatedAtoms <= magnitudeAtoms, "overallocated_movement", "Historical movement allocation exceeds its quantity");
    const unallocatedAtoms = magnitudeAtoms - allocatedAtoms;
    if (isNegative) {
      alreadyAllocatedNegativeAtoms += allocatedAtoms;
      if (unallocatedAtoms > 0n) {
        negativeMovements.push({ movementId: row.movementId, neededAtoms: unallocatedAtoms });
      }
    } else {
      const existingRemainingAtoms =
        row.existingLotRemainingBaseQuantity !== undefined
          ? quantityAtoms(row.existingLotRemainingBaseQuantity, input.basePrecision, true)
          : allocatedAtoms;
      const availableAtoms = unallocatedAtoms + existingRemainingAtoms;
      if (availableAtoms > 0n) {
        positiveBuckets.push({
          movementId: row.movementId,
          remainingAtoms: availableAtoms,
          unallocatedInitialAtoms: unallocatedAtoms,
          expiryDate: row.expiryDate,
          unitCostMinor: row.unitCostMinor,
          payableId: row.payableId,
          needsNewLot: unallocatedAtoms > 0n,
        });
      }
    }
  }
  // When existingLotRemainingBaseQuantity was not explicitly supplied by DB, deduct already-allocated negative outflows FIFO from already-allocated positive capacity
  if (alreadyAllocatedNegativeAtoms > 0n && input.movements.every((m) => m.existingLotRemainingBaseQuantity === undefined)) {
    let toDeduct = alreadyAllocatedNegativeAtoms;
    for (const bucket of positiveBuckets) {
      if (toDeduct === 0n) break;
      const existingPart = bucket.remainingAtoms - bucket.unallocatedInitialAtoms;
      if (existingPart <= 0n) continue;
      const cut = existingPart <= toDeduct ? existingPart : toDeduct;
      bucket.remainingAtoms -= cut;
      toDeduct -= cut;
    }
  }
  const totalUnallocatedPositive = positiveBuckets.reduce((sum, row) => sum + row.unallocatedInitialAtoms, 0n);
  const totalAvailablePositive = positiveBuckets.reduce((sum, row) => sum + row.remainingAtoms, 0n) + topLevelExistingRemainingAtoms;
  const totalNegative = negativeMovements.reduce((sum, row) => sum + row.neededAtoms, 0n);
  invariant(totalUnallocatedPositive > 0n || totalNegative > 0n, "already_reconciled", "All historical movements for this item are already allocated");
  invariant(totalAvailablePositive >= totalNegative, "negative_legacy_balance", "Historical negative movements exceed available positive inflows");
  const lotsToCreate: HistoricalReconciliationPlan["lotsToCreate"][number][] = [];
  const allocationsToCreate: HistoricalReconciliationPlan["allocationsToCreate"][number][] = [];
  for (const bucket of positiveBuckets) {
    if (!bucket.needsNewLot) continue;
    const lotStatus: "accepted" | "quarantined" =
      requiresExpiry && bucket.expiryDate === null ? "quarantined" : "accepted";
    lotsToCreate.push({
      movementId: bucket.movementId,
      itemId: input.itemId,
      locationId: input.locationId,
      baseQuantity: quantityText(bucket.unallocatedInitialAtoms),
      expiryDate: bucket.expiryDate,
      requiresExpiry,
      status: lotStatus,
      costStatus: bucket.unitCostMinor !== null ? "known" : "missing",
      costSnapshot: {
        source: "legacy_reconciliation",
        traceability: "legacy_unknown",
        conversion,
        requiresExpiry,
        unitCostMinor: bucket.unitCostMinor,
        payableId: bucket.payableId,
        reason: input.reason,
      },
    });
    allocationsToCreate.push({
      movementId: bucket.movementId,
      sourceLotMovementId: bucket.movementId,
      locationId: input.locationId,
      baseQuantity: quantityText(bucket.unallocatedInitialAtoms),
    });
  }
  let existingBucketsUsed = false;
  for (const neg of negativeMovements) {
    let needed = neg.neededAtoms;
    // Pass 1: allocate against prior unallocated legacy positive movements first
    for (const bucket of positiveBuckets) {
      if (needed === 0n) break;
      if (!bucket.needsNewLot || bucket.remainingAtoms === 0n) continue;
      if (bucket.movementId > neg.movementId) continue;
      const unallocatedAvail =
        bucket.remainingAtoms <= bucket.unallocatedInitialAtoms
          ? bucket.remainingAtoms
          : bucket.unallocatedInitialAtoms;
      if (unallocatedAvail === 0n) continue;
      const take = unallocatedAvail <= needed ? unallocatedAvail : needed;
      bucket.remainingAtoms -= take;
      needed -= take;
      allocationsToCreate.push({
        movementId: neg.movementId,
        sourceLotMovementId: bucket.movementId,
        locationId: input.locationId,
        baseQuantity: quantityText(take),
      });
    }
    // Pass 2: allocate any remaining unallocated outflow against prior existing tracked positive lot capacity
    for (const bucket of positiveBuckets) {
      if (needed === 0n) break;
      if (bucket.remainingAtoms === 0n) continue;
      if (bucket.movementId > neg.movementId) continue;
      const take = bucket.remainingAtoms <= needed ? bucket.remainingAtoms : needed;
      bucket.remainingAtoms -= take;
      needed -= take;
      existingBucketsUsed = true;
      allocationsToCreate.push({
        movementId: neg.movementId,
        sourceLotMovementId: bucket.movementId,
        locationId: input.locationId,
        baseQuantity: quantityText(take),
      });
    }
    invariant(
      needed === 0n,
      "unresolved_historical_lineage",
      "Historical outflow precedes available positive inflow; cannot attribute lot lineage retroactively",
    );
  }
  const netReconciledAtoms = existingBucketsUsed
    ? positiveBuckets.reduce((sum, row) => sum + row.remainingAtoms, 0n)
    : totalUnallocatedPositive - totalNegative;
  return freeze({
    itemId: input.itemId,
    locationId: input.locationId,
    reason: input.reason,
    netReconciledBaseQuantity: quantityText(netReconciledAtoms),
    lotsToCreate,
    allocationsToCreate,
    effects: NO_FINANCIAL_EFFECT,
  });
}

