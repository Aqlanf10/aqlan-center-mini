import type { DbPool } from "./db";
import { onClinicDaySql } from "./clinic-day-sql";
import { PLANNED_REBOOK_GENERATION_SQL } from "./planned-visit-rebooking-contract";
import { OPERATIONAL_PAGE_SIZE, type OperationalItem, type OperationalOverview, type OperationalQuery, type OperationalSection, type OperationalSource } from "./leadership-operations";

/** Compare JSON text, never cast untrusted audit details to identifiers. Require
 * the current reset generation plus immutable appointment identity in both snapshots. */
const rebookEdge = `old.planned_visit_id IS NULL AND old.arrived_at IS NULL AND old.started_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM planned_visits historical_link WHERE historical_link.appointment_id = old.id)
  AND NOT EXISTS (SELECT 1 FROM visits v WHERE v.appointment_id = old.id)
  AND NOT EXISTS (SELECT 1 FROM appointment_status_log s WHERE s.appointment_id = old.id
    AND (s.from_status IN ('arrived', 'in_progress', 'done') OR s.to_status IN ('arrived', 'in_progress', 'done')))
  AND log.action = 'planned_visit.rebook' AND log.entity = 'planned_visit'
  AND log.details->>'patientId' = old.patient_id::text
  AND log.details->>'oldAppointmentId' = old.id::text
  AND log.details->>'newAppointmentId' = replacement.id::text
  AND log.details#>>'{intent,expectedGeneration}' = ${PLANNED_REBOOK_GENERATION_SQL}
  AND log.details#>>'{intent,expectedAppointmentId}' = old.id::text
  AND log.details#>>'{intent,plannedVisitId}' = log.entity_id
  AND log.details#>>'{oldAppointment,id}' = old.id::text
  AND log.details#>>'{oldAppointment,patient_id}' = old.patient_id::text
  AND log.details#>>'{oldAppointment,planned_visit_id}' = log.entity_id
  AND log.details#>>'{oldAppointment,created_at}' = to_jsonb(old)->>'created_at'
  AND log.details#>>'{oldAppointment,scheduled_date}' = old.scheduled_date::text
  AND log.details#>>'{oldAppointment,scheduled_time}' = old.scheduled_time::text
  AND log.details#>>'{oldAppointment,status}' = old.status
  AND log.details#>>'{newAppointment,id}' = replacement.id::text
  AND log.details#>>'{newAppointment,patient_id}' = old.patient_id::text
  AND log.details#>>'{newAppointment,planned_visit_id}' = log.entity_id
  AND log.details#>>'{newAppointment,created_at}' = to_jsonb(replacement)->>'created_at'
  AND replacement.patient_id = old.patient_id AND replacement.id <> old.id
  -- A current-generation original must have exactly one candidate edge. Stop,
  -- rather than branch or choose a convenient audit, if its provenance is ambiguous.
  AND NOT EXISTS (SELECT 1 FROM audit_log competing
    WHERE competing.id <> log.id AND competing.action = 'planned_visit.rebook' AND competing.entity = 'planned_visit'
      AND competing.details->>'oldAppointmentId' = old.id::text
      AND competing.details->>'patientId' = old.patient_id::text
      AND competing.details#>>'{oldAppointment,created_at}' = to_jsonb(old)->>'created_at'
      AND competing.details#>>'{intent,expectedGeneration}' = ${PLANNED_REBOOK_GENERATION_SQL})`;

const paginationSql = (relation: string) => `tally AS (SELECT COUNT(*)::int AS total FROM ${relation}),
  paging AS (SELECT total, LEAST($3::int, GREATEST(0, (total - 1) / $4::int)) AS page FROM tally)`;

