import "server-only";
import { CLINIC_TIME_ZONE, arriveAppointmentWith, deleteAppointmentWith, findAppointmentForWaitingWith, getAppointmentWith, getWaitingEntryWith, markWaitingBookedWith, getPool, insertAuditRow, labWorkForPatientsWith, listAppointmentsByDateWith, patientInDoctorScopeWith, transitionAppointmentInTransaction } from "./db";
import { reasonAcceptable, requiresReason } from "./appointment-lifecycle";
import { CanonicalWaitingRefusal, readCanonicalFreedSlotCandidates } from "./canonical-waiting-list";
import type { WaitingEntry } from "./waiting-list";
import { parseReturnBookingSource } from "./return-booking-source";
import { STALE_MANUAL_REMINDER_MESSAGE, readManualReminderSnapshot, recordManualAppointmentReminder } from "./manual-appointment-reminder";
import { bookAppointment, rescheduleAppointment, type BookAppointmentInput, type BookingConflict, type RescheduleInput } from "./book-appointment";
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
    readonly code: "invalid_appointment_query" | "clinician_link_required" | "invalid_booking_input" | "patient_not_found" | "booking_doctor_not_allowed" | "booking_refused"
      | "appointment_not_found" | "appointment_move_conflict",
    readonly status: 400 | 403 | 404 | 409,
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

/* ---------------------------------------------------------------------------
 * M2 slice 17: appointment moves (PATCH /api/appointments/[id]): arrive, reminded,
 * cancel, no_show, close_done, close_no_show.
 *
 * One admitted `appointments.edit` transaction (the route's requirement), plus each
 * branch's own capability proved through the same handle: arrive and the past-day
 * closes need `visits.manage`; cancel and no_show need `appointments.cancel`. The
 * appointment row is locked first — the order every legacy appointment writer uses —
 * then checked against the CURRENT appointment scope (`own`: assigned to the clinician
 * party); a missing appointment and one outside the scope answer identically (404).
 * The domain writers run on the same transaction (arriveAppointmentWith,
 * transitionAppointmentInTransaction, the reminder writer) and keep their rules and
 * status log; an audit row with the canonical actor commits with every move. Any
 * refusal rolls back. Rescheduling is its own command below (slice 18). After a cancel,
 * no-show or past no-show commits, `waiting` carries how many entries inside the actor's
 * scope fit the freed slot (slice 19), best effort, as the legacy route does.
 * ------------------------------------------------------------------------- */
const APPOINTMENT_MOVES = ["arrive", "reminded", "cancel", "no_show", "close_done", "close_no_show"] as const;
type AppointmentMove = typeof APPOINTMENT_MOVES[number];
export interface CanonicalAppointmentMoveInput { readonly action: AppointmentMove; readonly reason: string | null; readonly snapshot: unknown }

export function parseCanonicalAppointmentMove(body: unknown): CanonicalAppointmentMoveInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CanonicalAppointmentRefusal("invalid_booking_input", 400, "طلب غير صالح.");
  const source = body as Record<string, unknown>;
  if (typeof source.action !== "string" || !(APPOINTMENT_MOVES as readonly string[]).includes(source.action)) throw new CanonicalAppointmentRefusal("invalid_booking_input", 400, "إجراء غير معروف.");
  const reason = typeof source.reason === "string" ? source.reason.trim().slice(0, 300) || null : null;
  return { action: source.action as AppointmentMove, reason, snapshot: source.snapshot };
}

const MOVE_NEEDS: Record<AppointmentMove, "visits.manage" | "appointments.cancel" | null> = {
  arrive: "visits.manage", close_done: "visits.manage", close_no_show: "visits.manage",
  cancel: "appointments.cancel", no_show: "appointments.cancel", reminded: null,
};
// A reminder records contact; the status stays as it was.
const MOVE_STATUS: Partial<Record<AppointmentMove, string>> = {
  arrive: "arrived", cancel: "cancelled", no_show: "no_show", close_done: "done", close_no_show: "no_show",
};

export interface FreedSlotSummary { readonly count: number; readonly slot: { readonly date: string; readonly time: string } }

