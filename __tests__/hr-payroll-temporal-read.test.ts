import { expect, it } from 'vitest';
import { explainHrPayrollHistory, type HrPayrollHistoryInput } from '../lib/hr-payroll-temporal-read';
import type { TemporalFact } from '../lib/hr-temporal';
const fact = <T>(id: string, from: string, to: string | null, value: T): TemporalFact<T> => ({ id, kind: 'known', from, to, value });
function input(): HrPayrollHistoryInput {
  return { from: '2026-10-01', to: '2026-11-01', employment: { revision: 3, facts: [fact('active', '2026-10-01', null, { status: 'active' })] },
    schedule: { revision: 7, facts: [fact('schedule', '2026-10-01', null, { timeZone: 'Asia/Aden', workingDays: [0, 1, 2, 3, 4, 5, 6], graceMins: 0, segments: [{ id: 'day', start: '08:00', startDayOffset: 0, end: '16:00', endDayOffset: 0 }] })] }, policies: {},
    profile: { kind: 'salary', salaryMinor: 10000, currency: 'SAR', salaryPeriod: 'monthly', effectiveOn: '2026-10-01', hireDate: null, endDate: null },
    contracts: [{ id: 10, contractNumber: 'Synthetic', versionNumber: 1, status: 'approved', startDate: '2026-10-01', endDate: null, kind: 'salary', salaryMinor: 10000, currency: 'SAR', salaryPeriod: 'monthly', commissionRatePercent: null, doctorPartyId: null }] };
}
it('pins revisions and partitions the entire end-exclusive period without returning an earned amount or operational approval', () => {
  const result = explainHrPayrollHistory(input());
  expect(result).toMatchObject({ from: '2026-10-01', to: '2026-11-01', endExclusive: true, pinnedRevisions: { employment: 3, schedule: 7 }, operationalReady: false, historyContextResolved: true, requiresProrationReview: false });
  expect(result.partitions.map(p => [p.from, p.to])).toEqual([['2026-10-01', '2026-11-01']]);
  expect(result.partitions[0].contract).toMatchObject({ id: 10, currency: 'SAR', salaryMinor: 10000 });
  expect(result).not.toHaveProperty('earnedAmount'); expect(result).not.toHaveProperty('totalWorkMinutes');
});
it('derives proration review from real status/terms changes and includes all policy boundaries', () => {
  const value = input(); value.employment = { ...value.employment, facts: [fact('active', '2026-10-01', '2026-10-15', { status: 'active' }), fact('suspended', '2026-10-15', null, { status: 'suspended' })] };
  value.policies.proration = { revision: 2, facts: [fact('draft-policy', '2026-10-20', null, { key: 'proration', approval: { state: 'unapproved' }, parameters: {} })] };
  const result = explainHrPayrollHistory(value);
  expect(result.requiresProrationReview).toBe(true); expect(result.partitions.map(p => [p.from, p.to])).toEqual([['2026-10-01', '2026-10-15'], ['2026-10-15', '2026-10-20'], ['2026-10-20', '2026-11-01']]);
  expect(result.partitions[1].blockers).toContain('employment_pay_effect:policy_history_unknown');
  expect(result.partitions[2].blockers).toContain('proration:policy_not_approved');
});
it('retains gaps as unknown and never backfills them from current status or profile hire dates', () => {
  const value = input(); value.employment = { revision: 1, facts: [fact('later', '2026-10-10', null, { status: 'active' })] }; value.profile.hireDate = '2020-01-01';
  const result = explainHrPayrollHistory(value);
  expect(result.partialCoverage).toBe(true); expect(result.requiresProrationReview).toBe(true); expect(result.partitions[0].blockers).toContain('employment_history_unknown');
});
it('uses inclusive contract ends as explicit boundaries and preserves original currency/minor-unit input', () => {
  const value = input(); value.contracts = [{ ...value.contracts[0], endDate: '2026-10-14' }, { ...value.contracts[0], id: 11, versionNumber: 2, startDate: '2026-10-15', currency: 'USD', salaryMinor: 25000 }];
  const result = explainHrPayrollHistory(value);
  expect(result.requiresProrationReview).toBe(true); expect(result.partitions.map(p => p.contract && [p.from, p.contract.currency, p.contract.salaryMinor])).toEqual([['2026-10-01', 'SAR', 10000], ['2026-10-15', 'USD', 25000]]);
});
it('does not treat mutable current pay terms as historical proof without an approved dated contract', () => {
  const value = input(); value.contracts = [];
  expect(explainHrPayrollHistory(value).partitions[0].blockers).toContain('documented_pay_terms_unknown');
});
it('reports the actual DST-ambiguous occurrence without assigning an invented worked amount', () => {
  const value = input(); value.from = '2026-11-01'; value.to = '2026-11-03';
  value.schedule = { revision: 9, facts: [fact('dst', '2026-10-01', null, { timeZone: 'America/New_York', workingDays: [0], graceMins: 0, segments: [{ id: 'fall-back', start: '01:15', startDayOffset: 0, end: '02:15', endDayOffset: 0 }] })] };
  const result = explainHrPayrollHistory(value); expect(result.historyContextResolved).toBe(false); expect(result.scheduleIssues).toEqual([{ day: '2026-11-01', code: 'ambiguous_wall_time' }]);
  expect(result.partitions.map(p => [p.from, p.to])).toEqual([['2026-11-01', '2026-11-02'], ['2026-11-02', '2026-11-03']]);
});
it('derives schedule-change review without a caller flag and keeps opaque approved policy terms non-executable', () => {
  const value = input(), first = value.schedule.facts[0].value;
  value.schedule = { revision: 8, facts: [fact('old', '2026-10-01', '2026-10-20', first), fact('new', '2026-10-20', null, { ...first, timeZone: 'UTC' })] };
  value.policies.proration = { revision: 4, facts: [fact('terms', '2026-10-01', null, { key: 'proration', approval: { state: 'approved', decisionRef: 'Synthetic configured decision' }, parameters: { denominator: 'uninterpreted' } })] };
  const result = explainHrPayrollHistory(value); expect(result.requiresProrationReview).toBe(true); expect(result.historyContextResolved).toBe(true); expect(result.operationalReady).toBe(false);
  expect(result.partitions[1].policies.proration).toMatchObject({ kind: 'approved', revision: 4, parameters: { denominator: 'uninterpreted' } });
});
