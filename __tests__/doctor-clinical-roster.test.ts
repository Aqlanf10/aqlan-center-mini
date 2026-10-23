import { describe, expect, it, vi, beforeEach } from 'vitest';
import { normalizeClinicalSchedule, readDoctorClinicalRoster, resolveDoctorClinicalRoster, type RosterSources, type RosterSchedule } from '../lib/doctor-clinical-roster';

const query = vi.fn();
const release = vi.fn();
vi.mock('../lib/db', () => ({ getPool: () => ({ connect: async () => ({ query, release }) }) }));
const schedule = (extra: Partial<RosterSchedule> = {}): RosterSchedule => ({ id: 10, staffId: 1, department: null, active: true,
  effectiveFrom: '2026-01-01', effectiveTo: null, workingDays: [0, 1, 2, 3, 4, 5, 6],
  start: '08:00', end: '12:00', secondStart: null, secondEnd: null, crossesMidnight: false, scheduleType: 'morning', updatedAt: 'v1', ...extra });
const sources = (): RosterSources => ({
  staff: [{ id: 1, userId: 5, department: 'doctors', workStatus: 'active', hireDate: '2020-01-01', endDate: null }],
  accounts: [{ id: 5, partyId: 7, active: true }], parties: [{ id: 7, kind: 'doctor', active: true }],
  partyLinks: null, schedules: [schedule()], leaves: [],
});
const resolve = (s = sources(), date = '2026-10-21') => resolveDoctorClinicalRoster(s, 7, date, 'Asia/Aden');
const leave = (extra = {}) => ({ id: 3, staffId: 1, startDate: '2026-10-21', endDate: '2026-10-21', status: 'approved', partial: false, updatedAt: 'v1', ...extra });

describe('clinical roster normalization', () => {
  it('normalizes morning, evening, contiguous and split same-day periods', () => {
    expect(normalizeClinicalSchedule(schedule())).toEqual([[480, 720]]);
    expect(normalizeClinicalSchedule(schedule({ start: '15:00', end: '21:00', scheduleType: 'evening' }))).toEqual([[900, 1260]]);
    expect(normalizeClinicalSchedule(schedule({ secondStart: '12:00', secondEnd: '17:00', scheduleType: 'split' }))).toEqual([[480, 720], [720, 1020]]);
    expect(normalizeClinicalSchedule(schedule({ secondStart: '16:00', secondEnd: '20:00', scheduleType: 'split' }))).toEqual([[480, 720], [960, 1200]]);
  });
  it('requires explicit midnight crossing and preserves overnight offset', () => {
    expect(normalizeClinicalSchedule(schedule({ start: '22:00', end: '04:00' }))).toBeNull();
    const s = sources(); s.schedules = [schedule({ start: '22:00', end: '04:00', crossesMidnight: true, scheduleType: 'night' })];
    expect(resolve(s).intervals).toEqual([{ startTime: '22:00', endTime: '04:00', startDayOffset: 0, endDayOffset: 1 }]);
  });
  it.each([
    { start: '24:00' }, { start: '8:00' }, { end: '08:00' }, { crossesMidnight: true },
    { secondStart: '11:00', secondEnd: '17:00' }, { secondStart: '16:00' }, { scheduleType: 'split' },
    { workingDays: [] }, { workingDays: [7] }, { workingDays: ['3'] }, { effectiveFrom: '2026-02-30' },
    { start: '22:00', end: '04:00', crossesMidnight: true, secondStart: '06:00', secondEnd: '08:00' },
  ])('rejects malformed or unsupported row %j', patch => expect(normalizeClinicalSchedule(schedule(patch))).toBeNull());
});