/** Only existing operational authorities. No financial projection or clinical procedures. */
export const OPERATIONAL_APPOINTMENTS_SQL = `WITH RECURSIVE
  cohort AS MATERIALIZED (
    SELECT a.*, p.full_name, p.patient_number FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE a.scheduled_date = $1::date AND $2::text IS NOT NULL AND a.status IN ('no_show', 'cancelled')
  ),
  ${paginationSql("cohort")},
  selected_cohort AS MATERIALIZED (
    SELECT * FROM cohort ORDER BY id DESC LIMIT $4 OFFSET (SELECT page FROM paging) * $4
  ),
  rebook_chain AS (
    SELECT old.id AS original_id, replacement.id AS replacement_id, log.entity_id AS planned_id,
      log.id AS audit_id, log.created_at AS recorded_at, ARRAY[old.id, replacement.id] AS seen
    FROM selected_cohort old JOIN audit_log log ON log.details->>'oldAppointmentId' = old.id::text
    JOIN appointments replacement ON log.details->>'newAppointmentId' = replacement.id::text
    WHERE ${rebookEdge}
    UNION ALL
    SELECT chain.original_id, replacement.id, log.entity_id, log.id, log.created_at, chain.seen || replacement.id
    FROM rebook_chain chain JOIN appointments old ON old.id = chain.replacement_id
    JOIN audit_log log ON log.entity_id = chain.planned_id AND log.details->>'oldAppointmentId' = old.id::text
    JOIN appointments replacement ON log.details->>'newAppointmentId' = replacement.id::text
    WHERE ${rebookEdge} AND old.status IN ('no_show', 'cancelled')
      AND log.created_at >= chain.recorded_at AND log.id > chain.audit_id
      AND cardinality(chain.seen) < 32 AND NOT replacement.id = ANY(chain.seen)
  ),
  records AS (
    SELECT a.id, a.patient_id AS "patientId", a.full_name AS "patientName", a.patient_number AS "patientNumber",
      a.status, a.scheduled_date::text || ' ' || LEFT(a.scheduled_time::text, 5) AS "eventAt",
      CASE WHEN proof.conflict OR proof.n > 1 OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM appointment_status_log s WHERE s.appointment_id = a.id
          AND (s.from_status IN ('arrived', 'in_progress', 'done') OR s.to_status IN ('arrived', 'in_progress', 'done')))
        OR EXISTS (SELECT 1 FROM visits v WHERE v.appointment_id = a.id)
        OR (a.planned_visit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM planned_visits pv
          WHERE pv.id = a.planned_visit_id AND pv.patient_id = a.patient_id AND pv.appointment_id = a.id AND pv.visit_id IS NULL))
        OR EXISTS (SELECT 1 FROM planned_visits other WHERE other.appointment_id = a.id
          AND (other.patient_id <> a.patient_id OR other.id IS DISTINCT FROM a.planned_visit_id))
        OR (a.planned_visit_id IS NOT NULL AND EXISTS (SELECT 1 FROM appointments other
          WHERE other.planned_visit_id = a.planned_visit_id AND other.id <> a.id))
        THEN 'history_review'
        WHEN proof.n <> 1 THEN 'needs_review'
        WHEN proof.status IN ('booked', 'arrived', 'in_progress') THEN 'replacement_active'
        WHEN proof.status = 'done' THEN 'replacement_finished'
        WHEN proof.status IN ('no_show', 'cancelled') THEN 'replacement_terminal'
        ELSE 'history_review' END AS state,
      CASE WHEN proof.n = 1 AND NOT proof.conflict THEN proof.planned_id ELSE (
        SELECT pv.id FROM planned_visits pv WHERE pv.id = a.planned_visit_id
          AND pv.patient_id = a.patient_id AND pv.appointment_id = a.id) END AS "plannedVisitId",
      NULL::text AS "reviewDoctor",
      CASE WHEN proof.n = 1 AND NOT proof.conflict THEN proof.replacement ELSE NULL END AS replacement
    FROM selected_cohort a
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS n, MIN(pv.id) AS planned_id, MIN(replacement.status) AS status,
        BOOL_OR(EXISTS (SELECT 1 FROM appointments other WHERE other.planned_visit_id = pv.id AND other.id <> replacement.id)
          OR EXISTS (SELECT 1 FROM planned_visits other WHERE other.appointment_id = replacement.id AND other.id <> pv.id)
          OR (pv.plan_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM treatment_plans plan WHERE plan.id = pv.plan_id AND plan.patient_id = a.patient_id))
          OR (replacement.status IN ('no_show', 'cancelled') AND (replacement.arrived_at IS NOT NULL OR replacement.started_at IS NOT NULL
            OR pv.visit_id IS NOT NULL OR EXISTS (SELECT 1 FROM visits v WHERE v.appointment_id = replacement.id)
            OR EXISTS (SELECT 1 FROM appointment_status_log s WHERE s.appointment_id = replacement.id
              AND (s.from_status IN ('arrived', 'in_progress', 'done') OR s.to_status IN ('arrived', 'in_progress', 'done')))))) AS conflict,
        (jsonb_agg(jsonb_build_object('id', replacement.id, 'date', replacement.scheduled_date::text,
          'time', LEFT(replacement.scheduled_time::text, 5), 'status', replacement.status,
          'auditId', chain.audit_id::text, 'recordedAt', chain.recorded_at) ORDER BY chain.audit_id DESC))->0 AS replacement
      FROM rebook_chain chain
      JOIN planned_visits pv ON pv.id::text = chain.planned_id AND pv.patient_id = a.patient_id
      JOIN appointments replacement ON replacement.id = chain.replacement_id AND replacement.patient_id = a.patient_id
        AND pv.appointment_id = replacement.id AND replacement.planned_visit_id = pv.id
      WHERE chain.original_id = a.id
    ) proof ON TRUE
  )`;

