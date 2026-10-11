import { expect, it } from 'vitest';
import { collectScheduleEvidence, correctScheduleSegment, selectHrSchedule, validateEffectiveSchedule, validateScheduleTimeline, type HrEffectiveSchedule } from '../lib/hr-schedule-segments';
import type { TemporalTimeline } from '../lib/hr-temporal';

const schedule = (start: string, end: string, endDayOffset: 0 | 1, workingDays = [0, 1, 2, 3, 4, 5, 6]): HrEffectiveSchedule => ({ timeZone: 'Asia/Aden', workingDays, graceMins: 0, segments: [{ id: 'work', start, startDayOffset: 0, end, endDayOffset }] });
const transition = (start: string): TemporalTimeline<HrEffectiveSchedule> => ({ revision: 2, facts: [
  { id: 'old', kind: 'known', from: '2026-10-01', to: '2026-10-02', value: schedule('22:00', '06:00', 1) },
  { id: 'new', kind: 'known', from: '2026-10-02', to: null, value: schedule(start, '13:00', 0) },
] });

it.each([[1, 2], [6, 0]])('rejects recurring 25-hour occurrences on weekdays %j', (...days) => {
  expect(() => validateEffectiveSchedule(schedule('22:00', '23:00', 1, days))).toThrow(/occurrence_overlap/);
});
it('rejects the old Oct1 night / new Oct2 05:00 overlap before selection', () => {
  expect(() => selectHrSchedule(transition('05:00'), '2026-10-02')).toThrow(/occurrence_overlap/);
});
it('allows the exact 06:00 shared boundary across dated versions', () => {
  expect(selectHrSchedule(transition('06:00'), '2026-10-01')).toMatchObject({ kind: 'selected', factId: 'old' });
  expect(selectHrSchedule(transition('06:00'), '2026-10-02')).toMatchObject({ kind: 'selected', factId: 'new' });
});
it('allows long but spaced occurrences without inventing a legal duration ceiling', () => {
  expect(validateEffectiveSchedule(schedule('00:00', '23:59', 1, [1, 3, 5])).segments[0].end).toBe('23:59');
});

it.each([0, 1, 2, 3, 4, 5, 6])('checks consecutive repeats for every weekday including wrap: %i', day => {
  expect(() => validateEffectiveSchedule(schedule('22:00', '23:00', 1, [day, (day + 1) % 7]))).toThrow(/occurrence_overlap/);
  expect(validateEffectiveSchedule(schedule('22:00', '22:00', 1, [day, (day + 1) % 7]))).toBeDefined();
});
it('compares split segments instead of rejecting overlapping envelopes around legitimate gaps', () => {
  const value = { ...schedule('08:00', '09:00', 0), segments: [schedule('08:00', '09:00', 0).segments[0], { id: 'late', start: '10:00', startDayOffset: 1 as const, end: '11:00', endDayOffset: 1 as const }] };
  expect(validateEffectiveSchedule(value)).toEqual(value);
});
it('compares actual UTC across changed zones and a gap without assuming missing history is a day off', () => {
  const timeline: TemporalTimeline<HrEffectiveSchedule> = { revision: 1, facts: [
    { id: 'old-zone', kind: 'known', from: '2026-10-01', to: '2026-10-02', value: { ...schedule('22:00', '06:00', 1), timeZone: 'America/Adak' } },
    { id: 'new-zone', kind: 'known', from: '2026-10-03', to: '2026-10-04', value: { ...schedule('01:00', '09:00', 0), timeZone: 'Pacific/Kiritimati' } },
  ] };
  expect(() => validateScheduleTimeline(timeline)).toThrow(/occurrence_overlap/);
  expect(() => validateScheduleTimeline({ ...timeline, facts: [...timeline.facts].reverse() })).toThrow(/occurrence_overlap/);
});
it('checks the furthest possible three-day anchor gap for opposite time zones', () => {
  const make = (start: string): TemporalTimeline<HrEffectiveSchedule> => ({ revision: 1, facts: [
    { id: 'old-zone', kind: 'known', from: '2026-10-01', to: '2026-10-02', value: { ...schedule('00:00', '23:59', 1, [4]), timeZone: 'Etc/GMT+12' } },
    { id: 'new-zone', kind: 'known', from: '2026-10-04', to: '2026-10-05', value: { ...schedule(start, '03:00', 0, [0]), timeZone: 'Pacific/Kiritimati' } },
  ] });
  expect(() => validateScheduleTimeline(make('00:00'))).toThrow(/occurrence_overlap/);
  expect(validateScheduleTimeline(make('02:00')).facts).toHaveLength(2);
});
it.each([['2026-03-08', '2026-03-09', '02:30', 'nonexistent_wall_time'], ['2026-11-01', '2026-11-02', '01:30', 'ambiguous_wall_time']])('blocks unresolved %s transition endpoints before calculating another version', (from, to, start, code) => {
  const timeline: TemporalTimeline<HrEffectiveSchedule> = { revision: 1, facts: [
    { id: 'old-zone', kind: 'known', from, to, value: { ...schedule(start, '04:00', 0), timeZone: 'America/New_York' } },
    { id: 'new-zone', kind: 'known', from: to, to: null, value: schedule('06:00', '13:00', 0) },
  ] };
  expect(() => selectHrSchedule(timeline, to)).toThrow(expect.objectContaining({ code }));
});

