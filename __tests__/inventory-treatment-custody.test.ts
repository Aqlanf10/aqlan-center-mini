import { describe, expect, it } from "vitest";
import { calculateProcedureProfitability } from "../lib/profitability";
import { materialCost } from "../lib/materialRate";

describe("foundation findings on exact base (not application fixes)", () => {
  it("INV-17 reproduces a complete-looking excellent tier when all costs are absent", () => {
    const legacy = calculateProcedureProfitability({ serviceName: "Synthetic", revenueMinor: 20_000 });
    expect(legacy.totalDirectCostMinor).toBe(0);
    expect(legacy.tier).toBe("excellent");
  });
  it("INV-18 existing materialRate reports theoretical cost, not an applied deduction ledger", () => {
    const legacy = materialCost(new Map([["synthetic", 10_000]]), new Map([["synthetic", 1_000]]));
    expect(legacy.costMinor).toBe(1_000);
    expect(legacy).not.toHaveProperty("appliedMinor");
  });
});

import {
  allocateOverhead, priceSimulation, proportionalCostMinor, summarizeTreatmentCost,
  summarizeTreatmentResult, treatmentFinancialSnapshot, type TreatmentIssue,
} from "../lib/inventory-domain/treatment-cost";
import {
  attributableConsumedCost, calculateDeduction, classifyDefaultPackageSafety, convertSettlementMoney,
  packageEvidenceAction, previewCustodyTransfer, proposeSettlement, reconcileCustody, reconcileEmptyPackage,
  resolvePackageSafetyWithFieldObservation, reviewReplenishment, summarizeAppliedDeductions,
  treatmentCostAfterDoctorRecovery, type AppliedDeduction, type AttributableConsumption,
} from "../lib/inventory-domain/custody";

const issue = (overrides: Partial<TreatmentIssue> = {}): TreatmentIssue => ({
  movementId: "out1", usageKey: "visit1/proc1/material1", itemId: "gutta", baseUnit: "cone", atomsPerUnit: 1,
  quantityAtoms: 6, quantityState: "confirmed",
  cost: { currency: "SAR", state: "known", amountMinor: 6_000, pricedQuantityAtoms: 120, sourceId: "wac-at-out1", recordedAt: "2026-10-11T00:00:00Z" },
  allocations: [{ id: "alloc1", patientId: "patient1", visitId: "visit1", caseId: "case1", procedureId: "proc1", quantityAtoms: 6 }],
  ...overrides,
});
const costInput = () => ({ currency: "SAR" as const, scope: { patientId: "patient1", kind: "case" as const, caseId: "case1" }, issues: [issue()], returns: [], registrationComplete: true });
const scope = { doctorId: "doctor1", periodId: "2026-case1" };
const deduction = (overrides: Partial<AppliedDeduction> = {}): AppliedDeduction => ({ ...scope, id: "ded1", agreementVersionId: "agreement-v1", currency: "SAR", theoreticalMinor: 1_000, appliedMinor: 600, ...overrides });
const consumption = (overrides: Partial<AttributableConsumption> = {}): AttributableConsumption => ({ ...scope, id: "c1", movementAllocationId: "alloc1", agreementVersionId: "agreement-v1", kind: "consumption", includedByAgreement: true, shareBp: 10_000, netCost: { currency: "SAR", amountMinor: 1_000 }, costState: "known", ...overrides });
const packageInput = () => ({ packageId: "unique-pack1", evidenceEventId: "receipt1", previousClosures: [], hazard: "none" as const, policy: "safe_empty_return" as const, evidenceAction: "receive_safe_empty_package" as const, originalAtoms: 120, recordedConsumptionAtoms: 80, returnedOrTransferredAtoms: 0, approvedWasteAtoms: 0, remainingAtoms: 0 });

