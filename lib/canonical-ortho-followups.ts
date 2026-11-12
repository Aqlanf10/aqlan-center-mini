import "server-only";
import { CLINIC_TIME_ZONE, listOrthoFollowupCaseIdsWith } from "./db";
import { runCanonicalReadSnapshot, type CanonicalSnapshotQuery, type CanonicalSnapshotScope } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { clinicDateString } from "./schedule";
import { classifyFollowups, type FollowupCase } from "./ortho-followup";
import { projectFollowupBookings, type ProjectedFollowupBooking } from "./ortho-followup-board";
import { CLINICAL_FOLLOWUP_BUCKETS, isCanonicalOrthoFollowups, type CanonicalOrthoFollowups } from "./canonical-ortho-followup-projection";

const MAX_BYTES = 2 * 1024 * 1024;
export class CanonicalOrthoFollowupRefusal extends Error {
  constructor(readonly code: "ortho_followup_limit" | "ortho_followup_reference" | "ortho_followup_invalid") {
    super("تعذّر التحقق من لوحة المتابعة ضمن حدود القراءة الآمنة."); this.name = "CanonicalOrthoFollowupRefusal";
  }
}
interface Row {
  case_id: number; patient_id: number; full_name: string; status: "active" | "retention"; phase: string;
  start_date: Date | string; last_adjustment_date: string | null; next_weeks: number | null;
  clinical_case_id: number | null; bookings: ProjectedFollowupBooking[]; last_no_show: boolean;
}
const clinicalSQL = `SELECT c.id AS case_id,c.patient_id,p.full_name,c.status,c.phase,c.start_date,
  a.last_adjustment_date,a.next_weeks,NULL::int AS clinical_case_id,'[]'::jsonb AS bookings,FALSE AS last_no_show
  FROM ortho_cases c JOIN patients p ON p.id=c.patient_id
  LEFT JOIN LATERAL (SELECT done_on::text AS last_adjustment_date,next_weeks FROM ortho_adjustments
    WHERE case_id=c.id ORDER BY done_on DESC,id DESC LIMIT 1) a ON TRUE
  WHERE c.id=ANY($1::int[]) ORDER BY c.start_date,c.id`;

