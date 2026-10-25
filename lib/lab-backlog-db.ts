import type { DbPool } from "./db";
import type { SessionPayload } from "./auth";
import { canReadLabBacklog, decodeLabBacklog, LAB_BACKLOG_PAGE_SIZE, type LabBacklogFilter, type LabBacklogSnapshot } from "./lab-backlog";
import { LAB_READINESS_STATUSES } from "./lab-readiness";

/** Aggregate the whole open population; enrich only one bounded page. This query is read-only. */
export const LAB_BACKLOG_SQL = `WITH
  clock AS (SELECT statement_timestamp() AS as_of, (statement_timestamp() AT TIME ZONE $1)::date AS today),
  open_orders AS MATERIALIZED (
    SELECT id, patient_id, status, created_at, received_at, due_date FROM lab_orders
    WHERE status = ANY($2::text[])
  ),
  counts AS (SELECT COUNT(*)::int AS orders, COUNT(DISTINCT patient_id)::int AS patients,
    COUNT(*) FILTER (WHERE status = 'needed')::int AS preparing,
    COUNT(*) FILTER (WHERE status IN ('sent', 'in_progress', 'remake'))::int AS with_lab,
    COUNT(*) FILTER (WHERE status IN ('sent', 'in_progress', 'remake') AND due_date < (SELECT today FROM clock))::int AS overdue,
    COUNT(*) FILTER (WHERE status = 'received')::int AS awaiting_fitting FROM open_orders),
  selected AS MATERIALIZED (SELECT * FROM open_orders WHERE $3 = 'all'
    OR ($3 = 'preparing' AND status = 'needed')
    OR ($3 = 'with_lab' AND status IN ('sent', 'in_progress', 'remake'))
    OR ($3 = 'overdue' AND status IN ('sent', 'in_progress', 'remake') AND due_date < (SELECT today FROM clock))
    OR ($3 = 'awaiting_fitting' AND status = 'received')),
  tally AS (SELECT COUNT(*)::int AS total FROM selected),
  paging AS (SELECT total, LEAST($4::int, GREATEST(0, (total - 1) / $5::int)) AS page FROM tally),
  page_rows AS MATERIALIZED (SELECT *, CASE WHEN status = 'received' THEN received_at
    WHEN status = 'needed' THEN created_at ELSE due_date::timestamp AT TIME ZONE $1 END AS sort_at
    FROM selected ORDER BY sort_at ASC NULLS FIRST, id ASC LIMIT $5 OFFSET (SELECT page FROM paging) * $5),
  page_tasks AS MATERIALIZED (SELECT link.link_id AS lab_order_id, ht.id, ht.title, ht.status,
    ht.assignee_staff_id, ht.assignee_label, ht.due_at, ht.updated_at,
    COUNT(*) OVER (PARTITION BY link.link_id) AS visible_count,
    ROW_NUMBER() OVER (PARTITION BY link.link_id ORDER BY ht.due_at ASC NULLS LAST, ht.id ASC) AS position
    FROM hr_task_links link JOIN page_rows pr ON pr.id = link.link_id
    JOIN hr_tasks ht ON ht.id = link.task_id
    WHERE link.link_kind = 'lab_order' AND ht.status IN ('planned', 'in_progress', 'blocked')
      -- Admin oversight sees shared tasks, never another user's private tasks.
      AND (NOT ht.is_private OR ht.owner_user_id = $6::int)),
  tasks AS (SELECT lab_order_id, MAX(visible_count)::int AS total,
    jsonb_agg(jsonb_build_object('id', id, 'title', title, 'status', status,
      'assignee', CASE WHEN assignee_staff_id IS NOT NULL THEN NULLIF(assignee_label, '') ELSE NULL END,
      'dueAt', due_at, 'updatedAt', updated_at) ORDER BY due_at ASC NULLS LAST, id ASC) AS items
    FROM page_tasks WHERE position <= 3 GROUP BY lab_order_id),
  enriched AS (SELECT lo.id, lo.patient_id AS "patientId", p.full_name AS "patientName", p.patient_number AS "patientNumber",
    lo.work_type AS "workType", COALESCE(NULLIF(BTRIM(lo.tooth_numbers), ''), lo.tooth_code::text) AS teeth,
    doctor.name AS "doctorName", lo.lab_name AS "labName", lo.status, lo.created_at AS "createdAt",
    lo.sent_date::text AS "sentDate", lo.due_date::text AS "dueDate", lo.received_at AS "receivedAt", pr.sort_at,
    (SELECT jsonb_build_object('action', e.action, 'fromStatus', e.from_status, 'toStatus', e.to_status,
      'actor', e.actor, 'at', e.created_at) FROM lab_order_tracking e WHERE e.lab_order_id = lo.id
      ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS "latestAction",
    COALESCE(tasks.total, 0) AS "visibleTaskCount", COALESCE(tasks.items, '[]'::jsonb) AS tasks
    FROM page_rows pr JOIN lab_orders lo ON lo.id = pr.id JOIN patients p ON p.id = lo.patient_id
    LEFT JOIN parties doctor ON doctor.id = lo.doctor_id
    LEFT JOIN tasks ON tasks.lab_order_id = lo.id)
  SELECT clock.as_of, clock.today::text, paging.total, paging.page,
    jsonb_build_object('orders', counts.orders, 'patients', counts.patients, 'preparing', counts.preparing,
      'withLab', counts.with_lab, 'overdue', counts.overdue, 'awaitingFitting', counts.awaiting_fitting) AS counts,
    COALESCE((SELECT jsonb_agg(to_jsonb(enriched) - 'sort_at' ORDER BY sort_at ASC NULLS FIRST, id ASC) FROM enriched), '[]'::jsonb) AS items
  FROM clock CROSS JOIN paging CROSS JOIN counts`;

export async function readLabBacklog(pool: Pick<DbPool, "query">, input: { filter: LabBacklogFilter; page: number }, timeZone: string,
  session: Pick<SessionPayload, "role" | "userId">): Promise<LabBacklogSnapshot> {
  // Keep the data function fail-closed too; SQL task visibility below is admin-only.
  if (!canReadLabBacklog(session.role) || !Number.isInteger(session.userId) || session.userId <= 0) throw new Error("lab_backlog_forbidden");
  const { rows: [row] } = await pool.query<{ as_of: Date; today: string; total: number; page: number;
    counts: LabBacklogSnapshot["counts"]; items: LabBacklogSnapshot["items"] }>(LAB_BACKLOG_SQL,
    [timeZone, [...LAB_READINESS_STATUSES], input.filter, input.page, LAB_BACKLOG_PAGE_SIZE, session.userId]);
  const value = row && decodeLabBacklog({ scope: "all_open_now", asOf: row.as_of.toISOString(), today: row.today, timeZone,
    filter: input.filter, counts: row.counts, total: row.total, page: row.page,
    hasMore: (row.page + 1) * LAB_BACKLOG_PAGE_SIZE < row.total, items: row.items }, input.filter);
  if (!value) throw new Error("lab_backlog_invalid_result");
  return value;
}
