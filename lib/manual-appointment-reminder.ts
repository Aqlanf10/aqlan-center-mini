import { ensureSchema, getPool } from "./db";

/** The displayed message/contact context, not a claim about delivery. */
export type ManualAppointmentReminderSnapshot = Readonly<{
  patientId: number;
  patientName: string;
  patientPhone: string | null;
  scheduledDate: string;
  scheduledTime: string;
  status: "booked" | "no_show";
}>;

export const STALE_MANUAL_REMINDER_MESSAGE =
  "تغيّرت بيانات الموعد أو المريض منذ عرض التذكير. لم يُسجّل التأكيد؛ حدّث القائمة وراجع البيانات قبل التأكيد من جديد.";

/** Reject missing/oversized/coerced snapshots; never silently use today's row. */
export function readManualReminderSnapshot(value: unknown): ManualAppointmentReminderSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.patientId !== "number" || !Number.isSafeInteger(raw.patientId) || raw.patientId <= 0
    || typeof raw.patientName !== "string" || !raw.patientName || raw.patientName.length > 500
    || !(raw.patientPhone === null || (typeof raw.patientPhone === "string" && raw.patientPhone.length <= 100))
    || typeof raw.scheduledDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.scheduledDate)
    || typeof raw.scheduledTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.scheduledTime)
    || (raw.status !== "booked" && raw.status !== "no_show")) return null;
  const date = new Date(`${raw.scheduledDate}T00:00:00Z`);
  if (raw.scheduledDate.startsWith("0000") || !Number.isFinite(date.getTime())
    || date.toISOString().slice(0, 10) !== raw.scheduledDate) return null;
  return {
    patientId: raw.patientId, patientName: raw.patientName, patientPhone: raw.patientPhone,
    scheduledDate: raw.scheduledDate, scheduledTime: raw.scheduledTime, status: raw.status,
  };
}

/**
 * Only the manual PATCH uses this writer. The authorization result supplies the
 * patient identity separately: a client snapshot can never substitute for it.
 * The target-row predicate is rechecked after concurrent moves/cancellation or
 * retargeting. A patient share lock also fences name/phone changes during the
 * statement, because these determine the displayed WhatsApp draft/recipient.
 * Time is compared at the displayed minute, just as canonical appointment
 * serialization does; invisible legacy seconds/microseconds are not a version.
 * Reminder timestamps deliberately are not versions: an ordinary retry or a
 * later explicit contact for the same unchanged appointment remains valid.
 */
export async function recordManualAppointmentReminder(
  appointmentId: number,
  authorizedPatientId: number | null,
  snapshot: ManualAppointmentReminderSnapshot,
): Promise<boolean> {
  if (authorizedPatientId === null || snapshot.patientId !== authorizedPatientId) return false;
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `WITH displayed_patient AS MATERIALIZED (
       SELECT id FROM patients
       WHERE id = $2 AND full_name = $6 AND phone IS NOT DISTINCT FROM $7::text
       FOR SHARE
     )
     UPDATE appointments AS a SET reminder_sent_at = NOW()
     FROM displayed_patient AS p
     WHERE a.id = $1 AND a.patient_id = $2 AND a.patient_id = p.id
       AND a.scheduled_date = $3::date AND to_char(a.scheduled_time, 'HH24:MI') = $4::text
       AND a.status = $5 AND a.status IN ('booked', 'no_show')`,
    [appointmentId, authorizedPatientId, snapshot.scheduledDate, snapshot.scheduledTime,
      snapshot.status, snapshot.patientName, snapshot.patientPhone],
  );
  return (rowCount ?? 0) === 1;
}