// SAME booking lineage facts and pure projector as the existing board. The SQL
// restricts appointments and their session joins to the admitted provider first.
const scheduleSQL = `WITH noshow AS (
       SELECT DISTINCT patient_id, TRUE AS was
         FROM appointments a
        WHERE a.status = 'no_show' AND a.patient_id=ANY($2::int[]) AND ($3::int IS NULL OR a.doctor_id=$3)
     ),
     planned_sessions AS (
       SELECT s.planned_visit_id, jsonb_agg(jsonb_build_object(
           'id', s.id, 'plannedVisitId', s.planned_visit_id, 'status', s.status, 'visitId', s.visit_id,
           'itemId', i.id, 'itemPlanId', i.plan_id, 'itemStatus', i.status, 'itemCategory', i.category,
           'clinicalCaseId', i.case_id, 'casePatientId', sc.patient_id,
           'caseSpecialty', sc.specialty, 'caseStatus', sc.status,
           'orthoCaseId', so.id, 'orthoPatientId', so.patient_id
         ) ORDER BY s.id) AS items
         FROM treatment_sessions s
         LEFT JOIN plan_items i ON i.id = s.plan_item_id
         LEFT JOIN clinical_cases sc ON sc.id = i.case_id
         LEFT JOIN ortho_cases so ON so.id = sc.ortho_case_id AND so.patient_id = sc.patient_id
        WHERE EXISTS (SELECT 1 FROM appointments candidate
                       WHERE candidate.planned_visit_id = s.planned_visit_id
                         AND candidate.status IN ('booked', 'arrived') AND candidate.patient_id=ANY($2::int[]) AND ($3::int IS NULL OR candidate.doctor_id=$3))
        GROUP BY s.planned_visit_id
     ),
     bookings AS (
       SELECT ap.patient_id, jsonb_agg(jsonb_build_object(
           'id', ap.id, 'patientId', ap.patient_id,
           'scheduledDate', ap.scheduled_date::text,
           'scheduledTime', to_char(ap.scheduled_time, 'HH24:MI'), 'status', ap.status,
           'appointmentType', ap.appointment_type, 'serviceId', ap.service_id,
           'service', CASE WHEN svc.id IS NULL THEN NULL ELSE jsonb_build_object(
             'id', svc.id, 'code', svc.code, 'specialty', svc.specialty, 'legacyType', svc.legacy_type) END,
           'serviceName', svc.name_ar, 'doctorName', doc.name,
           'referralId', ap.referral_id,
           'referral', CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
             'id', r.id, 'patientId', r.patient_id, 'toSpecialty', r.to_specialty,
             'caseId', r.case_id, 'casePatientId', rc.patient_id, 'orthoCaseId', linked_ortho.id) END,
           'plannedVisitId', ap.planned_visit_id,
           'plannedVisit', CASE WHEN pv.id IS NULL THEN NULL ELSE jsonb_build_object(
             'id', pv.id, 'patientId', pv.patient_id, 'planId', pv.plan_id,
             'planPatientId', plan.patient_id, 'planStatus', plan.status,
             'status', pv.status, 'appointmentId', pv.appointment_id,
             'visitId', pv.visit_id, 'visitPatientId', visit.patient_id,
             'visitPlannedVisitId', visit.planned_visit_id, 'visitAppointmentId', visit.appointment_id,
             'visitSigned', CASE WHEN visit.id IS NULL THEN NULL ELSE visit.signed_at IS NOT NULL END,
             'sessions', COALESCE(planned_sessions.items, '[]'::jsonb)) END
         ) ORDER BY ap.scheduled_date, ap.scheduled_time, ap.id) AS items
           FROM appointments ap
           LEFT JOIN appointment_services svc ON svc.id = ap.service_id
           LEFT JOIN parties doc ON doc.id = ap.doctor_id
           LEFT JOIN patient_referrals r ON r.id = ap.referral_id AND r.patient_id = ap.patient_id
           LEFT JOIN clinical_cases rc ON rc.id = r.case_id AND rc.patient_id = ap.patient_id
           LEFT JOIN ortho_cases linked_ortho ON linked_ortho.id = rc.ortho_case_id AND linked_ortho.patient_id = ap.patient_id
           LEFT JOIN planned_visits pv ON pv.id = ap.planned_visit_id AND pv.patient_id = ap.patient_id
           LEFT JOIN treatment_plans plan ON plan.id = pv.plan_id AND plan.patient_id = ap.patient_id
           LEFT JOIN visits visit ON visit.id = pv.visit_id AND visit.patient_id = ap.patient_id
           LEFT JOIN planned_sessions ON planned_sessions.planned_visit_id = pv.id
          WHERE ap.status IN ('booked', 'arrived') AND ap.patient_id=ANY($2::int[]) AND ($3::int IS NULL OR ap.doctor_id=$3)
          GROUP BY ap.patient_id
     )
     SELECT c.id AS case_id, c.patient_id, p.full_name, c.status, c.phase,
            c.start_date, a.last_adjustment_date, a.next_weeks,
            bridge.id AS clinical_case_id,
            COALESCE(bookings.items, '[]'::jsonb) AS bookings,
            COALESCE(ns.was, FALSE) AS last_no_show
       FROM ortho_cases c
       JOIN patients p ON p.id = c.patient_id
       LEFT JOIN clinical_cases bridge ON bridge.ortho_case_id = c.id AND bridge.patient_id = c.patient_id
       LEFT JOIN LATERAL (
         SELECT oa.done_on::text AS last_adjustment_date, oa.next_weeks
           FROM ortho_adjustments oa
          WHERE oa.case_id = c.id
          ORDER BY oa.done_on DESC, oa.id DESC LIMIT 1
       ) a ON TRUE
       LEFT JOIN bookings ON bookings.patient_id = c.patient_id
       LEFT JOIN noshow ns ON ns.patient_id = c.patient_id
      WHERE c.id=ANY($1::int[]) ORDER BY c.start_date,c.id`;

