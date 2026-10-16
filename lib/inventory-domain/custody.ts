/** Proposals and reconciliations only. Existing inventory/commission writers own all posting. */
import { FULL_RATE_BP } from "../materialRate";
import { requireCurrency, type Currency } from "../money";
import { proportionalCostMinor, type Money } from "./treatment-cost";

function nonnegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${name}`);
  return value;
}
function safe(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("custody_overflow");
  return result;
}
function required(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing_${name}`);
}
function amount(value: Money, currency: Currency): void {
  requireCurrency(value.currency, "custody", "amount"); nonnegative(value.amountMinor, "amount");
  if (value.currency !== currency) throw new Error("currency_mismatch_requires_snapshot");
}

export function previewCustodyTransfer(input: {
  readonly sourceQuantityAtoms: number; readonly sourceValue: Money;
  readonly dispatchedAtoms: number; readonly acceptedAtoms: number; readonly returnedAtoms: number;
}) {
  amount(input.sourceValue, input.sourceValue.currency);
  for (const value of [input.sourceQuantityAtoms, input.dispatchedAtoms, input.acceptedAtoms, input.returnedAtoms]) nonnegative(value, "quantity");
  if (input.dispatchedAtoms > input.sourceQuantityAtoms || BigInt(input.acceptedAtoms) + BigInt(input.returnedAtoms) > BigInt(input.dispatchedAtoms)) throw new Error("transfer_exceeds_quantity");
  if (!input.sourceQuantityAtoms && input.sourceValue.amountMinor) throw new Error("value_without_quantity");
  const inTransitAtoms = input.dispatchedAtoms - input.acceptedAtoms - input.returnedAtoms;
  const sourceAtoms = input.sourceQuantityAtoms - input.dispatchedAtoms + input.returnedAtoms;
  // Allocate the original value by cumulative boundaries so every minor unit is conserved.
  const sourceValueMinor = input.sourceQuantityAtoms ? proportionalCostMinor(input.sourceValue.amountMinor, sourceAtoms, input.sourceQuantityAtoms) : 0;
  const throughTransitMinor = input.sourceQuantityAtoms ? proportionalCostMinor(input.sourceValue.amountMinor, sourceAtoms + inTransitAtoms, input.sourceQuantityAtoms) : 0;
  return {
    sourceAtoms, inTransitAtoms, custodyAtoms: input.acceptedAtoms,
    clinicQuantityAtoms: input.sourceQuantityAtoms, currency: input.sourceValue.currency,
    sourceValueMinor, inTransitValueMinor: throughTransitMinor - sourceValueMinor,
    custodyValueMinor: input.sourceValue.amountMinor - throughTransitMinor,
    clinicValueMinor: input.sourceValue.amountMinor, consumedAtoms: 0, payableDeltaMinor: 0, cashDeltaMinor: 0,
  };
}

export interface CustodyQuantityEvent {
  readonly id: string;
  readonly movementId: string;
  readonly kind: "received" | "transferred_out" | "returned_to_store" | "consumed" | "approved_waste";
  readonly quantityAtoms: number;
  readonly approvalId?: string;
  readonly reason?: string;
}
export function reconcileCustody(input: {
  readonly openingAtoms: number; readonly events: readonly CustodyQuantityEvent[]; readonly countedAtoms: number | null;
}) {
  nonnegative(input.openingAtoms, "opening");
  if (input.countedAtoms !== null) nonnegative(input.countedAtoms, "count");
  let expected = BigInt(input.openingAtoms); let consumed = 0n;
  const seen = new Set<string>(); const movements = new Set<string>();
  for (const event of input.events) {
    required(event.id, "event"); required(event.movementId, "movement"); nonnegative(event.quantityAtoms, "quantity");
    if (!["received", "transferred_out", "returned_to_store", "consumed", "approved_waste"].includes(event.kind)) throw new Error("invalid_custody_event");
    if (event.quantityAtoms === 0) throw new Error("zero_quantity_event");
    if (seen.has(event.id) || movements.has(event.movementId)) throw new Error("duplicate_custody_movement");
    seen.add(event.id); movements.add(event.movementId);
    if (event.kind === "approved_waste") { required(event.approvalId ?? "", "waste_approval"); required(event.reason ?? "", "waste_reason"); }
    expected += (event.kind === "received" ? 1n : -1n) * BigInt(event.quantityAtoms);
    if (expected < 0n) throw new Error("negative_custody_balance");
    if (event.kind === "consumed") consumed += BigInt(event.quantityAtoms);
  }
  const expectedClosingAtoms = safe(expected);
  return {
    expectedClosingAtoms, consumedAtoms: safe(consumed),
    countDifferenceAtoms: input.countedAtoms === null ? null : safe(BigInt(input.countedAtoms) - expected),
    reviewRequired: input.countedAtoms === null || input.countedAtoms !== expectedClosingAtoms,
    /** A count discrepancy creates no consumption, liability, or wage deduction. */
    automaticFinancialAdjustmentMinor: 0,
  };
}

