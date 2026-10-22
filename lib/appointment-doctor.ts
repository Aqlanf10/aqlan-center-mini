import type { DbClient } from "./db";

export const APPOINTMENT_DOCTOR_UNAVAILABLE_MESSAGE = "الطبيب غير متاح للحجز.";

/**
 * Match the active-doctor picker inside the booking transaction, after its day
 * locks. FOR SHARE prevents deactivation or a kind change until the appointment
 * write commits. A preflight read or FOR KEY SHARE would not protect those fields.
 *
 * Selection remains optional. requiresProvider describes resource occupancy,
 * not whether attribution is mandatory; even a non-consuming service may only
 * attribute a selected, active doctor.
 */
export async function lockBookableAppointmentDoctor(
  client: DbClient, doctorId: number | null,
): Promise<boolean> {
  if (doctorId === null) return true;
  const { rows } = await client.query<{ id: number }>(
    `SELECT id FROM parties WHERE id = $1 AND kind = 'doctor' AND is_active FOR SHARE`,
    [doctorId],
  );
  return rows.length === 1;
}
