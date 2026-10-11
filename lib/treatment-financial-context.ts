import {
  invoiceNet, patientBalancesByCurrency, settlePaymentMinor, toCurrencyPaymentLikes,
  type Currency, type PaymentLike,
} from "./money";

/** A reference projection only. It neither posts money nor authorizes a clinical/billing action. */
export interface TreatmentReferenceIdentity {
  patientId: number;
  planId: number;
  planItemId: number;
  clinicalCaseId: number | null;
  orthoCaseId: number | null;
}

export interface FinancialPlanEvidence {
  id: number; patientId: number; currency: Currency; totalMinor: number; status: string;
  billingMode: string; hasInstallments: boolean;
}
export interface FinancialItemEvidence extends TreatmentReferenceIdentity {
  origin: string | null; originInvoiceId: number | null; billedInvoiceId: number | null;
  billingStatus: string; financialReviewRequired: boolean; hasInvoiceLineage: boolean;
  hasLegacyLineage: boolean; legacyCoverageState: string;
}
export interface FinancialInvoiceEvidence {
  id: number; patientId: number; planId: number | null; invoiceNumber: string;
  currency: Currency; totalMinor: number; discountMinor: number; status: "open" | "paid" | "cancelled";
}
export interface FinancialLineEvidence {
  id: number; invoiceId: number; planItemId: number | null;
  sourceType: string | null; sourceId: number | null; totalMinor: number;
}
export interface FinancialReceiptEvidence extends PaymentLike {
  id: number; patientId: number; invoiceId: number | null; planId: number | null;
  openingCurrency: Currency | null; reversalOfId: number | null;
}
export interface FinancialLegacyEvidence {
  id: number; patientId: number; planItemId: number; clinicalCaseId: number | null;
  currency: Currency; agreedMinor: number; previouslyPaidMinor: number; remainingAtRegistrationMinor: number;
  historicalAsOf: string; openingHistoryId: number | null; openingEffect: string; status: "live" | "void";
}
export interface FinancialOpeningEvidence {
  currency: Currency; openingMinor: number; settledMinor: number; remainingMinor: number;
}
export interface TreatmentFinancialSnapshot {
  patientId: number;
  plans: FinancialPlanEvidence[];
  items: FinancialItemEvidence[];
  invoices: FinancialInvoiceEvidence[];
  lines: FinancialLineEvidence[];
  receipts: FinancialReceiptEvidence[];
  legacyAgreements: FinancialLegacyEvidence[];
  openings: FinancialOpeningEvidence[];
}

export type FinancialReferenceReason =
  | "financial_review_required" | "invoice_reference_missing" | "invoice_lineage_unresolved"
  | "legacy_coverage_unresolved" | "legacy_agreement_void" | "legacy_agreement_missing"
  | "opening_reference_missing" | "opening_allocation_unavailable" | "multiple_financial_sources"
  | "package_coverage_unspecified" | "item_settlement_allocation_unavailable" | "invoice_item_identity_conflict" | "installment_schedule_missing";

