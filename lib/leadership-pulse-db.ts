import type { DbPool } from "./db";
import type { SessionPayload } from "./auth";
import { onClinicDaySql } from "./clinic-day-sql";
import { canReadLeadershipPulse, decodeLeadershipPulse, LEADERSHIP_PAGE_SIZE, type LeadershipPulse, type PulseQuery } from "./leadership-pulse";

const clock = `clock AS (SELECT statement_timestamp() AS as_of, (statement_timestamp() AT TIME ZONE $1)::date::text AS today)`;
const page = `tally AS (SELECT COUNT(*)::int AS total FROM selected),
 paging AS (SELECT total, LEAST($3::int, GREATEST(0, (total - 1) / $4::int)) AS page FROM tally)`;
/** Single snapshot, exact selected-day counts; only a bounded open-visit page is enriched. */
export const LEADERSHIP_DAY_SQL = `WITH ${clock},
 cohort AS MATERIALIZED (SELECT id,patient_id,patient_name,status,arrived_at,doctor_id FROM visits WHERE ${onClinicDaySql("arrived_at", "$1", "$2::date")}),
 counts AS (SELECT jsonb_build_object('arrived', COUNT(*)::int,
  'waiting', COUNT(*) FILTER(WHERE status='waiting')::int, 'called', COUNT(*) FILTER(WHERE status='called')::int,
  'inChair', COUNT(*) FILTER(WHERE status='in_chair')::int, 'done', COUNT(*) FILTER(WHERE status='done')::int) AS value FROM cohort),
 appointments AS (SELECT jsonb_build_object('appointments', COUNT(*)::int, 'noShow', COUNT(*) FILTER(WHERE status='no_show')::int,
  'cancelled', COUNT(*) FILTER(WHERE status='cancelled')::int) AS value FROM appointments WHERE scheduled_date=$2::date),
 selected AS (SELECT * FROM cohort WHERE status IN ('waiting','called','in_chair')), ${page},
 page_rows AS (SELECT * FROM selected ORDER BY CASE status WHEN 'waiting' THEN 0 WHEN 'called' THEN 1 ELSE 2 END,arrived_at,id LIMIT $4 OFFSET (SELECT page FROM paging)*$4),
 enriched AS (SELECT pr.id,pr.patient_name AS title,pr.status,pr.patient_id AS "patientId",pr.arrived_at AS "eventAt",
  doctor.name AS "doctorName",NULL::text AS assignee,NULL::timestamptz AS "dueAt",NULL::jsonb AS "latestAction",pr.arrived_at,
  CASE pr.status WHEN 'waiting' THEN 0 WHEN 'called' THEN 1 ELSE 2 END AS rank
  FROM page_rows pr LEFT JOIN parties doctor ON doctor.id=pr.doctor_id)
 SELECT clock.as_of,clock.today,paging.total,paging.page,counts.value || appointments.value AS counts,
  COALESCE((SELECT jsonb_agg(to_jsonb(enriched)-'arrived_at'-'rank' ORDER BY rank,arrived_at,id) FROM enriched),'[]'::jsonb) AS items
 FROM clock CROSS JOIN paging CROSS JOIN counts CROSS JOIN appointments`;
/** Leadership summaries contain shared tasks only. Private work stays in the HR workspace.
 * Latest actor is evidence of an event, not an inferred assignee. No event payload/links are disclosed. */
export const LEADERSHIP_TASKS_SQL = `WITH ${clock},
 selected AS MATERIALIZED (SELECT id,title,status,assignee_staff_id,assignee_label,due_at,updated_at FROM hr_tasks
  WHERE status IN ('planned','in_progress','blocked') AND NOT is_private AND $2::text IS NOT NULL),
 counts AS (SELECT jsonb_build_object('open',COUNT(*)::int,
  'overdue',COUNT(*) FILTER(WHERE due_at < (SELECT as_of FROM clock))::int,
  'blocked',COUNT(*) FILTER(WHERE status='blocked')::int,
  'unassigned',COUNT(*) FILTER(WHERE assignee_staff_id IS NULL)::int) AS value FROM selected), ${page},
 ranked AS (SELECT *,CASE WHEN due_at < (SELECT as_of FROM clock) THEN 0 WHEN status='blocked' THEN 1 ELSE 2 END AS rank FROM selected),
 page_rows AS (SELECT * FROM ranked ORDER BY rank,due_at ASC NULLS LAST,id ASC LIMIT $4 OFFSET (SELECT page FROM paging)*$4),
 enriched AS (SELECT pr.id,pr.title,pr.status,NULL::int AS "patientId",pr.updated_at AS "eventAt",NULL::text AS "doctorName",
  CASE WHEN pr.assignee_staff_id IS NOT NULL THEN COALESCE(NULLIF(pr.assignee_label,''),'موظف مسند دون اسم مسجّل') ELSE NULL END AS assignee,pr.due_at AS "dueAt",
  (SELECT jsonb_build_object('actor',e.actor_display_name,'action',e.action,'at',e.created_at) FROM hr_task_events e
   WHERE e.task_id=pr.id ORDER BY e.id DESC LIMIT 1) AS "latestAction",pr.rank,pr.due_at
  FROM page_rows pr)
 SELECT clock.as_of,clock.today,paging.total,paging.page,counts.value AS counts,
  COALESCE((SELECT jsonb_agg(to_jsonb(enriched)-'rank'-'due_at' ORDER BY rank,due_at ASC NULLS LAST,id) FROM enriched),'[]'::jsonb) AS items
 FROM clock CROSS JOIN paging CROSS JOIN counts`;