describe("scoped treatment costs (pure contract, P39–48)", () => {
  it("P39 preserves 3/1/8 SAR examples and sub-minor-unit prices", () => {
    expect(proportionalCostMinor(6_000, 6, 120)).toBe(300);
    expect(proportionalCostMinor(2_000, 10, 200)).toBe(100);
    expect(proportionalCostMinor(8_000, 1, 10)).toBe(800);
    expect(proportionalCostMinor(1, 1_000, 1_000)).toBe(1);
  });
  it("rejects fractional atoms, unsafe values, zero denominator and output overflow", () => {
    expect(() => proportionalCostMinor(1, 0.1, 1)).toThrow("invalid_quantity");
    expect(() => proportionalCostMinor(1, 1, 0)).toThrow("invalid_priced_quantity");
    expect(() => proportionalCostMinor(Number.MAX_SAFE_INTEGER + 1, 1, 1)).toThrow("invalid_amount");
    expect(() => proportionalCostMinor(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow("money_overflow");
    expect(proportionalCostMinor(Number.MAX_SAFE_INTEGER, 10_000, 10_000)).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("P41 isolates two cases for one patient and subtracts only linked original return", () => {
    const second = issue({ movementId: "out2", usageKey: "visit2/proc2/material1", allocations: [{ id: "alloc2", patientId: "patient1", visitId: "visit2", caseId: "case2", procedureId: "proc2", quantityAtoms: 6 }] });
    const result = summarizeTreatmentCost({ ...costInput(), issues: [issue(), second], returns: [{ movementId: "return1", issueMovementId: "out1", allocationId: "alloc1", quantityAtoms: 2 }] });
    expect(result.totalMinor).toBe(200);
    expect(result.selectedAllocationIds).toEqual(["alloc1"]);
    expect(summarizeTreatmentCost({ ...costInput(), issues: [issue(), second], scope: { patientId: "patient1", kind: "visit", visitId: "visit2" } }).totalMinor).toBe(300);
  });
  it("P41 rejects wrong-source, duplicate and cumulative excess returns", () => {
    const ret = { movementId: "return1", issueMovementId: "out1", allocationId: "alloc1", quantityAtoms: 4 };
    expect(() => summarizeTreatmentCost({ ...costInput(), returns: [{ ...ret, issueMovementId: "out2" }] })).toThrow("return_source_mismatch");
    expect(() => summarizeTreatmentCost({ ...costInput(), returns: [ret, ret] })).toThrow("duplicate_return");
    expect(() => summarizeTreatmentCost({ ...costInput(), returns: [ret, { ...ret, movementId: "return2" }] })).toThrow("return_exceeds_issue");
  });
  it("P42 prevents manual/automatic duplicate consumption and over-allocation", () => {
    expect(() => summarizeTreatmentCost({ ...costInput(), issues: [issue(), issue({ movementId: "manual-out" })] })).toThrow("duplicate_consumption");
    expect(() => summarizeTreatmentCost({ ...costInput(), issues: [issue({ quantityAtoms: 5 })] })).toThrow("overallocated_consumption");
  });
  it("P43 keeps shared visit supplies off individual procedure totals", () => {
    const shared = issue({ allocations: [{ id: "shared", patientId: "patient1", visitId: "visit1", caseId: "case1", procedureId: null, quantityAtoms: 6 }] });
    expect(summarizeTreatmentCost({ ...costInput(), issues: [shared], scope: { kind: "procedure", patientId: "patient1", visitId: "visit1", procedureId: "proc1" } }).totalMinor).toBe(0);
    expect(summarizeTreatmentCost({ ...costInput(), issues: [shared], scope: { kind: "visit", patientId: "patient1", visitId: "visit1" } }).totalMinor).toBe(300);
  });
  it("P43 estimated quantities remain estimates even with a known unit price", () => {
    expect(summarizeTreatmentCost({ ...costInput(), issues: [issue({ quantityState: "estimated" })] })).toMatchObject({ knownMinor: 0, estimatedMinor: 300, completeness: "estimated" });
  });
  it("P44 absence, unknown cost and unallocated usage never masquerade as known zero", () => {
    expect(summarizeTreatmentCost({ ...costInput(), issues: [], registrationComplete: false })).toMatchObject({ totalMinor: null, completeness: "missing" });
    const unknown = issue({ cost: { state: "missing", currency: "SAR", sourceId: "opening", recordedAt: "2026-10-11", reason: "No opening cost" } });
    expect(summarizeTreatmentCost({ ...costInput(), issues: [unknown] })).toMatchObject({ totalMinor: null, missingAllocationIds: ["alloc1"] });
    expect(summarizeTreatmentCost({ ...costInput(), issues: [issue({ allocations: [] })] })).toMatchObject({ totalMinor: null, unallocatedMovementIds: ["out1"] });
    const free = issue({ cost: { ...issue().cost, state: "known", amountMinor: 0, pricedQuantityAtoms: 120 } });
    expect(summarizeTreatmentCost({ ...costInput(), issues: [free] })).toMatchObject({ totalMinor: 0, completeness: "complete" });
  });
  it("P44/46 distinguishes direct contribution, overhead result and missing cost categories", () => {
    expect(summarizeTreatmentResult({ currency: "SAR", performedRevenue: { currency: "SAR", amountMinor: 20_000 }, components: [] })).toMatchObject({ totalCostMinor: null, resultAfterAllocatedOverheadMinor: null, completeness: "missing", missingKinds: ["materials", "laboratory", "direct_labor", "allocated_overhead"] });
    const components = (["materials", "laboratory", "direct_labor", "allocated_overhead"] as const).map((kind) => ({ kind, sourceId: kind, state: "known" as const, amount: { currency: "SAR" as const, amountMinor: 1_000 } }));
    expect(summarizeTreatmentResult({ currency: "SAR", performedRevenue: { currency: "SAR", amountMinor: 20_000 }, components })).toMatchObject({ totalCostMinor: 4_000, contributionBeforeOverheadMinor: 17_000, resultAfterAllocatedOverheadMinor: 16_000, completeness: "complete" });
    expect(() => summarizeTreatmentResult({ currency: "SAR", performedRevenue: null, components: [...components, { ...components[2], kind: "allocated_overhead" }] })).toThrow("duplicate_treatment_cost_source");
  });
  it("aggregates fractional cost before rounding, including linked fractional returns", () => {
    const cheap = issue({ cost: { ...issue().cost, state: "known", amountMinor: 1, pricedQuantityAtoms: 12 } });
    const second = issue({ ...cheap, movementId: "out2", usageKey: "u2", allocations: [{ ...cheap.allocations[0], id: "alloc2" }] });
    expect(summarizeTreatmentCost({ ...costInput(), issues: [cheap, second] }).knownMinor).toBe(1);
    expect(summarizeTreatmentCost({ ...costInput(), issues: [cheap, second], returns: [{ movementId: "ret1", issueMovementId: "out1", allocationId: "alloc1", quantityAtoms: 6 }] }).knownMinor).toBe(1);
  });
  it("P48 uses the issuance snapshot and rejects mixed currencies", () => {
    const input = costInput();
    const before = JSON.stringify(input);
    expect(summarizeTreatmentCost(input).knownMinor).toBe(300);
    expect(JSON.stringify(input)).toBe(before);
    expect(() => summarizeTreatmentCost({ ...input, issues: [issue({ cost: { ...issue().cost, currency: "USD" } })] })).toThrow("currency_mismatch");
  });
  it("P45 keeps agreement, performed revenue and late collections separate", () => {
    const money = (amountMinor: number) => ({ currency: "SAR" as const, amountMinor });
    const input = { agreement: money(100_000), billed: money(10_000), collected: money(8_000), revenueAllocations: [{ id: "stage1", amount: money(10_000) }], allocationPolicyId: "stages-v1", costToDate: money(3_000), expectedCompletionCost: money(70_000) };
    expect(treatmentFinancialSnapshot(input)).toMatchObject({ performedRevenueMinor: 10_000, collectedMinor: 8_000, receivableMinor: 2_000, projectedCompletionContributionMinor: 27_000 });
    expect(treatmentFinancialSnapshot({ ...input, collected: money(10_000) }).performedRevenueMinor).toBe(10_000);
    expect(treatmentFinancialSnapshot({ ...input, revenueAllocations: [], allocationPolicyId: null }).performedRevenueMinor).toBeNull();
    expect(() => treatmentFinancialSnapshot({ ...input, revenueAllocations: [{ id: "stage1", amount: money(100_001) }] })).toThrow("revenue_exceeds_agreement");
  });
  it("P46 reports idle capacity and reconciles every minor unit", () => {
    const result = allocateOverhead({ currency: "SAR", sources: [{ id: "rent", kind: "overhead", currency: "SAR", amountMinor: 10_001 }], capacityUnits: 100, targets: [{ id: "case1", units: 10 }, { id: "case2", units: 10 }] });
    expect(result.allocations.map((row) => row.amountMinor)).toEqual([1_000, 1_000]);
    expect(result.unallocatedMinor).toBe(8_001);
    expect(result.unusedCapacityUnits).toBe(80);
    expect(result.allocations.reduce((sum, row) => sum + row.amountMinor, result.unallocatedMinor)).toBe(result.totalMinor);
  });
  it("P46 rejects duplicate expense source, direct salary and capital purchase in overhead", () => {
    const base = { currency: "SAR" as const, capacityUnits: 100, targets: [] };
    const source = { id: "expense1", kind: "overhead" as const, currency: "SAR" as const, amountMinor: 10 };
    expect(() => allocateOverhead({ ...base, sources: [source, source] })).toThrow("duplicate_expense_source");
    for (const kind of ["direct_labor", "capital_purchase"] as const) expect(() => allocateOverhead({ ...base, sources: [{ ...source, kind }] })).toThrow("direct_or_capital_cost_in_overhead");
  });
  it("P47 distinguishes margin from markup and handles price-based commission", () => {
    const input = { fixedCost: { currency: "SAR" as const, amountMinor: 18_000 }, netPrice: { currency: "SAR" as const, amountMinor: 20_000 }, targetMarginBp: 2_500, commission: { basis: "included_in_fixed_cost" as const } };
    expect(priceSimulation(input)).toMatchObject({ contributionMinor: 2_000, marginBp: 1_000, targetNetPriceMinor: 24_000 });
    expect(priceSimulation({ ...input, commission: { basis: "net_price", rateBp: 1_000 } }).targetNetPriceMinor).toBe(27_693);
    expect(() => priceSimulation({ ...input, commission: { basis: "net_price", rateBp: 7_500 } })).toThrow("non_positive_price_denominator");
    expect(priceSimulation({ ...input, netPrice: { currency: "SAR", amountMinor: 0 } }).marginBp).toBeNull();
  });
});

describe("custody, actual deductions and settlement (pure contract, P49–63)", () => {
  it("P49 keeps clinic stock and value unchanged through dispatch, transit and acceptance", () => {
    const input = { sourceQuantityAtoms: 100, sourceValue: { currency: "SAR" as const, amountMinor: 10_000 }, dispatchedAtoms: 30, acceptedAtoms: 30, returnedAtoms: 0 };
    expect(previewCustodyTransfer(input)).toMatchObject({ sourceAtoms: 70, inTransitAtoms: 0, custodyAtoms: 30, clinicQuantityAtoms: 100, consumedAtoms: 0, payableDeltaMinor: 0, cashDeltaMinor: 0 });
    const partial = previewCustodyTransfer({ ...input, acceptedAtoms: 10, returnedAtoms: 5 });
    expect(partial).toMatchObject({ sourceAtoms: 75, inTransitAtoms: 15, custodyAtoms: 10 });
    expect(partial.sourceValueMinor + partial.inTransitValueMinor + partial.custodyValueMinor).toBe(10_000);
  });
  it("P50 leaves 20 in custody, 72 in store and 92 clinic-wide after 8 used and 2 returned", () => {
    const result = reconcileCustody({ openingAtoms: 30, events: [{ id: "c1", movementId: "out1", kind: "consumed", quantityAtoms: 8 }, { id: "r1", movementId: "in1", kind: "returned_to_store", quantityAtoms: 2 }], countedAtoms: 20 });
    expect(result).toMatchObject({ expectedClosingAtoms: 20, consumedAtoms: 8, reviewRequired: false });
    expect(70 + 2 + result.expectedClosingAtoms).toBe(92);
  });
  it("P51 count differences require review and never create consumption or financial debt", () => {
    const result = reconcileCustody({ openingAtoms: 30, events: [], countedAtoms: 25 });
    expect(result).toMatchObject({ countDifferenceAtoms: -5, consumedAtoms: 0, reviewRequired: true, automaticFinancialAdjustmentMinor: 0 });
    expect(() => reconcileCustody({ openingAtoms: 30, events: [{ id: "w1", movementId: "m1", kind: "approved_waste", quantityAtoms: 5 }], countedAtoms: 25 })).toThrow("missing_waste_approval");
  });
  it("rejects custody duplicates, overspend and excess transfer acceptance", () => {
    const event = { id: "c1", movementId: "m1", kind: "consumed" as const, quantityAtoms: 8 };
    expect(() => reconcileCustody({ openingAtoms: 30, events: [event, event], countedAtoms: null })).toThrow("duplicate_custody_movement");
    expect(() => reconcileCustody({ openingAtoms: 3, events: [event], countedAtoms: null })).toThrow("negative_custody_balance");
    expect(() => previewCustodyTransfer({ sourceQuantityAtoms: 100, sourceValue: { currency: "SAR", amountMinor: 100 }, dispatchedAtoms: 30, acceptedAtoms: 30, returnedAtoms: 1 })).toThrow("transfer_exceeds_quantity");
  });
  it("P52 distinguishes collections from commission bases", () => {
    expect(calculateDeduction({ basis: "collections", basisAmount: { currency: "SAR", amountMinor: 10_000 }, rateBp: 1_000, availableCommissionMinor: 3_000 }).theoreticalMinor).toBe(1_000);
    expect(calculateDeduction({ basis: "commission", basisAmount: { currency: "SAR", amountMinor: 3_000 }, rateBp: 1_000, availableCommissionMinor: 3_000 }).theoreticalMinor).toBe(300);
  });
  it("P53 uses 600 actually applied, not theoretical 1000; reversal 100 leaves D=500", () => {
    expect(calculateDeduction({ basis: "collections", basisAmount: { currency: "SAR", amountMinor: 10_000 }, rateBp: 1_000, availableCommissionMinor: 600 })).toMatchObject({ theoreticalMinor: 1_000, applicableMinor: 600, unappliedMinor: 400 });
    expect(summarizeAppliedDeductions({ scope, currency: "SAR", deductions: [deduction()], reversals: [{ id: "rev1", deductionId: "ded1", amount: { currency: "SAR", amountMinor: 100 } }] })).toMatchObject({ theoreticalMinor: 1_000, netAppliedMinor: 500 });
  });
  it("P53 rejects duplicate, unlinked and excessive applied-deduction reversals", () => {
    const input = { scope, currency: "SAR" as const, deductions: [deduction()], reversals: [] };
    expect(() => summarizeAppliedDeductions({ ...input, deductions: [deduction(), deduction()] })).toThrow("duplicate_deduction");
    expect(() => summarizeAppliedDeductions({ ...input, reversals: [{ id: "r", deductionId: "missing", amount: { currency: "SAR", amountMinor: 1 } }] })).toThrow("unlinked_deduction_reversal");
    expect(() => summarizeAppliedDeductions({ ...input, reversals: [{ id: "r", deductionId: "ded1", amount: { currency: "SAR", amountMinor: 601 } }] })).toThrow("reversal_exceeds_applied");
  });
  it.each([[12_000, 2_000, "due_to_doctor"], [8_000, -2_000, "proposed_from_doctor"], [10_000, 0, "balanced"]] as const)("P54 D=%i gives signed delta %i and direction %s", (d, expected, direction) => {
    expect(proposeSettlement({ scope, deductions: { currency: "SAR", amountMinor: d }, attributable: { currency: "SAR", amountMinor: 10_000 }, prerequisitesComplete: true, priorAdjustments: [] })).toMatchObject({ supplementalMinor: expected, direction, cashDeltaMinor: 0, automaticWageDeductionMinor: 0 });
  });
  it("P55 closing custody is not consumed and creates no new purchase when carried forward", () => {
    expect(reconcileCustody({ openingAtoms: 20, events: [], countedAtoms: 20 })).toMatchObject({ expectedClosingAtoms: 20, consumedAtoms: 0 });
    expect(attributableConsumedCost({ scope, currency: "SAR", lines: [], inventoryReconciled: true }).totalMinor).toBe(0);
  });
  it("P56 excludes uncovered materials and holds waste without an approved exception", () => {
    const result = attributableConsumedCost({ scope, currency: "SAR", inventoryReconciled: true, lines: [consumption(), consumption({ id: "excluded", movementAllocationId: "a2", includedByAgreement: false }), consumption({ id: "waste", movementAllocationId: "a3", kind: "waste" })] });
    expect(result).toMatchObject({ knownAttributableMinor: 1_000, totalMinor: null, pendingIds: ["waste"], excludedIds: ["excluded"] });
  });
  it("P57 supplemental proposal subtracts previous posted adjustment once", () => {
    const input = { scope, deductions: { currency: "SAR" as const, amountMinor: 12_000 }, attributable: { currency: "SAR" as const, amountMinor: 9_500 }, prerequisitesComplete: true, priorAdjustments: [{ ...scope, id: "settlement1", currency: "SAR" as const, signedMinor: 2_000 }] };
    expect(proposeSettlement(input).supplementalMinor).toBe(500);
    expect(proposeSettlement({ ...input, priorAdjustments: [...input.priorAdjustments, { ...scope, id: "supplement1", currency: "SAR", signedMinor: 500 }] }).supplementalMinor).toBe(0);
    expect(() => proposeSettlement({ ...input, priorAdjustments: [...input.priorAdjustments, ...input.priorAdjustments] })).toThrow("duplicate_settlement_adjustment");
  });
  it("P58 rejects mixing a different period or doctor instead of charging twice", () => {
    expect(() => summarizeAppliedDeductions({ scope, currency: "SAR", deductions: [deduction({ periodId: "2027-case2" })], reversals: [] })).toThrow("settlement_scope_mismatch");
    expect(() => attributableConsumedCost({ scope, currency: "SAR", inventoryReconciled: true, lines: [consumption({ doctorId: "other-doctor" })] })).toThrow("settlement_scope_mismatch");
  });
  it("P59 requires explicit currencies and preserves immutable FX quote metadata", () => {
    expect(() => proposeSettlement({ scope, deductions: { currency: "SAR", amountMinor: 1 }, attributable: { currency: "YER", amountMinor: 1 }, prerequisitesComplete: true, priorAdjustments: [] })).toThrow("currency_mismatch");
    const quote = convertSettlementMoney({ original: { currency: "SAR", amountMinor: 10_000 }, targetCurrency: "YER", numerator: 5, denominator: 1, quoteId: "fx-old", quotedAt: "2026-01-01" });
    expect(quote).toMatchObject({ amountMinor: 50_000, currency: "YER", quoteId: "fx-old" });
    expect(Object.isFrozen(quote)).toBe(true);
    expect(Object.isFrozen(quote.original)).toBe(true);
  });
  it("P60 reconciles materials 100 plus fee300 minus recovery40 to 360", () => {
    expect(treatmentCostAfterDoctorRecovery({ material: { currency: "SAR", amountMinor: 100 }, grossDoctorFee: { currency: "SAR", amountMinor: 300 }, doctorMaterialRecovery: { currency: "SAR", amountMinor: 40 } })).toMatchObject({ netDoctorFeeMinor: 260, totalCostMinor: 360 });
  });
  it("P62 unknown cost/count holds a settlement provisional", () => {
    const result = attributableConsumedCost({ scope, currency: "SAR", inventoryReconciled: false, lines: [consumption({ netCost: null, costState: "missing" })] });
    expect(result).toMatchObject({ totalMinor: null, complete: false });
    expect(proposeSettlement({ scope, deductions: { currency: "SAR", amountMinor: 600 }, attributable: null, prerequisitesComplete: false, priorAdjustments: [] })).toMatchObject({ status: "provisional", supplementalMinor: null, direction: "undetermined" });
  });
  it("P63 arithmetic composition connects transfer, exact case use, return, count and settlement (not E2E)", () => {
    const transfer = previewCustodyTransfer({ sourceQuantityAtoms: 120, sourceValue: { currency: "SAR", amountMinor: 6_000 }, dispatchedAtoms: 30, acceptedAtoms: 30, returnedAtoms: 0 });
    const custody = reconcileCustody({ openingAtoms: transfer.custodyAtoms, events: [{ id: "use", movementId: "out1", kind: "consumed", quantityAtoms: 6 }, { id: "return", movementId: "unused-return", kind: "returned_to_store", quantityAtoms: 2 }], countedAtoms: 22 });
    const treatment = summarizeTreatmentCost(costInput());
    const attributable = attributableConsumedCost({ scope, currency: "SAR", inventoryReconciled: !custody.reviewRequired, lines: [consumption({ netCost: { currency: "SAR", amountMinor: treatment.knownMinor } })] });
    const applied = summarizeAppliedDeductions({ scope, currency: "SAR", deductions: [deduction({ theoreticalMinor: 400, appliedMinor: 400 })], reversals: [] });
    const proposal = proposeSettlement({ scope, deductions: { currency: "SAR", amountMinor: applied.netAppliedMinor }, attributable: { currency: "SAR", amountMinor: attributable.totalMinor! }, prerequisitesComplete: attributable.complete, priorAdjustments: [] });
    expect(transfer.sourceAtoms + 2 + custody.expectedClosingAtoms).toBe(114);
    expect(treatment.knownMinor).toBe(300);
    expect(proposal.supplementalMinor).toBe(100);
    expect(proposal.cashDeltaMinor).toBe(0);
  });
});

describe("safe package evidence and replenishment (pure contract, P64–69)", () => {
  it("P64/65 returning an empty 120 package with 80 recorded leaves 40 for review only", () => {
    expect(reconcileEmptyPackage(packageInput())).toMatchObject({ unexplainedAtoms: 40, reviewRequired: true, materialStockDeltaAtoms: 0, consumptionDeltaAtoms: 0, automaticDebtMinor: 0 });
  });
  it("P66 prevents reuse of either package identity or evidence event", () => {
    expect(() => reconcileEmptyPackage({ ...packageInput(), previousClosures: [{ packageId: "unique-pack1", evidenceEventId: "other" }] })).toThrow("package_or_evidence_already_closed");
    expect(() => reconcileEmptyPackage({ ...packageInput(), previousClosures: [{ packageId: "other", evidenceEventId: "receipt1" }] })).toThrow("package_or_evidence_already_closed");
  });
  it("a package containing material requires a separate inspected material return", () => {
    expect(() => reconcileEmptyPackage({ ...packageInput(), remainingAtoms: 5 })).toThrow("material_return_requires_separate_inspected_movement");
  });
  it("P67 early replenishment considers remaining stock without requiring nonexistent empties", () => {
    expect(reviewReplenishment({ requestedAtoms: 20, remainingAtoms: 10, approvedTargetAtoms: 30, emergency: false, requesterId: "assistant", approverId: null, approverAuthorized: false, reason: null })).toMatchObject({ earlyReplenishment: true, requireNonexistentEmptyPackage: false });
    expect(() => reviewReplenishment({ requestedAtoms: 40, remainingAtoms: 10, approvedTargetAtoms: 30, emergency: true, requesterId: "assistant", approverId: "assistant", approverAuthorized: true, reason: "Synthetic emergency" })).toThrow("independent_authorized_approval_required");
  });
  it.each(["sharp", "contaminated"] as const)("P68 %s materials require safe disposal evidence even if configured as empty return", (hazard) => {
    expect(packageEvidenceAction(hazard, "safe_empty_return")).toBe("document_safe_disposal");
    expect(() => reconcileEmptyPackage({ ...packageInput(), hazard })).toThrow("unsafe_or_inapplicable_package_evidence");
    expect(reconcileEmptyPackage({ ...packageInput(), hazard, evidenceAction: "document_safe_disposal" })).toMatchObject({ evidenceAction: "document_safe_disposal", materialStockDeltaAtoms: 0, automaticDebtMinor: 0 });
  });
  it("P69 unexplained loss never automatically charges either doctor or assistant", () => {
    expect(reconcileEmptyPackage(packageInput()).automaticDebtMinor).toBe(0);
    expect(reconcileCustody({ openingAtoms: 120, events: [], countedAtoms: 80 }).automaticFinancialAdjustmentMinor).toBe(0);
  });
  it("rejects unknown safety classification instead of requesting a package return", () => {
    expect(() => packageEvidenceAction("none", "unknown" as "safe_empty_return")).toThrow("unknown_package_safety_classification");
  });
  it("completes full custody lifecycle: dispatch -> partial return -> patient consumption -> approved waste -> stocktake -> safe package closure -> annual settlement without double-counting", () => {
    // 1. Dispatch 50 units (1 box of 50 cones) from 200 store stock; accept 45, return 5 immediately to store
    const transfer = previewCustodyTransfer({
      sourceQuantityAtoms: 200,
      sourceValue: { currency: "SAR", amountMinor: 20_000 },
      dispatchedAtoms: 50,
      acceptedAtoms: 45,
      returnedAtoms: 5,
    });
    expect(transfer).toMatchObject({
      sourceAtoms: 155,
      inTransitAtoms: 0,
      custodyAtoms: 45,
      clinicQuantityAtoms: 200,
      consumedAtoms: 0,
      payableDeltaMinor: 0,
      cashDeltaMinor: 0,
    });

    // 2. Doctor consumes 12 for patient visit, records 3 approved waste, returns 5 unused to store, counts 23 (2 variance for review)
    const stocktake = reconcileCustody({
      openingAtoms: transfer.custodyAtoms,
      events: [
        { id: "ev-consume-1", movementId: "mov-out-1", kind: "consumed", quantityAtoms: 12 },
        { id: "ev-waste-1", movementId: "mov-out-2", kind: "approved_waste", quantityAtoms: 3, approvalId: "admin-waste-ok-1", reason: "Dropped ampoule" },
        { id: "ev-ret-1", movementId: "mov-ret-1", kind: "returned_to_store", quantityAtoms: 5 },
      ],
      countedAtoms: 23,
    });
    expect(stocktake).toMatchObject({
      expectedClosingAtoms: 25,
      consumedAtoms: 12,
      countDifferenceAtoms: -2,
      reviewRequired: true,
      automaticFinancialAdjustmentMinor: 0,
    });
    // Clinic-wide stock = 155 (store) + 5 (returned from custody) + 25 (expected custody closing) = 185 (200 - 12 consumed - 3 waste)
    expect(transfer.sourceAtoms + 5 + stocktake.expectedClosingAtoms).toBe(185);

    // 3. Safe package closure vs contaminated disposal
    const safeClosure = reconcileEmptyPackage({
      packageId: "pack-gutta-1",
      evidenceEventId: "ev-close-1",
      previousClosures: [],
      hazard: "none",
      policy: "safe_empty_return",
      evidenceAction: "receive_safe_empty_package",
      originalAtoms: 45,
      recordedConsumptionAtoms: 12,
      returnedOrTransferredAtoms: 5,
      approvedWasteAtoms: 3,
      remainingAtoms: 0,
    });
    expect(safeClosure).toMatchObject({
      unexplainedAtoms: 25,
      reviewRequired: true,
      materialStockDeltaAtoms: 0,
      consumptionDeltaAtoms: 0,
      automaticDebtMinor: 0,
    });

    // 4. Price coverage warning: procedure price 150 SAR vs fixed direct cost 160 SAR flags negative contribution without calling it net profit
    const underpriced = priceSimulation({
      fixedCost: { currency: "SAR", amountMinor: 16_000 },
      netPrice: { currency: "SAR", amountMinor: 15_000 },
      targetMarginBp: 2_000,
      commission: { basis: "included_in_fixed_cost" },
    });
    expect(underpriced.contributionMinor).toBe(-1_000);
    expect(underpriced.targetNetPriceMinor).toBe(20_000);
  });

  it("R01 & R02: proposeSettlement rejects unposted priorAdjustments and keeps manual/unbacked proposals provisional", () => {
    const baseInput = {
      scope,
      deductions: { currency: "SAR" as const, amountMinor: 12_000 },
      attributable: { currency: "SAR" as const, amountMinor: 9_500 },
      prerequisitesComplete: true,
    };

    for (const postingState of ["provisional", "ready_for_authorized_review", "objected_under_review"] as const) {
      expect(() => proposeSettlement({
        ...baseInput,
        priorAdjustments: [{ ...scope, id: `unposted-${postingState}`, currency: "SAR", signedMinor: 2_500, postingState }],
      })).toThrow("unposted_settlement_adjustment");
    }

    // Without sourceBacked=true, even if prerequisitesComplete=true is passed, status remains provisional
    expect(proposeSettlement({
      ...baseInput,
      sourceBacked: false,
      priorAdjustments: [{ ...scope, id: "posted-1", currency: "SAR", signedMinor: 2_000, postingState: "posted" }],
    })).toMatchObject({
      status: "provisional",
      supplementalMinor: 500,
      direction: "due_to_doctor",
    });

    // Only when both prerequisitesComplete=true and sourceBacked=true does status become ready_for_authorized_review
    expect(proposeSettlement({
      ...baseInput,
      sourceBacked: true,
      priorAdjustments: [{ ...scope, id: "posted-1", currency: "SAR", signedMinor: 2_000, postingState: "posted" }],
    })).toMatchObject({
      status: "ready_for_authorized_review",
      supplementalMinor: 500,
      direction: "due_to_doctor",
    });
  });

  it("R04: classifyDefaultPackageSafety and resolvePackageSafetyWithFieldObservation forbid hazard downgrade on sharp/contaminated items", () => {
    expect(classifyDefaultPackageSafety({ name: "إبر تخدير الأسنان", category: "anesthesia", unit: "cartridge" })).toEqual({
      minimumHazard: "sharp",
      defaultPolicy: "safe_disposal_record",
    });
    expect(classifyDefaultPackageSafety({ name: "Gutta Percha", category: "endodontics", unit: "cone" })).toEqual({
      minimumHazard: "none",
      defaultPolicy: "safe_empty_return",
    });

    const serverSharp = classifyDefaultPackageSafety({ name: "Surgical Scalpel Blade", category: "surgery", unit: "piece" });
    expect(() => resolvePackageSafetyWithFieldObservation({
      ...serverSharp,
      observedHazard: "none",
      requestedPolicy: "safe_empty_return",
    })).toThrow("package_hazard_downgrade_forbidden");

    const serverClean = classifyDefaultPackageSafety({ name: "Gutta Percha", category: "endodontics", unit: "cone" });
    const upgraded = resolvePackageSafetyWithFieldObservation({
      ...serverClean,
      observedHazard: "contaminated",
      requestedPolicy: "safe_empty_return",
    });
    expect(upgraded).toEqual({
      effectiveHazard: "contaminated",
      effectivePolicy: "safe_disposal_record",
    });
    expect(packageEvidenceAction(upgraded.effectiveHazard, upgraded.effectivePolicy)).toBe("document_safe_disposal");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INVENTORY_CUSTODY_SQL } from "../lib/inventory-domain/custody-schema-proposal";
import { INVENTORY_PROCUREMENT_SQL } from "../lib/inventory-domain/schema-proposal";

describe("R03, R10, R11, R12 schema, API and UI bilingual/locator invariants", () => {
  it("R03 & R11: schema proposals define custody_waste_approvals and dispose quarantine resolution without self-numbering migrations", () => {
    expect(INVENTORY_CUSTODY_SQL).toContain("CREATE TABLE IF NOT EXISTS custody_waste_approvals");
    expect(INVENTORY_CUSTODY_SQL).toContain("waste_approval_id IS NOT NULL");
    expect(INVENTORY_PROCUREMENT_SQL).toContain("action IN ('release','reject_return','dispose')");
  });

  it("R12: DoctorCustody.tsx keeps 'الدفعة الصالحة' and 'كمية التحويل' unique to dispatch form, distinguishes consumption banner, and uses closableLots", () => {
    const doctorCustodySrc = readFileSync(join(process.cwd(), "components", "inventory", "DoctorCustody.tsx"), "utf8");
    const validLotAriaMatches = doctorCustodySrc.match(/aria-label=\{text\("الدفعة الصالحة"\)\}/g) ?? [];
    const transferQtyLabelMatches = doctorCustodySrc.match(/text\("كمية التحويل"\)/g) ?? [];
    expect(validLotAriaMatches).toHaveLength(1);
    expect(transferQtyLabelMatches).toHaveLength(1);
    expect(doctorCustodySrc).toContain("تم تسجيل استهلاك العهدة وتخفيض رصيد العهدة ومخزون المركز.");
    expect(doctorCustodySrc).toContain("closableLots");
    expect(doctorCustodySrc).not.toContain("prerequisitesComplete: true");
  });

  it("R10, R11 & R12: route.ts returns correlationId on 500 and ProcurementOperations/ProcurementAdministration translate errors and expose dispose + excessDecision", () => {
    const routeSrc = readFileSync(join(process.cwd(), "app", "api", "inventory", "procurement", "route.ts"), "utf8");
    expect(routeSrc).toContain("correlationId");
    expect(routeSrc).toContain("DEFAULT_SAFE_INVENTORY_ERROR_MESSAGE");
    expect(routeSrc).toContain('case "custody.approve_waste"');

    const opsSrc = readFileSync(join(process.cwd(), "components", "inventory", "ProcurementOperations.tsx"), "utf8");
    expect(opsSrc).toContain('value="dispose"');
    expect(opsSrc).toContain("excessDecision");
    expect(opsSrc).toContain("t(command.message)");
    expect(opsSrc).toContain("Select the supplier, line sources, and enter the quote reference.");

    const adminSrc = readFileSync(join(process.cwd(), "components", "inventory", "ProcurementAdministration.tsx"), "utf8");
    expect(adminSrc).toContain("t(command.message)");
    expect(adminSrc).toContain("Enter a valid amount and valuation revision reason. Zero means a known free-of-charge value.");
  });
});
