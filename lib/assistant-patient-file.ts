import { CLINIC_TIME_ZONE, getPool } from "./db";
import { clinicDateString } from "./schedule";

/** Chairside file shell: one snapshot selects only patient identity, the safety
 * alert and the nonfinancial visit list for the current clinic day. A patient
 * outside today's roster is not disclosed to the clinical assistant. */
export async function getAssistantPatientFile(id: number) {
  const day = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const { rows } = await getPool().query<{
    patient_id: number; patient_number: string; full_name: string; medical_alert: string | null;
    visit_id: number; arrived_at: Date; status: string; chair: number | null;
  }>(`SELECT p.id AS patient_id, p.patient_number, p.full_name, p.medical_alert,
             v.id AS visit_id, v.arrived_at, v.status, v.chair
        FROM patients p JOIN visits v ON v.patient_id = p.id
       WHERE p.id = $1 AND (v.arrived_at AT TIME ZONE $2)::date = $3::date
       ORDER BY v.arrived_at DESC, v.id DESC LIMIT 50`, [id, CLINIC_TIME_ZONE, day]);
  const row = rows[0];
  if (!row || day !== clinicDateString(new Date(), CLINIC_TIME_ZONE)) return null;
  return {
    patient: { id: row.patient_id, patientNumber: row.patient_number, fullName: row.full_name,
      medicalAlert: row.medical_alert, phone: null, flags: [] },
    visits: rows.map(v => ({ id: v.visit_id, arrivedAt: v.arrived_at.toISOString(), status: v.status, chair: v.chair })),
    appointments: [],
  };
}