/** Who waits for the slot just freed: a count and the slot only (names come from the
 * waiting-list route under its own guard). Best effort after the commit, like the
 * legacy route: a failure never fails the move that already happened. */
export async function canonicalFreedSlotSummary(session: VerifiedDurableSession, request: { appointmentId: number; date: string; time: string }): Promise<FreedSlotSummary | null> {
  try {
    const match = await readCanonicalFreedSlotCandidates(session, request);
    return match && match.candidates.length > 0 ? { count: match.candidates.length, slot: { date: match.slot.date, time: match.slot.time } } : null;
  } catch {
    return null;
  }
}

const FREES_SLOT: ReadonlySet<AppointmentMove> = new Set(["cancel", "no_show", "close_no_show"]);

export async function commandCanonicalAppointmentMove(session: VerifiedDurableSession, id: number, move: CanonicalAppointmentMoveInput, pool = getPool()): Promise<{ ok: true; waiting: FreedSlotSummary | null }> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new CanonicalAppointmentRefusal("invalid_booking_input", 400, "رقم الموعد غير صالح.");
  const moved = await withStaffOperation(pool, session, "appointments.edit", async (client, handle) => {
    const need = MOVE_NEEDS[move.action];
    if (need && !(await staffOperationCapabilities(client, handle, "appointments.edit", [need])).has(need)) throw new Error("STAFF_OPERATION_CAPABILITY_DENIED");
    const scope = await staffOperationAppointmentScope(client, handle, "appointments.edit");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const { rows: [appointment] } = await client.query<{ patient_id: number; doctor_id: number | null; status: string; date: string; time: string }>(
      "SELECT patient_id, doctor_id, status, to_char(scheduled_date, 'YYYY-MM-DD') AS date, to_char(scheduled_time, 'HH24:MI') AS time FROM appointments WHERE id = $1 FOR UPDATE", [id]);
    if (!appointment || (scope.kind === "own" && appointment.doctor_id !== scope.clinicianPartyId)) {
      throw new CanonicalAppointmentRefusal("appointment_not_found", 404, "لا يوجد موعد بهذا الرقم ضمن مواعيدك.");
    }
    const identity = await staffOperationIdentity(client, handle, "appointments.edit");
    const who = { actor: identity.username, actorRole: identity.role };
    const conflict = (message: string): never => { throw new CanonicalAppointmentRefusal("appointment_move_conflict", 409, message); };
    switch (move.action) {
      case "arrive":
        if (!await arriveAppointmentWith(client, id, who)) conflict("سُجّل وصوله بالفعل أو تغيّرت حالة الموعد.");
        break;
      case "reminded": {
        const snapshot = readManualReminderSnapshot(move.snapshot);
        if (!snapshot) throw new CanonicalAppointmentRefusal("invalid_booking_input", 400, "بيانات التذكير المعروض غير صالحة. حدّث القائمة قبل التأكيد.");
        if (!await recordManualAppointmentReminder(id, appointment.patient_id, snapshot, client)) conflict(STALE_MANUAL_REMINDER_MESSAGE);
        break;
      }
      case "cancel":
      case "no_show": {
        const to = move.action === "cancel" ? "cancelled" : "no_show";
        const reason = move.reason ?? (to === "cancelled" ? "أُلغي من شاشة اليوم" : null);
        if (requiresReason(to) && !reasonAcceptable(reason)) throw new CanonicalAppointmentRefusal("invalid_booking_input", 400, "اكتب سبب الإلغاء.");
        const result = await transitionAppointmentInTransaction(client, id, to, { ...who, reason });
        if (!result.ok) conflict("تغيّرت حالة الموعد — حدّث القائمة.");
        break;
      }
      case "close_done":
      case "close_no_show": {
        const to = move.action === "close_done" ? "done" : "no_show";
        if (requiresReason(to) && !reasonAcceptable(move.reason)) throw new CanonicalAppointmentRefusal("invalid_booking_input", 400, "اكتب سبب الإلغاء.");
        const result = await transitionAppointmentInTransaction(client, id, to, { ...who, reason: move.reason }, { pastBookingOnly: true });
        if (!result.ok) conflict("الموعد لم يعد معلّقًا — حدّث القائمة.");
        break;
      }
    }
    await insertAuditRow(client, {
      action: "appointment.update", entity: "appointment", entityId: id,
      details: { الإجراء: move.action, من: appointment.status, إلى: MOVE_STATUS[move.action] ?? appointment.status, السبب: move.reason ?? "" },
      actor: identity.username, actorRole: identity.role,
    });
    return { date: appointment.date, time: appointment.time };
  });
  return { ok: true, waiting: FREES_SLOT.has(move.action) ? await canonicalFreedSlotSummary(session, { appointmentId: id, ...moved }) : null };
}

