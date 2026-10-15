import type { DbPool } from './db';
import { loadStaffContracts, payTermsKey, profileFromRow, governingContractOn, type ContractInput, type ProfileInput } from './hr-pay-terms';
import { addCalendarDays, assertRange, immutableJson, selectTemporal, type TemporalTimeline } from './hr-temporal';
import { selectHrSchedule, type HrEffectiveSchedule } from './hr-schedule-segments';
import { selectApprovedHrPolicy, type EmploymentFact, type HrPolicyTimelines } from './hr-effective-policy';
import { readHrTimeline } from './hr-temporal-store';
import { readHrPolicyHistories, readHrStaffScope, withHrHistoryRead } from './hr-temporal-read';
import { historyFail, canonicalHrIntent } from './hr-temporal-request';
import type { HrTemporalAuthority } from './hr-temporal-authority';

export interface HrPayrollHistoryInput {
  from: string; to: string;
  employment: TemporalTimeline<EmploymentFact>;
  schedule: TemporalTimeline<HrEffectiveSchedule>;
  policies: HrPolicyTimelines;
  contracts: readonly ContractInput[];
  profile: ProfileInput;
}
/** Explanation only. Never calls or changes salary, commission, approval or posting code. */
export function explainHrPayrollHistory(input: HrPayrollHistoryInput) {
  assertRange(input.from, input.to);
  const length = (Date.parse(input.to) - Date.parse(input.from)) / 86400000;
  if (length > 366) historyFail('preview_range_too_large', 'المعاينة حتى366 يومًا في الطلب الواحد.', 400);
  const boundaries = new Set([input.from, input.to]);
  const include = (date: string | null) => { if (date && date > input.from && date < input.to) boundaries.add(date); };
  for (const timeline of [input.employment, input.schedule, ...Object.values(input.policies)]) if (timeline) for (const fact of timeline.facts) if (fact.kind === 'known') { include(fact.from); include(fact.to); }
  for (const contract of input.contracts) if (['active', 'approved'].includes(contract.status)) {
    include(contract.startDate); if (contract.endDate && contract.endDate < '9999-12-31') include(addCalendarDays(contract.endDate, 1));
  }
  // This is an observation boundary only, never proof of historical employment or pay terms.
  include(input.profile.effectiveOn);
  const scheduleIssues: { day: string; code: string }[] = [];
  for (let day = input.from; day < input.to; day = addCalendarDays(day, 1)) {
    try { selectHrSchedule(input.schedule, day); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'schedule_unresolved';
      scheduleIssues.push({ day, code }); include(day); include(addCalendarDays(day, 1));
    }
  }
  const points = [...boundaries].sort();
  const selected = points.slice(0, -1).map((from, index) => ({ from, to: points[index + 1], employment: selectTemporal(input.employment, from),
    schedule: selectTemporal(input.schedule, from), contract: governingContractOn(input.contracts, from) }));
  const states = new Set(selected.flatMap(part => part.employment.kind === 'known' ? [part.employment.fact.value.status] : []));
  const schedules = new Set(selected.flatMap(part => part.schedule.kind === 'known' ? [canonicalHrIntent(part.schedule.fact.value)] : []));
  const terms = new Set(selected.flatMap(part => part.contract ? [payTermsKey(part.contract)] : []));
  const partialCoverage = (selected.some(p => p.employment.kind === 'unknown') && selected.some(p => p.employment.kind === 'known'))
    || (selected.some(p => !p.contract) && selected.some(p => Boolean(p.contract)))
    || (selected.some(p => p.schedule.kind === 'unknown') && selected.some(p => p.schedule.kind === 'known'));
  const requiresProrationReview = partialCoverage || states.size > 1 || schedules.size > 1 || terms.size > 1;
  const partitions = selected.map(part => {
    const blockers: string[] = [];
    if (part.employment.kind === 'unknown') blockers.push('employment_history_unknown');
    if (part.schedule.kind === 'unknown') blockers.push('schedule_history_unknown');
    blockers.push(...scheduleIssues.filter(issue => issue.day >= part.from && issue.day < part.to).map(issue => issue.code));
    if (!part.contract) blockers.push('documented_pay_terms_unknown');
    const policies = {
      employment_pay_effect: selectApprovedHrPolicy(input.policies.employment_pay_effect, 'employment_pay_effect', part.from),
      proration: selectApprovedHrPolicy(input.policies.proration, 'proration', part.from),
    };
    if (part.employment.kind === 'known' && part.employment.fact.value.status !== 'active' && policies.employment_pay_effect.kind === 'blocked') blockers.push(`employment_pay_effect:${policies.employment_pay_effect.code}`);
    if (requiresProrationReview && policies.proration.kind === 'blocked') blockers.push(`proration:${policies.proration.code}`);
    return { ...part, policies, blockers: [...new Set(blockers)] };
  });
  return immutableJson({ from: input.from, to: input.to, endExclusive: true,
    pinnedRevisions: { employment: input.employment.revision, schedule: input.schedule.revision,
      employment_pay_effect: input.policies.employment_pay_effect?.revision ?? 0, proration: input.policies.proration?.revision ?? 0,
      leave_entitlement: input.policies.leave_entitlement?.revision ?? 0 },
    partitions, requiresProrationReview, partialCoverage, scheduleIssues, historyContextResolved: partitions.every(part => part.blockers.length === 0),
    operationalReady: false, activation: 'documented_only', profileTermsObservation: { kind: 'legacy_current_terms', value: input.profile },
    warning: 'هذه معاينة سياق تاريخي فقط: ليست مبلغًا أو اعتمادًا أو استحقاقًا. لا تغيّر المسير المعتمد ولا تتجاوز حراس المال الحالية. اكتمال دفعة بصمات لا يثبت اكتمال فترة الرواتب.' });
}
export async function readHrPayrollHistory(pool: DbPool, authority: HrTemporalAuthority, staffId: number, from: string, to: string) {
  assertRange(from, to);
  return withHrHistoryRead(pool, authority, async client => {
    const staff = await readHrStaffScope(client, staffId);
    const employment = await readHrTimeline<EmploymentFact>(client, { kind: 'employment', subjectKey: String(staffId) });
    const schedule = await readHrTimeline<HrEffectiveSchedule>(client, { kind: 'schedule', subjectKey: String(staffId) });
    const policies = await readHrPolicyHistories(client), contracts = await loadStaffContracts(client, staffId);
    const { rows: [snapshot] } = await client.query('SELECT transaction_timestamp()::text AS read_at');
    return immutableJson({ staffId, fullName: staff.full_name, readAt: snapshot.read_at, ...explainHrPayrollHistory({ from, to, employment, schedule, policies, contracts, profile: profileFromRow(staff) }) });
  });
}
export type HrPayrollHistoryPreview = Awaited<ReturnType<typeof readHrPayrollHistory>>;
