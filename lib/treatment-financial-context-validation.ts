import { isCurrency } from "./money";
import type { FinancialReferenceReason, TreatmentFinancialContext } from "./treatment-financial-context";

type Row = Record<string, unknown>;
const row = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nullableId = (value: unknown) => value === null || id(value);
const amount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const nonnegative = (value: unknown) => amount(value) && value >= 0;
const nullableString = (value: unknown) => value === null || typeof value === "string";
const ids = (value: unknown): value is number[] => Array.isArray(value) && value.every(id) && new Set(value).size === value.length;
const rows = (value: unknown, check: (item: Row) => boolean): value is Row[] =>
  Array.isArray(value) && value.every((item: unknown) => row(item) && check(item));
const reasons = new Set<FinancialReferenceReason>([
  "financial_review_required", "invoice_reference_missing", "invoice_lineage_unresolved",
  "legacy_coverage_unresolved", "legacy_agreement_void", "legacy_agreement_missing",
  "opening_reference_missing", "opening_allocation_unavailable", "multiple_financial_sources",
  "package_coverage_unspecified", "item_settlement_allocation_unavailable", "invoice_item_identity_conflict", "installment_schedule_missing",
]);

/** Reject malformed/stale-owner responses before any patient identity or monetary field is rendered. */
export function isTreatmentFinancialContext(value: unknown, expectedPatientId: number): value is TreatmentFinancialContext {
  if (!row(value) || !id(expectedPatientId) || value.patientId !== expectedPatientId) return false;
  if (!row(value.accountPositions)) return false;
  for (const currency of ["YER", "SAR", "USD"]) {
    const position = value.accountPositions[currency];
    if (!row(position) || !["billedMinor", "collectedMinor", "openingMinor", "dueMinor"].every((key) => amount(position[key]))) return false;
  }
  if (!rows(value.plans, (plan) => id(plan.planId) && isCurrency(plan.currency) && nonnegative(plan.valueMinor)
    && typeof plan.status === "string" && typeof plan.billingMode === "string"
    && typeof plan.hasInstallments === "boolean" && plan.valueIsDebt === false)) return false;
  const plans = new Map(value.plans.map((plan) => [plan.planId, plan]));
  if (plans.size !== value.plans.length) return false;
  if (!rows(value.documents, (document) => id(document.invoiceId) && typeof document.invoiceNumber === "string"
    && (document.status === "open" || document.status === "paid" || document.status === "cancelled") && isCurrency(document.currency)
    && nonnegative(document.grossMinor) && nonnegative(document.discountMinor) && nonnegative(document.netMinor)
    && nullableId(document.installmentPlanId) && amount(document.directlyLinkedSettledMinor)
    && document.allocatedRemainingMinor === null && document.allocationState === "not_available"
    && rows(document.settlements, (receipt) => id(receipt.receiptId) && nullableId(receipt.reversalOfId)
      && (receipt.kind === "payment" || receipt.kind === "refund")
      && isCurrency(receipt.originalCurrency) && receipt.settlementCurrency === document.currency
      && nonnegative(receipt.originalAmountMinor) && nonnegative(receipt.settlementMinor)))) return false;
  const documents = new Map(value.documents.map((document) => [document.invoiceId, document]));
  if (documents.size !== value.documents.length) return false;
  if (!rows(value.openingPositions, (opening) => isCurrency(opening.currency)
    && amount(opening.openingMinor) && amount(opening.settledMinor) && nonnegative(opening.remainingMinor)
    && opening.scope === "patient_currency" && opening.allocationState === "not_allocated" && ids(opening.agreementIds))) return false;
  const openings = new Set(value.openingPositions.map((opening) => opening.currency));
  if (openings.size !== value.openingPositions.length) return false;
  if (!rows(value.references, (reference) => {
    if (reference.patientId !== expectedPatientId || !id(reference.planId) || !id(reference.planItemId)
      || !nullableId(reference.clinicalCaseId) || !nullableId(reference.orthoCaseId)
      || !nullableString(reference.origin) || typeof reference.billingStatus !== "string"
      || !ids(reference.invoiceIds) || !Array.isArray(reference.unresolvedReasons)
      || !reference.unresolvedReasons.every((reason: unknown) => typeof reason === "string" && reasons.has(reason as FinancialReferenceReason))
      || !row(reference.clinicalPlanValue) || reference.clinicalPlanValue.isDebt !== false
      || !isCurrency(reference.clinicalPlanValue.currency) || !nonnegative(reference.clinicalPlanValue.amountMinor)
      || !row(reference.packageCoverage) || reference.packageCoverage.state !== "unspecified") return false;
    const plan = plans.get(reference.planId);
    if (!plan || plan.currency !== reference.clinicalPlanValue.currency || plan.valueMinor !== reference.clinicalPlanValue.amountMinor) return false;
    if (reference.invoiceIds.some((invoiceId) => !documents.has(invoiceId))
      && !reference.unresolvedReasons.includes("invoice_reference_missing")) return false;
    if (!rows(reference.invoiceLines, (line) => {
      if (!id(line.invoiceId) || !id(line.invoiceLineId) || !nullableId(line.planItemId)
        || !nullableString(line.sourceType) || !nullableId(line.sourceId) || !nonnegative(line.grossMinor) || !isCurrency(line.currency)) return false;
      const document = documents.get(line.invoiceId);
      return !!document && document.currency === line.currency && (reference.invoiceIds as number[]).includes(line.invoiceId)
        && (line.planItemId === reference.planItemId || line.sourceType === "plan_item" && line.sourceId === reference.planItemId);
    })) return false;
    if (!rows(reference.historicalAgreements, (agreement) => agreement.patientId === expectedPatientId
      && agreement.planItemId === reference.planItemId && id(agreement.id) && nullableId(agreement.clinicalCaseId)
      && isCurrency(agreement.currency) && nonnegative(agreement.agreedMinor) && nonnegative(agreement.previouslyPaidMinor)
      && nonnegative(agreement.remainingAtRegistrationMinor) && typeof agreement.historicalAsOf === "string"
      && /^\d{4}-\d{2}-\d{2}$/.test(agreement.historicalAsOf)
      && nullableId(agreement.openingHistoryId) && (agreement.openingEffect === "none" || agreement.openingEffect === "created" || agreement.openingEffect === "increased")
      && (agreement.status === "live" || agreement.status === "void")
      && (agreement.openingPositionCurrency === null || agreement.openingPositionCurrency === agreement.currency && openings.has(agreement.currency))
      && agreement.currentAgreementRemainingMinor === null && agreement.currentAgreementSettlementState === "not_allocated")) return false;
    const installment = reference.installment;
    if (!row(installment) || !ids(installment.planDocumentIds) || typeof installment.collectionRequiresFinancialReview !== "boolean"
      || !(installment.mode === "none" && installment.planId === null
        || (installment.mode === "historical_invoice_on_collection" || installment.mode === "unconfigured_installment_plan")
          && installment.planId === reference.planId)) return false;
    return installment.planDocumentIds.every((invoiceId) => documents.get(invoiceId)?.installmentPlanId === reference.planId);
  })) return false;
  return new Set(value.references.map((reference) => reference.planItemId)).size === value.references.length;
}
