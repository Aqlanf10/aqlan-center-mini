import "server-only";
import { CLINIC_TIME_ZONE, getPool, insertAuditRow, labWorkForPatientsWith, listAppointmentsByDateWith, patientInDoctorScopeWith } from "./db";
import { bookAppointment, type BookAppointmentInput, type BookingConflict } from "./book-appointment";
import type { ReturnBookingSource } from "./return-booking-context";
import { staffOperationAppointmentScope, staffOperationCapabilities, staffOperationIdentity, withStaffOperation } from "./staff-operation-runtime";
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
  constructor(
    readonly code: "invalid_appointment_query" | "clinician_link_required" | "invalid_booking_input" | "patient_not_found" | "booking_doctor_not_allowed" | "booking_refused",
    readonly status: 400 | 403 | 404,
    message: string,
    /** The engine's own refusal code (for example return_booking_context_required). */
    readonly engineCode?: string,
  ) {
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

/* ---------------------------------------------------------------------------
 * M2 slice 16: booking (POST /api/appointments) through the same capacity engine.
 *
 * One admitted `appointments.create` transaction: the engine's day locks, judgement and
 * insert run on it (writeAppointmentInDay with the caller's client), so the booking,
 * its creation audit row and any capacity-override audit row commit or roll back
 * together. Admission rules:
 *  - the patient must be inside the actor's CURRENT appointment scope's reach: `all`
 *    books any patient; `own` books only the clinician's own patients (the patient
 *    list's condition), so a booking never pulls a new patient into the clinician's
 *    scope; outside answers like a missing patient (404);
 *  - `own` books on its own clinician party only (the default); another doctor is
 *    refused, and a return booking whose case clinician is someone else rolls back;
 *  - overriding capacity needs `appointments.override-capacity` (never a role label);
 *    the written reason and the override are audited in the same transaction.
 * Every engine refusal (validation, capacity conflict, return-booking context) rolls
 * the transaction back and answers as the legacy route does (400 with its code, or
 * 409 with the conflict).
 * ------------------------------------------------------------------------- */
export class CanonicalBookingConflict extends Error {
  constructor(readonly conflict: BookingConflict) {
    super("booking conflict");
    this.name = "CanonicalBookingConflict";
  }
}

/** The legacy route's body rules (same helpers, same bounds). */
export function parseCanonicalBooking(body: unknown): BookAppointmentInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CanonicalAppointmentRefusal("invalid_booking_input", 400, "طلب غير صالح.");
  const source = body as Record<string, unknown>;
  const text = (key: string, max: number): string | null => {
    const value = source[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
  };
  const integer = (key: string): number | null => {
    const value = Number(source[key]);
    return Number.isInteger(value) && value > 0 ? value : null;
  };
  return {
    patientId: Number(source.patientId),
    date: typeof source.date === "string" ? source.date : "",
    time: typeof source.time === "string" ? source.time : "",
    durationMinutes: source.durationMinutes == null ? null : Number(source.durationMinutes),
    serviceId: integer("serviceId"),
    appointmentType: text("appointmentType", 60),
    bookingIntent: source.bookingIntent === "ortho_follow_up" ? "ortho_follow_up" : undefined,
    note: text("note", 300),
    doctorId: integer("doctorId"),
    chairNo: source.chairNo == null || source.chairNo === "" ? null : Number(source.chairNo),
    overrideReason: text("overrideReason", 300),
    nearbyAppointmentConfirmation: text("nearbyAppointmentConfirmation", 4096),
    returnBookingSource: source.returnBookingSource as ReturnBookingSource | null | undefined,
    returnBookingOrigin: source.returnBookingOrigin as ReturnBookingSource | null | undefined,
    returnBookingFingerprint: text("returnBookingFingerprint", 128),
    isNewPatient: source.isNewPatient === true,
  };
}

export async function commandCanonicalBooking(session: VerifiedDurableSession, input: BookAppointmentInput, pool = getPool()) {
  const patientId = Number(input.patientId);
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw new CanonicalAppointmentRefusal("invalid_booking_input", 400, "اختر المريض أولًا.");
  return withStaffOperation(pool, session, "appointments.create", async (client, handle) => {
    const scope = await staffOperationAppointmentScope(client, handle, "appointments.create");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const clinician = scope.kind === "own" ? scope.clinicianPartyId : null;
    // No row lock here: the engine takes the day locks next (legacy order), and the
    // insert's foreign key holds the patient row against deletion.
    const { rows } = await client.query("SELECT id FROM patients WHERE id = $1", [patientId]);
    const inside = rows.length === 1 && (clinician === null || await patientInDoctorScopeWith(client, clinician, patientId));
    if (!inside) throw new CanonicalAppointmentRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
    if (clinician !== null && input.doctorId != null && input.doctorId !== clinician) {
      throw new CanonicalAppointmentRefusal("booking_doctor_not_allowed", 403, "تحجز مواعيد مرضاك على اسمك فقط.");
    }
    const identity = await staffOperationIdentity(client, handle, "appointments.create");
    const held = await staffOperationCapabilities(client, handle, "appointments.create", ["appointments.override-capacity"]);
    const audit = (row: Parameters<typeof insertAuditRow>[1]) => insertAuditRow(client, row);
    // Role "canonical" is a display label the engine never matches: neither the admin
    // override nor the doctor self-assignment applies; grants and scope decide.
    const result = await bookAppointment({ ...input, patientId, doctorId: clinician ?? input.doctorId ?? null }, {
      username: identity.username, userId: identity.userId, role: "canonical", doctorPartyId: null,
      canOverrideCapacity: held.has("appointments.override-capacity"), channel: "ui",
    }, { client, audit });
    if (!result.ok) {
      if (result.status === 409) throw new CanonicalBookingConflict(result.conflict);
      throw new CanonicalAppointmentRefusal("booking_refused", 400, result.message, result.code);
    }
    if (clinician !== null && result.appointment.doctorId !== clinician) {
      throw new CanonicalAppointmentRefusal("booking_doctor_not_allowed", 403, "موعد العودة يخص طبيب الحالة المسؤول؛ يحجزه من يملك نطاق المواعيد كاملًا.");
    }
    await audit({
      action: "appointment.create", entity: "appointment", entityId: result.appointment.id, entityLabel: result.appointment.patientName,
      details: { التاريخ: result.appointment.scheduledDate, الوقت: result.appointment.scheduledTime, الطبيب: result.appointment.doctorId ?? "", التجاوز: result.overridden },
      actor: identity.username, actorRole: identity.role,
    });
    return result;
  });
}
