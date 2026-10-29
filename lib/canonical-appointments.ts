import "server-only";
import { CLINIC_TIME_ZONE, labWorkForPatientsWith, listAppointmentsByDateWith, patientInDoctorScopeWith } from "./db";
import { PATIENT_CARE_CAPABILITIES } from "./canonical-patient-reads";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { readDoctorDailyScheduleWith, resolveScheduleDate, type DoctorDailySchedule } from "./doctor-daily-schedule";
import { labReadinessFor, type LabReadinessItem } from "./lab-readiness";
import { addDays, clinicDateString, type Appointment } from "./schedule";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Canonical appointment reads (M2 slice 15): GET /api/appointments?date= and
 * GET /api/appointments/mine.
 *
 * Day list: the record read `read:appointments.day`, one owning snapshot. Rows follow the
 * CURRENT appointment scope with its established meaning (slice 2): `all` lists every
 * appointment of the day; `own` lists the appointments assigned to the actor's clinician
 * party. The legacy doctor view also listed unassigned appointments and other doctors'
 * appointments of its patients; the canonical `own` scope does not. A role label never
 * widens it. Projection:
 *  - identity: the appointment as the schedule shows it (patient name and phone, time,
 *    service, doctor, status, lifecycle stamps, the booking note);
 *  - lab readiness («has the work arrived?», no cost or price): the operational summary
 *    (a clinical grant or `patients.operational-summary.view`), computed after the row
 *    filter so it never reveals another patient's work.
 * Personal schedule: `read:appointments.mine`. Only the actor's own validated clinician
 * party, never a client-selected doctor; the patient link is offered only when the
 * patient is inside the actor's CURRENT patient scope.
 */
export const APPOINTMENT_DAY_MAX_BYTES = 1024 * 1024;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class CanonicalAppointmentRefusal extends Error {
  constructor(readonly code: "invalid_appointment_query" | "clinician_link_required", readonly status: 400 | 403, message: string) {
    super(message);
    this.name = "CanonicalAppointmentRefusal";
  }
}

export interface CanonicalAppointmentDay {
  readonly appointments: readonly (Appointment & { labReadiness?: LabReadinessItem[] })[];
  readonly projection: { readonly labReadiness: boolean };
}

export async function readCanonicalAppointmentDay(session: VerifiedDurableSession, date: string): Promise<CanonicalAppointmentDay> {
  if (!DATE_PATTERN.test(date)) throw new CanonicalAppointmentRefusal("invalid_appointment_query", 400, "تاريخ غير صالح.");
  return runCanonicalReadSnapshot(session, "read:appointments.day", async (query, scope) => {
    if (scope.appointmentScope.kind !== "own" && scope.appointmentScope.kind !== "all") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const doctorPartyId = scope.appointmentScope.kind === "own" ? scope.appointmentScope.clinicianPartyId : null;
    const appointments = await listAppointmentsByDateWith(query, date, doctorPartyId);
    const labReadiness = PATIENT_CARE_CAPABILITIES.some(capability => scope.granted(capability)) || scope.granted("patients.operational-summary.view");
    if (!labReadiness || appointments.length === 0) return { appointments, projection: { labReadiness } };
    const works = await labWorkForPatientsWith(query, appointments.map(appointment => appointment.patientId));
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    return {
      appointments: appointments.map(appointment => {
        const own = works.filter(work => work.patientId === appointment.patientId);
        return own.length === 0 ? appointment : { ...appointment, labReadiness: labReadinessFor(own, date, today) };
      }),
      projection: { labReadiness },
    };
  }, { errorPrefix: "STAFF_READ", maxBytes: APPOINTMENT_DAY_MAX_BYTES });
}

export async function readCanonicalMySchedule(session: VerifiedDurableSession, requestDate: string): Promise<DoctorDailySchedule> {
  const now = new Date();
  const date = resolveScheduleDate(requestDate, now, CLINIC_TIME_ZONE);
  if (!date) throw new CanonicalAppointmentRefusal("invalid_appointment_query", 400, "تاريخ غير صالح.");
  return runCanonicalReadSnapshot(session, "read:appointments.mine", async (query, scope) => {
    const doctorId = scope.clinicianPartyId;
    if (doctorId === null) throw new CanonicalAppointmentRefusal("clinician_link_required", 403, "الحساب غير مرتبط بطبيب نشط.");
    const rows = await readDoctorDailyScheduleWith(query, doctorId, date);
    if (!rows) throw new CanonicalAppointmentRefusal("clinician_link_required", 403, "الحساب غير مرتبط بطبيب نشط.");
    const today = clinicDateString(now, CLINIC_TIME_ZONE);
    const opens = new Map<number, boolean>();
    for (const patientId of new Set(rows.map(row => row.patientId))) {
      opens.set(patientId, scope.patientScope.kind === "all"
        || (scope.patientScope.kind === "own" && await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, patientId)));
    }
    const cancelled = rows.filter(row => row.status === "cancelled").length;
    return {
      requestDate, date, today, tomorrow: addDays(today, 1), timeZone: CLINIC_TIME_ZONE, generatedAt: new Date().toISOString(),
      appointments: rows.map(row => ({ ...row, patientHref: opens.get(row.patientId) ? `/patients/${row.patientId}` : null })),
      counts: { total: rows.length, cancelled, scheduled: rows.length - cancelled },
    };
  }, { errorPrefix: "STAFF_READ", maxBytes: APPOINTMENT_DAY_MAX_BYTES });
}
