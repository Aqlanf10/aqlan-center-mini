import { describe, expect, it } from 'vitest';
import { projectPlannedVisitContext, type PlannedSessionContext } from '../lib/planned-visit-context';
const session = (sequence:number, status='planned', item=11):PlannedSessionContext => ({
  planned_visit_id:1, plan_item_id:item, sequence,status,service_name:'Synthetic work',tooth_code:11,session_count:12,
});
describe('read-only proposed work context', () => {
  it('does not infer grouping provenance or change the original duration', () => {
    const source=[session(1,'done'),session(2),session(3)];
    const snapshot=JSON.stringify(source);
    const result=projectPlannedVisitContext(source);
    expect(result.remainingWork).toBe('Synthetic work 11 — جلسة 2؛ Synthetic work 11 — جلسة 3');
    expect(result.durationWarning).toContain('المجموعة الأصلية');
    expect(JSON.stringify(source)).toBe(snapshot);
  });
  it('warns for multiple sequential sessions even before work and does not assume completion', () => {
    expect(projectPlannedVisitContext([session(1),session(2)]).durationWarning).toBeTruthy();
    expect(projectPlannedVisitContext([session(1),session(2)]).remainingWork).toContain('جلسة 1؛');
  });
  it('keeps ordinary single-session proposals free of group warnings', () => {
    expect(projectPlannedVisitContext([session(2)])).toEqual({});
    expect(projectPlannedVisitContext([session(1,'planned',11),session(1,'planned',12)])).toEqual({});
  });
  it('does not present completed or cancelled sessions as remaining work', () => {
    expect(projectPlannedVisitContext([session(1,'done'),session(2,'cancelled')]).remainingWork).toBe('لا جلسات متبقية ضمن هذه الزيارة المخطَّطة');
    expect(projectPlannedVisitContext([])).toEqual({});
  });
});
