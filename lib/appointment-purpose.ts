import type { DbClient } from './db';

/** Explicit patient-appointment intent; unrelated to service specialty,
 * treatment stage or attendance status. Legacy has no value or row. */
export const APPOINTMENT_PURPOSES = [
  'consultation','start_treatment','continue_session','try_in','delivery','follow_up',
] as const;
export type AppointmentPurpose = typeof APPOINTMENT_PURPOSES[number];
export const isAppointmentPurpose = (value: unknown): value is AppointmentPurpose =>
  typeof value === 'string' && (APPOINTMENT_PURPOSES as readonly string[]).includes(value);
export const planRequiredForPurpose = (purpose: AppointmentPurpose): boolean =>
  purpose !== 'consultation' && purpose !== 'start_treatment';

export interface DirectAppointmentCommandReceipt {
  appointmentId: number;
  patientId: number;
  actorUserId: number;
  recordedBy: string;
  commandHash: string;
  planScope: boolean;
}

/** Immutable receipt lookup on the caller's transaction, after UUID fencing.
 * Never return this row to a client before fresh actor/scope comparison. */
export async function findDirectAppointmentCommandReceipt(
  client: DbClient, commandId: string,
): Promise<DirectAppointmentCommandReceipt | null> {
  const { rows } = await client.query<{
    appointment_id: number; patient_id: number; actor_user_id: number;
    recorded_by: string; command_hash: string; plan_scope: boolean;
  }>(`SELECT appointment_id,patient_id,actor_user_id,recorded_by,command_hash,true AS plan_scope
      FROM appointment_purpose_provenance WHERE command_id=$1::uuid
      UNION ALL
      SELECT appointment_id,patient_id,actor_user_id,recorded_by,command_hash,false AS plan_scope
      FROM appointment_booking_commands WHERE command_id=$1::uuid`, [commandId]);
  const row = rows[0];
  return row ? { appointmentId: row.appointment_id, patientId: row.patient_id,
    actorUserId: row.actor_user_id, recordedBy: row.recorded_by,
    commandHash: row.command_hash, planScope: row.plan_scope } : null;
}

/** Caller passes only an already locked, server-derived origin; SQL verifies the
 * new appointment still has that live link. Composite FKs preserve the immutable
 * historical tuple after a later operational rebook detaches the old link. */
export async function insertAppointmentPurposeProvenance(client: DbClient, input: {
  appointmentId: number; purpose: AppointmentPurpose; sourcePlanId: number|null;
  sourcePlannedVisitId: number|null; recordedBy: string;
  commandId?: string|null; commandHash?: string|null; actorUserId?: number|null;
}): Promise<void> {
  const {rows} = await client.query<{appointment_id:number}>(
    `INSERT INTO appointment_purpose_provenance
      (appointment_id,patient_id,purpose,source_plan_id,source_planned_visit_id,recorded_by,
       command_id,command_hash,actor_user_id)
     SELECT a.id,a.patient_id,$2::text,$3::int,$4::int,$5::text,$6::uuid,$7::text,$8::int FROM appointments a
      WHERE a.id=$1 AND
        (($3::int IS NULL AND $4::int IS NULL AND a.planned_visit_id IS NULL)
          OR ($3::int IS NOT NULL AND $4::int IS NOT NULL AND a.planned_visit_id=$4::int))
     RETURNING appointment_id`,
    [input.appointmentId,input.purpose,input.sourcePlanId,input.sourcePlannedVisitId,input.recordedBy,
      input.commandId??null,input.commandHash??null,input.actorUserId??null]);
  if (rows.length!==1) throw new Error('APPOINTMENT_PURPOSE_ORIGIN_STALE');
}