/** Server-internal reader on one owning snapshot; never calls the rich legacy wrapper. */
export async function readOrthoFollowupsWith(q: CanonicalSnapshotQuery, scope: CanonicalSnapshotScope, today: string): Promise<CanonicalOrthoFollowups> {
  const page = await listOrthoFollowupCaseIdsWith(q, scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null);
  const coverage = scope.appointmentScope.kind;
  const result: CanonicalOrthoFollowups = { projection: "ortho-followups", today, appointmentCoverage: coverage, hasMore: page.hasMore, rows: [] };
  if (!page.ids.length) return result;
  const patientIds = (await q.query<{ patient_id: number }>("SELECT DISTINCT patient_id FROM ortho_cases WHERE id=ANY($1::int[])", [page.ids])).rows.map(r => Number(r.patient_id));
  // A corrupt or ambiguous bridge must not turn an uncertain booking into an
  // apparently absent one. No repair or bridge creation is performed by a read.
  const bridges = (await q.query<{ invalid: boolean }>(`SELECT EXISTS(SELECT 1 FROM clinical_cases b JOIN ortho_cases c ON c.id=b.ortho_case_id
    WHERE c.id=ANY($1::int[]) GROUP BY c.id HAVING count(*)>1 OR bool_or(b.patient_id<>c.patient_id OR b.specialty<>'orthodontics')) AS invalid`, [page.ids])).rows[0];
  if (bridges.invalid) throw new CanonicalOrthoFollowupRefusal("ortho_followup_reference");
  let sql = clinicalSQL;
  let params: unknown[] = [page.ids];
  if (coverage !== "none") {
    const doctorId = scope.appointmentScope.kind === "own" ? scope.appointmentScope.clinicianPartyId : null;
    const budget = (await q.query<{ appointments: number; sessions: number }>(`WITH allowed AS (
      SELECT id,planned_visit_id FROM appointments WHERE patient_id=ANY($1::int[])
      AND ($2::int IS NULL OR doctor_id=$2) AND status IN ('booked','arrived'))
      SELECT (SELECT count(*) FROM allowed)::int AS appointments,
      (SELECT count(*) FROM treatment_sessions s WHERE EXISTS(SELECT 1 FROM allowed a WHERE a.planned_visit_id=s.planned_visit_id))::int AS sessions`, [patientIds, doctorId])).rows[0];
    if (budget.appointments > 2000 || budget.sessions > 2000) throw new CanonicalOrthoFollowupRefusal("ortho_followup_limit");
    sql = scheduleSQL; params = [page.ids, patientIds, doctorId];
  }
  // Budget the explicit selected projection in PostgreSQL before transferring it
  // to the process. The owning repeatable-read snapshot keeps both reads identical.
  const bytes = Number((await q.query<{ bytes: string }>(`SELECT COALESCE(sum(octet_length(row_to_json(r)::text)),0)::text AS bytes FROM (${sql}) r`, params)).rows[0].bytes);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_BYTES) throw new CanonicalOrthoFollowupRefusal("ortho_followup_limit");
  const rows = (await q.query<Row>(sql, params)).rows;
  result.rows = rows.map(row => {
    const startDate = row.start_date instanceof Date ? row.start_date.toISOString().slice(0, 10) : row.start_date;
    const schedule = coverage === "none" ? null : projectFollowupBookings({
      target: { patientId: Number(row.patient_id), orthoCaseId: Number(row.case_id), clinicalCaseId: row.clinical_case_id === null ? null : Number(row.clinical_case_id), startDate },
      today, appointments: row.bookings,
    });
    const base: FollowupCase = { caseId: Number(row.case_id), patientId: Number(row.patient_id), patientName: row.full_name,
      patientPhone: null, status: row.status, phase: row.phase, startDate, lastAdjustmentDate: row.last_adjustment_date,
      nextWeeks: row.next_weeks ?? 4, upperWire: null, lowerWire: null,
      nextAppointment: schedule?.nextAppointment ?? null, bookingContext: schedule?.bookingContext, lastWasNoShow: schedule !== null && row.last_no_show };
    const classified = classifyFollowups({ cases: [base], today })[0];
    return { caseId: base.caseId, patientId: base.patientId, patientName: base.patientName, status: base.status, phase: base.phase,
      startDate, lastAdjustmentDate: base.lastAdjustmentDate, nextWeeks: base.nextWeeks, dueDate: classified.dueDate, daysSinceLast: classified.daysSinceLast!,
      buckets: classified.buckets.filter(bucket => coverage === "none" ? CLINICAL_FOLLOWUP_BUCKETS.includes(bucket) : coverage === "all" || bucket !== "no_appointment"),
      schedule: schedule === null ? null : { nextAppointment: schedule.nextAppointment,
        pastUnresolvedAppointment: schedule.bookingContext.pastUnresolvedAppointment,
        reviewAppointments: schedule.bookingContext.reviewAppointments, otherAppointments: schedule.bookingContext.otherAppointments,
        hasRecordedNoShow: row.last_no_show },
    };
  });
  if (!isCanonicalOrthoFollowups(result)) throw new CanonicalOrthoFollowupRefusal("ortho_followup_invalid");
  return result;
}
export async function readCanonicalOrthoFollowups(session: VerifiedDurableSession) {
  return runCanonicalReadSnapshot(session, "read:ortho.followups", (q, scope) => readOrthoFollowupsWith(q, scope, clinicDateString(new Date(), CLINIC_TIME_ZONE)),
    { errorPrefix: "STAFF_READ", maxBytes: MAX_BYTES });
}
