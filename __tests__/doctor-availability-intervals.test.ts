import { expect, it } from 'vitest';
import { proposedDoctorIntervals, proposedIntervalFits, type DoctorInstantInterval, type DoctorLeaveInterval } from '../lib/doctor-availability-intervals';
import { materializeScheduleSegments } from '../lib/hr-schedule-segments';
const interval = (start: string, end: string, doctorId = 1): DoctorInstantInterval => ({ doctorId, start, end });
const night = () => materializeScheduleSegments('2026-10-24', 'Asia/Aden', [{ id: 'night', start: '22:00', startDayOffset: 0, end: '04:00', endDayOffset: 1 }]).windows.map(w => interval(w.start,w.end));
const leave = (start: string | null, end: string | null, doctorId = 1): DoctorLeaveInterval => ({ doctorId, status: 'approved', start, end });
it('subtracts an exact partial leave spanning Saturday midnight into Sunday in clinic time', () => {
  const open = proposedDoctorIntervals(1, night(), [leave('2026-10-24T23:30:00+03:00','2026-10-25T01:00:00+03:00')]);
  expect(open).toEqual([interval('2026-10-24T19:00:00.000Z','2026-10-24T20:30:00.000Z'), interval('2026-10-24T22:00:00.000Z','2026-10-25T01:00:00.000Z')]);
  expect(proposedIntervalFits(open, interval('2026-10-24T23:00:00+03:00','2026-10-24T23:30:00+03:00'))).toBe(true);
  expect(proposedIntervalFits(open, interval('2026-10-24T23:00:00+03:00','2026-10-24T23:30:00+03:00'),0,1)).toBe(false);
  expect(proposedIntervalFits(open, interval('2026-10-25T01:00:00+03:00','2026-10-25T01:30:00+03:00'))).toBe(true);
});
it('calculates cross-midnight booking without activating the production admission path', () => {
  expect(proposedIntervalFits(night(), interval('2026-10-24T23:45:00+03:00','2026-10-25T00:15:00+03:00'))).toBe(true);
});
it('merges touching periods but cannot bridge a split gap', () => {
  const shifts=[interval('2026-10-25T08:00:00Z','2026-10-25T12:00:00Z'),interval('2026-10-25T12:00:00Z','2026-10-25T16:00:00Z')];
  const booking=interval('2026-10-25T11:30:00Z','2026-10-25T12:30:00Z');
  expect(proposedIntervalFits(proposedDoctorIntervals(1,shifts,[]),booking)).toBe(true);
  shifts[1].start='2026-10-25T13:00:00Z';
  expect(proposedIntervalFits(proposedDoctorIntervals(1,shifts,[]),booking)).toBe(false);
});
it('keeps doctors and unapproved leave separate and never mutates inputs', () => {
  const shifts=night(), snapshot=JSON.stringify(shifts);
  expect(proposedDoctorIntervals(1,shifts,[leave(shifts[0].start,shifts[0].end,2),{...leave(null,null),status:'pending'}])).toEqual(shifts);
  expect(JSON.stringify(shifts)).toBe(snapshot);
  expect(proposedIntervalFits(shifts,{...shifts[0],doctorId:2})).toBe(false);
});
it('rejects missing partial bounds, reversed bounds, invalid dates and overlapping shifts', () => {
  expect(() => proposedDoctorIntervals(1,night(),[leave(null,null)])).toThrow('partial_leave_bounds_required');
  expect(() => proposedDoctorIntervals(1,night(),[leave('2026-10-25T02:00:00Z','2026-10-25T01:00:00Z')])).toThrow('invalid_interval');
  expect(() => proposedDoctorIntervals(1,[interval('2026-02-30T01:00:00Z','2026-03-01T02:00:00Z')],[])).toThrow('invalid_instant');
  expect(() => proposedDoctorIntervals(1,[...night(),...night()],[])).toThrow('overlapping_assignments');
});
it('subtracts overlapping leaves idempotently including complete closure', () => {
  const shifts=night(), closure=leave(shifts[0].start,shifts[0].end);
  expect(proposedDoctorIntervals(1,shifts,[closure,closure])).toEqual([]);
});
