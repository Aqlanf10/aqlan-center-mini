import { getPool, type DbClient } from "./db";
import { addDays, clinicDateString } from "./schedule";

export interface DoctorScheduleRow {
  appointmentId: number;
  patientId: number;
  patientName: string;
  time: string;
  durationMinutes: number;
  status: string;
  hasReferral: boolean;
  patientHref: string | null;
}
export interface DoctorDailySchedule {
  requestDate: string;
  date: string;
  today: string;
  tomorrow: string;
  timeZone: string;
  generatedAt: string;
  appointments: DoctorScheduleRow[];
  counts: { total: number; cancelled: number; scheduled: number };
}

export function resolveScheduleDate(value: string, now: Date, zone: string): string | null {
  const today = clinicDateString(now, zone);
  if (value === "today") return today;
  if (value === "tomorrow") return addDays(today, 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1000-01-01") return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

/** Read-only, strictly assigned schedule. Never widen to owned patients or unassigned slots.
 * The active-party EXISTS also prevents stale/inactive doctor identities returning rows.
 * No clinical narratives, contacts or financial tables enter this read model. */
export async function readDoctorDailySchedule(doctorId: number, date: string) {
  return readDoctorDailyScheduleWith(getPool(), doctorId, date);
}

/** The same read in the caller's snapshot (canonical, M2 slice 15). */
export async function readDoctorDailyScheduleWith(pool: Pick<DbClient, "query">, doctorId: number, date: string) {
  if (!Number.isSafeInteger(doctorId) || doctorId <= 0) return null;
  const doctor = await pool.query<{ id: number }>(
    "SELECT id FROM parties WHERE id = $1 AND kind = 'doctor' AND is_active = TRUE", [doctorId],
  );
  if (!doctor.rows[0]) return null;
  const result = await pool.query<{
    id: number; patient_id: number; full_name: string; time: string; duration_minutes: number; status: string; has_referral: boolean;
  }>(`SELECT a.id, a.patient_id, p.full_name, to_char(a.scheduled_time, 'HH24:MI') AS time,
             a.duration_minutes, a.status, EXISTS (SELECT 1 FROM patient_referrals r
               WHERE r.id = a.referral_id AND r.patient_id = a.patient_id AND r.kind = 'internal') AS has_referral
        FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.doctor_id = $1 AND a.scheduled_date = $2::date
         AND EXISTS (SELECT 1 FROM parties d WHERE d.id = a.doctor_id AND d.kind = 'doctor' AND d.is_active = TRUE)
       ORDER BY a.scheduled_time, a.id`, [doctorId, date]);
  return result.rows.map((row) => ({
    appointmentId: row.id, patientId: row.patient_id, patientName: row.full_name,
    time: row.time, durationMinutes: row.duration_minutes, status: row.status, hasReferral: row.has_referral,
  }));
}
