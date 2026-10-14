/** Pure read models over existing inventory movements; these functions never post stock or money. */
import { FULL_RATE_BP } from "../materialRate";
import { requireCurrency, type Currency } from "../money";

export interface Money { readonly currency: Currency; readonly amountMinor: number }
export type CostSnapshot = {
  readonly currency: Currency;
  readonly sourceId: string;
  readonly recordedAt: string;
} & (
  | { readonly state: "known" | "estimated"; readonly amountMinor: number; readonly pricedQuantityAtoms: number }
  | { readonly state: "missing"; readonly reason: string }
);

function integer(value: number, name: string, positive = false): number {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new Error(`invalid_${name}`);
  return value;
}
function safe(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("money_overflow");
  return result;
}
function text(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing_${name}`);
}
function money(value: Money, currency?: Currency): void {
  requireCurrency(value.currency, "treatment", "snapshot");
  integer(value.amountMinor, "amount");
  if (currency && value.currency !== currency) throw new Error("currency_mismatch");
}
function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}
type Fraction = readonly [bigint, bigint];
function add(a: Fraction, b: Fraction): Fraction {
  const n = a[0] * b[1] + b[0] * a[1];
  const d = a[1] * b[1];
  const g = gcd(n, d);
  return [n / g, d / g];
}
function rounded([n, d]: Fraction): number { return safe((n * 2n + d) / (2n * d)); }

/** Keeps sub-minor-unit values until the quantity is extended; never rounds unit price early. */
export function proportionalCostMinor(amountMinor: number, quantityAtoms: number, pricedQuantityAtoms: number): number {
  integer(amountMinor, "amount"); integer(quantityAtoms, "quantity"); integer(pricedQuantityAtoms, "priced_quantity", true);
  return rounded([BigInt(amountMinor) * BigInt(quantityAtoms), BigInt(pricedQuantityAtoms)]);
}

export interface TreatmentAllocation {
  readonly id: string;
  readonly patientId: string;
  readonly visitId: string;
  readonly caseId: string | null;
  /** Null means shared visit material, not the first procedure. */
  readonly procedureId: string | null;
  readonly quantityAtoms: number;
}
export interface TreatmentIssue {
  /** Existing inventory_movements.id, not an independent quantity record. */
  readonly movementId: string;
  /** Shared by manual/automatic recording of one actual usage; persistence must enforce uniqueness. */
  readonly usageKey: string;
  readonly itemId: string;
  readonly baseUnit: string;
  readonly atomsPerUnit: number;
  readonly quantityAtoms: number;
  readonly quantityState: "confirmed" | "estimated";
  readonly cost: CostSnapshot;
  readonly allocations: readonly TreatmentAllocation[];
}
export interface TreatmentReturn {
  readonly movementId: string;
  readonly issueMovementId: string;
  readonly allocationId: string;
  readonly quantityAtoms: number;
}
export type TreatmentScope = { readonly patientId: string } & (
  | { readonly kind: "case"; readonly caseId: string }
  | { readonly kind: "visit"; readonly visitId: string }
  | { readonly kind: "procedure"; readonly visitId: string; readonly procedureId: string }
);
export interface TreatmentCostSummary {
  readonly currency: Currency;
  readonly knownMinor: number;
  readonly estimatedMinor: number;
  /** Null if anything is missing; known/estimated subtotals remain visible. */
  readonly totalMinor: number | null;
  readonly completeness: "complete" | "estimated" | "missing";
  readonly missingAllocationIds: readonly string[];
  readonly unallocatedMovementIds: readonly string[];
  readonly selectedAllocationIds: readonly string[];
}

export function summarizeTreatmentCost(input: {
  readonly currency: Currency;
  readonly scope: TreatmentScope;
  readonly issues: readonly TreatmentIssue[];
  readonly returns: readonly TreatmentReturn[];
  /** Asserted by the authorized source adapter, never inferred from an empty array. */
  readonly registrationComplete: boolean;
}): TreatmentCostSummary {
  requireCurrency(input.currency, "treatment", "scope");
  text(input.scope.patientId, "patient");
  if (!["case", "visit", "procedure"].includes(input.scope.kind)) throw new Error("invalid_treatment_scope");
  if (input.scope.kind === "case") text(input.scope.caseId, "case");
  else {
    text(input.scope.visitId, "visit");
    if (input.scope.kind === "procedure") text(input.scope.procedureId, "procedure");
  }
  const movements = new Set<string>();
  const usages = new Set<string>();
  const allocations = new Map<string, { issue: TreatmentIssue; allocation: TreatmentAllocation }>();
  const unallocated: string[] = [];
  for (const issue of input.issues) {
    text(issue.movementId, "movement"); text(issue.usageKey, "usage"); text(issue.itemId, "item"); text(issue.baseUnit, "unit");
    integer(issue.quantityAtoms, "quantity", true); integer(issue.atomsPerUnit, "unit_scale", true);
    if (!["confirmed", "estimated"].includes(issue.quantityState)) throw new Error("invalid_quantity_state");
    if (movements.has(issue.movementId) || usages.has(issue.usageKey)) throw new Error("duplicate_consumption");
    movements.add(issue.movementId); usages.add(issue.usageKey);
    requireCurrency(issue.cost.currency, "inventory_cost", issue.movementId);
    if (issue.cost.currency !== input.currency) throw new Error("currency_mismatch");
    text(issue.cost.sourceId, "cost_source");
    if (!["known", "estimated", "missing"].includes(issue.cost.state)) throw new Error("invalid_cost_state");
    if (!Number.isFinite(Date.parse(issue.cost.recordedAt))) throw new Error("invalid_cost_date");
    if (issue.cost.state === "missing") text(issue.cost.reason, "cost_reason");
    else { integer(issue.cost.amountMinor, "amount"); integer(issue.cost.pricedQuantityAtoms, "priced_quantity", true); }
    let allocated = 0n;
    for (const allocation of issue.allocations) {
      text(allocation.id, "allocation"); text(allocation.patientId, "patient"); text(allocation.visitId, "visit");
      if (allocation.caseId !== null) text(allocation.caseId, "case");
      if (allocation.procedureId !== null) text(allocation.procedureId, "procedure");
      integer(allocation.quantityAtoms, "allocation_quantity", true);
      if (allocations.has(allocation.id)) throw new Error("duplicate_allocation");
      allocations.set(allocation.id, { issue, allocation });
      allocated += BigInt(allocation.quantityAtoms);
    }
    if (allocated > BigInt(issue.quantityAtoms)) throw new Error("overallocated_consumption");
    if (allocated < BigInt(issue.quantityAtoms)) unallocated.push(issue.movementId);
  }
  const returned = new Map<string, bigint>();
  for (const entry of input.returns) {
    text(entry.movementId, "return"); integer(entry.quantityAtoms, "return_quantity", true);
    if (movements.has(entry.movementId)) throw new Error("duplicate_return");
    movements.add(entry.movementId);
    const source = allocations.get(entry.allocationId);
    if (!source || source.issue.movementId !== entry.issueMovementId) throw new Error("return_source_mismatch");
    const qty = (returned.get(entry.allocationId) ?? 0n) + BigInt(entry.quantityAtoms);
    if (qty > BigInt(source.allocation.quantityAtoms)) throw new Error("return_exceeds_issue");
    returned.set(entry.allocationId, qty);
  }
  let known: Fraction = [0n, 1n]; let estimated: Fraction = [0n, 1n];
  const missing: string[] = []; const selected: string[] = [];
  let hasEstimated = false;
  for (const { issue, allocation } of allocations.values()) {
    const scope = input.scope;
    const matches = allocation.patientId === scope.patientId && (scope.kind === "case"
      ? allocation.caseId === scope.caseId
      : allocation.visitId === scope.visitId && (scope.kind === "visit" || allocation.procedureId === scope.procedureId));
    if (!matches) continue;
    selected.push(allocation.id);
    const qty = BigInt(allocation.quantityAtoms) - (returned.get(allocation.id) ?? 0n);
    if (qty === 0n) continue;
    if (issue.cost.state === "missing") { missing.push(allocation.id); continue; }
    const cost: Fraction = [BigInt(issue.cost.amountMinor) * qty, BigInt(issue.cost.pricedQuantityAtoms)];
    if (issue.quantityState === "estimated" || issue.cost.state === "estimated") {
      estimated = add(estimated, cost); hasEstimated = true;
    } else known = add(known, cost);
  }
  const completeness = !input.registrationComplete || missing.length > 0 || unallocated.length > 0
    ? "missing" : hasEstimated ? "estimated" : "complete";
  // Round the combined amount once; estimated residual makes displayed columns reconcile.
  const knownMinor = rounded(known);
  const combined = rounded(add(known, estimated));
  return {
    currency: input.currency, knownMinor, estimatedMinor: combined - knownMinor,
    totalMinor: completeness === "missing" ? null : combined, completeness,
    missingAllocationIds: missing, unallocatedMovementIds: unallocated, selectedAllocationIds: selected,
  };
}

export function priceSimulation(input: {
  readonly fixedCost: Money; readonly netPrice: Money; readonly targetMarginBp: number;
  readonly commission: { readonly basis: "net_price"; readonly rateBp: number } | { readonly basis: "included_in_fixed_cost" };
}) {
  money(input.fixedCost); money(input.netPrice, input.fixedCost.currency);
  if (!["net_price", "included_in_fixed_cost"].includes(input.commission.basis)) throw new Error("unsupported_commission_basis");
  integer(input.targetMarginBp, "margin");
  const commissionBp = input.commission.basis === "net_price" ? integer(input.commission.rateBp, "commission") : 0;
  if (input.targetMarginBp >= FULL_RATE_BP || commissionBp > FULL_RATE_BP) throw new Error("invalid_rate");
  const denominator = FULL_RATE_BP - commissionBp - input.targetMarginBp;
  if (denominator <= 0) throw new Error("non_positive_price_denominator");
  const numerator = BigInt(input.fixedCost.amountMinor) * BigInt(FULL_RATE_BP);
  const targetNetPriceMinor = safe((numerator + BigInt(denominator) - 1n) / BigInt(denominator));
  const commissionMinor = proportionalCostMinor(input.netPrice.amountMinor, commissionBp, FULL_RATE_BP);
  const contributionMinor = safe(BigInt(input.netPrice.amountMinor) - BigInt(input.fixedCost.amountMinor) - BigInt(commissionMinor));
  return {
    currency: input.fixedCost.currency, targetNetPriceMinor, commissionMinor, contributionMinor,
    marginBp: input.netPrice.amountMinor === 0 ? null : safe(BigInt(contributionMinor) * BigInt(FULL_RATE_BP) / BigInt(input.netPrice.amountMinor)),
  };
}

export interface OverheadSource extends Money { readonly id: string; readonly kind: "overhead" | "direct_labor" | "capital_purchase" }

export type TreatmentCostKind = "materials" | "laboratory" | "direct_labor" | "allocated_overhead";
export interface TreatmentCostComponent {
  readonly kind: TreatmentCostKind;
  readonly sourceId: string;
  readonly state: "known" | "estimated" | "missing";
  /** Explicit known zero is allowed; missing values must be null. */
  readonly amount: Money | null;
}

/** Complete category coverage is explicit, including a sourced zero when a category does not apply. */
export function summarizeTreatmentResult(input: {
  readonly currency: Currency; readonly performedRevenue: Money | null;
  readonly components: readonly TreatmentCostComponent[];
}) {
  requireCurrency(input.currency, "treatment_result", "report");
  if (input.performedRevenue) money(input.performedRevenue, input.currency);
  const kinds: TreatmentCostKind[] = ["materials", "laboratory", "direct_labor", "allocated_overhead"];
  const present = new Set<TreatmentCostKind>(); const sources = new Set<string>();
  const missing = new Set<TreatmentCostKind>();
  let knownDirect = 0n; let estimatedDirect = 0n; let knownOverhead = 0n; let estimatedOverhead = 0n;
  let hasEstimate = false;
  for (const component of input.components) {
    if (!kinds.includes(component.kind)) throw new Error("invalid_treatment_cost_kind");
    if (!["known", "estimated", "missing"].includes(component.state)) throw new Error("invalid_cost_state");
    text(component.sourceId, "component_source");
    if (sources.has(component.sourceId)) throw new Error("duplicate_treatment_cost_source");
    sources.add(component.sourceId); present.add(component.kind);
    if ((component.state === "missing") !== (component.amount === null)) throw new Error("inconsistent_cost_state");
    if (component.amount === null) { missing.add(component.kind); continue; }
    money(component.amount, input.currency);
    const value = BigInt(component.amount.amountMinor);
    if (component.state === "estimated") {
      hasEstimate = true;
      if (component.kind === "allocated_overhead") estimatedOverhead += value;
      else estimatedDirect += value;
    } else if (component.kind === "allocated_overhead") knownOverhead += value;
    else knownDirect += value;
  }
  for (const kind of kinds) if (!present.has(kind)) missing.add(kind);
  const direct = knownDirect + estimatedDirect;
  const total = direct + knownOverhead + estimatedOverhead;
  const revenue = input.performedRevenue?.amountMinor;
  const directComplete = [...missing].every((kind) => kind === "allocated_overhead");
  return {
    currency: input.currency, knownDirectMinor: safe(knownDirect), estimatedDirectMinor: safe(estimatedDirect),
    knownAllocatedOverheadMinor: safe(knownOverhead), estimatedAllocatedOverheadMinor: safe(estimatedOverhead),
    missingKinds: [...missing], completeness: missing.size ? "missing" as const : hasEstimate ? "estimated" as const : "complete" as const,
    totalCostMinor: missing.size ? null : safe(total),
    contributionBeforeOverheadMinor: revenue === undefined || !directComplete ? null : safe(BigInt(revenue) - direct),
    resultAfterAllocatedOverheadMinor: revenue === undefined || missing.size ? null : safe(BigInt(revenue) - total),
  };
}

/** Planned capacity leaves idle capacity visible; largest remainders conserve every minor unit. */
export function allocateOverhead(input: {
  readonly currency: Currency; readonly sources: readonly OverheadSource[]; readonly capacityUnits: number;
  readonly targets: readonly { readonly id: string; readonly units: number }[];
}) {
  requireCurrency(input.currency, "overhead", "pool"); integer(input.capacityUnits, "capacity", true);
  const ids = new Set<string>(); let total = 0n;
  for (const source of input.sources) {
    text(source.id, "source"); money(source, input.currency);
    if (ids.has(source.id)) throw new Error("duplicate_expense_source");
    ids.add(source.id);
    if (source.kind !== "overhead") throw new Error("direct_or_capital_cost_in_overhead");
    total += BigInt(source.amountMinor);
  }
  const totalMinor = safe(total); const targetIds = new Set<string>(); let used = 0n;
  const weights = input.targets.map((target) => {
    text(target.id, "target"); integer(target.units, "driver_units");
    if (targetIds.has(target.id)) throw new Error("duplicate_overhead_target");
    targetIds.add(target.id); used += BigInt(target.units);
    return BigInt(target.units);
  });
  const capacity = BigInt(input.capacityUnits);
  if (used > capacity) throw new Error("capacity_exceeded_requires_policy_revision");
  weights.push(capacity - used);
  const parts = weights.map((weight, index) => ({ index, amount: total * weight / capacity, remainder: total * weight % capacity }));
  let residual = total - parts.reduce((sum, part) => sum + part.amount, 0n);
  for (const part of [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    if (residual === 0n) break;
    part.amount += 1n; residual -= 1n;
  }
  return {
    currency: input.currency, totalMinor,
    allocations: input.targets.map((target, index) => ({ id: target.id, amountMinor: safe(parts[index].amount) })),
    unallocatedMinor: safe(parts[parts.length - 1].amount), unusedCapacityUnits: safe(capacity - used),
  };
}

/** These fields remain separate: collections never become performed treatment revenue. */
export function treatmentFinancialSnapshot(input: {
  readonly agreement: Money; readonly billed: Money; readonly collected: Money;
  readonly revenueAllocations: readonly { readonly id: string; readonly amount: Money }[];
  readonly allocationPolicyId: string | null; readonly costToDate: Money; readonly expectedCompletionCost: Money | null;
}) {
  money(input.agreement); money(input.billed, input.agreement.currency); money(input.collected, input.agreement.currency);
  money(input.costToDate, input.agreement.currency);
  if (input.expectedCompletionCost) money(input.expectedCompletionCost, input.agreement.currency);
  if (input.revenueAllocations.length && !input.allocationPolicyId?.trim()) throw new Error("revenue_allocation_policy_required");
  const seen = new Set<string>(); let performed = 0n;
  for (const allocation of input.revenueAllocations) {
    text(allocation.id, "revenue_allocation"); money(allocation.amount, input.agreement.currency);
    if (seen.has(allocation.id)) throw new Error("duplicate_revenue_allocation");
    seen.add(allocation.id); performed += BigInt(allocation.amount.amountMinor);
  }
  if (performed > BigInt(input.agreement.amountMinor)) throw new Error("revenue_exceeds_agreement");
  return {
    currency: input.agreement.currency,
    performedRevenueMinor: input.allocationPolicyId ? safe(performed) : null,
    billedMinor: input.billed.amountMinor, collectedMinor: input.collected.amountMinor,
    receivableMinor: safe(BigInt(input.billed.amountMinor) - BigInt(input.collected.amountMinor)),
    projectedCompletionContributionMinor: input.expectedCompletionCost === null ? null
      : safe(BigInt(input.agreement.amountMinor) - BigInt(input.costToDate.amountMinor) - BigInt(input.expectedCompletionCost.amountMinor)),
  };
}
