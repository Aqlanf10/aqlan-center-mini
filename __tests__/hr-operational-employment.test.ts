import { expect, it } from 'vitest';
import { employmentPeriodReview, operationalEmployment, operationalStatusLabel } from '../lib/hr-operational-employment-shared';
import type { EmploymentFact } from '../lib/hr-effective-policy';
import type { TemporalTimeline } from '../lib/hr-temporal';
const history: TemporalTimeline<EmploymentFact> = { revision: 1, facts: [
  { id: 'before', kind: 'known', from: '2026-10-01', to: '2026-11-01', value: { status: 'active' } },
  { id: 'pause', kind: 'known', from: '2026-11-01', to: '2026-11-02', value: { status: 'suspended' } },
  { id: 'return', kind: 'known', from: '2026-11-02', to: '2026-12-01', value: { status: 'active' } },
  { id: 'end', kind: 'known', from: '2026-12-01', to: null, value: { status: 'ended' } },
] };
it.each([['2026-09-30','unknown'],['2026-10-31','active'],['2026-11-01','suspended'],['2026-11-02','active'],['2026-12-01','ended']])('selects %s as %s without rewriting the profile', (day, status) => {
  expect(operationalEmployment('active', history, day)).toMatchObject({ status, revision: 1, source: 'documented_history' });
});
it('does not backfill a future-only or explicit unknown history from an active legacy observation', () => {
  expect(operationalEmployment('active', { revision: 1, facts: [history.facts[3]] }, '2026-11-30').status).toBe('unknown');
  expect(operationalEmployment('active', { revision: 2, facts: [{ id: 'unproven', kind: 'unknown', value: { status: 'active' } }] }, '2026-11-30').status).toBe('unknown');
});
it('labels the compatibility fallback as a legacy observation, not historical evidence', () => {
  const selected = operationalEmployment('active', { revision: 0, facts: [] }, '2026-11-01');
  expect(selected).toMatchObject({ status: 'active', source: 'legacy_current_observation' });
  expect(operationalStatusLabel({ workStatus: 'active', operationalEmployment: selected })).toContain('غير مؤرخة');
});
it('checks a payroll period independently from today and rejects unknown or nonactive coverage', () => {
  expect(employmentPeriodReview(history, '2026-10-01', '2026-10-31')).toEqual({ documented: true, whollyActive: true, hasActive: true });
  expect(employmentPeriodReview(history, '2026-11-01', '2026-11-30').whollyActive).toBe(false);
  expect(employmentPeriodReview(history, '2026-09-01', '2026-09-30')).toEqual({ documented: true, whollyActive: false, hasActive: false });
  expect(employmentPeriodReview({ revision: 0, facts: [] }, '2026-10-01', '2026-10-31').documented).toBe(false);
});
it('rejects malformed history rather than reusing active', () => {
  expect(() => operationalEmployment('active', { revision: 1, facts: [{ ...history.facts[0], value: { status: 'invented' } }] } as never, '2026-10-01')).toThrow();
});
