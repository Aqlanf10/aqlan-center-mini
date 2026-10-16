/** Proposals and reconciliations only. Existing inventory/commission writers own all posting. */
import { FULL_RATE_BP } from "../materialRate";
import { requireCurrency, type Currency } from "../money";
import { invariant, quantityAtoms, quantityText } from "./quantities";
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
    .replace(/^(?:(?:pkg|ev|transfer_ack|transfer_line|mov_alloc|mov|usage|stocktake|waste_approval|transfer_out):)+/i, "");
}

const UUID_PART = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CHECKPOINT_ACK_RE = new RegExp(`^checkpoint:(${UUID_PART}):(?:(?:transfer_ack|pkg):)?(${UUID_PART}):(${UUID_PART})$`, "i");
const TERMINAL_ACK_RE = new RegExp(`^(?:(?:transfer_ack|pkg):)?(${UUID_PART}):(${UUID_PART})$`, "i");
const CHECKPOINT_SINGLE_RE = new RegExp(`^checkpoint:(${UUID_PART}):(?:(transfer_line|mov_alloc|pkg):)?(${UUID_PART})$`, "i");
const TERMINAL_SINGLE_RE = new RegExp(`^(?:(transfer_line|mov_alloc|pkg):)?(${UUID_PART})$`, "i");
const CANONICAL_ACK_RE = new RegExp(`^transfer_ack:(${UUID_PART}):(${UUID_PART})$`, "i");
const CANONICAL_LINE_RE = new RegExp(`^transfer_line:(${UUID_PART})$`, "i");
const CANONICAL_ALLOC_RE = new RegExp(`^mov_alloc:(${UUID_PART})$`, "i");

export type ParsedCustodyClosureSource =
  | {
      readonly kind: "transfer_ack";
      readonly isCheckpoint: boolean;
      readonly closureId: string | null;
      readonly ackId: string;
      readonly lineId: string;
      readonly rawSourceId: string;
      readonly canonicalSourceId: string;
    }
  | {
      readonly kind: "mov_alloc";
      readonly isCheckpoint: boolean;
      readonly closureId: string | null;
      readonly allocationId: string;
      readonly rawSourceId: string;
      readonly canonicalSourceId: string;
    }
  | {
      readonly kind: "legacy_transfer_line";
      readonly isCheckpoint: boolean;
      readonly closureId: string | null;
      readonly lineId: string;
      readonly rawSourceId: string;
      readonly canonicalSourceId: string;
    }
  | {
      readonly kind: "single_uuid";
      readonly isCheckpoint: boolean;
      readonly closureId: string | null;
      readonly targetId: string;
      readonly rawSourceId: string;
    }
  | {
      readonly kind: "unrecognized";
      readonly isCheckpoint: boolean;
      readonly rawSourceId: string;
    };

/**
 * Extracts the stored source identity of a `custody_package_closures` row using anchored UUID rules
 * and optional `document.canonicalPackageSourceId` metadata.
 * - Ack-specific checkpoints (`checkpoint:<closureId>:<ackId>:<lineId>`) carry 3 UUIDs after `checkpoint:`
 *   and match ONLY `<ackId>:<lineId>`, never other acknowledgements on `<lineId>`.
 * - Legacy line-only checkpoints (`checkpoint:<closureId>:<lineId>`) carry 2 UUIDs after `checkpoint:`.
 */
