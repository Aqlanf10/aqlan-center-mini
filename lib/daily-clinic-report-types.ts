import type { Currency } from "./money";
import type { DailyClinicExpenseReport } from "./daily-clinic-expense-report";

export type DailyCurrencyAmounts = Record<Currency, number>;
export interface DailyClinicAttendee {
  key: string;
  patientId: number | null;
  patientNumber: string | null;
  patientName: string;
  visitIds: number[];
  visitsCount: number;
  signedVisitsCount: number;
  pendingVisitsCount: number;
  lateSignedVisitsCount: number;
  workSummary: string;
  agreementIds: number[];
  agreement: DailyCurrencyAmounts;
  explicitlySettled: DailyCurrencyAmounts;
  agreementRemaining: DailyCurrencyAmounts;
  excludedAgreementCount: number;
}
export interface DailyClinicAgreement {
  id: number;
  patientId: number;
  patientName: string;
  title: string;
  status: string;
  consentAt: string | null;
  currency: Currency;
  principalMinor: number;
  explicitlySettledMinor: number;
  remainingMinor: number | null;
  excessSettlementMinor: number;
  includedInTotals: boolean;
  excludedReason: string | null;
  linkedVisitIds: number[];
  paymentIds: number[];
}
export interface DailyClinicWork {
  key: string;
  patientKey: string;
  patientName: string;
  visitId: number;
  sourceType: "procedure" | "ortho_adjustment" | "endo_visit" | "clinical_note";
  sourceId: number;
  signedAt: string;
  description: string;
  quantity: number;
  toothCode: number | null;
  doctorName: string | null;
  agreementId: number | null;
  classification: "included" | "recorded_charge" | "documented_unpriced";
  valueMinor: number | null;
  currency: Currency | null;
  valuationBasis: "recorded_procedure_price" | "completed_plan_item" | "included_in_completed_item" | null;
  unvaluedReason: string | null;
}
export interface DailyClinicAccount {
  patientId: number;
  patientName: string;
  byCurrency: Record<Currency, {
    openingMinor: number; billedMinor: number; collectedMinor: number;
    receivableMinor: number; creditMinor: number;
  }>;
  unallocatedPaymentIds: number[];
}
export interface DailyClinicReceipt {
  id: number;
  receiptNumber: string;
  patientId: number;
  patientName: string;
  attendee: boolean;
  at: string;
  kind: "payment" | "refund";
  reversalOfId: number | null;
  tenderCurrency: Currency;
  /** Positive stored receipt magnitude; kind determines direction. */
  tenderMinor: number;
  method: string;
  invoiceId: number | null;
  planId: number | null;
  openingCurrency: Currency | null;
  settlementCurrency: Currency;
  signedSettlementMinor: number;
  recordedBaseMinor: number;
  exchangeRate: number;
}
/** (INV-LINK REPORT) One row per invoice; explicit receipts only, never an estimated split across cases. */
export interface DailyClinicInvoiceLine {
  id: number;
  description: string;
  totalMinor: number;
  planItemId: number | null;
  planId: number | null;
  caseId: number | null;
  toothCode: number | null;
}
export interface DailyClinicInvoiceCorrection {
  /** Stored audit evidence only (`invoice.correct`); never an inferred replacement chain. */
  originalInvoiceId: number;
  originalInvoiceNumber: string | null;
  correctedInvoiceNumber: string;
  reason: string | null;
  at: string;
  actor: string;
}
export interface DailyClinicInvoice {
  id: number;
  invoiceNumber: string;
  patientId: number;
  patientName: string;
  status: "open" | "paid" | "cancelled";
  currency: Currency;
  totalMinor: number;
  discountMinor: number;
  /** Zero when cancelled, as in the canonical patient balance. */
  netMinor: number;
  issuedAt: string;
  issuedClinicDate: string;
  issuedOnReportDay: boolean;
  /** Why this invoice is in the day's report (it appears once even with several reasons). */
  reasons: ("issued_today" | "receipt_today" | "linked_to_day_agreement" | "attached_to_day_visit" | "line_from_day_visit")[];
  /** `plan_installment`: only invoices.plan_id links it (an installment/plan payment invoice), no line identifies work. */
  linkage: "financial_only" | "plan_installment" | "single_plan_item" | "single_case" | "mixed";
  /** Recorded document value (total − discount) even when cancelled; `netMinor` is the current effect (0 when cancelled). */
  originalNetMinor: number;
  /** Explicit settlement above the current net. Shown apart: it is not patient debt and is not moved to a replacement. */
  excessSettledMinor: number;
  lines: DailyClinicInvoiceLine[];
  explicitPaymentIds: number[];
  explicitlySettledMinor: number;
  remainingMinor: number;
  corrections: DailyClinicInvoiceCorrection[];
  correctsInvoiceNumbers: string[];
}
export interface DailyClinicLegacyAgreement {
  id: number;
  patientId: number;
  patientName: string;
  serviceName: string;
  specialty: string;
  toothCode: number | null;
  coverageTeeth: number[] | null;
  coverageScope: string | null;
  coverageRecorded: boolean;
  /** Canonical decoder result of the immutable snapshot: verified, missing/unsupported (review), or conflicting (review). */
  coverageState: "verified" | "unknown" | "conflict";
  /** Full verified site with readable labels (teeth/tooth, surfaces, scope); null when not verified. */
  coverageLabel: string | null;
  /** How the remaining at start entered the opening at registration. */
  openingEffect: "none" | "created" | "increased";
  /** Current effect of that remaining: inside today's opening, removed by void, or none (historically settled). */
  currentOpeningEffect: "in_opening" | "removed_by_void" | "none";
  currency: Currency;
  agreedMinor: number;
  /** Paid before the system. Not a receipt and never part of the day's collections. */
  previouslyPaidMinor: number;
  /** Remaining at system start; already inside the opening balance, never added again to current debt. */
  remainingAtStartMinor: number;
  historicalAsOf: string;
  status: "live" | "void";
  voidReason: string | null;
  planItemId: number;
  caseId: number | null;
}