export function calculateDeduction(input: {
  readonly basis: "collections" | "commission" | "agreed_other";
  readonly basisAmount: Money; readonly rateBp: number; readonly availableCommissionMinor: number;
}) {
  amount(input.basisAmount, input.basisAmount.currency); nonnegative(input.rateBp, "rate");
  if (!["collections", "commission", "agreed_other"].includes(input.basis)) throw new Error("invalid_deduction_basis");
  nonnegative(input.availableCommissionMinor, "commission");
  if (input.rateBp > FULL_RATE_BP) throw new Error("invalid_rate");
  const theoreticalMinor = proportionalCostMinor(input.basisAmount.amountMinor, input.rateBp, FULL_RATE_BP);
  const applicableMinor = Math.min(theoreticalMinor, input.availableCommissionMinor);
  return { basis: input.basis, currency: input.basisAmount.currency, theoreticalMinor, applicableMinor, unappliedMinor: theoreticalMinor - applicableMinor };
}
export interface SettlementScope { readonly doctorId: string; readonly periodId: string }
interface Scoped { readonly doctorId: string; readonly periodId: string }
export function canonicalSettlementPeriodId(periodId: string): string {
  required(periodId, "period");
  const trimmed = periodId.trim();
  if (/^\d{4}$/.test(trimmed)) return `${trimmed}-annual`;
  return trimmed;
}
function checkScope(entry: Scoped, scope: SettlementScope): void {
  required(scope.doctorId, "doctor"); required(scope.periodId, "period");
  if (
    entry.doctorId !== scope.doctorId ||
    canonicalSettlementPeriodId(entry.periodId) !== canonicalSettlementPeriodId(scope.periodId)
  ) {
    throw new Error("settlement_scope_mismatch");
  }
}
export interface AppliedDeduction extends Scoped {
  readonly id: string; readonly agreementVersionId: string; readonly currency: Currency;
  readonly theoreticalMinor: number; readonly appliedMinor: number;
}
export interface DeductionReversal {
  readonly id: string; readonly deductionId: string; readonly amount: Money;
}
export function summarizeAppliedDeductions(input: {
  readonly scope: SettlementScope; readonly currency: Currency;
  readonly deductions: readonly AppliedDeduction[]; readonly reversals: readonly DeductionReversal[];
}) {
  requireCurrency(input.currency, "deduction", "settlement"); checkScope(input.scope, input.scope);
  const originals = new Map<string, AppliedDeduction>(); let applied = 0n; let theoretical = 0n;
  for (const deduction of input.deductions) {
    checkScope(deduction, input.scope); required(deduction.id, "deduction"); required(deduction.agreementVersionId, "agreement_version");
    amount({ currency: deduction.currency, amountMinor: deduction.appliedMinor }, input.currency);
    nonnegative(deduction.theoreticalMinor, "theoretical");
    if (deduction.appliedMinor > deduction.theoreticalMinor) throw new Error("applied_exceeds_theoretical");
    if (originals.has(deduction.id)) throw new Error("duplicate_deduction");
    originals.set(deduction.id, deduction); applied += BigInt(deduction.appliedMinor); theoretical += BigInt(deduction.theoreticalMinor);
  }
  const reversalIds = new Set<string>(); const reversed = new Map<string, bigint>(); let totalReversed = 0n;
  for (const reversal of input.reversals) {
    required(reversal.id, "reversal"); amount(reversal.amount, input.currency);
    if (reversalIds.has(reversal.id) || originals.has(reversal.id)) throw new Error("duplicate_reversal");
    reversalIds.add(reversal.id);
    const original = originals.get(reversal.deductionId);
    if (!original) throw new Error("unlinked_deduction_reversal");
    const cumulative = (reversed.get(original.id) ?? 0n) + BigInt(reversal.amount.amountMinor);
    if (cumulative > BigInt(original.appliedMinor)) throw new Error("reversal_exceeds_applied");
    reversed.set(original.id, cumulative); totalReversed += BigInt(reversal.amount.amountMinor);
  }
  return { currency: input.currency, theoreticalMinor: safe(theoretical), appliedMinor: safe(applied), reversedMinor: safe(totalReversed), netAppliedMinor: safe(applied - totalReversed) };
}

