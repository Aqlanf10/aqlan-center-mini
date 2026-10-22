/** Read-only predicate, alias a = appointments. Used identically by writer and queue.
 * Only source-linked planned rows are inspected, never sibling visits in a plan.
 * A moved planned pointer is ambiguous, not proof of original attendance.
 * ended_at alone is not attendance: no_show legitimately stamps it.
 * Only internal parameter positions are accepted; the clinic zone stays bound. */
export function followupEligibilitySql(zoneParameter: "$1" | "$2"): string {
  return `COALESCE((a.id IS NOT NULL AND a.status='no_show'
    AND a.arrived_at IS NULL AND a.started_at IS NULL
    AND a.scheduled_date + a.scheduled_time <= clock_timestamp() AT TIME ZONE ${zoneParameter}
    AND NOT EXISTS (SELECT 1 FROM planned_visits moved WHERE moved.id=a.planned_visit_id
      AND moved.appointment_id IS NOT NULL AND moved.appointment_id<>a.id)
    AND NOT EXISTS (SELECT 1 FROM appointment_status_log attendance WHERE attendance.appointment_id=a.id
      AND (attendance.from_status IN ('arrived','in_progress','done')
        OR attendance.to_status IN ('arrived','in_progress','done')))
    AND NOT EXISTS (SELECT 1 FROM visits attendance WHERE attendance.appointment_id=a.id
      OR EXISTS (SELECT 1 FROM planned_visits linked
        WHERE (linked.appointment_id=a.id OR (linked.id=a.planned_visit_id AND linked.appointment_id IS NULL))
          AND (attendance.planned_visit_id=linked.id OR attendance.id=linked.visit_id)))
    AND NOT EXISTS (SELECT 1 FROM planned_visits linked
      WHERE (linked.appointment_id=a.id OR (linked.id=a.planned_visit_id AND linked.appointment_id IS NULL))
        AND (linked.visit_id IS NOT NULL OR linked.status IN ('in_progress','completed')
          OR EXISTS (SELECT 1 FROM treatment_sessions session LEFT JOIN plan_items item ON item.id=session.plan_item_id
            WHERE session.planned_visit_id=linked.id AND (session.status <> 'planned'
              OR session.completed_at IS NOT NULL OR session.visit_id IS NOT NULL
              OR item.status IN ('done','cancelled') OR item.done_at IS NOT NULL OR item.visit_id IS NOT NULL)))))
    , false)`;
}
