import type { TreatmentFinancialSnapshot } from "../lib/treatment-financial-context";

/** Synthetic two-case document with corrected prices; no real patient or Production data. */
export function historicalSnapshot(): TreatmentFinancialSnapshot {
  return {
    patientId: 10,
    plans: [{ id: 1, patientId: 10, currency: "YER", totalMinor: 300000, status: "active", billingMode: "per_procedure", hasInstallments: false }],
    items: [2, 8].map((planItemId, index) => ({ patientId: 10, planId: 1, planItemId, clinicalCaseId: 5 + index,
      orthoCaseId: index === 0 ? 12 : null, origin: "legacy", originInvoiceId: null, billedInvoiceId: null,
      billingStatus: "billed", financialReviewRequired: false, hasInvoiceLineage: false, hasLegacyLineage: true, legacyCoverageState: "verified" })),
    invoices: [], lines: [], receipts: [],
    legacyAgreements: [2, 8].map((planItemId, index) => ({ id: 20 + index, patientId: 10, planItemId, clinicalCaseId: 5 + index,
      documentId: 30, documentLine: index, currency: "YER", agreedMinor: 150000,
      previouslyPaidMinor: null, remainingAtRegistrationMinor: null, historicalAsOf: "2026-09-01",
      openingHistoryId: null, openingEffect: "none", status: "live" })),
    historicalDocuments: [{ id: 30, patientId: 10, currency: "YER", lineCount: 2,
      revision: { id: 32, version: 2, totalMinor: 600000, discountMinor: 60000, previouslyPaidMinor: 90000,
        remainingMinor: 450000, historicalAsOf: "2026-09-02",
        lines: [2, 8].map((planItemId, index) => ({ agreementId: 20 + index, planId: 1, planItemId, caseId: 5 + index,
          unitPriceMinor: 300000, discountMinor: 30000, netMinor: 270000 })) } }],
    openings: [{ currency: "YER", openingMinor: 450000, settledMinor: 0, remainingMinor: 450000 }],
  };
}
