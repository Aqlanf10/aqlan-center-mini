/** Read visibility only. This must never authorize appointment or patient writes. */
export type AppointmentReadScope =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "doctor"; doctorPartyId: number; ownedPatientIds: ReadonlySet<number> };

export function canReadAppointment(
  scope: AppointmentReadScope,
  appointment: { patientId: number; doctorId?: number | null },
): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "none") return false;
  return !appointment.doctorId || appointment.doctorId === scope.doctorPartyId
    || scope.ownedPatientIds.has(appointment.patientId);
}

/** Authority for the patient-local list, independent of row count or its 50-row cap. */
export type PatientAppointmentVisibility = "all" | "scoped" | "hidden";

/** A legacy or malformed response makes no positive calendar-read assertion. */
export type PatientAppointmentReadVisibility = PatientAppointmentVisibility | "unknown";

export function readPatientAppointmentVisibility(value: unknown): PatientAppointmentReadVisibility {
  return value === "all" || value === "scoped" || value === "hidden" ? value : "unknown";
}


export function patientAppointmentVisibility(
  scope: AppointmentReadScope,
  patientId: number,
): PatientAppointmentVisibility {
  if (scope.kind === "none") return "hidden";
  if (scope.kind === "all" || scope.ownedPatientIds.has(patientId)) return "all";
  return "scoped";
}

/** Parameters for the patient-local SQL projection; $1 remains the patient ID. */
export function patientAppointmentReadParameters(
  scope: AppointmentReadScope,
  patientId: number,
): [boolean, number | null] {
  return [
    patientAppointmentVisibility(scope, patientId) === "all",
    scope.kind === "doctor" ? scope.doctorPartyId : null,
  ];
}

/** Apply before LIMIT and only alongside a.patient_id = the requested patient. */
export const PATIENT_APPOINTMENT_READ_SQL =
  "($2::boolean OR ($3::int IS NOT NULL AND (COALESCE(a.doctor_id, 0) = 0 OR a.doctor_id = $3::int)))";
