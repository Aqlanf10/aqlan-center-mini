import { getPool } from "./db";
import type { Appointment } from "./schedule";
import {
  encodePatientAppointmentsCursor, PATIENT_APPOINTMENTS_PAGE_SIZE, patientAppointmentId,
  type PatientAppointmentsQuery,
} from "./patient-appointments-contract";

/** Canonical appointments only. Fixed-size keyset pages avoid the patient file's last-50 cap.
 * No financial tables, schema initialization, duplicated records, or scheduling writes. */
export async function readPatientAppointments(patientId: number, query: PatientAppointmentsQuery, today: string) {
  if (patientAppointmentId(String(patientId)) !== patientId) throw new Error("Invalid patient ID");
  const pool = getPool();
  const patient = await pool.query<{ id: number }>("SELECT id FROM patients WHERE id = $1", [patientId]);
  if (!patient.rows[0]) return null;
  const cutoff = query.cursor?.today ?? today;
  const upcoming = query.view === "upcoming";
  const direction = upcoming ? "ASC" : "DESC";
  const comparison = upcoming ? ">" : "<";
  const values: unknown[] = [patientId, cutoff];
  let after = "";
  if (query.cursor) {
    values.push(query.cursor.date, query.cursor.time, query.cursor.id);
    after = `AND (a.scheduled_date, a.scheduled_time, a.id) ${comparison} ($3::date, $4::time, $5::integer)`;
  }
  values.push(PATIENT_APPOINTMENTS_PAGE_SIZE + 1);
  const { rows } = await pool.query<Omit<Appointment, "reminderSentAt"> & { reminderSentAt: Date | string | null; cursorTime: string }>(`
    SELECT a.id, a.patient_id AS "patientId", p.full_name AS "patientName", p.phone AS "patientPhone",
      to_char(a.scheduled_date, 'YYYY-MM-DD') AS "scheduledDate",
      to_char(a.scheduled_time, 'HH24:MI') AS "scheduledTime",
      to_char(a.scheduled_time, 'HH24:MI:SS.US') AS "cursorTime",
      a.duration_minutes AS "durationMinutes", a.status, a.doctor_id AS "doctorId", d.name AS "doctorName",
      a.cancel_reason AS "cancelReason", a.reminder_sent_at AS "reminderSentAt", NULL AS note
    FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN parties d ON d.id = a.doctor_id
    WHERE a.patient_id = $1 AND ${upcoming
      ? "(a.status IN ('booked', 'arrived') AND a.scheduled_date >= $2::date)"
      : "(a.status NOT IN ('booked', 'arrived') OR a.scheduled_date < $2::date)"}
    ${after}
    ORDER BY a.scheduled_date ${direction}, a.scheduled_time ${direction}, a.id ${direction}
    LIMIT $${values.length}`, values);
  const visible = rows.slice(0, PATIENT_APPOINTMENTS_PAGE_SIZE);
  const last = visible.at(-1);
  const nextCursor = rows.length > PATIENT_APPOINTMENTS_PAGE_SIZE && last
    ? encodePatientAppointmentsCursor({ patientId, view: query.view, today: cutoff, date: last.scheduledDate, time: last.cursorTime, id: last.id }) : null;
  return {
    today: cutoff,
    appointments: visible.map(({ cursorTime: _cursorTime, ...item }) => ({ ...item,
      reminderSentAt: item.reminderSentAt instanceof Date ? item.reminderSentAt.toISOString() : item.reminderSentAt,
    })), nextCursor,
  };
}