export interface AttributableConsumption extends Scoped {
  readonly id: string; readonly movementAllocationId: string; readonly agreementVersionId: string;
  readonly kind: "consumption" | "waste";
  readonly includedByAgreement: boolean; readonly shareBp: number;
  /** Net original consumption cost after linked returns, in this settlement currency. */
  readonly netCost: Money | null; readonly costState: "known" | "estimated" | "missing";
  readonly exceptionApprovalId?: string;
}
export function attributableConsumedCost(input: {
  readonly scope: SettlementScope; readonly currency: Currency; readonly lines: readonly AttributableConsumption[];
  readonly inventoryReconciled: boolean;
}) {
  requireCurrency(input.currency, "consumption", "settlement"); checkScope(input.scope, input.scope);
  const ids = new Set<string>(); const allocations = new Set<string>(); let total = 0n;
  const pendingIds: string[] = []; const excludedIds: string[] = [];
  for (const line of input.lines) {
    checkScope(line, input.scope); required(line.id, "consumption"); required(line.movementAllocationId, "movement_allocation");
    required(line.agreementVersionId, "agreement_version"); nonnegative(line.shareBp, "share");
    if (!["known", "estimated", "missing"].includes(line.costState)) throw new Error("invalid_cost_state");
    if (!["consumption", "waste"].includes(line.kind)) throw new Error("invalid_attribution_kind");
    if (line.shareBp > FULL_RATE_BP) throw new Error("invalid_share");
    if (ids.has(line.id) || allocations.has(line.movementAllocationId)) throw new Error("duplicate_attributed_consumption");
    ids.add(line.id); allocations.add(line.movementAllocationId);
    if (line.netCost !== null) amount(line.netCost, input.currency);
    if ((line.costState === "missing") !== (line.netCost === null)) throw new Error("inconsistent_cost_state");
    if (!line.includedByAgreement || line.shareBp === 0) { excludedIds.push(line.id); continue; }
    if (line.kind === "waste" && !line.exceptionApprovalId?.trim()) { pendingIds.push(line.id); continue; }
    if (line.costState !== "known" || line.netCost === null) { pendingIds.push(line.id); continue; }
    total += BigInt(line.netCost.amountMinor) * BigInt(line.shareBp);
  }
  const knownAttributableMinor = safe((total + BigInt(FULL_RATE_BP / 2)) / BigInt(FULL_RATE_BP));
  const complete = input.inventoryReconciled && pendingIds.length === 0;
  return { currency: input.currency, knownAttributableMinor, totalMinor: complete ? knownAttributableMinor : null, complete, pendingIds, excludedIds };
}

/** Signed prior adjustments: positive credit to doctor, negative debit; include linked reversals.
 * Every adjustment MUST carry explicit postingState === "posted" and a non-empty postedEntryId.
 */