export interface DailyClinicReport {
  date: string;
  clinicTimeZone: string;
  generatedAt: string;
  selectedDayCutoff: string;
  basis: {
    cohort: "arrival_day";
    account: "current_at_generation";
    work: "signed_by_cutoff";
    receipts: "clinicwide_recorded_day";
  };
  attendees: DailyClinicAttendee[];
  agreements: DailyClinicAgreement[];
  work: DailyClinicWork[];
  currentAccounts: DailyClinicAccount[];
  receipts: DailyClinicReceipt[];
  invoices: DailyClinicInvoice[];
  legacyAgreements: DailyClinicLegacyAgreement[];
  expenses: DailyClinicExpenseReport;
  totals: {
    attendeesCount: number;
    visitsCount: number;
    signedVisitsCount: number;
    pendingVisitsCount: number;
    lateSignedVisitsCount: number;
    agreement: DailyCurrencyAmounts;
    explicitlySettled: DailyCurrencyAmounts;
    agreementRemaining: DailyCurrencyAmounts;
    knownCompletedValue: DailyCurrencyAmounts;
    unvaluedWorkCount: number;
    currentReceivable: DailyCurrencyAmounts;
    currentCredit: DailyCurrencyAmounts;
    nativeReceipts: DailyCurrencyAmounts;
    nativeReversals: DailyCurrencyAmounts;
    nativeNetRecorded: DailyCurrencyAmounts;
    nativeCashNetRecorded: DailyCurrencyAmounts;
    nativeTransferNetRecorded: DailyCurrencyAmounts;
    /** Net of non-cancelled invoices issued on the report day, per currency. */
    invoicesIssuedNet: DailyCurrencyAmounts;
    invoicesIssuedCount: number;
    cancelledInvoicesCount: number;
  };
  warnings: string[];
}

