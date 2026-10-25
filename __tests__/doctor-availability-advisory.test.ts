import { beforeEach, expect, it, vi } from 'vitest';
import { readDoctorAvailabilityAdvisory } from '../lib/doctor-availability-advisory';
const { query, release, connect, readSources } = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn(), readSources: vi.fn() }));
vi.mock('../lib/db', () => ({ getPool: () => ({ connect }) }));
vi.mock('../lib/doctor-clinical-roster', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/doctor-clinical-roster')>(), readClinicalRosterSources: readSources,
}));
beforeEach(() => {
  vi.clearAllMocks(); query.mockReset(); readSources.mockReset();
  query.mockResolvedValue({ rows: [] }); connect.mockResolvedValue({ query, release });
});
it.each([null, '2026-10-24'])('uses one read-only snapshot and distinguishes an expired anchor assignment: %s', async effectiveTo => {
  readSources.mockResolvedValue({ staff: [{ id: 1, userId: 1, department: 'doctors', workStatus: 'active', hireDate: null, endDate: null }],
    accounts: [{ id: 1, partyId: 7, active: true }], parties: [{ id: 7, kind: 'doctor', active: true }], partyLinks: null, leaves: [],
    schedules: [{ id: 1, staffId: 1, department: null, active: true, effectiveFrom: '2026-01-01', effectiveTo,
      workingDays: [6], start: '22:00', end: '04:00', secondStart: null, secondEnd: null, crossesMidnight: true, scheduleType: 'night', updatedAt: 'v1' }] });
  expect(await readDoctorAvailabilityAdvisory(7,'2026-10-25','Asia/Aden')).toEqual({ purpose: 'advisory_only', bookingGuaranteed: false,
    doctorId: 7, date: '2026-10-25', timeZone: 'Asia/Aden', resolved: true, reason: null, windows: [{ start: 0, end: 240 }],
    ...(effectiveTo ? { currentAssignmentMissing: true } : {}) });
  expect(connect).toHaveBeenCalledOnce(); expect(readSources).toHaveBeenCalledExactlyOnceWith({ query, release },7,'2026-10-25');
  expect(query.mock.calls.map(c => c[0])).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','COMMIT']);
  expect(release).toHaveBeenCalledWith(false);
});
it('does not turn missing schema into an available day', async () => {
  readSources.mockResolvedValue(null);
  expect(await readDoctorAvailabilityAdvisory(7,'2026-10-25','Asia/Aden')).toMatchObject({ resolved: false, reason: 'schema_unavailable', bookingGuaranteed: false, windows: [] });
});
it('propagates read failure and discards the client after failed rollback', async () => {
  const failure = new Error('synthetic read failure'); readSources.mockRejectedValue(failure);
  query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error('rollback failure'));
  await expect(readDoctorAvailabilityAdvisory(7,'2026-10-25','Asia/Aden')).rejects.toBe(failure);
  expect(query).toHaveBeenLastCalledWith('ROLLBACK'); expect(release).toHaveBeenCalledWith(true);
});
it.each([[0,'2026-10-25','Asia/Aden'],[7,'2026-02-30','Asia/Aden'],[7,'2026-10-25','bad-zone'],[7,'0001-01-01','UTC']] as const)('rejects invalid request %s %s %s before connecting', async (id,date,zone) => {
  expect(await readDoctorAvailabilityAdvisory(id,date,zone)).toMatchObject({ resolved: false, reason: 'invalid_request', bookingGuaranteed: false });
  expect(connect).not.toHaveBeenCalled();
});
