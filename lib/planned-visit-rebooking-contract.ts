import { parseReturnBookingSource, type ReturnBookingSource } from "./return-booking-source";
/** Read-only eligibility shared by summary projection and locked rebooking.
 * Aliases: v = planned_visits, a = its current appointment, t = its plan,
 * r = appointment referral. ended_at is intentionally NOT attendance evidence:
 * a no-show/cancellation legitimately stamps terminal closure there. */
// A version identifier, not authorization. Keep the full database timestamp:
// a coherent restore can rewind audit IDs before a subsequent reset reuses one.
export const PLANNED_REBOOK_GENERATION_SQL = `(SELECT md5(COALESCE(
  (SELECT id::text || ':' || EXTRACT(EPOCH FROM created_at)::text FROM audit_log
    WHERE action = 'system.reset' ORDER BY id DESC LIMIT 1), 'planned-rebook-initial-v1')))`;

export const PLANNED_REBOOK_BLOCK_REASON_SQL = `CASE
  WHEN a.id IS NULL OR a.status NOT IN ('no_show', 'cancelled') THEN 'not_terminal'
  WHEN v.status NOT IN ('planned', 'scheduled') OR (v.plan_id IS NOT NULL AND (t.id IS NULL OR t.status <> 'active')) THEN 'not_unfinished'
  WHEN a.patient_id IS DISTINCT FROM v.patient_id
    OR (t.id IS NOT NULL AND t.patient_id IS DISTINCT FROM v.patient_id)
    OR a.planned_visit_id IS DISTINCT FROM v.id
    OR EXISTS (SELECT 1 FROM appointments inverse WHERE inverse.planned_visit_id = v.id AND inverse.id <> a.id)
    OR EXISTS (SELECT 1 FROM planned_visits other WHERE other.appointment_id = a.id AND other.id <> v.id)
    OR EXISTS (SELECT 1 FROM treatment_sessions session
      LEFT JOIN plan_items item ON item.id = session.plan_item_id
      LEFT JOIN treatment_plans item_plan ON item_plan.id = item.plan_id
      WHERE session.planned_visit_id = v.id
        AND (item.id IS NULL OR item_plan.id IS NULL OR item_plan.patient_id IS DISTINCT FROM v.patient_id OR item_plan.status <> 'active'))
    THEN 'history_conflict'
  WHEN a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR v.visit_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM appointment_status_log attendance WHERE attendance.appointment_id = a.id
      AND (attendance.from_status IN ('arrived', 'in_progress', 'done') OR attendance.to_status IN ('arrived', 'in_progress', 'done')))
    OR EXISTS (SELECT 1 FROM visits attendance WHERE (attendance.appointment_id = a.id OR attendance.planned_visit_id = v.id)
      AND (attendance.arrived_at IS NOT NULL OR attendance.signed_at IS NOT NULL OR attendance.finished_at IS NOT NULL
        OR attendance.status IN ('waiting', 'called', 'in_chair', 'done')))
    THEN 'attendance_evidence'
  WHEN EXISTS (SELECT 1 FROM treatment_sessions session JOIN plan_items item ON item.id = session.plan_item_id
    WHERE session.planned_visit_id = v.id AND (session.status <> 'planned' OR session.completed_at IS NOT NULL
      OR session.visit_id IS NOT NULL OR item.status IN ('done', 'cancelled')
      OR item.done_at IS NOT NULL OR item.visit_id IS NOT NULL))
    THEN 'completed_treatment'
  WHEN a.referral_id IS NOT NULL AND (r.id IS NULL OR r.patient_id <> v.patient_id OR r.kind <> 'internal'
    OR COALESCE(r.workflow_state, '') NOT IN ('requested', 'accepted') OR r.to_party_id IS NULL
    OR r.to_party_id IS DISTINCT FROM COALESCE(v.doctor_id, a.doctor_id)
    OR EXISTS (SELECT 1 FROM appointments referral_live WHERE referral_live.referral_id = a.referral_id
      AND referral_live.id <> a.id AND referral_live.status IN ('booked', 'arrived', 'in_progress'))) THEN 'referral_unavailable'
  ELSE NULL END`;

export const PLANNED_REBOOK_REASONS = {
  not_terminal: "إعادة الحجز مخصّصة لموعد ملغى أو لم يحضر صاحبه.",
  not_unfinished: "الجلسة أو خطة العلاج ليست مفتوحة لإعادة الحجز.",
  history_conflict: "روابط الجلسة والموعد تحتاج مراجعة قبل إعادة الحجز.",
  attendance_evidence: "يوجد حضور أو زيارة مرتبطة. راجع السجل قبل إنشاء موعد آخر.",
  completed_treatment: "يوجد تنفيذ علاجي مرتبط بهذه الجلسة. راجع الخطة أولًا.",
  referral_unavailable: "الإحالة ليست بانتظار الحجز أو تغير طبيبها. راجع الإحالة أولًا.",
} as const;
export type PlannedRebookBlockReason = keyof typeof PLANNED_REBOOK_REASONS;

export interface PlannedRebookIntent {
  plannedVisitId: number;
  expectedAppointmentId: number;
  expectedGeneration: string;
  date: string;
  time: string;
  reason: string;
  requestId: string;
  nearbyAppointmentConfirmation?: string;
  returnBookingSource?: ReturnBookingSource;
  returnBookingFingerprint?: string;
}
export function parsePlannedRebookIntent(plannedVisitId: number, source: unknown): PlannedRebookIntent | null {
  if (!Number.isSafeInteger(plannedVisitId) || plannedVisitId <= 0 || plannedVisitId > 2147483647 || !source || typeof source !== "object" || Array.isArray(source)) return null;
  const input = source as Record<string, unknown>;
  if (Object.keys(input).some(key => !["expectedAppointmentId", "expectedGeneration", "date", "time", "reason", "requestId", "nearbyAppointmentConfirmation", "returnBookingSource", "returnBookingFingerprint"].includes(key))) return null;
  const { expectedAppointmentId, expectedGeneration, date, time, reason, requestId } = input;
  if (typeof expectedAppointmentId !== "number" || !Number.isSafeInteger(expectedAppointmentId) || expectedAppointmentId <= 0 || expectedAppointmentId > 2147483647
    || typeof expectedGeneration !== "string" || !/^[a-f0-9]{32}$/.test(expectedGeneration)
    || typeof date !== "string" || date.startsWith("0000") || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
    || typeof reason !== "string" || reason.trim().length < 3 || reason.trim().length > 500
    || typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(requestId)) return null;
  if (input.nearbyAppointmentConfirmation !== undefined && (typeof input.nearbyAppointmentConfirmation !== "string"
    || input.nearbyAppointmentConfirmation.length === 0 || input.nearbyAppointmentConfirmation.length > 4096)) return null;
  const returnBookingSource = input.returnBookingSource === undefined ? undefined : parseReturnBookingSource(input.returnBookingSource);
  if (returnBookingSource === null) return null;
  if (input.returnBookingFingerprint !== undefined && (typeof input.returnBookingFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.returnBookingFingerprint))) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  return { plannedVisitId, expectedAppointmentId, expectedGeneration, date, time, reason: reason.trim(), requestId,
    ...(input.nearbyAppointmentConfirmation === undefined ? {} : { nearbyAppointmentConfirmation: input.nearbyAppointmentConfirmation as string }),
    ...(returnBookingSource === undefined ? {} : { returnBookingSource }),
    ...(input.returnBookingFingerprint === undefined ? {} : { returnBookingFingerprint: input.returnBookingFingerprint as string }) };
}