export function parseCustodyPackageClosureSource(
  packageId: string,
  document?: Record<string, unknown> | null,
): ParsedCustodyClosureSource {
  const trimmed = (packageId ?? "").trim();
  const cpAck = CHECKPOINT_ACK_RE.exec(trimmed);
  if (cpAck) {
    const [, closureId, ackId, lineId] = cpAck;
    return {
      kind: "transfer_ack",
      isCheckpoint: true,
      closureId,
      ackId,
      lineId,
      rawSourceId: `${ackId}:${lineId}`,
      canonicalSourceId: `transfer_ack:${ackId}:${lineId}`,
    };
  }
  const termAck = TERMINAL_ACK_RE.exec(trimmed);
  if (termAck) {
    const [, ackId, lineId] = termAck;
    return {
      kind: "transfer_ack",
      isCheckpoint: false,
      closureId: null,
      ackId,
      lineId,
      rawSourceId: `${ackId}:${lineId}`,
      canonicalSourceId: `transfer_ack:${ackId}:${lineId}`,
    };
  }
  const cpSingle = CHECKPOINT_SINGLE_RE.exec(trimmed);
  const termSingle = cpSingle ? null : TERMINAL_SINGLE_RE.exec(trimmed);
  if (cpSingle || termSingle) {
    const isCheckpoint = Boolean(cpSingle);
    const closureId = cpSingle ? cpSingle[1] : null;
    const prefix = (cpSingle ? cpSingle[2] : termSingle![1])?.toLowerCase() ?? null;
    const targetId = cpSingle ? cpSingle[3] : termSingle![2];
    const docCanonical =
      typeof document?.canonicalPackageSourceId === "string"
        ? document.canonicalPackageSourceId.trim()
        : "";
    const docAck = CANONICAL_ACK_RE.exec(docCanonical);
    if (docAck && (docAck[1].toLowerCase() === targetId.toLowerCase() || docAck[2].toLowerCase() === targetId.toLowerCase())) {
      const [, ackId, lineId] = docAck;
      return {
        kind: "transfer_ack",
        isCheckpoint,
        closureId,
        ackId,
        lineId,
        rawSourceId: `${ackId}:${lineId}`,
        canonicalSourceId: `transfer_ack:${ackId}:${lineId}`,
      };
    }
    const docAlloc = CANONICAL_ALLOC_RE.exec(docCanonical);
    if (prefix === "mov_alloc" || (docAlloc && docAlloc[1].toLowerCase() === targetId.toLowerCase())) {
      return {
        kind: "mov_alloc",
        isCheckpoint,
        closureId,
        allocationId: targetId,
        rawSourceId: targetId,
        canonicalSourceId: `mov_alloc:${targetId}`,
      };
    }
    const docLine = CANONICAL_LINE_RE.exec(docCanonical);
    if (prefix === "transfer_line" || (docLine && docLine[1].toLowerCase() === targetId.toLowerCase())) {
      return {
        kind: "legacy_transfer_line",
        isCheckpoint,
        closureId,
        lineId: targetId,
        rawSourceId: targetId,
        canonicalSourceId: `transfer_line:${targetId}`,
      };
    }
    return {
      kind: "single_uuid",
      isCheckpoint,
      closureId,
      targetId,
      rawSourceId: targetId,
    };
  }
  return {
    kind: "unrecognized",
    isCheckpoint: /^checkpoint:/i.test(trimmed),
    rawSourceId: canonicalCustodyReferenceKey(trimmed),
  };
}

export interface CustodyInboundSourceRecord {
  readonly kind: "transfer_ack" | "mov_alloc";
  readonly rawId: string;
  readonly canonicalId: string;
  readonly ackId?: string | null;
  readonly lineId?: string | null;
  readonly transferId?: string | null;
  readonly allocationId?: string | null;
  readonly movementId?: string | null;
  readonly acceptedQuantity: string;
  readonly sourceTs: string;
}

export interface CustodyClosureRecord {
  readonly id?: string;
  readonly packageId: string;
  readonly evidenceEventId?: string;
  readonly originalQuantity: string;
  readonly remainingQuantity?: string;
  readonly document?: Record<string, unknown> | null;
  readonly createdAt?: string;
}

export interface ResolvedCustodyTrancheSource {
  readonly kind: "transfer_ack" | "mov_alloc";
  readonly rawId: string;
  readonly canonicalId: string;
  readonly ackId: string | null;
  readonly lineId: string | null;
  readonly transferId: string | null;
  readonly allocationId: string | null;
  readonly movementId: string | null;
  readonly sourceTs: string;
  readonly initialAtoms3: bigint;
  readonly retiredAtoms3: bigint;
  readonly openAtoms3: bigint;
  readonly initialQuantity: string;
  readonly retiredQuantity: string;
  readonly openQuantity: string;
  readonly terminallyClosed: boolean;
  readonly legacyReconciliationRequired: boolean;
}