describe('date-scoped identity and assignments', () => {
  it('uses explicit user mapping or open party link without name or contract inference', () => {
    expect(resolve().status).toBe('resolved');
    const s = sources(); s.staff[0].userId = null; s.accounts = []; s.partyLinks = [{ staffId: 1, partyId: 7 }];
    expect(resolve(s).status).toBe('resolved');
    s.partyLinks = null;
    expect(resolve(s).unresolvedReason).toBe('missing_mapping');
  });
  it('fails closed for conflicting links and multiple staff sharing one doctor', () => {
    const s = sources(); s.partyLinks = [{ staffId: 1, partyId: 8 }];
    expect(resolve(s).unresolvedReason).toBe('invalid_mapping');
    s.partyLinks = [{ staffId: 2, partyId: 7 }]; s.staff.push({ ...s.staff[0], id: 2, userId: null });
    expect(resolve(s).unresolvedReason).toBe('ambiguous_mapping');
  });
  it('rejects inactive doctor, account or staff and staff outside employment dates', () => {
    const s = sources(); s.parties[0].active = false;
    expect(resolve(s).unresolvedReason).toBe('invalid_doctor');
    s.parties[0].active = true; s.accounts[0].active = false;
    expect(resolve(s).unresolvedReason).toBe('invalid_mapping');
    s.accounts[0].active = true; s.staff[0].workStatus = 'suspended';
    expect(resolve(s).unresolvedReason).toBe('inactive_staff');
    s.staff[0].workStatus = 'active'; s.staff[0].endDate = '2026-10-20';
    expect(resolve(s).unresolvedReason).toBe('inactive_staff');
  });
  it('staff assignment overrides department, even on its non-working weekday', () => {
    const s = sources(); s.schedules.push(schedule({ id: 11, staffId: null, department: 'doctors' }));
    expect(resolve(s).sourceScheduleId).toBe(10);
    s.schedules[0].workingDays = [0];
    expect(resolve(s)).toMatchObject({ status: 'resolved', intervals: [] });
    s.schedules[0].active = false;
    expect(resolve(s).sourceScheduleId).toBe(11);
  });
  it('uses inclusive effective dates and does not choose latest overlapping schedule', () => {
    const s = sources(); s.schedules[0].effectiveTo = '2026-10-21';
    expect(resolve(s).status).toBe('resolved');
    expect(resolve(s, '2026-10-22').unresolvedReason).toBe('missing_schedule');
    s.schedules.push(schedule({ id: 12, effectiveFrom: '2026-10-21' }));
    expect(resolve(s).unresolvedReason).toBe('ambiguous_schedule');
    s.schedules = s.schedules.map(v => ({ ...v, staffId: null, department: 'doctors' }));
    expect(resolve(s).unresolvedReason).toBe('ambiguous_schedule');
  });
  it('never uses a clinic-wide default or another employee assignment', () => {
    const s = sources(); s.schedules = [schedule({ staffId: null }), schedule({ id: 11, staffId: 9, department: 'doctors' })];
    expect(resolve(s).unresolvedReason).toBe('missing_schedule');
  });
  it('fails invalid date/timezone before producing intervals', () => {
    expect(resolve(sources(), '2026-02-30').unresolvedReason).toBe('invalid_request');
    expect(resolveDoctorClinicalRoster(sources(), 7, '2026-10-21', 'Invalid/Zone').unresolvedReason).toBe('invalid_request');
  });
  it('includes stable source/revision metadata that changes with schedule or leave', () => {
    const s = sources(), a = resolve(s);
    expect(a).toMatchObject({ staffId: 1, doctorPartyId: 7, sourceScheduleId: 10, clinicTimeZone: 'Asia/Aden', effectiveFrom: '2026-01-01' });
    expect(resolve(s).revision).toBe(a.revision);
    s.schedules[0].end = '13:00';
    expect(resolve(s).sourceScheduleRevision).not.toBe(a.sourceScheduleRevision);
    const b = resolve(s); s.leaves = [leave()];
    expect(resolve(s).revision).not.toBe(b.revision);
    expect(resolve(s).sourceScheduleRevision).toBe(b.sourceScheduleRevision);
  });
});

