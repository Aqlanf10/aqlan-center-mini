import { readPatientAppointmentVisibility } from "./appointment-read-scope";
import { isConfirmedUnscheduled, readWorkflowPlannedAppointment, type PlannedVisitCalendar } from "./patient-workflow-calendar";

/** Same calendar-read contract as workflow; never derives booking/write authority. */
export function patientPlanCalendar<P extends PlannedVisitCalendar>(snapshot: {
  plannedVisits: P[]; appointmentVisibility?: unknown;
}) {
  const appointmentVisibility = readPatientAppointmentVisibility(snapshot.appointmentVisibility);
  return {
    appointmentVisibility,
    plannedVisits: snapshot.plannedVisits.map((visit) => readWorkflowPlannedAppointment(visit, appointmentVisibility)),
  };
}

/** Used only after patientPlanCalendar has removed unreadable calendar fields. */
export function patientPlanAppointmentEmptyText(visit: PlannedVisitCalendar & { status: string }): string {
  if (visit.appointmentVisibility === "hidden") return "تفاصيل موعد الزيارة محجوبة ضمن الوصول الحالي";
  if (visit.appointmentVisibility === "scoped") return "موعد الزيارة غير ظاهر ضمن نطاق القراءة؛ قد يوجد حجز غير ظاهر";
  if (visit.appointmentVisibility !== "all") return "قراءة موعد الزيارة غير مؤكدة؛ أعد تحميل الخطط";
  return isConfirmedUnscheduled(visit) ? "لم يُحدد موعد لهذه الزيارة" : "لا يظهر موعد مرتبط بهذه الزيارة؛ راجع الملخص";
}