/** Read-only source projection. No patient clinical history or diagnoses are loaded. */
export interface DailyClinicSourceVisit {
  id: number; patientId: number | null; patientNumber: string | null; patientName: string;
  arrivedAt: string; signedAt: string | null; signedClinicDate: string | null;
  billingCurrency: string | null; treatmentDone: string | null;
  doctorName: string | null; plannedPlanId: number | null;
  /** visits.invoice_id: the invoice recorded as issued for this visit. */
  invoiceId?: number | null;
}
export interface DailyClinicSourcePlan {
  id: number; patientId: number; title: string; status: string; consentAt: string | null;
  currency: string; totalMinor: number; funded: boolean;
  /** A live (non-cancelled) invoice line references one of this plan's items via invoice_items.plan_item_id. */
  invoiceLinked: boolean;
}
export interface DailyClinicSourceItem {
  id: number; planId: number; serviceName: string; quantity: number; unitPriceMinor: number;
  status: string; visitId: number | null; doneAt: string | null; doneClinicDate: string | null;
}
export interface DailyClinicSourceWork {
  sourceType: DailyClinicWork["sourceType"]; id: number; visitId: number;
  patientId: number | null; description: string; quantity: number;
  toothCode: number | null; doctorName: string | null;
  planId: number | null; planItemId: number | null; unitPriceMinor: number | null;
}
export interface DailyClinicSourceInvoice {
  id: number; patientId: number; currency: string; totalMinor: number; discountMinor: number;
  status: string; planId: number | null;
  invoiceNumber: string; createdAt: string; clinicDate: string;
}
export interface DailyClinicSourceInvoiceLine {
  id: number; invoiceId: number; description: string; totalMinor: number;
  planItemId: number | null; planId: number | null; caseId: number | null; toothCode: number | null;
  /** invoice_items.source_type/source_id and, for a visit-procedure source, that procedure's visit and patient. */
  sourceType?: string | null; sourceId?: number | null; sourceVisitId?: number | null; sourceVisitPatientId?: number | null;
}
export interface DailyClinicSourceInvoiceCorrection {
  originalInvoiceId: number; correctedInvoiceNumber: string; reason: string | null; at: string; actor: string;
}
export interface DailyClinicSourceLegacyAgreement {
  id: number; patientId: number; serviceName: string; specialty: string; toothCode: number | null;
  coverageTeeth: number[] | null; coverageScope: string | null; coverageRecorded: boolean;
  coverageState?: "verified" | "unknown" | "conflict"; coverageLabel?: string | null;
  openingEffect?: "none" | "created" | "increased";
  currency: string; agreedMinor: number; previouslyPaidMinor: number; remainingMinor: number;
  historicalAsOf: string; status: string; voidReason: string | null; planItemId: number; caseId: number | null;
}
export interface DailyClinicSourcePayment {
  id: number; patientId: number; patientName: string; receiptNumber: string;
  invoiceId: number | null; planId: number | null; openingCurrency: string | null;
  currency: string; amountMinor: number; baseAmountMinor: number; exchangeRate: number;
  kind: string; method: string; createdAt: string; clinicDate: string; reversalOfId: number | null;
}
export interface DailyClinicSourceOpening {
  patientId: number; currency: string; amountMinor: number;
}
export interface DailyClinicSource {
  date: string; clinicTimeZone: string; generatedAt: string; selectedDayCutoff: string;
  visits: DailyClinicSourceVisit[];
  plans: DailyClinicSourcePlan[];
  items: DailyClinicSourceItem[];
  work: DailyClinicSourceWork[];
  invoices: DailyClinicSourceInvoice[];
  invoiceLines: DailyClinicSourceInvoiceLine[];
  invoiceCorrections: DailyClinicSourceInvoiceCorrection[];
  legacyAgreements: DailyClinicSourceLegacyAgreement[];
  payments: DailyClinicSourcePayment[];
  openings: DailyClinicSourceOpening[];
  additionalPlanLinks: { planId: number; patientId: number; visitId: number }[];
  expenses: DailyClinicExpenseReport;
}
