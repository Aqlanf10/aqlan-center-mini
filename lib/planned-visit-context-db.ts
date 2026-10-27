import type { DbClient } from './db';
import { projectPlannedVisitContext, type PlannedSessionContext, type PlannedVisitContext } from './planned-visit-context';

export async function readPlannedVisitContexts(executor: Pick<DbClient, 'query'>, ids: number[]): Promise<Map<number, PlannedVisitContext>> {
  if (!ids.length) return new Map();
  const { rows } = await executor.query<PlannedSessionContext>(
    `SELECT s.planned_visit_id, s.plan_item_id, s.sequence, s.status,
            i.service_name, i.tooth_code, i.session_count
       FROM treatment_sessions s JOIN plan_items i ON i.id = s.plan_item_id
      WHERE s.planned_visit_id = ANY($1::int[])
      ORDER BY s.planned_visit_id, i.sort_order, i.id, s.sequence`, [ids]);
  const grouped = new Map<number, PlannedSessionContext[]>();
  for (const row of rows) {
    const members = grouped.get(row.planned_visit_id) ?? [];
    members.push(row); grouped.set(row.planned_visit_id, members);
  }
  return new Map(ids.map(id => [id, projectPlannedVisitContext(grouped.get(id) ?? [])]));
}
