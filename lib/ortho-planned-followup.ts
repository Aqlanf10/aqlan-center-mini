import type { FollowupTarget } from "./ortho-followup-booking-context";

/** Read facts only. A treatment plan/doctor/name alone never establishes a case. */
export interface PlannedFollowupSessionFacts {
  id: number;
  plannedVisitId: number;
  status: string;
  visitId: number | null;
  itemId: number | null;
  itemPlanId: number | null;
  itemStatus: string | null;
  itemCategory: string | null;
  clinicalCaseId: number | null;
  casePatientId: number | null;
  caseSpecialty: string | null;
  caseStatus: string | null;
  orthoCaseId: number | null;
  orthoPatientId: number | null;
}

export interface PlannedFollowupFacts {
  id: number;
  patientId: number;
  planId: number | null;
  planPatientId: number | null;
  planStatus: string | null;
  status: string;
  appointmentId: number | null;
  visitId: number | null;
  visitPatientId: number | null;
  visitPlannedVisitId: number | null;
  visitAppointmentId: number | null;
  visitSigned: boolean | null;
  sessions: PlannedFollowupSessionFacts[];
}

const own = (value: unknown, key: string): unknown => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Null means exact pending case linkage, NOT periodic purpose or completed work.
 * Mixed/unresolved sessions are retained for review, never silently filtered. */
export function plannedFollowupRefusal(target: FollowupTarget, appointmentId: number,
  plannedVisitId: number, facts: unknown): string | null {
  if (facts == null) return "planned_visit_requires_review";
  if (own(facts, "id") !== plannedVisitId || own(facts, "patientId") !== target.patientId
    || own(facts, "appointmentId") !== appointmentId) return "unresolved_planned_visit";
  const planId = own(facts, "planId");
  if (!id(planId) || own(facts, "planPatientId") !== target.patientId
    || own(facts, "planStatus") !== "active") return "unresolved_planned_plan";
  const status = own(facts, "status"), visitId = own(facts, "visitId");
  if (status !== "scheduled" && status !== "in_progress") return "planned_visit_not_pending";
  if (visitId === null) {
    if (status !== "scheduled" || own(facts, "visitPatientId") !== null
      || own(facts, "visitPlannedVisitId") !== null || own(facts, "visitAppointmentId") !== null
      || own(facts, "visitSigned") !== null) {
      return "unresolved_planned_visit_record";
    }
  } else if (!id(visitId) || status !== "in_progress" || own(facts, "visitPatientId") !== target.patientId
    || own(facts, "visitPlannedVisitId") !== plannedVisitId || own(facts, "visitSigned") !== false) {
    return "unresolved_planned_visit_record";
  }
  if (visitId !== null) {
    const visitAppointmentId = own(facts, "visitAppointmentId");
    // Starting from a planned visit can leave this NULL until arrival. Preserve
    // that legacy absence, but never treat an omitted projection as NULL or
    // contradict arriveAppointment's refusal of a different non-NULL booking.
    if (visitAppointmentId !== null && !id(visitAppointmentId)) return "unresolved_planned_visit_appointment";
    if (visitAppointmentId !== null && visitAppointmentId !== appointmentId) return "conflicting_planned_visit_appointment";
  }
  const sessions = own(facts, "sessions");
  if (!Array.isArray(sessions) || !sessions.length) return "planned_sessions_missing";
  const ids = new Set<number>();
  for (const session of sessions) {
    const sessionId = own(session, "id"), sessionVisitId = own(session, "visitId");
    if (!id(sessionId) || ids.has(sessionId) || own(session, "plannedVisitId") !== plannedVisitId
      || !id(own(session, "itemId")) || own(session, "itemPlanId") !== planId
      || (sessionVisitId !== null && (!id(sessionVisitId) || sessionVisitId !== visitId))) {
      return "unresolved_planned_session";
    }
    ids.add(sessionId);
    const sessionStatus = own(session, "status"), itemStatus = own(session, "itemStatus");
    if ((sessionStatus !== "planned" && sessionStatus !== "in_progress")
      || (itemStatus !== "planned" && itemStatus !== "in_progress")) {
      return "planned_session_not_pending";
    }
    if (!id(target.clinicalCaseId) || own(session, "clinicalCaseId") !== target.clinicalCaseId
      || own(session, "casePatientId") !== target.patientId || own(session, "caseSpecialty") !== "orthodontics"
      || (own(session, "caseStatus") !== "active" && own(session, "caseStatus") !== "waiting")
      || own(session, "orthoCaseId") !== target.orthoCaseId || own(session, "orthoPatientId") !== target.patientId
      || (own(session, "itemCategory") !== null && own(session, "itemCategory") !== "ortho")) {
      return "different_or_unresolved_planned_case";
    }
  }
  return null;
}
