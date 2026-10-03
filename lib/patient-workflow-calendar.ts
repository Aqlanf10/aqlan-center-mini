import {
  canReadAppointment, patientAppointmentVisibility, readPatientAppointmentVisibility,
  type AppointmentReadScope, type PatientAppointmentReadVisibility,
} from "./appointment-read-scope";

export interface PlannedVisitCalendar {
  appointmentId?: number | null;
  appointmentDate: string | null;
  appointmentTime: string | null;
  /** Optional for legacy consumers only; absence never grants calendar reads. */
  appointmentVisibility?: PatientAppointmentReadVisibility;
}

/** Actual joined appointment evidence, not the planned visit's assigned doctor. */
export interface PlannedAppointmentReference {
  id: number;
  patientId: number | null;
  doctorId: number | null;
}

/** GET projection only. Never pass this object to a writer or transition guard. */
export function projectWorkflowPlannedAppointment<T extends PlannedVisitCalendar>(
  visit: T, patientId: number, scope: AppointmentReadScope, reference: PlannedAppointmentReference | null,
): T & { appointmentVisibility: PatientAppointmentReadVisibility } {
  const visibility = patientAppointmentVisibility(scope, patientId);
  const inconsistent = visit.appointmentId === undefined
    || (visit.appointmentId === null && (visit.appointmentDate !== null || visit.appointmentTime !== null))
    || (visit.appointmentId !== null && (typeof visit.appointmentDate !== "string" || typeof visit.appointmentTime !== "string"))
    || (visit.appointmentId !== null && (!reference || reference.id !== visit.appointmentId))
    || (reference !== null && (reference.id !== visit.appointmentId || reference.patientId !== patientId));
  const readable = visibility !== "hidden" && !inconsistent && reference !== null
    && canReadAppointment(scope, { patientId, doctorId: reference.doctorId });
  return {
    ...visit,
    appointmentId: readable ? visit.appointmentId : null,
    appointmentDate: readable ? visit.appointmentDate : null,
    appointmentTime: readable ? visit.appointmentTime : null,
    appointmentVisibility: visibility === "hidden" ? "hidden" : inconsistent ? "unknown" : visibility,
  };
}

/** Defense in depth for direct/legacy consumers, independent of file-list state. */
export function readWorkflowPlannedAppointment<T extends PlannedVisitCalendar>(
  visit: T, parentVisibility: PatientAppointmentReadVisibility,
): T & { appointmentVisibility: PatientAppointmentReadVisibility } {
  const rowVisibility = readPatientAppointmentVisibility(visit.appointmentVisibility);
  let visibility = parentVisibility === "hidden" || parentVisibility === "unknown" ? parentVisibility
    : rowVisibility === "all" && parentVisibility === "scoped" ? "scoped" : rowVisibility;
  const readable = visibility === "all" || visibility === "scoped";
  const absent = visit.appointmentId === null && visit.appointmentDate === null && visit.appointmentTime === null;
  const linked = Number.isSafeInteger(visit.appointmentId) && (visit.appointmentId ?? 0) > 0
    && typeof visit.appointmentDate === "string" && typeof visit.appointmentTime === "string";
  if (readable && !absent && !linked) visibility = "unknown";
  const show = (visibility === "all" || visibility === "scoped") && linked;
  return { ...visit, appointmentVisibility: visibility,
    appointmentId: show ? visit.appointmentId : null,
    appointmentDate: show ? visit.appointmentDate : null,
    appointmentTime: show ? visit.appointmentTime : null };
}

export function workflowCalendar<N, P extends PlannedVisitCalendar>(snapshot: {
  nextAppointment: N; plannedVisits: P[]; appointmentVisibility?: unknown;
}) {
  let appointmentVisibility = readPatientAppointmentVisibility(snapshot.appointmentVisibility);
  const next = snapshot.nextAppointment as unknown;
  const validNext = next === null || (typeof next === "object" && next !== null
    && "id" in next && Number.isSafeInteger(next.id) && Number(next.id) > 0
    && "date" in next && typeof next.date === "string" && next.date.length > 0
    && "time" in next && typeof next.time === "string" && next.time.length > 0);
  if ((appointmentVisibility === "all" || appointmentVisibility === "scoped") && !validNext) appointmentVisibility = "unknown";
  const readable = appointmentVisibility === "all" || appointmentVisibility === "scoped";
  return {
    appointmentVisibility,
    nextAppointment: readable ? snapshot.nextAppointment : null,
    plannedVisits: snapshot.plannedVisits.map((visit) => readWorkflowPlannedAppointment(visit, appointmentVisibility)),
  };
}

/** Read certainty only, never booking authority; existing action/API checks still apply. */
export function isConfirmedUnscheduled(visit: PlannedVisitCalendar & { status: string }): boolean {
  return visit.appointmentVisibility === "all" && visit.status === "planned"
    && visit.appointmentId === null && visit.appointmentDate === null && visit.appointmentTime === null;
}

export function workflowAppointmentEmptyText(visibility: PatientAppointmentReadVisibility): string {
  if (visibility === "all") return "لا يوجد موعد قادم";
  if (visibility === "scoped") return "لا يظهر موعد قادم ضمن نطاق القراءة؛ قد توجد مواعيد أخرى غير ظاهرة";
  if (visibility === "hidden") return "تفاصيل المواعيد محجوبة ضمن الوصول الحالي";
  return "قراءة المواعيد غير مؤكدة؛ أعد تحميل الملخص";
}

/** This known alert asserts booking absence; clinical plan progress remains separate. */
export function workflowCalendarAlertVisible(kind: string, visibility: PatientAppointmentReadVisibility): boolean {
  return kind !== "unscheduled_visit" || visibility === "all";
}