export interface ResolvedCustodyPackageSourcesResult {
  readonly sources: readonly ResolvedCustodyTrancheSource[];
  readonly openTranches: readonly ResolvedCustodyTrancheSource[];
  readonly legacyReconciliationRequiredLines: readonly string[];
  readonly hasInvalidLegacyClosure: boolean;
}

/**
 * Shared deterministic resolver used by both `verifyPackageSource` and `readDoctorCustody`.
 * - Attributes ack-bound terminal and checkpoint closures strictly to their full `<ackId>:<lineId>` identity.
 * - Handles legacy line-only closures (`<lineId>` or `checkpoint:<closureId>:<lineId>`) explicitly:
 *   1. If `document.legacyAckAllocations` provides a documented one-time mapping whose positive shares
 *      sum exactly to `originalQuantity` and stay within each acknowledgement's remaining accepted quantity,
 *      attributes each share once to its mapped acknowledgement.
 *   2. If the transfer line has only a single accepted acknowledgement and the legacy closure fits within
 *      that acknowledgement's remaining capacity, attributes it once to that sole acknowledgement.
 *   3. Otherwise (e.g. multiple acknowledgements on the same transfer line with an unmapped legacy line-only
 *      closure, or any invalid/over-allocated legacy mapping), marks the transfer line as
 *      `legacyReconciliationRequired: true` (`legacy_source_reconciliation_required`) and withholds ambiguous
 *      tranches from automatic closure without guessing or double-deducting across acknowledgements.
 */
