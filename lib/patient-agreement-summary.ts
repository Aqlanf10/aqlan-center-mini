import type { TreatmentPlan } from "./db";
import type { ClinicalProgressView } from "./historical-clinical-projection";
import type { Currency } from "./money";

/** One population of immutable approvals, including clinically completed plans.
 * If any source cannot be verified, settlement totals are unknown, not zero or
 * a partial sum of the remaining sources. The approved principal stays known. */
export interface ApprovedAgreementSummary {
  count: number;
  available: boolean;
  reviewCount: number;
  totalMinor: number;
  paidMinor: number | null;
  remainingMinor: number | null;
  dueNowMinor: number | null;
}

/** A reference for the classic installment workflow, never posted principal. */
export interface ClassicInstallmentSummary {
  count: number;
  totalMinor: number;
  paidMinor: number;
  remainingMinor: number;
}

export interface PatientWorkflowFinancialBucket {
  balanceMinor: number;
  invoicedMinor: number;
  paidMinor: number;
  openingMinor: number;
  /** Active planned treatment value; deliberately not approved principal. */
  agreedMinor: number;
  treatmentDoneMinor: number;
  remainingTreatmentMinor: number;
  clinicalProgress?: ClinicalProgressView;
  approvedAgreements: ApprovedAgreementSummary | null;
  classicInstallments: ClassicInstallmentSummary | null;
  /** @deprecated Compatibility for already-open clients only. These retain the
   * old active fixed-plan population and are not the approved agreement trio. */
  agreementPaidMinor?: number;
  agreementRemainingMinor?: number;
}

type PlanReference = Pick<TreatmentPlan,
  "status" | "baseCurrency" | "totalMinor" | "progress" | "approvedAgreement" | "invoiceFinancial" | "debtSource">;

function sumMinor(values: number[]): number {
  return values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(sum + value)) {
      throw new Error("Patient agreement summary exceeds safe minor units");
    }
    return sum + value;
  }, 0);
}

/** Read projection only. Never infer an approval from consent, item presence,
 * installment schedules, or a generic plan-progress fallback. Each financial
 * source retains its existing ownership; nothing here is added to the ledger. */
export function patientAgreementSummary(plans: PlanReference[], currency: Currency):
  Pick<PatientWorkflowFinancialBucket, "approvedAgreements" | "classicInstallments"> {
  const approved = plans.flatMap((plan) =>
    plan.approvedAgreement?.currency === currency ? [plan.approvedAgreement] : []);
  const reviewCount = approved.filter((agreement) => !agreement.available).length;
  const classic = plans.filter((plan) => plan.status === "active" && plan.baseCurrency === currency
    && plan.debtSource === "classic_installments" && !plan.approvedAgreement && !plan.invoiceFinancial);
  return {
    approvedAgreements: approved.length ? {
      count: approved.length,
      available: reviewCount === 0,
      reviewCount,
      totalMinor: sumMinor(approved.map((agreement) => agreement.totalMinor)),
      paidMinor: reviewCount ? null : sumMinor(approved.map((agreement) => agreement.paidMinor)),
      remainingMinor: reviewCount ? null : sumMinor(approved.map((agreement) => agreement.remainingMinor)),
      dueNowMinor: reviewCount ? null : sumMinor(approved.map((agreement) => agreement.dueNowMinor)),
    } : null,
    classicInstallments: classic.length ? {
      count: classic.length,
      totalMinor: sumMinor(classic.map((plan) => plan.totalMinor)),
      paidMinor: sumMinor(classic.map((plan) => plan.progress.paidMinor)),
      remainingMinor: sumMinor(classic.map((plan) => plan.progress.remainingMinor)),
    } : null,
  };
}

export function hasPatientFinancialActivity(row: PatientWorkflowFinancialBucket): boolean {
  return Object.values(row).some((value) => typeof value === "number" && value !== 0)
    || (row.clinicalProgress?.historicalItems ?? 0) > 0
    || !!row.approvedAgreements || !!row.classicInstallments
    // An older response lacks these fields; that is unknown, not no agreements.
    || row.approvedAgreements === undefined || row.classicInstallments === undefined;
}