/** Current active plans, including those with no remaining items. Counts cover all rows;
 * patient/doctor names are enriched only for the ten-plan page. No money, contacts, tasks or payroll. */
export const LEADERSHIP_CARE_SQL = `WITH ${clock},
 active AS MATERIALIZED (SELECT id,patient_id,title,status,primary_doctor_id,created_at,start_date FROM treatment_plans
  WHERE status='active' AND $2::text IS NOT NULL),
 item_counts AS (SELECT pi.plan_id,COUNT(*) FILTER(WHERE pi.status='planned')::int AS planned,
  COUNT(*) FILTER(WHERE pi.status='in_progress')::int AS in_progress
  FROM plan_items pi JOIN active a ON a.id=pi.plan_id WHERE pi.status IN ('planned','in_progress') GROUP BY pi.plan_id),
 selected AS MATERIALIZED (SELECT a.*,COALESCE(i.planned,0) AS planned,COALESCE(i.in_progress,0) AS in_progress,
  COALESCE(i.planned,0)+COALESCE(i.in_progress,0) AS pending FROM active a LEFT JOIN item_counts i ON i.plan_id=a.id),
 counts AS (SELECT jsonb_build_object('activePlans',COUNT(*)::int,'pendingPlans',COUNT(*) FILTER(WHERE pending>0)::int,
  'patients',COUNT(DISTINCT patient_id)::int,'pendingItems',COALESCE(SUM(pending),0)::int,
  'plannedItems',COALESCE(SUM(planned),0)::int,'inProgressItems',COALESCE(SUM(in_progress),0)::int,
  'withoutPendingItems',COUNT(*) FILTER(WHERE pending=0)::int) AS value FROM selected), ${page},
 page_rows AS (SELECT * FROM selected ORDER BY (pending=0),start_date,id LIMIT $4 OFFSET (SELECT page FROM paging)*$4),
 enriched AS (SELECT pr.id,pr.title,pr.status,pr.patient_id AS "patientId",p.full_name AS "patientName",pr.created_at AS "eventAt",
  d.name AS "doctorName",NULL::text AS assignee,NULL::timestamptz AS "dueAt",NULL::jsonb AS "latestAction",
  pr.start_date::text AS "startDate",pr.pending AS "pendingItems",pr.planned AS "plannedItems",pr.in_progress AS "inProgressItems"
  FROM page_rows pr JOIN patients p ON p.id=pr.patient_id LEFT JOIN parties d ON d.id=pr.primary_doctor_id)
 SELECT clock.as_of,clock.today,paging.total,paging.page,counts.value AS counts,
  COALESCE((SELECT jsonb_agg(to_jsonb(enriched) ORDER BY ("pendingItems"=0),"startDate",id) FROM enriched),'[]'::jsonb) AS items
 FROM clock CROSS JOIN paging CROSS JOIN counts`;
export async function readLeadershipPulse(pool: Pick<DbPool,"query">, input: PulseQuery, timeZone: string,
 session: Pick<SessionPayload,"role"|"userId">): Promise<LeadershipPulse> {
 if (!canReadLeadershipPulse(session.role) || !Number.isInteger(session.userId) || session.userId <= 0) throw new Error("leadership_forbidden");
 const args: unknown[] = [timeZone,input.day,input.page,LEADERSHIP_PAGE_SIZE];
 const {rows:[row]} = await pool.query<{as_of:Date;today:string;total:number;page:number;counts:Record<string,number>;items:LeadershipPulse["items"]}>(
  input.view === "day" ? LEADERSHIP_DAY_SQL : input.view === "care" ? LEADERSHIP_CARE_SQL : LEADERSHIP_TASKS_SQL,args);
 const value = row && decodeLeadershipPulse({view:input.view,scope:input.view === "day" ? "selected_arrival_day" : input.view === "care" ? "active_plan_work_now" : "visible_open_tasks_now",
  day:input.view === "day" ? input.day : row.today,today:row.today,timeZone,asOf:row.as_of.toISOString(),counts:row.counts,
  total:row.total,page:row.page,hasMore:(row.page+1)*LEADERSHIP_PAGE_SIZE<row.total,items:row.items},input.view,input.view === "day" ? input.day : null);
 if (!value) throw new Error("leadership_invalid_result");
 return value;
}