/** Document money is shown once in documents, never copied into item totals or a second ledger. */
export function projectTreatmentFinancialReferences(snapshot: TreatmentFinancialSnapshot) {
  const patientId = snapshot.patientId;
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw new Error("Invalid patient identity");
  for (const row of [...snapshot.plans, ...snapshot.items, ...snapshot.invoices, ...snapshot.receipts, ...snapshot.legacyAgreements]) {
    if (row.patientId !== patientId) throw new Error("Cross-patient financial reference");
  }
  const plans = new Map(snapshot.plans.map((plan) => [plan.id, plan]));
  const invoices = new Map(snapshot.invoices.map((invoice) => [invoice.id, invoice]));
  const items = new Map(snapshot.items.map((item) => [item.planItemId, item]));
  const invoiceCurrencies = new Map(snapshot.invoices.map((invoice) => [invoice.id, { patientId, currency: invoice.currency }]));
  const planCurrencies = new Map(snapshot.plans.map((plan) => [plan.id, { patientId, currency: plan.currency }]));
  const openingByCurrency = Object.fromEntries(snapshot.openings.map((opening) => [opening.currency, opening.openingMinor]));
  // Exactly the same native-currency engine used by patient ledger/report readers.
  const accountPositions = patientBalancesByCurrency(
    snapshot.invoices.map((invoice) => ({ ...invoice, baseCurrency: invoice.currency })),
    toCurrencyPaymentLikes(patientId, snapshot.receipts, invoiceCurrencies, planCurrencies),
    openingByCurrency,
  );
  for (const item of snapshot.items) if (!plans.has(item.planId)) throw new Error("Missing clinical plan");
  for (const line of snapshot.lines) if (!invoices.has(line.invoiceId)) throw new Error("Missing invoice document");
  for (const agreement of snapshot.legacyAgreements) if (!items.has(agreement.planItemId)) throw new Error("Missing historical item");

  const documents = snapshot.invoices.map((invoice) => {
    const receipts = snapshot.receipts.filter((receipt) => receipt.invoiceId === invoice.id);
    const settlements = receipts.map((receipt) => ({
      receiptId: receipt.id, reversalOfId: receipt.reversalOfId, kind: receipt.kind ?? "payment",
      originalCurrency: receipt.currency, originalAmountMinor: receipt.amountMinor,
      settlementCurrency: invoice.currency, settlementMinor: settlePaymentMinor(receipt, invoice.currency),
    }));
    return {
      invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, status: invoice.status,
      currency: invoice.currency, grossMinor: invoice.totalMinor, discountMinor: invoice.discountMinor,
      netMinor: invoiceNet(invoice), installmentPlanId: invoice.planId,
      settlements,
      directlyLinkedSettledMinor: settlements.reduce((sum, receipt) => sum + (receipt.kind === "refund" ? -1 : 1) * receipt.settlementMinor, 0),
      // Account credits, original-invoice receipts retained after correction and FIFO commissions
      // do not constitute a persisted allocation to this document or to its treatment items.
      allocatedRemainingMinor: null,
      allocationState: "not_available" as const,
    };
  });

  const references = snapshot.items.map((item) => {
    const plan = plans.get(item.planId)!;
    const reasons = new Set<FinancialReferenceReason>();
    const lines = snapshot.lines.filter((line) => line.planItemId === item.planItemId
      || (line.sourceType === "plan_item" && line.sourceId === item.planItemId));
    const documentIds = [...new Set([
      ...lines.map((line) => line.invoiceId), item.originInvoiceId, item.billedInvoiceId,
    ].filter((id): id is number => id !== null))].sort((a, b) => a - b);
    const legacyAgreements = snapshot.legacyAgreements.filter((agreement) => agreement.planItemId === item.planItemId);
    if (item.financialReviewRequired) reasons.add("financial_review_required");
    if (documentIds.some((id) => !invoices.has(id))) reasons.add("invoice_reference_missing");
    if (lines.some((line) => line.sourceType === "plan_item" && line.planItemId !== null
      && line.sourceId !== line.planItemId)) reasons.add("invoice_item_identity_conflict");
    if (item.hasInvoiceLineage && !lines.length) reasons.add("invoice_lineage_unresolved");
    if (item.hasLegacyLineage && !legacyAgreements.length) reasons.add("legacy_agreement_missing");
    if (item.hasLegacyLineage && item.legacyCoverageState !== "verified") reasons.add("legacy_coverage_unresolved");
    if (legacyAgreements.some((agreement) => agreement.status === "void")) reasons.add("legacy_agreement_void");
    if (legacyAgreements.length && documentIds.length) reasons.add("multiple_financial_sources");
    if (documentIds.length) reasons.add("item_settlement_allocation_unavailable");
    if (item.orthoCaseId !== null) reasons.add("package_coverage_unspecified");
    const historical = legacyAgreements.map((agreement) => {
      const opening = snapshot.openings.find((position) => position.currency === agreement.currency);
      const hasOpening = agreement.openingEffect !== "none";
      if (agreement.status === "live" && hasOpening && !opening) reasons.add("opening_reference_missing");
      if (agreement.status === "live" && hasOpening) reasons.add("opening_allocation_unavailable");
      return {
        ...agreement,
        // This is a link to the patient/currency position below, not this agreement's allocated balance.
        openingPositionCurrency: hasOpening && opening ? agreement.currency : null,
        currentAgreementRemainingMinor: null,
        currentAgreementSettlementState: "not_allocated" as const,
      };
    });
    const planDocuments = snapshot.invoices.filter((invoice) => invoice.planId === item.planId);
    const installmentMode = plan.hasInstallments || planDocuments.length > 0
      ? "historical_invoice_on_collection" as const
      : plan.billingMode === "installments" || plan.billingMode === "custom_schedule"
        ? "unconfigured_installment_plan" as const : "none" as const;
    if (installmentMode === "unconfigured_installment_plan") reasons.add("installment_schedule_missing");
    return {
      patientId, planId: item.planId, planItemId: item.planItemId,
      clinicalCaseId: item.clinicalCaseId, orthoCaseId: item.orthoCaseId,
      origin: item.origin, billingStatus: item.billingStatus,
      invoiceIds: documentIds,
      invoiceLines: lines.map((line) => ({ invoiceId: line.invoiceId, invoiceLineId: line.id,
        sourceType: line.sourceType, sourceId: line.sourceId, planItemId: line.planItemId,
        grossMinor: line.totalMinor, currency: invoices.get(line.invoiceId)!.currency })),
      historicalAgreements: historical,
      installment: {
        mode: installmentMode,
        planId: installmentMode === "none" ? null : item.planId,
        // Old installment invoices are plan-level evidence, never claimed as precise item coverage.
        planDocumentIds: planDocuments.map((invoice) => invoice.id),
        // The existing installment writer fences the WHOLE plan, not only the selected item.
        collectionRequiresFinancialReview: snapshot.items.some((sibling) => sibling.planId === item.planId
          && (sibling.hasInvoiceLineage || sibling.hasLegacyLineage)),
      },
      clinicalPlanValue: { currency: plan.currency, amountMinor: plan.totalMinor, isDebt: false as const },
      packageCoverage: { state: "unspecified" as const },
      unresolvedReasons: [...reasons],
    };
  });
  return {
    patientId, references, documents, accountPositions,
    openingPositions: snapshot.openings.map((opening) => ({
      ...opening, scope: "patient_currency" as const,
      agreementIds: snapshot.legacyAgreements.filter((agreement) => agreement.currency === opening.currency
        && agreement.status === "live" && agreement.openingEffect !== "none").map((agreement) => agreement.id),
      allocationState: "not_allocated" as const,
    })),
    plans: snapshot.plans.map((plan) => ({ planId: plan.id, currency: plan.currency, valueMinor: plan.totalMinor,
      status: plan.status, valueIsDebt: false as const, billingMode: plan.billingMode, hasInstallments: plan.hasInstallments })),
  };
}

export type TreatmentFinancialContext = ReturnType<typeof projectTreatmentFinancialReferences>;
