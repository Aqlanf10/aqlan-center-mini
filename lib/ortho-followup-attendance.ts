import { clinicDateString } from "./schedule";
import type { FollowupAttendanceContext } from "./ortho-followup";

type AttendanceCutoff = Omit<FollowupAttendanceContext["cutoff"], "localDateTime">;

/**
 * The route supplies its captured instant with its matching clinic day. Legacy
 * one-argument board callers retain live current-day behavior. A non-current
 * date alone means strictly before that clinic day's midnight, never that day
 * combined with today's clock. Current stored statuses are NOT historical replay.
 * PostgreSQL resolves the local cutoff and orders DATE + TIME without losing
 * microseconds or 24:00 normalization. DST repeated hours remain wall-clock slots.
 */
export function resolveFollowupAttendanceCutoff(today: string, timeZone: string, asOf?: Date): AttendanceCutoff {
  if (typeof today !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new RangeError("A valid clinic date is required");
  }
  const calendarDay = new Date(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== today) {
    throw new RangeError("A valid clinic date is required");
  }
  const captured = asOf === undefined ? new Date() : asOf;
  if (!(captured instanceof Date) || !Number.isFinite(captured.getTime())) {
    throw new RangeError("A valid attendance cutoff Date is required");
  }
  const matchesClinicDay = clinicDateString(captured, timeZone) === today;
  if (asOf !== undefined && !matchesClinicDay) {
    throw new RangeError("Attendance cutoff must match the supplied clinic date");
  }
  if (!matchesClinicDay) return { kind: "date_only_before_midnight", instant: null, timeZone };
  return { kind: asOf === undefined ? "captured_now" : "explicit_instant", instant: captured.toISOString(), timeZone };
}