export function resolveCustodyPackageSources(input: {
  readonly sources: readonly CustodyInboundSourceRecord[];
  readonly closures: readonly CustodyClosureRecord[];
}): ResolvedCustodyPackageSourcesResult {
  type MutableSource = {
    readonly kind: "transfer_ack" | "mov_alloc";
    readonly rawId: string;
    readonly canonicalId: string;
    readonly ackId: string | null;
    readonly lineId: string | null;
    readonly transferId: string | null;
    readonly allocationId: string | null;
    readonly movementId: string | null;
    readonly sourceTs: string;
    readonly initialAtoms3: bigint;
    retiredAtoms3: bigint;
    terminallyClosed: boolean;
    legacyReconciliationRequired: boolean;
  };

  const mutable: MutableSource[] = input.sources.map((src) => {
    let ackId = src.ackId ?? null;
    let lineId = src.lineId ?? null;
    if (src.kind === "transfer_ack" && (!ackId || !lineId) && src.rawId.includes(":")) {
      const [a, l] = src.rawId.split(":");
      ackId = ackId ?? a;
      lineId = lineId ?? l;
    }
    const allocationId = src.kind === "mov_alloc" ? (src.allocationId ?? src.rawId) : null;
    return {
      kind: src.kind,
      rawId: src.rawId,
      canonicalId: src.canonicalId,
      ackId,
      lineId,
      transferId: src.transferId ?? null,
      allocationId,
      movementId: src.movementId ?? null,
      sourceTs: src.sourceTs,
      initialAtoms3: quantityAtoms(src.acceptedQuantity, 3, true),
      retiredAtoms3: 0n,
      terminallyClosed: false,
      legacyReconciliationRequired: false,
    };
  });

  const ackByKey = new Map<string, MutableSource>();
  const acksByLine = new Map<string, MutableSource[]>();
  const acksByAckId = new Map<string, MutableSource[]>();
  const allocById = new Map<string, MutableSource>();

  for (const s of mutable) {
    if (s.kind === "transfer_ack" && s.ackId && s.lineId) {
      ackByKey.set(`${s.ackId.toLowerCase()}:${s.lineId.toLowerCase()}`, s);
      const lineKey = s.lineId.toLowerCase();
      const lineArr = acksByLine.get(lineKey) ?? [];
      lineArr.push(s);
      acksByLine.set(lineKey, lineArr);
      const ackKey = s.ackId.toLowerCase();
      const ackArr = acksByAckId.get(ackKey) ?? [];
      ackArr.push(s);
      acksByAckId.set(ackKey, ackArr);
    } else if (s.kind === "mov_alloc" && s.allocationId) {
      allocById.set(s.allocationId.toLowerCase(), s);
    }
  }

  const legacyLineClosures = new Map<string, Array<{ closure: CustodyClosureRecord; isCheckpoint: boolean }>>();
  const modernClosures: Array<{ parsed: ParsedCustodyClosureSource; retired: bigint }> = [];
  let hasInvalidLegacyClosure = false;

  for (const c of input.closures) {
    const parsed = parseCustodyPackageClosureSource(c.packageId, c.document);
    const retired = quantityAtoms(c.originalQuantity ?? "0", 3, true);
    if (parsed.kind === "legacy_transfer_line") {
      const lineKey = parsed.lineId.toLowerCase();
      const arr = legacyLineClosures.get(lineKey) ?? [];
      arr.push({ closure: c, isCheckpoint: parsed.isCheckpoint });
      legacyLineClosures.set(lineKey, arr);
      continue;
    }
    if (parsed.kind === "single_uuid") {
      const tid = parsed.targetId.toLowerCase();
      if (!allocById.has(tid) && acksByLine.has(tid)) {
        const arr = legacyLineClosures.get(tid) ?? [];
        arr.push({ closure: c, isCheckpoint: parsed.isCheckpoint });
        legacyLineClosures.set(tid, arr);
        continue;
      }
    }
    modernClosures.push({ parsed, retired });
  }

  const legacyReconciliationRequiredLinesSet = new Set<string>();

  for (const [lineKey, closuresOnLine] of legacyLineClosures.entries()) {
    const acksOnLine = acksByLine.get(lineKey) ?? [];
    if (acksOnLine.length === 0) continue;
    const canonicalLineId = acksOnLine[0].lineId ?? lineKey;

    for (const { closure, isCheckpoint } of closuresOnLine) {
      const legacyRetired = quantityAtoms(closure.originalQuantity ?? "0", 3, true);
      const rawMap = closure.document?.legacyAckAllocations;
      if (Array.isArray(rawMap)) {
        let sumMapped = 0n;
        let mapValid = legacyRetired > 0n && rawMap.length > 0;
        const seenAckIds = new Set<string>();
        const plannedShares: Array<{ target: MutableSource; shareAtoms3: bigint; terminal: boolean }> = [];

        for (const entry of rawMap) {
          if (!entry || typeof entry !== "object") {
            mapValid = false;
            break;
          }
          const rec = entry as Record<string, unknown>;
          const ackId = typeof rec.acknowledgementId === "string" ? rec.acknowledgementId.trim().toLowerCase() : "";
          const shareText = typeof rec.retiredOriginalQuantity === "string" ? rec.retiredOriginalQuantity.trim() : "";
          if (!ackId || !shareText || seenAckIds.has(ackId)) {
            mapValid = false;
            break;
          }
          seenAckIds.add(ackId);
          const target = acksOnLine.find((a) => a.ackId?.toLowerCase() === ackId);
          if (!target || target.terminallyClosed) {
            mapValid = false;
            break;
          }
          let shareAtoms3 = 0n;
          try {
            shareAtoms3 = quantityAtoms(shareText, 3, false);
          } catch {
            mapValid = false;
            break;
          }
          if (target.retiredAtoms3 + shareAtoms3 > target.initialAtoms3) {
            mapValid = false;
            break;
          }
          sumMapped += shareAtoms3;
          plannedShares.push({
            target,
            shareAtoms3,
            terminal: rec.terminal === true || (!isCheckpoint && target.retiredAtoms3 + shareAtoms3 === target.initialAtoms3),
          });
        }

        if (!mapValid || sumMapped !== legacyRetired) {
          for (const a of acksOnLine) a.legacyReconciliationRequired = true;
          legacyReconciliationRequiredLinesSet.add(canonicalLineId);
          hasInvalidLegacyClosure = true;
          break;
        }

        for (const share of plannedShares) {
          share.target.retiredAtoms3 += share.shareAtoms3;
          if (share.terminal) share.target.terminallyClosed = true;
        }
        continue;
      }

      // Unmapped legacy line-only closure: unambiguous ONLY when there is a single accepted acknowledgement on this line
      if (acksOnLine.length === 1) {
        const onlyAck = acksOnLine[0];
        const fitsCapacity =
          legacyRetired > 0n &&
          !onlyAck.terminallyClosed &&
          onlyAck.retiredAtoms3 + legacyRetired <= onlyAck.initialAtoms3;
        if (fitsCapacity) {
          onlyAck.retiredAtoms3 += legacyRetired;
          if (!isCheckpoint || onlyAck.retiredAtoms3 === onlyAck.initialAtoms3) {
            onlyAck.terminallyClosed = true;
          }
        } else {
          onlyAck.legacyReconciliationRequired = true;
          legacyReconciliationRequiredLinesSet.add(canonicalLineId);
          hasInvalidLegacyClosure = true;
        }
      } else {
        for (const a of acksOnLine) a.legacyReconciliationRequired = true;
        legacyReconciliationRequiredLinesSet.add(canonicalLineId);
      }
    }
  }

  for (const { parsed, retired } of modernClosures) {
    if (parsed.kind === "transfer_ack") {
      const target = ackByKey.get(`${parsed.ackId.toLowerCase()}:${parsed.lineId.toLowerCase()}`);
      if (target) {
        target.retiredAtoms3 += retired;
        if (!parsed.isCheckpoint) target.terminallyClosed = true;
      }
      continue;
    }
    if (parsed.kind === "mov_alloc") {
      const target = allocById.get(parsed.allocationId.toLowerCase());
      if (target) {
        target.retiredAtoms3 += retired;
        if (!parsed.isCheckpoint) target.terminallyClosed = true;
      }
      continue;
    }
    if (parsed.kind === "single_uuid") {
      const tid = parsed.targetId.toLowerCase();
      const allocTarget = allocById.get(tid);
      if (allocTarget) {
        allocTarget.retiredAtoms3 += retired;
        if (!parsed.isCheckpoint) allocTarget.terminallyClosed = true;
        continue;
      }
      const ackTargets = acksByAckId.get(tid);
      if (ackTargets && ackTargets.length === 1) {
        ackTargets[0].retiredAtoms3 += retired;
        if (!parsed.isCheckpoint) ackTargets[0].terminallyClosed = true;
        continue;
      }
      if (ackTargets && ackTargets.length > 1) {
        for (const a of ackTargets) a.legacyReconciliationRequired = true;
        hasInvalidLegacyClosure = true;
      }
    }
  }

  for (const lineKey of legacyLineClosures.keys()) {
    const acksOnLine = acksByLine.get(lineKey) ?? [];
    if (acksOnLine.some((a) => a.retiredAtoms3 > a.initialAtoms3)) {
      const canonicalLineId = acksOnLine[0]?.lineId ?? lineKey;
      for (const a of acksOnLine) a.legacyReconciliationRequired = true;
      legacyReconciliationRequiredLinesSet.add(canonicalLineId);
      hasInvalidLegacyClosure = true;
    }
  }

  const resolvedSources: ResolvedCustodyTrancheSource[] = mutable.map((s) => {
    const terminallyClosed =
      s.terminallyClosed || (!s.legacyReconciliationRequired && s.retiredAtoms3 >= s.initialAtoms3);
    const openAtoms3 =
      s.legacyReconciliationRequired || terminallyClosed || s.retiredAtoms3 >= s.initialAtoms3
        ? 0n
        : s.initialAtoms3 - s.retiredAtoms3;
    return {
      kind: s.kind,
      rawId: s.rawId,
      canonicalId: s.canonicalId,
      ackId: s.ackId,
      lineId: s.lineId,
      transferId: s.transferId,
      allocationId: s.allocationId,
      movementId: s.movementId,
      sourceTs: s.sourceTs,
      initialAtoms3: s.initialAtoms3,
      retiredAtoms3: s.retiredAtoms3,
      openAtoms3,
      initialQuantity: quantityText(s.initialAtoms3),
      retiredQuantity: quantityText(s.retiredAtoms3),
      openQuantity: quantityText(openAtoms3),
      terminallyClosed,
      legacyReconciliationRequired: s.legacyReconciliationRequired,
    };
  });

  const openTranches = resolvedSources.filter(
    (s) => !s.legacyReconciliationRequired && !s.terminallyClosed && s.openAtoms3 > 0n,
  );

  return {
    sources: resolvedSources,
    openTranches,
    legacyReconciliationRequiredLines: [...legacyReconciliationRequiredLinesSet],
    hasInvalidLegacyClosure,
  };
}

