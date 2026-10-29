import { doctorBookingDay, doctorBookingRefusal } from "./doctor-booking-window";
import { readClinicalRosterSources } from "./doctor-clinical-roster";
import { CLINIC_TIME_ZONE, type DbClient } from "./db";

/** Read approved responsibility; never assign or change case ownership. */
export async function bookingRequestDoctor(client: DbClient, input: {
  patientId: number | null; caseId: number | null; doctorId: number | null; followUp: boolean;
}): Promise<number | null> {
  if (!input.caseId && !input.followUp) return input.doctorId;
  if (!input.patientId) throw new Error("BOOKING_CASE_REQUIRED");
  // SHARE also protects responsibility edits until the appointment commit.
  const { rows } = await client.query<{ id: number; responsible_party_id: number | null }>(
    `SELECT id,responsible_party_id FROM clinical_cases WHERE patient_id=$1 AND status IN ('active','waiting')
     AND ($2::int IS NULL OR id=$2) ORDER BY id FOR SHARE`, [input.patientId, input.caseId]);
  if (rows.length !== 1 || !rows[0].responsible_party_id) throw new Error("BOOKING_CASE_REQUIRED");
  const responsible = rows[0].responsible_party_id;
  if (input.doctorId !== null && input.doctorId !== responsible) throw new Error("BOOKING_RESPONSIBLE_CHANGED");
  return responsible;
}

/** Portal conversion must verify the named doctor's actual duty and approved leave.
 * Existing read model only: no HR history/identity activation or inferred assignments.
 * Table SHARE locks cover concurrent insertions as well as edits/deletions; a row lock
 * alone would miss a new leave or conflicting schedule arriving after this read.
 */
export async function assertBookingRequestDuty(client: DbClient, input: {
  doctorId: number; date: string; time: string; durationMinutes: number; before: number; after: number;
}) {
  await client.query("LOCK TABLE hr_staff, hr_work_schedules, hr_leave_requests, provider_blocks, users, parties IN SHARE MODE");
  const links = (await client.query("SELECT to_regclass('public.hr_staff_party_links') AS present")).rows[0]?.present;
  if (links) await client.query("LOCK TABLE hr_staff_party_links IN SHARE MODE");
  const sources = await readClinicalRosterSources(client, input.doctorId, input.date);
  const day = sources ? doctorBookingDay(sources, input.doctorId, input.date, CLINIC_TIME_ZONE)
    : { resolved: false, reason: "schema_unavailable", windows: [] };
  if (doctorBookingRefusal(day, { ...input, zone: CLINIC_TIME_ZONE })) throw new Error("BOOKING_DOCTOR_DUTY");
}
