import { resolveDoctorClinicalRoster, type RosterSources } from './doctor-clinical-roster';
import { addCalendarDays } from './hr-temporal';
import { materializeScheduleSegments } from './hr-schedule-segments';

export interface BookingWindow { start: number; end: number }
export type DoctorBookingDay = { resolved: boolean; reason: string | null; windows: BookingWindow[] };
const minute = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** Civil booking date, distinct from the HR shift's anchor date. No HR history activation. */
export function doctorBookingDay(sources: RosterSources, doctorId: number, date: string, zone: string): DoctorBookingDay {
  const windows: BookingWindow[] = [];
  for (const offset of [-1, 0]) {
    const roster = resolveDoctorClinicalRoster(sources, doctorId, addCalendarDays(date, offset), zone);
    if (roster.status !== 'resolved') {
      // A missing prior assignment cannot authorize a night tail; today's explicit
      // assignment can still authorize today's windows. Invalid/ambiguous evidence blocks.
      if (offset === -1 && ['missing_schedule', 'inactive_staff'].includes(roster.unresolvedReason ?? '')) continue;
      return { resolved: false, reason: roster.unresolvedReason, windows: [] };
    }
    for (const interval of roster.intervals) {
      const start = Math.max(0, minute(interval.startTime) + (interval.startDayOffset + offset) * 1440);
      const end = Math.min(1440, minute(interval.endTime) + (interval.endDayOffset + offset) * 1440);
      if (end > start) windows.push({ start, end });
    }
  }
  windows.sort((a, b) => a.start - b.start);
  const merged: BookingWindow[] = [];
  for (const window of windows) {
    const prior = merged.at(-1);
    if (prior && window.start < prior.end) return { resolved: false, reason: 'overlapping_assignments', windows: [] };
    if (prior && window.start === prior.end) prior.end = window.end;
    else merged.push({ ...window });
  }
  return { resolved: true, reason: null, windows: merged };
}

/** Appointment storage uses a civil date and clock, without a DST fold discriminator.
 * Reject ambiguous/nonexistent endpoints instead of silently moving the appointment.
 * Crossing midnight is deliberately blocked until the existing day-lock/capacity
 * protocol supports a single appointment occupying two civil days. Night tails
 * booked wholly after midnight use their actual civil date.
 */
export function doctorBookingRefusal(day: DoctorBookingDay, input: {
  date: string; time: string; durationMinutes: number; before?: number; after?: number; zone: string;
}): string | null {
  if (!day.resolved) return day.reason ?? 'unresolved_roster';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) || !Number.isInteger(input.durationMinutes) || input.durationMinutes < 1) return 'invalid_booking_window';
  const before = input.before ?? 0, after = input.after ?? 0;
  if (![before, after].every(n => Number.isInteger(n) && n >= 0)) return 'invalid_booking_window';
  const start = minute(input.time) - before, end = minute(input.time) + input.durationMinutes + after;
  if (start < 0 || end > 1440) return 'cross_day_booking_requires_review';
  if (!day.windows.some(w => w.start <= start && end <= w.end)) return 'outside_doctor_schedule';
  const clock = (n: number) => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  try {
    materializeScheduleSegments(input.date, input.zone, [{ id: 'booking', start: clock(start), startDayOffset: 0,
      end: clock(end), endDayOffset: end === 1440 ? 1 : 0 }]);
  } catch { return 'unresolved_wall_time'; }
  return null;
}