export interface SettlementAdjustment extends Scoped {
  readonly id: string;
  readonly currency: Currency;
  readonly signedMinor: number;
  readonly postingState?:
    | "posted"
    | "provisional"
    | "objected"
    | "unposted"
    | "ready_for_authorized_review"
    | "objected_under_review";
  readonly postedEntryId?: string | null;
}
export function proposeSettlement(input: {
  readonly scope: SettlementScope;
  readonly deductions: Money;
  readonly attributable: Money | null;
  readonly prerequisitesComplete: boolean;
  readonly sourceBacked?: boolean;
  readonly priorAdjustments: readonly SettlementAdjustment[];
}) {
  checkScope(input.scope, input.scope); amount(input.deductions, input.deductions.currency);
  if (input.attributable) amount(input.attributable, input.deductions.currency);
  const seen = new Set<string>();
  const seenPostedEntries = new Set<string>();
  let prior = 0n;
  for (const adjustment of input.priorAdjustments) {
    checkScope(adjustment, input.scope); required(adjustment.id, "adjustment");
    requireCurrency(adjustment.currency, "settlement", adjustment.id);
    if (adjustment.currency !== input.deductions.currency) throw new Error("currency_mismatch_requires_snapshot");
    if (!Number.isSafeInteger(adjustment.signedMinor)) throw new Error("invalid_adjustment");
    if (adjustment.postingState !== "posted") {
      throw new Error("unposted_settlement_adjustment");
    }
    if (typeof adjustment.postedEntryId !== "string" || !adjustment.postedEntryId.trim()) {
      throw new Error("unposted_settlement_adjustment");
    }
    const entryKey = adjustment.postedEntryId.trim();
    if (seen.has(adjustment.id) || seenPostedEntries.has(entryKey)) {
      throw new Error("duplicate_settlement_adjustment");
    }
    seen.add(adjustment.id);
    seenPostedEntries.add(entryKey);
    prior += BigInt(adjustment.signedMinor);
  }
  const sourceBacked = input.sourceBacked === true;
  const delta = input.attributable === null ? null : BigInt(input.deductions.amountMinor) - BigInt(input.attributable.amountMinor);
  const supplementalMinor = delta === null ? null : safe(delta - prior);
  return {
    currency: input.deductions.currency, targetDifferenceMinor: delta === null ? null : safe(delta), priorAdjustmentMinor: safe(prior), supplementalMinor,
    direction: supplementalMinor === null ? "undetermined" as const : supplementalMinor > 0 ? "due_to_doctor" as const : supplementalMinor < 0 ? "proposed_from_doctor" as const : "balanced" as const,
    status: input.prerequisitesComplete && sourceBacked && delta !== null ? "ready_for_authorized_review" as const : "provisional" as const,
    cashDeltaMinor: 0, automaticWageDeductionMinor: 0,
  };
}

/** Rate is target MINOR units per source MINOR unit, with the immutable quote explicitly attached. */
export function convertSettlementMoney(input: {
  readonly original: Money; readonly targetCurrency: Currency; readonly numerator: number; readonly denominator: number;
  readonly quoteId: string; readonly quotedAt: string;
}) {
  amount(input.original, input.original.currency); requireCurrency(input.targetCurrency, "settlement", "target");
  required(input.quoteId, "fx_quote"); nonnegative(input.numerator, "fx_numerator"); nonnegative(input.denominator, "fx_denominator");
  if (!input.numerator || !input.denominator || !Number.isFinite(Date.parse(input.quotedAt))) throw new Error("invalid_fx_snapshot");
  if (input.original.currency === input.targetCurrency && input.numerator !== input.denominator) throw new Error("same_currency_fx_must_be_one");
  return Object.freeze({
    currency: input.targetCurrency, amountMinor: proportionalCostMinor(input.original.amountMinor, input.numerator, input.denominator),
    original: Object.freeze({ ...input.original }), quoteId: input.quoteId, quotedAt: input.quotedAt, numerator: input.numerator, denominator: input.denominator,
  });
}

export function treatmentCostAfterDoctorRecovery(input: { readonly material: Money; readonly grossDoctorFee: Money; readonly doctorMaterialRecovery: Money }) {
  amount(input.material, input.material.currency); amount(input.grossDoctorFee, input.material.currency); amount(input.doctorMaterialRecovery, input.material.currency);
  if (input.doctorMaterialRecovery.amountMinor > input.grossDoctorFee.amountMinor || input.doctorMaterialRecovery.amountMinor > input.material.amountMinor) throw new Error("recovery_exceeds_cost_or_fee");
  const netDoctorFeeMinor = input.grossDoctorFee.amountMinor - input.doctorMaterialRecovery.amountMinor;
  return { currency: input.material.currency, netDoctorFeeMinor, totalCostMinor: safe(BigInt(input.material.amountMinor) + BigInt(netDoctorFeeMinor)) };
}

export type PackageSafetyPolicy = "safe_empty_return" | "safe_disposal_record" | "bulk_count" | "reusable_custody";
const HAZARD_RANK: Record<"none" | "sharp" | "contaminated", number> = {
  none: 0,
  sharp: 1,
  contaminated: 2,
};

/**
 * Classifies package safety policy.
 * Explicit item safety metadata recorded on `costSnapshot.hazard` and `costSnapshot.policy` is authoritative.
 * When explicit metadata is absent, name/category/unit pattern matching acts only as a conservative fallback heuristic
 * and does not replace clinical item master classification.
 */
