import type { DoctorDailySchedule } from "./doctor-daily-schedule";
import { addDays } from "./schedule";
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
/** Validate untrusted network JSON before rendering dates/counts or links. */
export function isDoctorDailySchedule(value: unknown, selection: string): value is DoctorDailySchedule {
  if (!value || typeof value !== "object") return false;
  const data = value as DoctorDailySchedule;
  if (data.requestDate !== selection || !validDate(data.date) || !validDate(data.today) || !validDate(data.tomorrow)
    || data.tomorrow !== addDays(data.today, 1)
    || data.date !== (selection === "today" ? data.today : selection === "tomorrow" ? data.tomorrow : selection)
    || typeof data.generatedAt !== "string" || !Number.isFinite(Date.parse(data.generatedAt))
    || typeof data.timeZone !== "string") return false;
  try { new Intl.DateTimeFormat("en", { timeZone: data.timeZone }).format(); } catch { return false; }
  if (!Array.isArray(data.appointments) || !data.counts) return false;
  if (!data.appointments.every((row) => row && Number.isSafeInteger(row.appointmentId) && row.appointmentId > 0
    && Number.isSafeInteger(row.patientId) && row.patientId > 0 && typeof row.patientName === "string"
    && typeof row.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(row.time)
    && Number.isSafeInteger(row.durationMinutes) && row.durationMinutes > 0 && typeof row.status === "string"
    && typeof row.hasReferral === "boolean"
    && (row.patientHref === null || row.patientHref === `/patients/${row.patientId}` || row.patientHref === `/patients/${row.patientId}?tab=today`))) return false;
  const cancelled = data.appointments.filter(row => row.status === "cancelled").length;
  return data.counts.total === data.appointments.length && data.counts.cancelled === cancelled
    && data.counts.scheduled === data.appointments.length - cancelled;
}
