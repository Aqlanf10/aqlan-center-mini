import type { TreatmentPlan } from "./db";

/** Clinical agreement data is independent of receipts. Withheld collections are
 * null, never a fabricated zero; the whole progress object is withheld because
 * even its next due date depends on which installments have been paid.
 * The generic plan picker needs installment identities to recognize an agreement.
 * The patient-file endpoint retains its existing empty installment projection.
 */
export function withoutPlanPayments(plan: TreatmentPlan, keepInstallmentIds = false) {
  return {
    id: plan.id,
    patientId: plan.patientId,
    patientName: plan.patientName,
    patientPhone: plan.patientPhone,
    title: plan.title,
    totalMinor: plan.totalMinor,
    baseCurrency: plan.baseCurrency,
    status: plan.status,
    startDate: plan.startDate,
    note: plan.note,
    createdAt: plan.createdAt,
    items: plan.items,
    itemsProgress: plan.itemsProgress,
    totalFromItems: plan.totalFromItems,
    consentAt: plan.consentAt,
    consentBy: plan.consentBy,
    consentNote: plan.consentNote,
    hasInstallments: plan.installments.length > 0,
    installments: keepInstallmentIds ? plan.installments.map(({ id }) => ({ id })) : [],
    paidMinor: null,
    progress: null,
    lastReminderAt: null,
  };
}
