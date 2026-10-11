import { describe, expect, it } from 'vitest';
import { addCalendarDays, immutableJson, partitionTemporal, reviseTimeline, selectTemporal, validateTimeline, type TemporalFact, type TemporalTimeline } from '../lib/hr-temporal';
import { assessHrCalculation, selectApprovedHrPolicy, type EmploymentFact, type HrEffectivePolicy } from '../lib/hr-effective-policy';
import { appendSegmentEvidence, collectOccurrenceEvidence, collectSegmentEvidence, correctSegmentEvidence, materializeScheduleSegments, selectHrSchedule, validateScheduleSegments, type HrScheduleSegment } from '../lib/hr-schedule-segments';

const known = <T>(id: string, from: string, to: string | null, value: T): TemporalFact<T> => ({ id, kind: 'known', from, to, value });
const employment: TemporalTimeline<EmploymentFact> = { revision: 1, facts: [
  known('august', '2026-08-01', '2026-09-01', { status: 'active' }),
  { id: 'legacy-observation', kind: 'unknown', value: { status: 'suspended' } },
] };
const night: readonly HrScheduleSegment[] = [
  { id: 'first', start: '22:00', startDayOffset: 0, end: '02:00', endDayOffset: 1 },
  { id: 'second', start: '02:00', startDayOffset: 1, end: '06:00', endDayOffset: 1 },
];
const approved = (key: HrEffectivePolicy['key'], from: string, to: string | null): TemporalTimeline<HrEffectivePolicy> => ({ revision: 1, facts: [known(key, from, to, { key, approval: { state: 'approved', decisionRef: `decision-${key}` }, parameters: { configuredReference: 'synthetic-policy' } })] });

