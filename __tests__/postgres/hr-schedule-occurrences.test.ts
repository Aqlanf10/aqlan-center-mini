import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { HR_STAFF_SQL } from '../../lib/hr-schema';
import { appendHrTimeline, readHrTimeline } from '../../lib/hr-temporal-store';

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  await fixture.source.query(await readFile('migrations/0001_baseline_schema.sql', 'utf8'));
  await fixture.source.query(HR_STAFF_SQL);
  await fixture.source.query(await readFile('migrations/0056_hr_employment_history.sql', 'utf8'));
  await fixture.source.query(await readFile('migrations/0057_hr_schedule_policy_versions.sql', 'utf8'));
  await fixture.source.query("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(901,'r1-manager','Synthetic R1 Manager','synthetic','admin')");
});
afterAll(async () => { await fixture?.close(); });
const schedule = (start: string, end: string, endDayOffset: number, workingDays = [0, 1, 2, 3, 4, 5, 6]) => ({ timeZone: 'Asia/Aden', workingDays, graceMins: 0, segments: [{ id: 'work', start, startDayOffset: 0, end, endDayOffset }] });
const known = (id: string, from: string, to: string | null, value: ReturnType<typeof schedule>) => ({ id, kind: 'known', from, to, value });
async function rawInsert(facts: ReturnType<typeof known>[]) {
  const staff = (await fixture.source.query("INSERT INTO hr_staff(full_name,created_by) VALUES('Synthetic R1 employee','test') RETURNING id")).rows[0];
  const stream = (await fixture.source.query("INSERT INTO hr_effective_streams(kind,subject_key,staff_id) VALUES('schedule',$1::text,$1::text::int) RETURNING id", [String(staff.id)])).rows[0];
  return fixture.source.query("INSERT INTO hr_effective_revisions(stream_id,revision,previous_revision,actor_user_id,reason,snapshot) VALUES($1,1,0,901,'Synthetic R1 proof',$2) RETURNING stream_id", [stream.id, JSON.stringify({ revision: 1, facts })]);
}
it.each([[1, 2], [6, 0]])('raw SQL rejects weekly recurrence overlap on %j', async (...days) => {
  await expect(rawInsert([known('long', '2026-10-01', null, schedule('22:00', '23:00', 1, days))])).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('occurrence_overlap') });
});
it('raw SQL rejects Oct1 night continuing into a new Oct2 05:00 schedule', async () => {
  await expect(rawInsert([known('old', '2026-10-01', '2026-10-02', schedule('22:00', '06:00', 1)), known('new', '2026-10-02', null, schedule('05:00', '13:00', 0))])).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('occurrence_overlap') });
});
it('raw SQL allows exactly touching versions and long but spaced occurrences', async () => {
  expect((await rawInsert([known('old', '2026-10-01', '2026-10-02', schedule('22:00', '06:00', 1)), known('new', '2026-10-02', null, schedule('06:00', '13:00', 0))])).rowCount).toBe(1);
  expect((await rawInsert([known('long', '2026-10-01', null, schedule('00:00', '23:59', 1, [1, 3, 5]))])).rowCount).toBe(1);
});
it.each([0, 1, 2, 3, 4, 5, 6])('raw SQL handles consecutive weekday %i and accepts a 24-hour touching repeat', async day => {
  await expect(rawInsert([known('long', '2026-10-01', null, schedule('22:00', '23:00', 1, [day, (day + 1) % 7]))])).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('occurrence_overlap') });
  expect((await rawInsert([known('long', '2026-10-01', null, schedule('22:00', '22:00', 1, [day, (day + 1) % 7]))])).rowCount).toBe(1);
});
it('raw SQL accepts separate split segments even when occurrence envelopes intersect', async () => {
  const value = { ...schedule('08:00', '09:00', 0), segments: [schedule('08:00', '09:00', 0).segments[0], { id: 'late', start: '10:00', startDayOffset: 1, end: '11:00', endDayOffset: 1 }] };
  expect((await rawInsert([known('split', '2026-10-01', null, value)])).rowCount).toBe(1);
});
it('raw SQL checks distant local dates that overlap in UTC, with a safe later start accepted', async () => {
  const facts = (start: string) => [
    known('old-zone', '2026-10-01', '2026-10-02', { ...schedule('00:00', '23:59', 1, [4]), timeZone: 'Etc/GMT+12' }),
    known('new-zone', '2026-10-04', '2026-10-05', { ...schedule(start, '03:00', 0, [0]), timeZone: 'Pacific/Kiritimati' }),
  ];
  await expect(rawInsert(facts('00:00'))).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('occurrence_overlap') });
  expect((await rawInsert(facts('02:00'))).rowCount).toBe(1);
});
it.each([['2026-03-08', '2026-03-09', '02:30', 'nonexistent_wall_time'], ['2026-11-01', '2026-11-02', '01:30', 'ambiguous_wall_time']])('raw SQL does not silently normalize %s DST endpoints', async (from, to, start, code) => {
  await expect(rawInsert([
    known('old-zone', from, to, { ...schedule(start, '04:00', 0), timeZone: 'America/New_York' }),
    known('new-zone', to, null, schedule('06:00', '13:00', 0)),
  ])).rejects.toMatchObject({ code: '23514', message: expect.stringContaining(code) });
});
it('failed raw and adapter revisions preserve the prior snapshot; a corrected boundary appends once', async () => {
  const old = known('old', '2026-10-01', '2026-10-02', schedule('22:00', '06:00', 1));
  const streamId = (await rawInsert([old])).rows[0].stream_id;
  const row = (await fixture.source.query('SELECT subject_key FROM hr_effective_streams WHERE id=$1', [streamId])).rows[0];
  const stream = { kind: 'schedule' as const, subjectKey: row.subject_key };
  const before = await readHrTimeline(fixture.source, stream);
  const next = known('new', '2026-10-02', null, schedule('05:00', '13:00', 0));
  await expect(fixture.source.query("INSERT INTO hr_effective_revisions(stream_id,revision,previous_revision,actor_user_id,reason,snapshot) VALUES($1,2,1,901,'Synthetic conflicting revision',$2)", [streamId, JSON.stringify({ revision: 2, facts: [old, next] })])).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('occurrence_overlap') });
  await expect(appendHrTimeline(fixture.source, stream, { append: [next], supersedeIds: [], expectedRevision: 1, reason: 'Synthetic conflicting revision' }, 901)).rejects.toMatchObject({ code: 'occurrence_overlap' });
  expect(await readHrTimeline(fixture.source, stream)).toEqual(before);
  const corrected = known('safe-new', '2026-10-02', null, schedule('06:00', '13:00', 0));
  const after = await appendHrTimeline(fixture.source, stream, { append: [corrected], supersedeIds: [], expectedRevision: 1, reason: 'Synthetic non-overlapping revision' }, 901);
  expect(after.revision).toBe(2); expect(await readHrTimeline(fixture.source, stream, 1)).toEqual(before);
  expect((await fixture.source.query('SELECT count(*)::int AS n FROM hr_effective_revisions WHERE stream_id=$1', [streamId])).rows[0].n).toBe(2);
});
