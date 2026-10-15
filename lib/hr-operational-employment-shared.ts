import { addCalendarDays, immutableJson, partitionTemporal, selectTemporal, temporalFail, type TemporalTimeline } from './hr-temporal';
import type { EmploymentFact } from './hr-effective-policy';
import { HR_WORK_STATUS_LABEL, type HrWorkStatus } from './hr-shared';

export type HrOperationalEmployment = {
  readonly asOfDay: string;
  readonly revision: number;
  readonly source: 'legacy_current_observation' | 'documented_history';
  readonly status: HrWorkStatus | 'unknown';
};
export function operationalEmployment(legacy: HrWorkStatus, timeline: TemporalTimeline<EmploymentFact>, day: string): HrOperationalEmployment {
  const selected = selectTemporal(timeline, day);
  for (const fact of timeline.facts) if (!fact.value || !['active', 'suspended', 'ended'].includes(fact.value.status)) temporalFail('invalid_employment', 'Invalid employment history.');
  return immutableJson({ asOfDay: day, revision: timeline.revision,
    source: timeline.revision === 0 ? 'legacy_current_observation' : 'documented_history',
    status: timeline.revision === 0 ? legacy : selected.kind === 'known' ? selected.fact.value.status : 'unknown' });
}
export function operationalStatus(staff: { workStatus: HrWorkStatus; operationalEmployment?: HrOperationalEmployment }) {
  return staff.operationalEmployment?.status ?? staff.workStatus;
}
export function operationalStatusLabel(staff: { workStatus: HrWorkStatus; operationalEmployment?: HrOperationalEmployment }): string {
  const status = operationalStatus(staff), label = status === 'unknown' ? 'غير معروفة — راجع تاريخ العمل' : HR_WORK_STATUS_LABEL[status];
  return `${label} (${staff.operationalEmployment?.source === 'documented_history' ? 'مؤرخة' : 'حالة قديمة غير مؤرخة'})${staff.operationalEmployment ? ` — ${staff.operationalEmployment.asOfDay}` : ''}`;
}
/** No amount, entitlement, proration or deduction policy is inferred here. */
export function employmentPeriodReview(timeline: TemporalTimeline<EmploymentFact>, start: string, endInclusive: string) {
  if (timeline.revision === 0) return { documented: false, whollyActive: false, hasActive: false };
  const parts = partitionTemporal(timeline, start, addCalendarDays(endInclusive, 1));
  return { documented: true,
    whollyActive: parts.every(part => part.selection.kind === 'known' && part.selection.fact.value.status === 'active'),
    hasActive: parts.some(part => part.selection.kind === 'known' && part.selection.fact.value.status === 'active') };
}
