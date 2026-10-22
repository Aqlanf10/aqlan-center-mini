import { expect, it } from 'vitest';
import { doctorBookingDay, doctorBookingRefusal } from '../lib/doctor-booking-window';
import { resolveDoctorClinicalRoster, type RosterSources } from '../lib/doctor-clinical-roster';

function sources(): RosterSources {
  return { staff: [1, 2].map(id => ({ id, userId: id, department: 'doctors', workStatus: 'active', hireDate: '2020-01-01', endDate: null })),
    accounts: [1, 2].map(id => ({ id, partyId: id, active: true })), parties: [1, 2].map(id => ({ id, kind: 'doctor', active: true })),
    partyLinks: null, leaves: [], schedules: [1, 2].map(id => ({ id, staffId: id, department: null, active: true,
      effectiveFrom: '2026-01-01', effectiveTo: null, workingDays: [0,1,2,3,4,5,6], start: '08:00', end: '12:00',
      secondStart: null, secondEnd: null, crossesMidnight: false, scheduleType: 'morning', updatedAt: 'synthetic-v1' })) };
}
function refusal(s: RosterSources, time: string, durationMinutes = 30, date = '2026-10-25', doctorId = 1, zone = 'Asia/Aden') {
  return doctorBookingRefusal(doctorBookingDay(s, doctorId, date, zone), { date, time, durationMinutes, zone });
}
it('preserves the existing anchor-day reader result when the source query also loads yesterday', () => {
  const s = sources(); s.schedules[0].effectiveFrom = '2026-10-25';
  const expected = resolveDoctorClinicalRoster(s, 1, '2026-10-25', 'Asia/Aden');
  s.schedules.push({ ...s.schedules[0], id: 3, effectiveFrom: '2026-01-01', effectiveTo: '2026-10-24',
    start: '22:00', end: '04:00', crossesMidnight: true, scheduleType: 'night' });
  s.leaves.push({ id: 1, staffId: 1, startDate: '2026-10-24', endDate: '2026-10-24', status: 'approved', partial: false, updatedAt: 'v1' });
  expect(resolveDoctorClinicalRoster(s, 1, '2026-10-25', 'Asia/Aden')).toEqual(expected);
  expect(expected).toMatchObject({ status: 'resolved', sourceScheduleId: 1 });
});
it('honors exact morning boundaries and keeps two doctors independent', () => {
  const s = sources(); Object.assign(s.schedules[1], { start: '16:00', end: '20:00', scheduleType: 'evening' });
  expect(refusal(s, '08:00')).toBeNull(); expect(refusal(s, '11:30')).toBeNull();
  expect(refusal(s, '11:45')).toBe('outside_doctor_schedule');
  expect(refusal(s, '16:00')).toBe('outside_doctor_schedule');
  expect(refusal(s, '16:00', 30, '2026-10-25', 2)).toBeNull();
});
it('merges touching shifts while retaining the split-shift gap', () => {
  const s = sources(); Object.assign(s.schedules[0], { secondStart: '12:00', secondEnd: '20:00', scheduleType: 'split' });
  expect(refusal(s, '11:30', 90)).toBeNull();
  s.schedules[0].secondStart = '16:00';
  expect(refusal(s, '11:30', 90)).toBe('outside_doctor_schedule');
  expect(refusal(s, '16:00')).toBeNull();
});
it('carries Saturday night into Sunday but not Sunday night into Monday', () => {
  const s = sources(); Object.assign(s.schedules[0], { start: '22:00', end: '04:00', crossesMidnight: true, scheduleType: 'night', workingDays: [6] });
  expect(refusal(s, '01:00')).toBeNull();
  expect(refusal(s, '22:00')).toBe('outside_doctor_schedule');
  expect(refusal(s, '01:00', 30, '2026-10-26')).toBe('outside_doctor_schedule');
  expect(refusal(s, '23:45', 30, '2026-10-24')).toBe('cross_day_booking_requires_review');
});
it('subtracts approved leave and fails closed for partial leave without clock bounds', () => {
  const s = sources(); s.leaves.push({ id: 1, staffId: 1, startDate: '2026-10-25', endDate: '2026-10-25', status: 'approved', partial: false, updatedAt: 'v1' });
  expect(refusal(s, '08:00')).toBe('outside_doctor_schedule');
  s.leaves[0].partial = true; expect(refusal(s, '08:00')).toBe('unsupported_partial_leave');
  expect(refusal(s, '08:00', 30, '2026-10-25', 2)).toBeNull();
});
it('does not expose a night tail from an approved day off', () => {
  const s = sources(); Object.assign(s.schedules[0], { start: '22:00', end: '04:00', crossesMidnight: true, scheduleType: 'night' });
  s.leaves.push({ id: 1, staffId: 1, startDate: '2026-10-24', endDate: '2026-10-24', status: 'approved', partial: false, updatedAt: 'v1' });
  expect(refusal(s, '01:00')).toBe('outside_doctor_schedule');
});
it('includes service buffers and never interprets ambiguous DST clocks as valid bookings', () => {
  const s = sources(); const day = doctorBookingDay(s, 1, '2026-10-25', 'Asia/Aden');
  expect(doctorBookingRefusal(day, { date: '2026-10-25', time: '08:00', durationMinutes: 30, before: 5, zone: 'Asia/Aden' })).toBe('outside_doctor_schedule');
  Object.assign(s.schedules[0], { start: '00:00', end: '04:00' });
  expect(refusal(s, '01:00', 30, '2026-11-01', 1, 'America/New_York')).toBe('unresolved_wall_time');
  expect(refusal(s, '02:00', 30, '2026-03-08', 1, 'America/New_York')).toBe('unresolved_wall_time');
});
it('re-evaluates a changed schedule without mutating existing appointment data', () => {
  const s = sources(), appointment = Object.freeze({ date: '2026-10-25', time: '08:30', durationMinutes: 30 });
  expect(refusal(s, appointment.time)).toBeNull();
  s.schedules[0].start = '09:00';
  expect(refusal(s, appointment.time)).toBe('outside_doctor_schedule');
  expect(appointment).toEqual({ date: '2026-10-25', time: '08:30', durationMinutes: 30 });
});