/* ---------------------------------------------------------------------------
 * M2 slice 18: rescheduling (PATCH /api/appointments/[id], action "reschedule").
 *
 * One admitted `appointments.edit` transaction through THE SAME cross-day capacity
 * engine (`rescheduleAppointment(..., { client, audit })` → `writeAppointmentAcrossDays`
 * on the caller's client). Order: the appointment is read without a row lock, checked
 * against the CURRENT appointment scope (`own`: assigned to the clinician party;
 * missing and outside answer identically, 404); the engine then takes the sorted day
 * locks and locks the row, and its UPDATE keeps the read status, date, time and doctor
 * (`expectedDoctorId`), so a concurrent change between the read and the write is
 * refused, never overwritten. `own` cannot move the appointment to another doctor; a
 * responsibility transfer that would land on someone else rolls back. Overriding
 * capacity needs `appointments.override-capacity`; the reschedule and override audit
 * rows commit with the move. Every engine refusal rolls back and answers with the
 * legacy route's status and code.
 * ------------------------------------------------------------------------- */
export type CanonicalRescheduleInput = Omit<RescheduleInput, "appointmentId">;

/** The legacy route's body rules for "reschedule" (same bounds). */
export function parseCanonicalReschedule(body: unknown): CanonicalRescheduleInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CanonicalAppointmentRefusal("invalid_booking_input", 400, "طلب غير صالح.");
  const source = body as Record<string, unknown>;
  const optional = (key: string): number | null | undefined => source[key] === undefined ? undefined : (source[key] == null ? null : Number(source[key]));
  return {
    date: String(source.date ?? ""),
    time: String(source.time ?? ""),
    durationMinutes: source.durationMinutes == null ? null : Number(source.durationMinutes),
    serviceId: optional("serviceId"),
    doctorId: optional("doctorId"),
    chairNo: optional("chairNo"),
    nearbyAppointmentConfirmation: typeof source.nearbyAppointmentConfirmation === "string" ? source.nearbyAppointmentConfirmation.slice(0, 4096) : null,
    transferToCurrentResponsibleDoctor: source.transferToCurrentResponsibleDoctor === true,
    returnBookingSource: source.returnBookingSource as ReturnBookingSource | null | undefined,
    returnBookingOrigin: source.returnBookingOrigin as ReturnBookingSource | null | undefined,
    returnBookingFingerprint: typeof source.returnBookingFingerprint === "string" ? source.returnBookingFingerprint.slice(0, 128) : null,
    reason: typeof source.reason === "string" ? source.reason.trim().slice(0, 300) : "",
    overrideReason: typeof source.overrideReason === "string" ? source.overrideReason : null,
  };
}