export function classifyDefaultPackageSafety(item: {
  readonly name?: string | null;
  readonly category?: string | null;
  readonly unit?: string | null;
  readonly costSnapshot?: Record<string, unknown> | null;
}): {
  readonly minimumHazard: "none" | "sharp" | "contaminated";
  readonly defaultPolicy: PackageSafetyPolicy;
} {
  const snapHazard = item.costSnapshot?.hazard;
  const snapPolicy = item.costSnapshot?.policy;
  if (
    (snapHazard === "none" || snapHazard === "sharp" || snapHazard === "contaminated") &&
    (snapPolicy === "safe_empty_return" || snapPolicy === "safe_disposal_record" || snapPolicy === "bulk_count" || snapPolicy === "reusable_custody")
  ) {
    return {
      minimumHazard: snapHazard,
      defaultPolicy: snapHazard !== "none" ? "safe_disposal_record" : snapPolicy,
    };
  }
  const combined = `${item.category ?? ""} ${item.name ?? ""} ${item.unit ?? ""}`.toLowerCase();
  if (/(?:contaminated|blood|biohazard|ملوث|دم)/i.test(combined)) {
    return { minimumHazard: "contaminated", defaultPolicy: "safe_disposal_record" };
  }
  if (/(?:anesthesia|cartridge|carpule|needle|blade|scalpel|suture|sharp|endo\s*file|reamer|bur|إبرة|ابر|مشرط|شفرة|خدر|تخدير|خرطوش|كربول|مبرد|فايل)/i.test(combined)) {
    return { minimumHazard: "sharp", defaultPolicy: "safe_disposal_record" };
  }
  if (/(?:ml|liter|gel|liquid|bond|etch|rinse|مل|سائل|جل|بوند)/i.test(combined)) {
    return { minimumHazard: "none", defaultPolicy: "bulk_count" };
  }
  return { minimumHazard: "none", defaultPolicy: "safe_empty_return" };
}

export function resolvePackageSafetyWithFieldObservation(input: {
  readonly minimumHazard: "none" | "sharp" | "contaminated";
  readonly defaultPolicy: PackageSafetyPolicy;
  readonly observedHazard?: "none" | "sharp" | "contaminated";
  readonly requestedPolicy?: PackageSafetyPolicy;
}): {
  readonly effectiveHazard: "none" | "sharp" | "contaminated";
  readonly effectivePolicy: PackageSafetyPolicy;
} {
  const observed = input.observedHazard ?? input.minimumHazard;
  const requested = input.requestedPolicy ?? input.defaultPolicy;
  if (!["none", "sharp", "contaminated"].includes(observed) || !["safe_empty_return", "safe_disposal_record", "bulk_count", "reusable_custody"].includes(requested)) {
    throw new Error("unknown_package_safety_classification");
  }
  if (HAZARD_RANK[observed] < HAZARD_RANK[input.minimumHazard]) {
    throw new Error("package_hazard_downgrade_forbidden");
  }
  const effectiveHazard = HAZARD_RANK[observed] >= HAZARD_RANK[input.minimumHazard] ? observed : input.minimumHazard;
  if (effectiveHazard !== "none") {
    return { effectiveHazard, effectivePolicy: "safe_disposal_record" };
  }
  if (requested !== input.defaultPolicy) {
    throw new Error("package_policy_override_forbidden");
  }
  return { effectiveHazard, effectivePolicy: input.defaultPolicy };
}

export function canonicalCustodyReferenceKey(raw: string): string {
  return raw
    .trim()
    .replace(/^checkpoint:[^:]+:/i, "")
    .replace(/^(?:(?:pkg|ev|transfer_line|mov_alloc|mov|usage|stocktake|waste_approval|transfer_out):)+/i, "");
}

