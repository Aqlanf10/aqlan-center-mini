import type { PlanItem, TreatmentPlan } from "@/lib/db";
import type { DoctorPermissions } from "@/lib/doctor-permissions";
import { canHandleMoney, canViewMoney } from "@/lib/roles";

/** Agreement snapshots are patient finance, never the current service catalogue. */
export function canReadPatientPlanFinance(role: string, doctorFinancialView: boolean, canViewPatientPayments: boolean): boolean {
  return canViewMoney(role) || (role === "doctor" && doctorFinancialView && canViewPatientPayments);
}

export interface PatientPlanCapabilities {
  canEditPlans: boolean;
  canViewCatalogPrices: boolean;
  canCollectPayments: boolean;
  canRecordConsent: boolean;
  canCompletePlan: boolean;
  canPrintContract: boolean;
}
export const NO_PATIENT_PLAN_CAPABILITIES: PatientPlanCapabilities = {
  canEditPlans: false, canViewCatalogPrices: false, canCollectPayments: false,
  canRecordConsent: false, canCompletePlan: false, canPrintContract: false,
};

/** Mirrors the existing writers. Viewing all patients never grants own-patient writes. */
export function patientPlanCapabilities(role: string, permissions: Partial<DoctorPermissions> | null, ownsPatient = false): PatientPlanCapabilities {
  const moneyWriter = canHandleMoney(role);
  return {
    canEditPlans: moneyWriter || (role === "doctor" && ownsPatient && permissions?.canEditPlans === true),
    canViewCatalogPrices: canViewMoney(role) || (role === "doctor" && permissions?.canViewServicePrices === true),
    canCollectPayments: moneyWriter,
    canRecordConsent: moneyWriter,
    canCompletePlan: moneyWriter,
    canPrintContract: moneyWriter,
  };
}

export type ClinicalPlanItem = Omit<PlanItem, "unitPriceMinor" | "totalMinor"> & {
  unitPriceMinor: null; totalMinor: null;
};
export type FinancialPatientPlan = TreatmentPlan & { financialVisible: true; hasInstallments: boolean };
export type ClinicalPatientPlan = Omit<TreatmentPlan,
  "totalMinor" | "paidMinor" | "progress" | "items" | "itemsProgress" | "installments" | "lastReminderAt" | "consentNote"
> & {
  financialVisible: false;
  hasInstallments: boolean;
  totalMinor: null;
  paidMinor: null;
  progress: null;
  installments: null;
  lastReminderAt: null;
  consentNote: null;
  items: ClinicalPlanItem[];
  itemsProgress: { count: number; doneCount: number; totalMinor: null; doneMinor: null; remainingMinor: null };
};
export type PatientPlanProjection = FinancialPatientPlan | ClinicalPatientPlan;

/** Explicit allowlist: newly added monetary fields cannot leak through a denied spread. */
export function projectPatientPlan(plan: TreatmentPlan, financialVisible: boolean): PatientPlanProjection {
  const hasInstallments = plan.installments.length > 0;
  if (financialVisible) return { ...plan, financialVisible: true, hasInstallments };
  return {
    id: plan.id, patientId: plan.patientId, patientName: plan.patientName, patientPhone: plan.patientPhone,
    title: plan.title, baseCurrency: plan.baseCurrency, status: plan.status,
    startDate: plan.startDate, note: plan.note, createdAt: plan.createdAt,
    totalFromItems: plan.totalFromItems, consentAt: plan.consentAt, consentBy: plan.consentBy,
    consentNote: null, lastReminderAt: null,
    financialVisible: false, hasInstallments,
    totalMinor: null, paidMinor: null, installments: null, progress: null,
    itemsProgress: {
      count: plan.itemsProgress.count, doneCount: plan.itemsProgress.doneCount,
      totalMinor: null, doneMinor: null, remainingMinor: null,
    },
    items: plan.items.map((item) => ({
      id: item.id, serviceId: item.serviceId, serviceName: item.serviceName, category: item.category,
      toothCode: item.toothCode, surfaces: item.surfaces, quantity: item.quantity,
      status: item.status, visitId: item.visitId, doneAt: item.doneAt, note: item.note,
      plannedVisitNumber: item.plannedVisitNumber, billingRule: item.billingRule, billingStatus: item.billingStatus,
      sessionCount: item.sessionCount, sessionsCompleted: item.sessionsCompleted,
      doctorId: item.doctorId, doctorName: item.doctorName,
      unitPriceMinor: null, totalMinor: null,
    })),
  };
}

/** Item creation shares GET visibility; an absent legacy total stays unknown, never zero. */
export function projectPatientPlanTotal(totalMinor: number | undefined, financialVisible: boolean) {
  return { totalMinor: financialVisible ? totalMinor ?? null : null, financialVisible };
}

/** Clinical grouping does not coerce hidden money into a fabricated zero. */
export function groupProjectedPlanItems(items: PatientPlanProjection["items"]) {
  const groups = new Map<number, (PlanItem | ClinicalPlanItem)[]>();
  for (const item of items) {
    if (item.status === "cancelled") continue;
    const visit = item.plannedVisitNumber > 0 ? item.plannedVisitNumber : 1;
    groups.set(visit, [...(groups.get(visit) ?? []), item]);
  }
  return [...groups].sort(([a], [b]) => a - b).map(([visitNumber, grouped]) => ({
    visitNumber, items: grouped,
    doneCount: grouped.filter((item) => item.status === "done").length,
    allDone: grouped.every((item) => item.status === "done"),
    totalMinor: grouped.some((item) => item.totalMinor === null) ? null
      : grouped.reduce((sum, item) => sum + (item.totalMinor as number), 0),
  }));
}
