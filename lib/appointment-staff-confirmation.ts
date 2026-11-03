import { isAppointmentCategory, type AppointmentCategory } from './appointment-category';
import type { SessionPayload } from './auth';
import { getPool, insertAuditRow } from './db';
import { canAccessPatient } from './patient-access';
import { revalidateSessionInTransaction } from './session';
import type { ManualAppointmentReminderSnapshot } from './manual-appointment-reminder';

/** Staff reports the patient's confirmation. This never marks attendance or
 * claims a message was sent. Retrying preserves the first actor/time. */
export async function confirmAppointmentByStaff(id:number, patientId:number|null,
  snapshot:ManualAppointmentReminderSnapshot, session:SessionPayload,
  category?:{value:AppointmentCategory;expected:AppointmentCategory|null}):Promise<boolean> {
  if (category && (!isAppointmentCategory(category.value) || (category.expected !== null && !isAppointmentCategory(category.expected)))) return false;
  if (snapshot.status !== 'booked' || snapshot.patientId !== patientId) return false;
  const client=await getPool().connect();
  try {
    await client.query('BEGIN');
    const fresh=await revalidateSessionInTransaction(session,client);
    if (!fresh || !['admin','reception','doctor'].includes(fresh.role)
      || !await canAccessPatient(fresh,snapshot.patientId,undefined,client,'nowait')) {
      await client.query('ROLLBACK'); return false;
    }
    const {rows:[current]}=await client.query<{staff_confirmed_at:Date|null;clinical_category:AppointmentCategory|null}>(
      `SELECT a.staff_confirmed_at,a.clinical_category FROM appointments a
       JOIN patients p ON p.id=a.patient_id
       WHERE a.id=$1 AND a.patient_id=$2 AND a.status='booked'
         AND a.scheduled_date=$3::date AND to_char(a.scheduled_time,'HH24:MI')=$4
         AND p.full_name=$5 AND p.phone IS NOT DISTINCT FROM $6::text
       FOR UPDATE OF a`,[id,patientId,snapshot.scheduledDate,snapshot.scheduledTime,snapshot.patientName,snapshot.patientPhone]);
    if (!await revalidateSessionInTransaction(session,client)) {await client.query('ROLLBACK');return false;}
    if (!current) {await client.query('ROLLBACK');return false;}
    if (category) {
      if (current.clinical_category !== category.expected) {await client.query('ROLLBACK');return false;}
      if (category.value !== current.clinical_category) {
        await client.query('UPDATE appointments SET clinical_category=$2 WHERE id=$1',[id,category.value]);
        await insertAuditRow(client,{action:'appointment.update',entity:'appointment',entityId:id,
          actor:fresh.username,actorRole:fresh.role,details:{action:'clinical_category',before:current.clinical_category,after:category.value}});
      }
    } else if (!current.staff_confirmed_at) {
      await client.query('UPDATE appointments SET staff_confirmed_at=clock_timestamp(),staff_confirmed_by=$2 WHERE id=$1',[id,fresh.username]);
      await insertAuditRow(client,{action:'appointment.update',entity:'appointment',entityId:id,
        actor:fresh.username,actorRole:fresh.role,details:{action:'staff_confirmed',date:snapshot.scheduledDate,time:snapshot.scheduledTime}});
    }
    await client.query('COMMIT');return true;
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally {client.release();}
}