export async function commandCanonicalReschedule(session: VerifiedDurableSession, id: number, input: CanonicalRescheduleInput, pool = getPool()) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new CanonicalAppointmentRefusal("invalid_booking_input", 400, "رقم الموعد غير صالح.");
  return withStaffOperation(pool, session, "appointments.edit", async (client, handle) => {
    const scope = await staffOperationAppointmentScope(client, handle, "appointments.edit");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const clinician = scope.kind === "own" ? scope.clinicianPartyId : null;
    // No row lock here: the engine takes the day locks first (legacy order), then the
    // row; its guarded UPDATE keeps the doctor read here, so this scope check holds.
    const current = await getAppointmentWith(client, id);
    if (!current || (clinician !== null && current.doctorId !== clinician)) {
      throw new CanonicalAppointmentRefusal("appointment_not_found", 404, "لا يوجد موعد بهذا الرقم ضمن مواعيدك.");
    }
    if (clinician !== null && input.doctorId != null && input.doctorId !== clinician) {
      throw new CanonicalAppointmentRefusal("booking_doctor_not_allowed", 403, "تنقل مواعيدك على اسمك فقط.");
    }
    const identity = await staffOperationIdentity(client, handle, "appointments.edit");
    const held = await staffOperationCapabilities(client, handle, "appointments.edit", ["appointments.override-capacity"]);
    const audit = (row: Parameters<typeof insertAuditRow>[1]) => insertAuditRow(client, row);
    // Role "canonical" is a display label the engine never matches: grants decide.
    const result = await rescheduleAppointment({ ...input, appointmentId: id }, {
      username: identity.username, userId: identity.userId, role: "canonical", doctorPartyId: null,
      canOverrideCapacity: held.has("appointments.override-capacity"), channel: "ui",
    }, { client, audit });
    if (!result.ok) {
      if (result.status === 409 && result.conflict) throw new CanonicalBookingConflict(result.conflict);
      if (result.status === 404) throw new CanonicalAppointmentRefusal("appointment_not_found", 404, "لا يوجد موعد بهذا الرقم ضمن مواعيدك.");
      if (result.status === 409) throw new CanonicalAppointmentRefusal("appointment_move_conflict", 409, result.message, result.code);
      throw new CanonicalAppointmentRefusal("booking_refused", 400, result.message, result.code);
    }
    if (clinician !== null && result.appointment.doctorId !== clinician) {
      throw new CanonicalAppointmentRefusal("booking_doctor_not_allowed", 403, "نقل مسؤولية الموعد إلى طبيبٍ آخر لمن يملك نطاق المواعيد كاملًا.");
    }
    return result;
  });
}

/* ---------------------------------------------------------------------------
 * M2 slice 19: deleting an appointment (DELETE /api/appointments/[id]).
 *
 * One admitted `appointments.cancel` transaction (the map's requirement; the legacy
 * route kept it to the admin role, the canonical path to the grant and the scope). The
 * row is locked, then checked against the CURRENT appointment scope (outside = missing,
 * 404); an arrived appointment is refused (409) — it became a visit; the same writer
 * releases a booked referral and unlinks a visit; the audit row (the deleted row's
 * snapshot and the reason) commits with the deletion.
 * ------------------------------------------------------------------------- */
export async function commandCanonicalAppointmentDelete(session: VerifiedDurableSession, id: number, reason: string | null, pool = getPool()): Promise<{ message: string }> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new CanonicalAppointmentRefusal("invalid_booking_input", 400, "رقم الموعد غير صالح.");
  return withStaffOperation(pool, session, "appointments.cancel", async (client, handle) => {
    const scope = await staffOperationAppointmentScope(client, handle, "appointments.cancel");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const { rows: [row] } = await client.query<{ doctor_id: number | null }>("SELECT doctor_id FROM appointments WHERE id = $1 FOR UPDATE", [id]);
    if (!row || (scope.kind === "own" && row.doctor_id !== scope.clinicianPartyId)) {
      throw new CanonicalAppointmentRefusal("appointment_not_found", 404, "لا يوجد موعد بهذا الرقم ضمن مواعيدك.");
    }
    const identity = await staffOperationIdentity(client, handle, "appointments.cancel");
    const result = await deleteAppointmentWith(client, id, { actor: identity.username, actorRole: identity.role, reason });
    if (!result.ok) {
      if (result.reason === "arrived") throw new CanonicalAppointmentRefusal("appointment_move_conflict", 409, "صاحب الموعد وصل وتحوّل زيارةً — لا يُحذف، أُنهِ الزيارة أو ألغِ الموعد.");
      throw new CanonicalAppointmentRefusal("appointment_not_found", 404, "لا يوجد موعد بهذا الرقم ضمن مواعيدك.");
    }
    await insertAuditRow(client, result.audit);
    return { message: "حُذف الموعد وسُجِّل في التدقيق." };
  });
}