export const OPERATIONAL_REFERRALS_SQL = `WITH records AS (
  SELECT r.id, r.patient_id AS "patientId", p.full_name AS "patientName", p.patient_number AS "patientNumber",
    r.workflow_state AS status, 'awaiting_referrer'::text AS state, r.completed_at AS "eventAt",
    NULL::int AS "plannedVisitId", doctor.name AS "reviewDoctor", NULL::jsonb AS replacement
  FROM patient_referrals r JOIN patients p ON p.id = r.patient_id
  LEFT JOIN parties doctor ON doctor.id = COALESCE(r.return_to_party_id, r.doctor_party_id)
  WHERE r.kind = 'internal' AND r.status = 'completed' AND r.workflow_state = 'completed'
    AND r.returned_at IS NULL AND ${onClinicDaySql("r.completed_at", "$2", "$1::date")}
)`;

const pageSql = (source: OperationalSource) => `${source === "appointments" ? OPERATIONAL_APPOINTMENTS_SQL : `${OPERATIONAL_REFERRALS_SQL}, ${paginationSql("records")}`}
  SELECT statement_timestamp() AS as_of, paging.total, paging.page,
    COALESCE((SELECT jsonb_agg(row ORDER BY row.id DESC) FROM
      (SELECT * FROM records ORDER BY id DESC ${source === "referrals" ? "LIMIT $4 OFFSET (SELECT page FROM paging) * $4" : ""}) row), '[]'::jsonb) AS items
  FROM paging`;

async function readSection(pool: Pick<DbPool, "query">, source: OperationalSource, day: string, timeZone: string, page: number): Promise<OperationalSection> {
  try {
    // Both date-only and timestamp sources share the explicit clinic zone contract.
    const sql = pageSql(source);
    const { rows: [row] } = await pool.query<{ as_of: Date; total: number; page: number; items: OperationalItem[] }>(
      sql,
      [day, timeZone, page, OPERATIONAL_PAGE_SIZE]);
    return { source, status: "ready", asOf: row.as_of.toISOString(), total: row.total, page: row.page,
      hasMore: (row.page + 1) * OPERATIONAL_PAGE_SIZE < row.total, items: row.items };
  } catch {
    return { source, status: "error", asOf: null, total: null,
      message: source === "appointments" ? "تعذّر التحقق من سجل المواعيد. العدد غير معروف؛ أعد المحاولة." : "تعذّر التحقق من سجل الإحالات. العدد غير معروف؛ أعد المحاولة." };
  }
}
export async function readOperationalOverview(pool: Pick<DbPool, "query">, input: OperationalQuery, timeZone: string): Promise<OperationalOverview> {
  const sections = await Promise.all([
    ...(input.lane !== "doctor" ? [readSection(pool, "appointments", input.day, timeZone, input.appointmentPage)] : []),
    ...(input.lane !== "reception" ? [readSection(pool, "referrals", input.day, timeZone, input.referralPage)] : []),
  ]);
  return { day: input.day, timeZone, lane: input.lane, sections };
}