describe('approved leave overlay, not attendance', () => {
  it('subtracts approved full-day leave while retaining source intervals and closure IDs', () => {
    const s = sources(); s.leaves = [leave()];
    expect(resolve(s)).toMatchObject({ status: 'resolved', intervals: [], scheduledIntervals: [{ startTime: '08:00', endTime: '12:00' }],
      approvedClosureIntervals: [{ leaveId: 3, startTime: '00:00', endTime: '00:00', startDayOffset: 0, endDayOffset: 1 }] });
  });
  it.each(['pending', 'under_review', 'rejected', 'cancelled'])('does not subtract %s leave', status => {
    const s = sources(); s.leaves = [leave({ status })]; expect(resolve(s).intervals).toHaveLength(1);
  });
  it('refuses to guess partial leave bounds', () => {
    const s = sources(); s.leaves = [leave({ partial: true })];
    expect(resolve(s)).toMatchObject({ status: 'unresolved', unresolvedReason: 'unsupported_partial_leave', intervals: [] });
  });
  it('closes the entire shift for start-day leave, and clips next-day leave at midnight', () => {
    const s = sources(); s.schedules = [schedule({ start: '22:00', end: '04:00', crossesMidnight: true })];
    s.leaves = [leave()];
    expect(resolve(s).intervals).toEqual([]);
    expect(resolve(s).approvedClosureIntervals[0]).toMatchObject({ startTime: '00:00', endTime: '04:00', endDayOffset: 1 });
    s.leaves = [leave({ startDate: '2026-10-22', endDate: '2026-10-22' })];
    expect(resolve(s).intervals).toEqual([{ startTime: '22:00', endTime: '00:00', startDayOffset: 0, endDayOffset: 1 }]);
    s.leaves.push(leave()); expect(resolve(s).intervals).toEqual([]);
  });
  it('ignores other staff leave and next-day leave when no overnight tail exists', () => {
    const s = sources(); s.leaves = [leave({ staffId: 9 }), leave({ startDate: '2026-10-22', endDate: '2026-10-22', partial: true })];
    expect(resolve(s).intervals).toHaveLength(1);
  });
});

describe('read-only database adapter', () => {
  beforeEach(() => { query.mockReset(); release.mockReset(); });
  it('uses repeatable-read read-only snapshot and only safe projections with optional link fallback', async () => {
    const s = sources();
    const replies = [[], [{ ready: true, links: false }], s.staff, s.accounts, s.parties, s.schedules, s.leaves, []];
    query.mockImplementation(async () => ({ rows: replies.shift() }));
    expect((await readDoctorClinicalRoster(7, '2026-10-21', 'Asia/Aden')).status).toBe('resolved');
    const sql = query.mock.calls.map(c => c[0] as string);
    expect(sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); expect(sql.at(-1)).toBe('COMMIT');
    expect(sql.join('\n')).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|FOR SHARE|FOR UPDATE)\b/i);
    expect(sql.join('\n')).not.toMatch(/salary|contract|payroll|punch|full_name|password|hr_temporal/i);
    expect(release).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledWith(false);
  });
  it('reports missing HR schema without ensuring it', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ready: false }] }).mockResolvedValueOnce({ rows: [] });
    expect((await readDoctorClinicalRoster(7, '2026-10-21')).unresolvedReason).toBe('schema_unavailable');
    expect(query).toHaveBeenCalledTimes(3); expect(release).toHaveBeenCalledOnce();
  });
  it('rolls back errors, releases the connection, and does not return availability', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce({ rows: [] });
    await expect(readDoctorClinicalRoster(7, '2026-10-21')).rejects.toThrow('read failed');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK'); expect(release).toHaveBeenCalledWith(false);
  });
  it('preserves the original failure and discards the connection if rollback fails', async () => {
    const original = new Error('original read failure');
    query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(original).mockRejectedValueOnce(new Error('rollback failed'));
    await expect(readDoctorClinicalRoster(7, '2026-10-21')).rejects.toBe(original);
    expect(release).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledWith(true);
  });
  it('does not open a database transaction for invalid requests', async () => {
    expect((await readDoctorClinicalRoster(7, '2026-02-30')).unresolvedReason).toBe('invalid_request');
    expect(query).not.toHaveBeenCalled();
  });
});
