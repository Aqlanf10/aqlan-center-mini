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
  };
  warnings: string[];
}

/** Read-only source projection. No patient clinical history or diagnoses are loaded. */
export interface DailyClinicSourceVisit {
  id: number; patientId: number | null; patientNumber: string | null; patientName: string;
  arrivedAt: string; signedAt: string | null; signedClinicDate: string | null;
  billingCurrency: string | null; treatmentDone: string | null;
  doctorName: string | null; plannedPlanId: number | null;
}
export interface DailyClinicSourcePlan {
  id: number; patientId: number; title: string; status: string; consentAt: string | null;
  currency: string; totalMinor: number; funded: boolean;
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
  payments: DailyClinicSourcePayment[];
  openings: DailyClinicSourceOpening[];
  additionalPlanLinks: { planId: number; patientId: number; visitId: number }[];
  expenses: DailyClinicExpenseReport;
}
