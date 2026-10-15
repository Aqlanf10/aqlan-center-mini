import { clinicLocalDateTimeToIso } from './schedule';

/** Minute precision editor value in the clinic zone, independent of the device. */
export function taskDeadlineInput(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(iso)).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Local values mean clinic time; offset-bearing values already identify an instant. */
export function parseTaskDeadline(value: unknown, timeZone: string): string {
  if (typeof value !== 'string') throw new Error('موعد الاستحقاق غير صالح.');
  const calendarDay = new Date(`${value.slice(0,10)}T00:00:00Z`);
  if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0,10)!==value.slice(0,10)) throw new Error('تاريخ الاستحقاق غير صالح.');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    const iso=clinicLocalDateTimeToIso(value.slice(0,10),value.slice(11),timeZone);
    if(taskDeadlineInput(iso,timeZone)!==value) throw new Error('موعد الاستحقاق غير صالح.');
    return iso;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('أرسل وقت العيادة أو تاريخًا بإزاحة زمنية صريحة.');
  const date=new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('موعد الاستحقاق غير صالح.');
  return date.toISOString();
}
