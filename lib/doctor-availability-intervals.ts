/** Pure proposal only; not connected to HR persistence or appointment admission.
 * Explicit offset-bearing leave bounds are required. A duration alone never
 * implies when a partial leave starts. All intervals are half-open [start,end).
 */
export interface DoctorInstantInterval { doctorId: number; start: string; end: string }
export interface DoctorLeaveInterval {
  doctorId: number; status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  start: string | null; end: string | null;
}
type Window = { start: number; end: number };
function instant(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.test(value)) throw new Error('explicit_instant_required');
  const day = value.slice(0, 10), epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error('invalid_instant');
  return epoch;
}
function window(start: string, end: string): Window {
  const result = { start: instant(start), end: instant(end) };
  if (result.end <= result.start) throw new Error('invalid_interval');
  return result;
}
export function proposedDoctorIntervals(doctorId: number, shifts: readonly DoctorInstantInterval[], leaves: readonly DoctorLeaveInterval[]) {
  if (!Number.isSafeInteger(doctorId) || doctorId < 1) throw new Error('invalid_doctor');
  const sorted = shifts.filter(s => s.doctorId === doctorId).map(s => window(s.start, s.end)).sort((a,b) => a.start-b.start);
  let available: Window[] = [];
  for (const next of sorted) {
    const prior = available.at(-1);
    if (prior && next.start < prior.end) throw new Error('overlapping_assignments');
    if (prior && next.start === prior.end) prior.end = next.end;
    else available.push({ ...next });
  }
  for (const leave of leaves.filter(l => l.doctorId === doctorId && l.status === 'approved')) {
    if (leave.start === null || leave.end === null) throw new Error('partial_leave_bounds_required');
    const closed = window(leave.start, leave.end);
    available = available.flatMap(open => {
      if (open.end <= closed.start || closed.end <= open.start) return [open];
      return [...(open.start < closed.start ? [{ start: open.start, end: closed.start }] : []),
        ...(closed.end < open.end ? [{ start: closed.end, end: open.end }] : [])];
    });
  }
  return available.map(w => ({ doctorId, start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() }));
}
/** A pure cross-midnight calculation, not permission to store such appointments. */
export function proposedIntervalFits(available: readonly DoctorInstantInterval[], booking: DoctorInstantInterval, beforeMinutes = 0, afterMinutes = 0): boolean {
  if (![beforeMinutes, afterMinutes].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('invalid_buffer');
  const requested = window(booking.start, booking.end);
  return available.some(s => {
    if (s.doctorId !== booking.doctorId) return false;
    const open = window(s.start, s.end);
    return open.start <= requested.start-beforeMinutes*60000 && requested.end+afterMinutes*60000 <= open.end;
  });
}
