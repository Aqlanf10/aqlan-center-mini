import type { DbClient } from './db';
import { loadProviderBlockWindows } from './capacity-context';
import { effectiveWindow, windowsOverlap } from './appointment-services';
import { toMinutes } from './schedule';
import { CLINIC_TIME_ZONE } from './db';
import { readClinicalRosterSources } from './doctor-clinical-roster';
import { doctorBookingDay, doctorBookingRefusal } from './doctor-booking-window';

/** Existing HR sources are the only schedule authority. Freeze all source tables
 * against inserts as well as updates: row locks alone miss a new leave or a new
 * conflicting mapping. NOWAIT prevents a reverse-order HR/booking lock cycle.
 * The brief SHARE locks last through the caller's existing booking transaction.
 * No payroll, attendance or documented-only schedule history is consulted. */
export async function prepareAppointmentDoctorAdmission(client: DbClient, input: {
  doctorId: number; date: string; time: string; durationMinutes: number;
  before: number; after: number;
}): Promise<(time:string)=>string | null> {
  await client.query(`LOCK TABLE users, parties, hr_staff, hr_work_schedules, hr_leave_requests, provider_blocks IN SHARE MODE NOWAIT`);
  const { rows: [links] } = await client.query<{exists:boolean}>(
    "SELECT to_regclass('public.hr_staff_party_links') IS NOT NULL AS exists");
  if (links.exists) await client.query('LOCK TABLE hr_staff_party_links IN SHARE MODE NOWAIT');
  const sources = await readClinicalRosterSources(client, input.doctorId, input.date);
  const day = sources ? doctorBookingDay(sources, input.doctorId, input.date, CLINIC_TIME_ZONE)
    : {resolved:false,reason:'schema_unavailable',windows:[]};
  const blocks=await loadProviderBlockWindows(input.doctorId,input.date,client);
  return (time:string) => {
    const refusal = doctorBookingRefusal(day, {...input,time,zone:CLINIC_TIME_ZONE});
    if (!refusal) {
      const window=effectiveWindow({startMinutes:toMinutes(time)!,durationMinutes:input.durationMinutes,
        bufferBeforeMinutes:input.before,bufferAfterMinutes:input.after});
      if (blocks.some(block=>windowsOverlap(window,{start:block.startMinutes,end:block.endMinutes})))
        return 'الطبيب غير متاح في هذا الوقت بسبب حجب مسجل. اختر وقتًا آخر.';
      return null;
    }
    return day.resolved
      ? 'الطبيب غير متاح في هذا الوقت وفق جدول دوامه والإجازات المعتمدة. اختر وقتًا آخر.'
      : 'تعذّر إثبات جدول الطبيب. راجع ربط الطبيب بالموظف وجدول دوامه قبل الحجز.';
  };
}
export async function appointmentDoctorAdmission(client:DbClient,input:Parameters<typeof prepareAppointmentDoctorAdmission>[1]) {
  return (await prepareAppointmentDoctorAdmission(client,input))(input.time);
}
