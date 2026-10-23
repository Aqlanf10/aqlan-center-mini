/** 0071 is a new migration: never rewrite already published 0070.
 * Build the generation-aware queue index before retiring its unscoped predecessor.
 * Keep these bytes identical to migrations/0071_appointment_followup_query_indexes.sql. */
export const APPOINTMENT_FOLLOWUP_QUERY_SQL = `
CREATE INDEX appointment_followups_generation_queue_idx
  ON appointment_followups (generation, due_at, id) WHERE status = 'open';
CREATE INDEX visits_followup_appointment_idx
  ON visits (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX visits_followup_planned_idx
  ON visits (planned_visit_id) WHERE planned_visit_id IS NOT NULL;
CREATE INDEX planned_visits_followup_appointment_idx
  ON planned_visits (appointment_id) WHERE appointment_id IS NOT NULL;
DROP INDEX appointment_followups_queue_idx;
`;