export function matchCustodyPackageSource(
  resolved: ResolvedCustodyPackageSourcesResult,
  pkgKey: string,
): ResolvedCustodyTrancheSource | null {
  const trimmed = (pkgKey ?? "").trim().toLowerCase();
  const normKey = canonicalCustodyReferenceKey(pkgKey).toLowerCase();
  const candidates: Array<{ source: ResolvedCustodyTrancheSource; exactAckMatch: boolean }> = [];

  for (const s of resolved.sources) {
    if (s.kind === "transfer_ack" && s.ackId && s.lineId) {
      const ackId = s.ackId.toLowerCase();
      const lineId = s.lineId.toLowerCase();
      const transferId = (s.transferId ?? "").toLowerCase();
      const rawId = s.rawId.toLowerCase();
      const canonicalId = s.canonicalId.toLowerCase();
      const exactAckMatch =
        trimmed === ackId ||
        trimmed === `pkg:${ackId}` ||
        trimmed === rawId ||
        trimmed === `pkg:${rawId}` ||
        trimmed === canonicalId ||
        normKey === ackId ||
        normKey === rawId;
      const lineOrTransferMatch =
        trimmed === lineId ||
        trimmed === `pkg:${lineId}` ||
        trimmed === `transfer_line:${lineId}` ||
        (Boolean(transferId) && (trimmed === transferId || trimmed === `pkg:${transferId}`)) ||
        normKey === lineId ||
        (Boolean(transferId) && normKey === transferId);
      if (exactAckMatch || lineOrTransferMatch) {
        candidates.push({ source: s, exactAckMatch });
      }
    } else if (s.kind === "mov_alloc" && s.allocationId) {
      const allocId = s.allocationId.toLowerCase();
      const movId = (s.movementId ?? "").toLowerCase();
      const canonicalId = s.canonicalId.toLowerCase();
      const exactMatch =
        trimmed === allocId ||
        trimmed === `pkg:${allocId}` ||
        trimmed === canonicalId ||
        (Boolean(movId) && trimmed === `mov:${movId}`) ||
        normKey === allocId ||
        (Boolean(movId) && normKey === movId);
      if (exactMatch) {
        candidates.push({ source: s, exactAckMatch: true });
      }
    }
  }

  if (candidates.length === 0) return null;

  invariant(
    !resolved.hasInvalidLegacyClosure && !candidates.some((c) => c.source.legacyReconciliationRequired),
    "legacy_source_reconciliation_required",
    "Legacy line-only package closure on this transfer line requires explicit source attribution before closing tranches",
  );

  let matching = candidates;
  if (matching.length > 1 && matching.every((c) => !c.exactAckMatch)) {
    const openMatching = matching.filter((c) => c.source.openAtoms3 > 0n && !c.source.terminallyClosed);
    if (openMatching.length === 1) {
      matching = openMatching;
    } else if (openMatching.length === 0) {
      matching = [matching[matching.length - 1]];
    }
  }
  invariant(
    matching.length === 1,
    "ambiguous_package_source",
    "Package identifier matches multiple custody source records; specify the exact transfer acknowledgement or allocation ID",
  );
  return matching[0].source;
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
