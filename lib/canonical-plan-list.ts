import "server-only";
import { CLINIC_TIME_ZONE, listActivePlansWith, listPatientPlansWith, patientInDoctorScopeWith, type DbClient, type PlanItem, type TreatmentPlan } from "./db";
import { CanonicalPatientReadRefusal } from "./canonical-patient-reads";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { clinicDateString } from "./schedule";
import { CLINIC_BASE_CURRENCY } from "./money";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * `GET /api/plans` on the canonical runtime (M2 slice 94a; owner decisions G4-1, G4-6, G4-8;
 * contract section 9). One snapshot; rows inside the patient scope; an explicit allowlist per
 * group, a hidden group omitted (never nulled or zeroed); role labels and the legacy
 * `workflow.doctor_financial_view` decide nothing.
 */
export interface PlanListGrants { readonly clinical: boolean; readonly prices: boolean; readonly account: boolean }

function projectItem(item: PlanItem, prices: boolean) {
  return {
    id: item.id, serviceId: item.serviceId, serviceName: item.serviceName, category: item.category, toothCode: item.toothCode,
    surfaces: item.surfaces, quantity: item.quantity, status: item.status, visitId: item.visitId, doneAt: item.doneAt, note: item.note,
    plannedVisitNumber: item.plannedVisitNumber, sessionCount: item.sessionCount, sessionsCompleted: item.sessionsCompleted,
    doctorId: item.doctorId, doctorName: item.doctorName,
    ...(item.caseId !== undefined ? { caseId: item.caseId } : {}), ...(item.caseSite !== undefined ? { caseSite: item.caseSite } : {}),
    ...(item.clinicalConsentRecorded !== undefined ? { clinicalConsentRecorded: item.clinicalConsentRecorded } : {}),
    ...(prices ? {
      unitPriceMinor: item.unitPriceMinor, totalMinor: item.totalMinor, billingRule: item.billingRule, billingStatus: item.billingStatus,
      ...(item.origin !== undefined ? { origin: item.origin } : {}), ...(item.originInvoiceId !== undefined ? { originInvoiceId: item.originInvoiceId } : {}),
      ...(item.billedInvoiceId !== undefined ? { billedInvoiceId: item.billedInvoiceId } : {}),
      ...(item.financialReviewRequired !== undefined ? { financialReviewRequired: item.financialReviewRequired } : {}),
      ...(item.legacyAgreementId !== undefined ? { legacyAgreementId: item.legacyAgreementId } : {}),
      ...(item.legacyAgreementStatus !== undefined ? { legacyAgreementStatus: item.legacyAgreementStatus } : {}),
      ...(item.legacyCoverageState !== undefined ? { legacyCoverageState: item.legacyCoverageState } : {}),
      ...(item.legacyCoverageSite !== undefined ? { legacyCoverageSite: item.legacyCoverageSite } : {}),
      ...(item.legacyCurrentConsentRequired !== undefined ? { legacyCurrentConsentRequired: item.legacyCurrentConsentRequired } : {}),
    } : {}),
  };
}