/* ---------------------------------------------------------------------------
 * M2 slice 20: booking from the waiting list (PATCH /api/waiting-list/[id], "book").
 *
 * The legacy door claims the entry, books, then marks it booked in three
 * transactions, with recovery for a crash between them. The canonical door does all
 * of it in ONE admitted `appointments.edit` transaction (the route's requirement),
 * plus the branch's `appointments.create`:
 *  1. the entry row is locked (FOR UPDATE) — before the engine's day locks, the order
 *     the legacy claim already uses — then checked against the CURRENT appointment
 *     scope (outside = missing, 404);
 *  2. an entry already booked answers its appointment (no second one); a closed one
 *     refuses; a live legacy claim (< 2 minutes) refuses, so the two doors never book
 *     the same entry twice during the cutover;
 *  3. recovery: an appointment already carrying this entry's id is linked, not
 *     rebooked;
 *  4. the booking goes through `bookAppointment(..., { client, audit })` with the
 *     entry id written with the appointment; `own` books on its own party only;
 *  5. the entry is marked booked in the same transaction; the appointment.create,
 *     any capacity-override and the waiting_list.book rows are atomic.
 * Any refusal rolls everything back: no claim is ever left behind.
 * ------------------------------------------------------------------------- */
export interface CanonicalWaitingBookInput {
  readonly date: string; readonly time: string;
  readonly durationMinutes: number | null; readonly serviceId: number | null; readonly doctorId: number | null; readonly chairNo: number | null;
  readonly overrideReason: string | null; readonly nearbyAppointmentConfirmation: string | null;
  readonly returnBookingSource: ReturnBookingSource | null; readonly returnBookingFingerprint: string | null;
}

/** The legacy route's body rules for "book". */
export function parseCanonicalWaitingBook(body: unknown): CanonicalWaitingBookInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "طلب غير صالح.");
  const source = body as Record<string, unknown>;
  const date = String(source.date ?? ""), time = String(source.time ?? "");
  if (!DATE_PATTERN.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "حدّد تاريخ الموعد ووقته.");
  const returnBookingSource = source.returnBookingSource === undefined ? null : parseReturnBookingSource(source.returnBookingSource);
  if (source.returnBookingSource !== undefined && !returnBookingSource) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "اختر حالة صحيحة للحجز.");
  const number = (key: string) => source[key] == null ? null : Number(source[key]);
  return {
    date, time, durationMinutes: number("durationMinutes"), serviceId: number("serviceId"), doctorId: number("doctorId"), chairNo: number("chairNo"),
    overrideReason: typeof source.overrideReason === "string" ? source.overrideReason : null,
    nearbyAppointmentConfirmation: typeof source.nearbyAppointmentConfirmation === "string" ? source.nearbyAppointmentConfirmation.slice(0, 4096) : null,
    returnBookingSource,
    returnBookingFingerprint: typeof source.returnBookingFingerprint === "string" ? source.returnBookingFingerprint.slice(0, 128) : null,
  };
}

export type CanonicalWaitingBookResult =
  | { ok: true; appointment: Appointment; entry: WaitingEntry; warning: string | null; alreadyBooked: null }
  | { ok: true; appointment: null; entry: WaitingEntry; warning: null; alreadyBooked: number };

const WAITING_NOT_FOUND = "الانتظار غير موجود ضمن مواعيدك.";

