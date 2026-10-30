import "server-only";
import { createNextSessionWith, doctorOwnsPatient, getPool, insertAuditRow, lockAppointmentServiceForBooking, patientInDoctorScopeWith, prepareNextSessionPatient, resolveServiceByLegacyTypeWith, writeAppointmentInDay } from "./db";
import { loadCapacityContextWith } from "./capacity-context";
import { actorCanOverride, judgeBookingInDay, recordCapacityOverride } from "./book-appointment";
import { MAX_DURATION, MIN_DURATION } from "./appointment-services";
import { parseReturnBookingSource, readReturnBookingContext } from "./return-booking-context";
import { toWhatsAppNumber } from "./reminders";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationAppointmentScope, staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalNextSessionRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string) { super(message); this.name = "CanonicalNextSessionRefusal"; }
}
const missing = () => new CanonicalNextSessionRefusal("visit_not_found", 404, "لا توجد زيارة بهذا الرقم ضمن مرضاك.");
const invalid = (message: string) => new CanonicalNextSessionRefusal("invalid_next_session", 400, message);
class BookingNotDone extends Error { constructor(readonly conflict: unknown) { super("next session not booked"); } }

/** Slice 28. Same next-session writer and capacity engine, admitted on ONE client.
 * Day window → visit → NOWAIT patient/scope/context witnesses, preserving the old
 * order without waiting backwards against clinical writers. Patient admission is
 * before the walk-in link, so linking/booking cannot manufacture its own access.
 * Current authority is proved after waits and again before commit by the runtime.
 * Refusals (including context/capacity) roll back file/link/phone changes and audits.
 * This is not a durable request receipt: overlap blocks identical live bookings;
 * clients must verify an uncertain outcome and obtain a new intent before retrying.
 */