describe('effective-date history and immutable revisions', () => {
  it('keeps a documented August active despite a currently observed suspension of unknown date', () => {
    expect(selectTemporal(employment, '2026-08-15')).toMatchObject({ kind: 'known', fact: { id: 'august', value: { status: 'active' } } });
    expect(selectTemporal(employment, '2026-10-01')).toMatchObject({ kind: 'unknown', observations: [{ value: { status: 'suspended' } }] });
    expect(selectTemporal(employment, '2026-07-31').kind).toBe('unknown');
  });
  it('uses end-exclusive intervals and retains gaps rather than extending the nearest fact', () => {
    const state = { revision: 1, facts: [known('a', '2026-08-01', '2026-08-10', 'active'), known('b', '2026-08-12', null, 'ended')] };
    expect(partitionTemporal(state, '2026-08-09', '2026-08-13').map(p => [p.from, p.to, p.selection.kind])).toEqual([
      ['2026-08-09', '2026-08-10', 'known'], ['2026-08-10', '2026-08-12', 'unknown'], ['2026-08-12', '2026-08-13', 'known'],
    ]);
  });
  it('refuses overlap, including an unbounded prior interval, without selecting the highest ID', () => {
    expect(() => validateTimeline({ revision: 1, facts: [known('a', '2026-01-01', null, 1), known('z', '2026-08-01', null, 2)] })).toThrow(/overlap/);
    expect(() => validateTimeline({ revision: 1, facts: [known('a', '2026-08-01', '2026-08-15', 1), known('b', '2026-08-14', '2026-09-01', 2)] })).toThrow(/overlap/);
  });
  it('requires explicit replacement of an open interval and leaves the old snapshot intact', () => {
    const old = { revision: 1, facts: [known('open', '2026-01-01', null, { status: 'active' })] };
    const next = reviseTimeline(old, { expectedRevision: 1, reason: 'Documented October decision', supersedeIds: ['open'], append: [known('closed', '2026-01-01', '2026-10-01', { status: 'active' }), known('suspended', '2026-10-01', null, { status: 'suspended' })] });
    expect(selectTemporal(old, '2026-10-10')).toMatchObject({ kind: 'known', fact: { value: { status: 'active' } } });
    expect(selectTemporal(next, '2026-10-10')).toMatchObject({ kind: 'known', revision: 2, fact: { value: { status: 'suspended' } } });
    expect(() => reviseTimeline(next, { expectedRevision: 1, reason: 'Stale command', supersedeIds: [], append: [] })).toThrow(/changed/);
  });
  it('stores unknown observations without fabricating an effective date or erasing them on new facts', () => {
    const next = reviseTimeline(employment, { expectedRevision: 1, reason: 'A different documented month', supersedeIds: [], append: [known('november', '2026-11-01', null, { status: 'active' })] });
    expect(next.facts).toContainEqual(employment.facts[1]);
    expect(() => validateTimeline({ revision: 1, facts: [{ id: 'bad', kind: 'unknown', from: '2026-10-01', value: 'suspended' } as unknown as TemporalFact<string>] })).toThrow(/Unknown/);
  });
  it.each(['2026-02-30', '0000-01-01', '2026-8-01'])('rejects invalid calendar date %s', from => {
    expect(() => validateTimeline({ revision: 1, facts: [known('a', from, null, 1)] })).toThrow();
  });
  it('handles leap dates and year boundaries without using the device time zone', () => {
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('copies and deeply freezes snapshots, rejecting non-JSON identity objects', () => {
    const value = { details: { amount: 100 } }, state = validateTimeline({ revision: 1, facts: [known('a', '2026-01-01', null, value)] });
    value.details.amount = 0;
    expect(state.facts[0].value.details.amount).toBe(100); expect(Object.isFrozen(state.facts[0].value.details)).toBe(true);
    expect(() => immutableJson({ value: Number.NaN })).toThrow();
    expect(() => immutableJson({ get value() { throw new Error('must not execute'); } })).toThrow(/accessors/);
  });
});

describe('policy gaps block only the affected calculation', () => {
  it('does not demand suspension policy for a documented earlier active month', () => {
    expect(assessHrCalculation({ operation: 'salary_accrual', from: '2026-08-01', to: '2026-09-01', employment, policies: {} })).toMatchObject({ ready: true, blockers: [] });
  });
  it('blocks unknown employment without producing an amount or guessed active status', () => {
    const result = assessHrCalculation({ operation: 'salary_accrual', from: '2026-10-01', to: '2026-11-01', employment, policies: {} });
    expect(result.ready).toBe(false); expect(result.blockers[0].code).toBe('employment_history_unknown'); expect(result).not.toHaveProperty('amount');
  });
  it('keeps raw attendance measurement independent of missing financial and leave policies', () => {
    expect(assessHrCalculation({ operation: 'attendance_measurement', from: '2026-10-01', to: '2026-11-01', employment, policies: {} })).toMatchObject({ ready: true, blockers: [] });
    expect(assessHrCalculation({ operation: 'leave_entitlement', from: '2026-08-01', to: '2026-09-01', employment, policies: {} }).blockers).toContainEqual({ code: 'policy_history_unknown', from: '2026-08-01', to: '2026-09-01', policyKey: 'leave_entitlement' });
  });
  it('requires explicit approved policy across every affected date, not only at the period start', () => {
    const suspended: TemporalTimeline<EmploymentFact> = { revision: 1, facts: [known('s', '2026-10-01', null, { status: 'suspended' })] };
    const partial = approved('employment_pay_effect', '2026-10-01', '2026-10-15');
    const result = assessHrCalculation({ operation: 'salary_accrual', from: '2026-10-01', to: '2026-11-01', employment: suspended, policies: { employment_pay_effect: partial } });
    expect(result.blockers).toEqual([{ code: 'policy_history_unknown', from: '2026-10-15', to: '2026-11-01', policyKey: 'employment_pay_effect' }]);
    expect(result.segments[0]).toMatchObject({ policies: [{ factId: 'employment_pay_effect', decisionRef: 'decision-employment_pay_effect' }] });
  });
  it('does not treat draft policy values as approval or inherit a future approval into the past', () => {
    const draft: TemporalTimeline<HrEffectivePolicy> = { revision: 1, facts: [known('draft', '2026-10-01', null, { key: 'leave_entitlement', approval: { state: 'unapproved' }, parameters: { annualDays: 30 } })] };
    expect(selectApprovedHrPolicy(draft, 'leave_entitlement', '2026-10-01')).toMatchObject({ kind: 'blocked', code: 'policy_not_approved' });
    expect(selectApprovedHrPolicy(approved('leave_entitlement', '2027-01-01', null), 'leave_entitlement', '2026-10-01')).toMatchObject({ kind: 'blocked' });
  });
  it('requires proration policy when employment changes or the caller identifies a partial period', () => {
    const state: TemporalTimeline<EmploymentFact> = { revision: 1, facts: [known('a', '2026-08-01', '2026-08-15', { status: 'active' }), known('s', '2026-08-15', null, { status: 'suspended' })] };
    const result = assessHrCalculation({ operation: 'salary_accrual', from: '2026-08-01', to: '2026-09-01', employment: state, policies: { employment_pay_effect: approved('employment_pay_effect', '2026-08-01', null) } });
    expect(result.ready).toBe(false); expect(result.blockers.every(b => b.policyKey === 'proration')).toBe(true);
    expect(assessHrCalculation({ operation: 'salary_accrual', from: '2026-08-01', to: '2026-09-01', employment, policies: {}, requiresProration: true }).ready).toBe(false);
  });
});

describe('anchored segments, raw evidence and reasoned corrections', () => {
  it('materializes touching night segments across a year boundary using clinic time', () => {
    const snapshot = materializeScheduleSegments('2026-12-31', 'Asia/Aden', night);
    expect(snapshot.windows).toEqual([{ id: 'first', start: '2026-12-31T19:00:00.000Z', end: '2026-12-31T23:00:00.000Z' }, { id: 'second', start: '2026-12-31T23:00:00.000Z', end: '2027-01-01T03:00:00.000Z' }]);
  });
  it('selects the dated schedule revision and retains the source fact in the snapshot', () => {
    const timeline = { revision: 3, facts: [known('night-v2', '2026-10-01', null, { timeZone: 'Asia/Aden', segments: night })] };
    expect(selectHrSchedule(timeline, '2026-09-30')).toMatchObject({ kind: 'blocked', code: 'schedule_history_unknown' });
    expect(selectHrSchedule(timeline, '2026-10-01')).toMatchObject({ kind: 'selected', timelineRevision: 3, factId: 'night-v2', calculationVersion: 'hr-segments-v1' });
  });
  it('requires day offsets and refuses actual overlap while allowing the exact shared boundary', () => {
    expect(validateScheduleSegments(night)).toEqual(night);
    expect(() => validateScheduleSegments([{ ...night[0], endDayOffset: 0 }])).toThrow(/ordered/);
    expect(() => validateScheduleSegments([night[0], { ...night[1], start: '01:59' }])).toThrow(/overlap/);
  });
  it.each([['2026-03-08', '02:30', 'nonexistent'], ['2026-11-01', '01:30', 'ambiguous']])('refuses %s %s New York wall-time ambiguity instead of guessing', (day, start, code) => {
    try { materializeScheduleSegments(day, 'America/New_York', [{ id: 's', start, startDayOffset: 0, end: '04:00', endDayOffset: 0 }]); throw new Error('unexpected success'); }
    catch (error) { expect(error).toMatchObject({ code: `${code}_wall_time` }); }
  });
  it('does not invent a missing boundary event, double count duplicates, or reuse an event across segments', () => {
    const { windows } = materializeScheduleSegments('2026-12-31', 'Asia/Aden', night);
    const input = [{ segmentId: 'first', punches: [{ id: 'in1', type: 'check_in' as const, at: windows[0].start }, { id: 'out1', type: 'check_out' as const, at: windows[0].end }, { id: 'dup', type: 'check_out' as const, at: windows[0].end }] }, { segmentId: 'second', punches: [{ id: 'out2', type: 'check_out' as const, at: windows[1].end }] }];
    const partial = collectOccurrenceEvidence(windows, input);
    expect(partial).toMatchObject({ complete: false, provenWorkMinutes: 240, totalWorkMinutes: null }); expect(partial.segments[1].actualIn).toBeNull();
    const complete = collectOccurrenceEvidence(windows, [input[0], { segmentId: 'second', punches: [...input[1].punches, { id: 'in2', type: 'check_in', at: windows[1].start }] }]);
    expect(complete).toMatchObject({ complete: true, totalWorkMinutes: 480 }); expect(complete.segments[0].rawPunches).toHaveLength(3);
    expect(() => collectOccurrenceEvidence(windows, [input[0], { segmentId: 'second', punches: [input[0].punches[1]] }])).toThrow(/two segments/);
  });
  it('preserves an approved correction and raw events, refuses stale/self approval, and ignores rejected values', () => {
    const partial = collectSegmentEvidence('night', [{ id: 'a', type: 'check_in', at: '2026-10-01T22:00:00+03:00' }]);
    const decision = { segmentId: 'night', status: 'approved' as const, expectedSegmentVersion: 1, newIn: '2026-10-01T22:00:00+03:00', newOut: '2026-10-02T06:00:00+03:00', reason: 'Documented missing exit', requestedBy: 1, decidedBy: 2 };
    expect(() => correctSegmentEvidence(partial, { ...decision, decidedBy: 1 })).toThrow(/own correction/);
    const fixed = correctSegmentEvidence(partial, decision);
    expect(fixed.workMinutes).toBe(480); expect(fixed.rawPunches).toEqual(partial.rawPunches); expect(partial.actualOut).toBeNull();
    expect(() => correctSegmentEvidence(fixed, decision)).toThrow(/changed/);
    const late = { id: 'b', type: 'check_out' as const, at: '2026-10-02T05:00:00+03:00' };
    expect(appendSegmentEvidence(fixed, [late])).toMatchObject({ state: 'corrected', workMinutes: 480, rawPunches: [...partial.rawPunches, late] });
    const rejected = correctSegmentEvidence(partial, { ...decision, status: 'rejected' });
    expect(rejected.workMinutes).toBeNull(); expect(appendSegmentEvidence(rejected, [late])).toMatchObject({ state: 'complete', workMinutes: 420 });
  });
});