function assignments() {
  return ['2026-10-01', '2026-10-02'].map(anchorDay => {
    const selected = selectHrSchedule(transition('06:00'), anchorDay);
    if (selected.kind !== 'selected') throw new Error('fixture selection');
    return { anchorDay, segments: selected.windows.map(window => ({ segmentId: window.id, punches: [
      { id: `${anchorDay}-in`, type: 'check_in' as const, at: window.start },
      { id: `${anchorDay}-out`, type: 'check_out' as const, at: window.end },
    ] })) };
  });
}
it('requires separate exit/entry raw IDs at a shared boundary and preserves both occurrences', () => {
  const input = assignments(), result = collectScheduleEvidence(transition('06:00'), input);
  expect(result).toMatchObject({ complete: true, totalWorkMinutes: 900, provenWorkMinutes: 900 });
  expect(result.occurrences.map(o => o.factId)).toEqual(['old', 'new']);
  expect(result.occurrences[0].evidence.segments[0].rawPunches).toEqual(input[0].segments[0].punches);
  expect(input[0].segments[0].punches[1].at).toBe(input[1].segments[0].punches[0].at);
  input[1].segments[0].punches[0].id = input[0].segments[0].punches[1].id;
  expect(() => collectScheduleEvidence(transition('06:00'), input)).toThrow(/two occurrences/);
});
it('does not invent a missing boundary punch or allow actual work to overlap across anchors', () => {
  const missing = assignments(); missing[1].segments[0].punches.shift();
  expect(collectScheduleEvidence(transition('06:00'), missing)).toMatchObject({ complete: false, totalWorkMinutes: null, provenWorkMinutes: 480 });
  const overlapping = assignments(); overlapping[1].segments[0].punches[0].at = '2026-10-02T02:30:00Z';
  expect(() => collectScheduleEvidence(transition('06:00'), overlapping)).toThrow(/overlaps across occurrences/);
  expect(() => collectScheduleEvidence(transition('06:00'), [assignments()[0], assignments()[0]])).toThrow(/only once/);
});
it('rechecks cross-occurrence overlap after an approved correction without changing raw evidence', () => {
  const current = collectScheduleEvidence(transition('06:00'), assignments());
  const correction = { segmentId: 'work', status: 'approved' as const, expectedSegmentVersion: 1, newIn: '2026-10-01T19:00:00Z', newOut: '2026-10-02T03:30:00Z', reason: 'Synthetic documented correction', requestedBy: 1, decidedBy: 2 };
  expect(() => correctScheduleSegment(current, '2026-10-01', correction)).toThrow(/overlaps across occurrences/);
  const fixed = correctScheduleSegment(current, '2026-10-01', { ...correction, newOut: '2026-10-02T02:30:00Z' });
  expect(fixed.totalWorkMinutes).toBe(870);
  expect(fixed.occurrences[0].evidence.segments[0].rawPunches).toEqual(current.occurrences[0].evidence.segments[0].rawPunches);
  expect(fixed.occurrences[1]).toEqual(current.occurrences[1]);
  expect(current.totalWorkMinutes).toBe(900);
});
it('keeps unknown history unresolved and refuses to turn an empty evidence set into zero earned time', () => {
  expect(selectHrSchedule({ revision: 0, facts: [] }, '2026-10-01')).toMatchObject({ kind: 'blocked', code: 'schedule_history_unknown' });
  expect(() => collectScheduleEvidence({ revision: 0, facts: [] }, assignments())).toThrow(/not resolved/);
  expect(collectScheduleEvidence(transition('06:00'), [])).toMatchObject({ complete: false, totalWorkMinutes: null });
});
