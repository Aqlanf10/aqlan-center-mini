import type { PatientVisitWorkFocus } from "../../lib/patient-workspace-focus";
import type { VisitWorkSnapshot } from "../../lib/patient-visit-work";

export const visitWorkFocus: PatientVisitWorkFocus = { kind: "visit_work", patientId: 92001, visitId: 91001, planId: 95001, itemId: 96001, caseId: 97001, toothCode: 16 };
export function visitWorkSnapshot(): VisitWorkSnapshot {
  const item = { id: 96001, serviceId: 93001, serviceName: "Synthetic filling", category: "filling", toothCode: 16,
    surfaces: null, quantity: 1, unitPriceMinor: 1200, totalMinor: 1200, status: "planned" as const, visitId: null,
    doneAt: null, note: null, plannedVisitNumber: 1, billingRule: "per_session" as const, billingStatus: "unbilled" as const,
    sessionCount: 3, sessionsCompleted: 0, doctorId: 94002, doctorName: "Assigned plan clinician" };
  return {
    visit: { id: 91001, patientId: 92001, status: "open", signedAt: null, doctorId: 94001,
      chiefComplaint: "Synthetic saved chiefComplaint", examination: "Synthetic saved examination", diagnosis: "Synthetic saved diagnosis",
      treatmentDone: "Synthetic saved treatmentDone", nextPlan: "Synthetic saved nextPlan", billingCurrency: "YER", procedures: [],
      outstanding: [{ planItemId: 96001, serviceId: 93001, serviceName: "Synthetic filling", planTitle: "Synthetic plan", toothCode: 16,
        billingRule: "per_session", sessionCount: 3, doneSessions: 0, unitPriceMinor: 1200, quantity: 1, status: "planned",
        planCurrency: "SAR", includedByAgreement: false, unmetRequirements: [] }] },
    plans: [{ id: 95001, patientId: 92001, patientName: "Synthetic patient", patientPhone: null, title: "Synthetic plan", baseCurrency: "SAR",
      status: "active", startDate: "2026-10-03", note: null, createdAt: "2026-10-03T09:00:00Z", totalFromItems: true,
      consentAt: "2026-10-03T09:00:00Z", consentBy: "Synthetic author", consentNote: null, lastReminderAt: null,
      financialVisible: false, hasInstallments: false, totalMinor: null, paidMinor: null, installments: null, progress: null,
      itemsProgress: { count: 1, doneCount: 0, totalMinor: null, doneMinor: null, remainingMinor: null },
      items: [{ ...item, unitPriceMinor: null, totalMinor: null }] }],
    cases: { planVisible: true,
      cases: [{ id: 97001, patientId: 92001, kind: "specialty", orthoCaseId: null, specialty: "endodontics", title: "Synthetic case", site: "16",
        problem: null, responsiblePartyId: 94003, responsibleName: "Case clinician", status: "active", startedOn: "2026-10-03",
        completedAt: null, outcome: null, itemsTotal: 1, itemsDone: 0, createdBy: "Synthetic author" }],
      items: [{ id: 96001, planId: 95001, planTitle: "Synthetic plan", serviceName: "Synthetic filling", category: "filling", toothCode: 16,
        status: "planned", doctorName: "Assigned plan clinician", caseId: 97001, priority: null, sortOrder: 0 }] },
    workflow: { patient: { id: 92001 }, planVisible: true, openVisit: { id: 91001, status: "in_chair" } },
  };
}
