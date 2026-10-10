import { CLINIC_TIME_ZONE, ensureSchema, getPool } from "./db";
import { onClinicDaysSql } from "./clinic-day-sql";
import { clinicDateString } from "./schedule";
import { isHandoffDate, type ReceptionHandoff } from "./reception-handoff";

/** No message insert, acknowledgement, invoice write, or second source of signed state. */
export async function listReceptionHandoffs(throughDate?: string) {
  const toDate = throughDate ?? clinicDateString(new Date(), CLINIC_TIME_ZONE);
  if (!isHandoffDate(toDate)) throw new Error("Invalid signing date");
  const fromDate = new Date(new Date(`${toDate}T00:00:00.000Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; patient_id: number; full_name: string; patient_number: string; signed_at: Date;
  }>(
    `SELECT v.id, v.patient_id, p.full_name, p.patient_number, v.signed_at
       FROM visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.signed_at IS NOT NULL
        AND ${onClinicDaysSql("v.signed_at", "$1", "$2::date", "$3::date")}
      ORDER BY v.signed_at DESC, v.id DESC`,
    [CLINIC_TIME_ZONE, fromDate, toDate],
  );
  const items: ReceptionHandoff[] = rows.map(row => ({
    visitId: row.id, patientId: row.patient_id, patientName: row.full_name,
    patientNumber: row.patient_number, signedAt: row.signed_at.toISOString(),
  }));
  return { fromDate, toDate, clinicTimeZone: CLINIC_TIME_ZONE, items };
}