export async function commandCanonicalNextSession(session: VerifiedDurableSession, visitId: number, body: unknown, pool = getPool()) {
  if (!Number.isSafeInteger(visitId) || visitId <= 0) throw invalid("رقم الزيارة غير صالح.");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("طلب غير صالح.");
  const source = body as Record<string, unknown>;
  const date = typeof source.date === "string" ? source.date : "", time = typeof source.time === "string" ? source.time : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw invalid("التاريخ غير صالح.");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw invalid("الوقت غير صالح.");
  const durationMinutes = Number(source.durationMinutes ?? 30);
  if (!Number.isInteger(durationMinutes) || durationMinutes < MIN_DURATION || durationMinutes > MAX_DURATION) throw invalid(`المدّة يجب أن تكون بين ${MIN_DURATION} و${MAX_DURATION} دقيقة.`);
  const note = typeof source.note === "string" ? source.note.trim().slice(0, 300) || null : null;
  const rawPhone = typeof source.phone === "string" ? source.phone.trim() : "";
  const phone = rawPhone ? toWhatsAppNumber(rawPhone) : null;
  if (rawPhone && !phone) throw invalid("رقم الجوال غير صالح.");
  try {
    return await withStaffOperation(pool, session, "appointments.create", async (client, handle) => {
      const scope = await staffOperationPatientScope(client, handle, "appointments.create");
      const appointments = await staffOperationAppointmentScope(client, handle, "appointments.create");
      if (scope.kind === "none" || appointments.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      // A lock-free preflight avoids revealing even the existence of another's visit.
      // The exact same check is repeated after the day and visit locks.
      const admitVisit = async (lock: boolean) => {
        const { rows: [visit] } = await client.query<{ patient_id: number | null; doctor_id: number | null }>(
          `SELECT patient_id,doctor_id FROM visits WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [visitId]);
        await assertStaffOperation(client, handle, "appointments.create");
        if (!visit || (scope.kind === "own" && (visit.patient_id === null ? visit.doctor_id !== scope.clinicianPartyId
          : !await patientInDoctorScopeWith(client, scope.clinicianPartyId, visit.patient_id)))) throw missing();
      };
      await admitVisit(false);
      const identity = await staffOperationIdentity(client, handle, "appointments.create");
      const held = await staffOperationCapabilities(client, handle, "appointments.create", ["appointments.override-capacity", "patients.create"]);
      const actor = { username: identity.username, role: "canonical", channel: "visit" as const, canOverrideCapacity: held.has("appointments.override-capacity") };
      const overrideReason = typeof source.overrideReason === "string" ? source.overrideReason.trim().slice(0, 300) : "";
      let doctorId = 0, doctorName = "";
      let overrideAudit: ((appointmentId: number) => Promise<void>) | undefined;
      const result = await writeAppointmentInDay({ client, date,
        judge: async (sameDay, client) => {
          await admitVisit(true);
          const patientId = await prepareNextSessionPatient(client, { visitId, phone }, async target => {
            await assertStaffOperation(client, handle, "appointments.create");
            if (target === null) {
              if (!held.has("patients.create")) throw new CanonicalNextSessionRefusal("patient_create_required", 403, "إنشاء ملف المريض يحتاج صلاحية إنشاء المرضى.");
              return;
            }
            // Match the central patient predicate, with a positive witness held to
            // commit. NOWAIT refuses clinical lock inversions without leaking SQL.
            // The resolver may fill an empty phone. Take its write lock now;
            // two far-apart day windows must not upgrade SHARE locks together.
            const found = await client.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE NOWAIT", [target]);
            if (!found.rows.length || (scope.kind === "own" && !await doctorOwnsPatient(scope.clinicianPartyId, target, client, "nowait"))) throw missing();
          });
          if (patientId === null) throw missing();
          if (typeof source.returnBookingFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(source.returnBookingFingerprint)) throw new CanonicalNextSessionRefusal("return_booking_context_required", 409, "تحقّق من سياق العودة والطبيب المسؤول قبل الحجز.");
          const origin = { kind: "visit" as const, id: visitId };
          const selected = source.returnBookingSource === undefined ? origin : parseReturnBookingSource(source.returnBookingSource);
          if (!selected) throw new CanonicalNextSessionRefusal("return_booking_source_invalid", 400, "اختر الحالة المرتبطة بهذه الزيارة.");
          const responsible = await readReturnBookingContext(client, patientId, selected, { lock: true, origin });
          if (!responsible.ok) throw new CanonicalNextSessionRefusal(responsible.code, 409, responsible.message);
          if (source.returnBookingFingerprint !== responsible.fingerprint) throw new CanonicalNextSessionRefusal("return_booking_source_changed", 409, "تغيّر الطبيب المسؤول. حدّث اقتراح الحجز وراجعه قبل التأكيد.");
          doctorId = responsible.doctorId; doctorName = responsible.doctorName;
          if (appointments.kind === "own" && doctorId !== appointments.clinicianPartyId) throw new CanonicalNextSessionRefusal("next_session_doctor_not_allowed", 403, "هذه الجلسة تُحجز على طبيب الحالة المسؤول؛ يحجزها من يملك نطاق المواعيد كاملًا.");
          const serviceId = Number(source.serviceId) > 0 ? Number(source.serviceId) : null;
          const legacyService = !serviceId && typeof source.appointmentType === "string" ? await resolveServiceByLegacyTypeWith(client, source.appointmentType) : null;
          const service = serviceId || legacyService ? await lockAppointmentServiceForBooking(client, serviceId ?? legacyService!.id) : null;
          const context = await loadCapacityContextWith(client);
          await assertStaffOperation(client, handle, "appointments.create");
          const judged = await judgeBookingInDay({ sameDay, client, date, time, durationMinutes, service, context,
            providerId: doctorId, requireAssignedProvider: true, patientId, canOverride: actorCanOverride(actor), overrideReason,
            nearbyAppointmentConfirmation: typeof source.nearbyAppointmentConfirmation === "string" ? source.nearbyAppointmentConfirmation.slice(0, 4096) : null,
            bookingActor: `${identity.userId}:${identity.username}`, bookingScope: JSON.stringify({ entry: "next-visit", visitId, phone, note, source: selected, fingerprint: responsible.fingerprint }),
          });
          if (!judged.ok) return { ok: false, conflict: judged.conflict };
          // Retain the exact judgement for the atomic override audit after insert.
          if (judged.overridden) overrideAudit = async appointmentId => recordCapacityOverride({ appointmentId, verdict: judged.verdict, date, time,
            reason: overrideReason, serviceName: service?.nameAr, actor: identity.username, actorRole: identity.role, channel: "visit" }, row => insertAuditRow(client, row));
          return { ok: true };
        },
        commit: async client => {
          await assertStaffOperation(client, handle, "appointments.create");
          const created = await createNextSessionWith(client, { visitId, date, time, durationMinutes, phone, note, doctorId });
          if (!created) throw missing();
          await insertAuditRow(client, { action: "appointment.create", entity: "appointment", entityId: created.appointmentId,
            details: { المصدر: "الجلسة القادمة", الزيارة: visitId, المريض: created.patientId, الطبيب: doctorId, التاريخ: date, الوقت: time, المدّة: durationMinutes }, actor: identity.username, actorRole: identity.role });
          await overrideAudit?.(created.appointmentId);
          return { ...created, doctorId, doctorName };
        },
      });
      if (!result.ok) throw new BookingNotDone(result.conflict);
      return { ok: true as const, value: result.value };
    });
  } catch (error) {
    if (error instanceof BookingNotDone) return { ok: false as const, conflict: error.conflict };
    throw error;
  }
}
