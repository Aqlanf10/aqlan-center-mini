import { getPool } from './db';
import type { Appointment } from './schedule';
import type { SessionPayload } from './auth';
import { revalidateSessionInTransaction } from './session';
import { canAccessPatient } from './patient-access';

/** Existing relations only. A matching patient, label or specialty is never a
 * relationship. The destination verifies current authority again on navigation. */
export async function withAppointmentClinicalLinks(items:Appointment[],session:SessionPayload):Promise<Appointment[]> {
  if (!items.length || !['admin','reception','doctor'].includes(session.role)) return items;
  const client=await getPool().connect();
  try {
  await client.query('BEGIN');
  const fresh=await revalidateSessionInTransaction(session,client);
  if (!fresh || !['admin','reception','doctor'].includes(fresh.role)) {await client.query('ROLLBACK');return items;}
  const permitted = new Set<number>();
  for (const patientId of new Set(items.map(item=>item.patientId))) {
    if (await canAccessPatient(fresh,patientId,'canViewPlans',client,'nowait')) permitted.add(patientId);
  }
  const ids=items.filter(item=>permitted.has(item.patientId)).map(item=>item.id);
  if (!ids.length) {await client.query('COMMIT');return items;}
  const {rows}=await client.query<{id:number;patient_id:number;plan_id:number|null;visit_ids:number[];case_ids:number[]}>(
    `SELECT a.id,a.patient_id,plan.id AS plan_id,
       ARRAY(SELECT v.id FROM visits v WHERE v.patient_id=a.patient_id
         AND (v.appointment_id=a.id OR (pv.id IS NOT NULL AND (v.planned_visit_id=pv.id OR pv.visit_id=v.id))) ORDER BY v.id) AS visit_ids,
       ARRAY(SELECT DISTINCT c.id FROM treatment_sessions ts
         JOIN plan_items pi ON pi.id=ts.plan_item_id AND pi.plan_id=plan.id
         JOIN clinical_cases c ON c.id=pi.case_id AND c.patient_id=a.patient_id
         WHERE ts.planned_visit_id=pv.id ORDER BY c.id) AS case_ids
     FROM appointments a
     LEFT JOIN planned_visits pv ON pv.id=a.planned_visit_id AND pv.appointment_id=a.id AND pv.patient_id=a.patient_id
     LEFT JOIN treatment_plans plan ON plan.id=pv.plan_id AND plan.patient_id=a.patient_id
     WHERE a.id=ANY($1::int[])`,[ids]);
  if (!await revalidateSessionInTransaction(session,client)) {await client.query('ROLLBACK');return items;}
  await client.query('COMMIT');
  const links=new Map(rows.map(row=>[row.id,row]));
  return items.map(item=>{
    const row=links.get(item.id);
    return row && row.patient_id===item.patientId ? {...item,clinicalLinks:{planId:row.plan_id,
      visitIds:row.visit_ids,caseIds:row.case_ids}} : item;
  });
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally {client.release();}
}