export async function commandCanonicalWaitingBook(session: VerifiedDurableSession, waitingId: number, input: CanonicalWaitingBookInput, pool = getPool()): Promise<CanonicalWaitingBookResult> {
  if (!Number.isSafeInteger(waitingId) || waitingId <= 0) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "رقم الانتظار غير صالح.");
  return withStaffOperation(pool, session, "appointments.edit", async (client, handle) => {
    const held = await staffOperationCapabilities(client, handle, "appointments.edit", ["appointments.create", "appointments.override-capacity"]);
    if (!held.has("appointments.create")) throw new Error("STAFF_OPERATION_CAPABILITY_DENIED");
    const scope = await staffOperationAppointmentScope(client, handle, "appointments.edit");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const clinician = scope.kind === "own" ? scope.clinicianPartyId : null;
    const { rows: [locked] } = await client.query<{ claimed: boolean }>(
      "SELECT (booking_claim_at IS NOT NULL AND booking_claim_at >= NOW() - INTERVAL '2 minutes') AS claimed FROM waiting_list WHERE id = $1 FOR UPDATE", [waitingId]);
    const entry = locked ? await getWaitingEntryWith(client, waitingId) : null;
    if (!entry || (clinician !== null && entry.doctorId !== clinician)) throw new CanonicalWaitingRefusal("waiting_not_found", 404, WAITING_NOT_FOUND);
    if (entry.status === "booked" && entry.appointmentId) return { ok: true, appointment: null, entry, warning: null, alreadyBooked: entry.appointmentId };
    if (entry.status !== "waiting" && entry.status !== "offered") throw new CanonicalWaitingRefusal("waiting_conflict", 409, "هذا الانتظار مُغلقٌ سلفًا.");
    if (locked.claimed) throw new CanonicalWaitingRefusal("waiting_conflict", 409, "زميلٌ آخر يحجز لهذا المريض الآن. انتظر لحظة ثم أعد المحاولة.");
    const identity = await staffOperationIdentity(client, handle, "appointments.edit");
    const who = { actor: identity.username, actorRole: identity.role };
    const audit = (row: Parameters<typeof insertAuditRow>[1]) => insertAuditRow(client, row);

    // Recovery: an appointment already written for this entry is linked, never doubled.
    const orphan = await findAppointmentForWaitingWith(client, waitingId);
    if (orphan) {
      if (clinician !== null && orphan.doctorId !== clinician) throw new CanonicalWaitingRefusal("waiting_not_found", 404, WAITING_NOT_FOUND);
      await markWaitingBookedWith(client, waitingId, orphan.id, who, audit);
      return { ok: true, appointment: orphan, entry: (await getWaitingEntryWith(client, waitingId))!, warning: null, alreadyBooked: null };
    }

    if (clinician !== null && input.doctorId != null && input.doctorId !== clinician) {
      throw new CanonicalAppointmentRefusal("booking_doctor_not_allowed", 403, "تحجز مواعيد مرضاك على اسمك فقط.");
    }
    const preferred = input.returnBookingSource ? null : input.doctorId ?? entry.doctorId ?? null;
    // Role "canonical" is a display label the engine never matches: grants decide.
    const result = await bookAppointment({
      patientId: entry.patientId, date: input.date, time: input.time,
      durationMinutes: input.durationMinutes ?? entry.durationMinutes ?? null,
      serviceId: input.serviceId ?? entry.serviceId ?? null,
      doctorId: clinician ?? preferred,
      returnBookingSource: input.returnBookingSource, returnBookingFingerprint: input.returnBookingFingerprint,
      chairNo: input.chairNo, note: entry.note ?? null,
      overrideReason: input.overrideReason, nearbyAppointmentConfirmation: input.nearbyAppointmentConfirmation,
      waitingListId: waitingId,
    }, {
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
      details: { التاريخ: result.appointment.scheduledDate, الوقت: result.appointment.scheduledTime, الطبيب: result.appointment.doctorId ?? "", التجاوز: result.overridden, "من قائمة الانتظار": waitingId },
      actor: identity.username, actorRole: identity.role,
    });
    const marked = await markWaitingBookedWith(client, waitingId, Number(result.appointment.id), who, audit);
    // The entry row is locked and open: marking cannot miss; a miss is a bug, so roll back.
    if (!marked.ok) throw new Error("WAITING_BOOK_MARK_MISSED");
    return { ok: true, appointment: result.appointment, entry: (await getWaitingEntryWith(client, waitingId))!, warning: result.warning ?? null, alreadyBooked: null };
  });
}
