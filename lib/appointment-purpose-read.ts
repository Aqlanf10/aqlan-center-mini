import { ensureSchema, getPool } from './db';
import type { SessionPayload } from './auth';
import { revalidateSessionInTransaction } from './session';
import { canAccessPatient } from './patient-access';
import type { AppointmentPurpose } from './appointment-purpose';

/** Only the plan-scoped patient route calls this; never a general day-list
 * projection. Re-check credential, role, doctor grant and ownership in the same
 * read transaction before exposing even the purpose identifier. */
export async function readPatientPlannedVisitPurposes(patientId:number,admitted:SessionPayload):Promise<
  {ok:true; byPlannedVisit:Map<number,AppointmentPurpose>}|{ok:false}
> {
  await ensureSchema();
  const client=await getPool().connect();
  try {
    await client.query('BEGIN');
    const session=await revalidateSessionInTransaction(admitted,client);
    if (!session || !['admin','reception','doctor'].includes(session.role) ||
        !await canAccessPatient(session,patientId,'canViewPlans',client,'nowait')) {
      await client.query('ROLLBACK');return {ok:false};
    }
    const {rows}=await client.query<{planned_visit_id:number;purpose:AppointmentPurpose}>(
      `SELECT pv.id AS planned_visit_id,origin.purpose
         FROM planned_visits pv
         JOIN treatment_plans plan ON plan.id=pv.plan_id AND plan.patient_id=pv.patient_id
         JOIN appointments a ON a.id=pv.appointment_id AND a.patient_id=pv.patient_id
           AND a.planned_visit_id=pv.id
         JOIN appointment_purpose_provenance origin ON origin.appointment_id=a.id
           AND origin.patient_id=pv.patient_id AND origin.source_plan_id=plan.id
           AND origin.source_planned_visit_id=pv.id
        WHERE pv.patient_id=$1 AND pv.status NOT IN ('completed','cancelled')`,[patientId]);
    if (session.expiresAt<Date.now()) {await client.query('ROLLBACK');return {ok:false};}
    await client.query('COMMIT');
    return {ok:true,byPlannedVisit:new Map(rows.map(row=>[row.planned_visit_id,row.purpose]))};
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally {client.release();}
}
