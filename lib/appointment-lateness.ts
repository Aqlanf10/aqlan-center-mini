import { clinicDateString, toMinutes, type Appointment } from './schedule';
/** Display-only: a late booking stays booked until staff records an outcome. */
export function isLateAppointment(appointment:Appointment,now:Date,zone:string,toleranceMinutes:number):boolean {
  if (appointment.status !== 'booked' || appointment.scheduledDate !== clinicDateString(now,zone)) return false;
  const clock=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
  const scheduled=toMinutes(appointment.scheduledTime), current=toMinutes(clock);
  return scheduled !== null && current !== null && current >= scheduled + Math.max(0,toleranceMinutes);
}