/** The allowlist projection of one plan (pure; contract section 9). */
export function projectCanonicalPlan(plan: TreatmentPlan, grants: PlanListGrants) {
  return {
    id: plan.id, patientId: plan.patientId, patientName: plan.patientName, patientPhone: plan.patientPhone, status: plan.status,
    startDate: plan.startDate, createdAt: plan.createdAt, baseCurrency: plan.baseCurrency,
    // The plan picker's structure, shown to every reader as legacy did (withoutPlanPayments):
    // whether the agreement is approved and the instalment identities, never their amounts.
    agreementApproved: plan.agreementApproved === true, hasInstallments: plan.installments.length > 0,
    installments: plan.installments.map(row => grants.prices
      ? { id: row.id, number: row.number, dueDate: row.dueDate, amountMinor: row.amountMinor,
        ...(grants.account && row.lastReminderAt !== undefined ? { lastReminderAt: row.lastReminderAt } : {}) }
      : { id: row.id }),
    title: grants.clinical ? plan.title : `خطة مالية #${plan.id}`,
    ...(grants.clinical ? {
      note: plan.note, items: plan.items.map(item => projectItem(item, grants.prices)),
      itemsProgress: { count: plan.itemsProgress.count, doneCount: plan.itemsProgress.doneCount,
        ...(grants.prices ? { totalMinor: plan.itemsProgress.totalMinor, doneMinor: plan.itemsProgress.doneMinor, remainingMinor: plan.itemsProgress.remainingMinor } : {}) },
      consentAt: plan.consentAt, consentBy: plan.consentBy, consentNote: plan.consentNote, totalFromItems: plan.totalFromItems,
    } : {}),
    // The agreement total is both an invoice detail and a ledger total (G4-1; the account read of
    // slice 88 already shows it with the ledger grant), so either money grant shows it.
    ...(grants.prices || grants.account ? { totalMinor: plan.totalMinor } : {}),
    ...(grants.account ? {
      paidMinor: plan.paidMinor, lastReminderAt: plan.lastReminderAt,
      progress: { totalMinor: plan.progress.totalMinor, dueToDateMinor: plan.progress.dueToDateMinor, paidMinor: plan.progress.paidMinor,
        remainingMinor: plan.progress.remainingMinor, overdueMinor: plan.progress.overdueMinor, nextDueDate: plan.progress.nextDueDate,
        nextDueAmountMinor: plan.progress.nextDueAmountMinor, paidCount: plan.progress.paidCount, count: plan.progress.count,
        ...(plan.progress.lastReminderAt !== undefined ? { lastReminderAt: plan.progress.lastReminderAt } : {}) },
      ...(plan.invoiceFinancial !== undefined ? { invoiceFinancial: plan.invoiceFinancial } : {}),
      ...(plan.approvedAgreement !== undefined ? { approvedAgreement: plan.approvedAgreement } : {}),
      ...(plan.debtSource !== undefined ? { debtSource: plan.debtSource } : {}),
    } : {}),
  };
}

export async function readCanonicalPlanList(session: VerifiedDurableSession, rawPatientId: string | null) {
  const patientId = rawPatientId === null || rawPatientId === "" ? null : Number(rawPatientId);
  if (patientId !== null && (!Number.isSafeInteger(patientId) || patientId <= 0)) throw new CanonicalPatientReadRefusal("invalid_patient_query", "رقم الملف غير صالح.");
  return runCanonicalReadSnapshot(session, "read:plans.list", async (query, scope) => {
    const client = query as DbClient, patientScope = scope.patientScope;
    if (patientScope.kind === "none") throw new CanonicalPatientReadRefusal("patient_not_found", "المريض غير موجود.");
    const has = (capability: Parameters<typeof scope.granted>[0]) => scope.isProtectedOwner() || scope.granted(capability);
    const grants: PlanListGrants = { clinical: has("clinical.plans.view"), prices: has("finance.invoices.view"), account: has("finance.patient-ledger.view") };
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    let plans: TreatmentPlan[];
    if (patientId !== null) {
      if (patientScope.kind === "own" && !await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, patientId)) {
        throw new CanonicalPatientReadRefusal("patient_not_found", "المريض غير موجود.");
      }
      plans = await listPatientPlansWith(client, patientId, today);
    } else {
      plans = await listActivePlansWith(client, today, patientScope.kind === "own" ? patientScope.clinicianPartyId : null);
    }
    // The legacy envelope; canSeeFinancial only when both money groups are present, so a screen
    // never renders an absent group as zero.
    return { plans: plans.map(plan => projectCanonicalPlan(plan, grants)), today, baseCurrency: CLINIC_BASE_CURRENCY,
      canSeeFinancial: grants.prices && grants.account, projection: grants };
  }, { errorPrefix: "STAFF_READ", maxBytes: 4 * 1024 * 1024 });
}