export function packageEvidenceAction(hazard: "none" | "sharp" | "contaminated", policy: PackageSafetyPolicy) {
  if (!["none", "sharp", "contaminated"].includes(hazard) || !["safe_empty_return", "safe_disposal_record", "bulk_count", "reusable_custody"].includes(policy)) throw new Error("unknown_package_safety_classification");
  if (hazard !== "none" || policy === "safe_disposal_record") return "document_safe_disposal" as const;
  if (policy === "bulk_count") return "measure_and_count" as const;
  if (policy === "reusable_custody") return "separate_reusable_return" as const;
  return "receive_safe_empty_package" as const;
}
export function reconcileEmptyPackage(input: {
  readonly packageId: string; readonly evidenceEventId: string;
  readonly previousClosures: readonly { readonly packageId: string; readonly evidenceEventId: string }[];
  readonly hazard: "none" | "sharp" | "contaminated"; readonly policy: PackageSafetyPolicy;
  readonly evidenceAction: ReturnType<typeof packageEvidenceAction>;
  readonly disposalEvidenceVerified?: boolean;
  readonly originalAtoms: number; readonly recordedConsumptionAtoms: number; readonly returnedOrTransferredAtoms: number;
  readonly approvedWasteAtoms: number; readonly remainingAtoms: number;
}) {
  required(input.packageId, "unique_package"); required(input.evidenceEventId, "evidence_event");
  const pkgCanonical = canonicalCustodyReferenceKey(input.packageId);
  const evCanonical = canonicalCustodyReferenceKey(input.evidenceEventId);
  if (
    input.previousClosures.some(
      (row) =>
        (!row.packageId.startsWith("checkpoint:") && canonicalCustodyReferenceKey(row.packageId) === pkgCanonical) ||
        canonicalCustodyReferenceKey(row.evidenceEventId) === evCanonical,
    )
  ) {
    throw new Error("package_or_evidence_already_closed");
  }
  const expectedAction = packageEvidenceAction(input.hazard, input.policy);
  if (input.evidenceAction !== expectedAction) throw new Error("unsafe_or_inapplicable_package_evidence");
  for (const value of [input.originalAtoms, input.recordedConsumptionAtoms, input.returnedOrTransferredAtoms, input.approvedWasteAtoms, input.remainingAtoms]) nonnegative(value, "package_quantity");
  if (!input.originalAtoms) throw new Error("empty_original_package");
  if (expectedAction === "receive_safe_empty_package" && input.remainingAtoms !== 0) throw new Error("material_return_requires_separate_inspected_movement");
  const unexplainedAtoms = safe(BigInt(input.originalAtoms) - BigInt(input.recordedConsumptionAtoms) - BigInt(input.returnedOrTransferredAtoms) - BigInt(input.approvedWasteAtoms) - BigInt(input.remainingAtoms));
  const disposalUnverified = expectedAction === "document_safe_disposal" && input.disposalEvidenceVerified === false;
  const evidenceVerificationStatus =
    expectedAction === "document_safe_disposal"
      ? input.disposalEvidenceVerified === true
        ? ("verified_disposal_record" as const)
        : ("unverified_attestation_requires_review" as const)
      : ("verified_custody_event" as const);
  const terminalClosure = input.remainingAtoms === 0;
  return {
    packageId: input.packageId,
    evidenceEventId: input.evidenceEventId,
    evidenceAction: expectedAction,
    evidenceVerificationStatus,
    closureKind: terminalClosure ? ("terminal" as const) : ("checkpoint" as const),
    terminalClosure,
    unexplainedAtoms,
    reviewRequired: unexplainedAtoms !== 0 || disposalUnverified,
    materialStockDeltaAtoms: 0,
    consumptionDeltaAtoms: 0,
    automaticDebtMinor: 0,
  };
}

export function reviewReplenishment(input: {
  readonly requestedAtoms: number; readonly remainingAtoms: number; readonly approvedTargetAtoms: number;
  readonly emergency: boolean; readonly requesterId: string; readonly approverId: string | null;
  readonly approverAuthorized: boolean; readonly reason: string | null;
}) {
  for (const value of [input.requestedAtoms, input.remainingAtoms, input.approvedTargetAtoms]) nonnegative(value, "replenishment_quantity");
  required(input.requesterId, "requester");
  if (!input.requestedAtoms) throw new Error("zero_replenishment");
  const exceedsTarget = BigInt(input.requestedAtoms) + BigInt(input.remainingAtoms) > BigInt(input.approvedTargetAtoms);
  if (input.emergency || exceedsTarget) {
    required(input.reason ?? "", "exception_reason"); required(input.approverId ?? "", "approver");
    if (!input.approverAuthorized || input.approverId === input.requesterId) throw new Error("independent_authorized_approval_required");
  }
  return { earlyReplenishment: input.remainingAtoms > 0, exceedsTarget, exceptionReviewRequired: input.emergency || exceedsTarget, requireNonexistentEmptyPackage: false, stockDeltaAtoms: 0 };
}
