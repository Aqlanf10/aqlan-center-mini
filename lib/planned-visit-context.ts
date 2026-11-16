import { plannedVisitTitle } from './workflow';

/** Read-only scheduling provenance; never a changed duration or performed-work assertion. */
export interface PlannedVisitContext {
  remainingWork?: string | null;
  durationWarning?: string | null;
}
export interface PlannedSessionContext {
  planned_visit_id: number; plan_item_id: number; sequence: number; status: string;
  service_name: string; tooth_code: number | null; session_count: number;
}
export function projectPlannedVisitContext(sessions: PlannedSessionContext[]): PlannedVisitContext {
  if (sessions.length === 0) return {};
  const remaining = sessions.filter(session => ['planned', 'in_progress'].includes(session.status));
  const repeatedItem = new Set(sessions.map(session => session.plan_item_id)).size < sessions.length;
  const partlyFulfilled = remaining.length > 0 && sessions.some(session => session.status === 'done');
  if (!repeatedItem && !partlyFulfilled && remaining.length > 0) return {};
  return {
    remainingWork: remaining.length ? remaining.map(session => plannedVisitTitle([{
      serviceName: session.service_name, toothCode: session.tooth_code,
      sessionIndex: session.sequence, sessionCount: session.session_count,
    }])).join('؛ ') : 'لا جلسات متبقية ضمن هذه الزيارة المخطَّطة',
    durationWarning: repeatedItem || partlyFulfilled
      ? 'المدة المعروضة هي مدة المجموعة الأصلية، وليست تقديرًا جديدًا للعمل المتبقي. راجع ملاءمتها قبل الحجز.' : null,
  };
}
