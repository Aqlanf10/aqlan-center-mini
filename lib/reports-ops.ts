import { CLINIC_TIME_ZONE, ensureSchema, getPool } from "./db";

/**
 * (Slice 7) مصادر تقارير سير العمل الجديدة في مركز التقارير — قراءةٌ فقط من الجداول القائمة
 * (الإحالات الداخلية، الزيارات، سجل التدقيق). لا محرّك ثانٍ ولا كتابة.
 */

export interface InternalReferralReportRow {
  id: number;
  patientId: number;
  patientName: string;
  patientNumber: string | null;
  fromName: string | null;
  fromPartyId: number | null;
  toName: string;
  toPartyId: number | null;
  toSpecialty: string;
  teeth: string | null;
  workflowState: string;
  createdOn: string;
  completedOn: string | null;
  blocksCaseTitle: string | null;
  /** أيام من الطلب إلى الإكمال (للمكتملة)، وإلا عمر الإحالة حتى اليوم. */
  days: number;
  open: boolean;
}

/**
 * إحالات الفترة (بتاريخ طلبها في يوم العيادة) + كل إحالةٍ ما زالت مفتوحة أيًّا كان تاريخها —
 * فالتراكم لا يختفي بتغيير الفترة. مرشّح الطبيب يشمل المحيل والمستقبِل.
 */
export interface InternalReferralTotals {
  byState: Record<string, number>;
  open: number;
  completedCount: number;
  averageDaysToComplete: number | null;
}

/** شرط المجموعة الواحدة للصفوف والمجاميع معًا — إحالات الفترة (بيوم العيادة) + كل مفتوحة. */
const REFERRAL_SCOPE = `
  r.kind = 'internal' AND r.workflow_state IS NOT NULL
  AND ((r.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date OR r.status = 'sent')
  AND ($4::int IS NULL OR r.doctor_party_id = $4 OR r.to_party_id = $4)
  AND ($5::int IS NULL OR r.patient_id = $5)`;

/** سقف تاريخ المغلقة المعروضة فقط — المفتوحة تُعرض كلها دائمًا، والمجاميع بلا سقف. */
export const REFERRAL_HISTORY_ROW_CAP = 2000;

/**
 * إحالات الفترة (بتاريخ طلبها في يوم العيادة) + كل إحالةٍ ما زالت مفتوحة أيًّا كان تاريخها —
 * فالتراكم لا يختفي بتغيير الفترة. مرشّح الطبيب يشمل المحيل والمستقبِل. المفتوحة كلها في التفصيل،
 * والمغلقة حتى السقف؛ والمجاميع من استعلامٍ تجميعيٍّ بلا سقف.
 */
export async function loadInternalReferrals(filters: {
  from: string; to: string; doctorId: number | null; patientId: number | null;
}): Promise<{ rows: InternalReferralReportRow[]; totals: InternalReferralTotals; historyCapped: boolean }> {
  await ensureSchema();
  const pool = getPool();
  const params = [CLINIC_TIME_ZONE, filters.from, filters.to, filters.doctorId, filters.patientId];
  const select = `
    SELECT r.id, r.patient_id, p.full_name, p.patient_number, r.doctor_name, r.doctor_party_id,
           r.to_name, r.to_party_id, r.to_specialty, r.teeth, r.workflow_state, r.status, r.created_at,
           (r.created_at AT TIME ZONE $1)::date::text AS created_on,
           (r.completed_at AT TIME ZONE $1)::date::text AS completed_on,
           b.title AS blocks_title,
           FLOOR(EXTRACT(EPOCH FROM COALESCE(r.completed_at, NOW()) - r.created_at) / 86400)::text AS days
      FROM patient_referrals r
      JOIN patients p ON p.id = r.patient_id
      LEFT JOIN clinical_cases b ON b.id = r.blocks_case_id
     WHERE ${REFERRAL_SCOPE}`;
  const { rows } = await pool.query<{
    id: number; patient_id: number; full_name: string; patient_number: string | null;
    doctor_name: string | null; doctor_party_id: number | null; to_name: string; to_party_id: number | null;
    to_specialty: string; teeth: string | null; workflow_state: string; status: string;
    created_on: string; completed_on: string | null; blocks_title: string | null; days: string;
  }>(
    `SELECT * FROM (
       (${select} AND r.status = 'sent')
       UNION ALL
       (${select} AND r.status <> 'sent' ORDER BY r.created_at DESC, r.id DESC LIMIT ${REFERRAL_HISTORY_ROW_CAP + 1})
     ) x ORDER BY (x.status = 'sent') DESC, x.created_at DESC, x.id DESC`,
    params,
  );
  const closedShown = rows.filter((row) => row.status !== "sent").length;
  const historyCapped = closedShown > REFERRAL_HISTORY_ROW_CAP;
  let closedKept = 0;
  const kept = rows.filter((row) => row.status === "sent" || ++closedKept <= REFERRAL_HISTORY_ROW_CAP);

  const { rows: aggregate } = await pool.query<{ workflow_state: string; open: boolean; n: string; days_sum: string | null; completed: string }>(
    `SELECT r.workflow_state, (r.status = 'sent') AS open, COUNT(*)::text AS n,
            SUM(CASE WHEN r.completed_at IS NOT NULL THEN FLOOR(EXTRACT(EPOCH FROM r.completed_at - r.created_at) / 86400) END)::text AS days_sum,
            COUNT(r.completed_at)::text AS completed
       FROM patient_referrals r
      WHERE ${REFERRAL_SCOPE}
      GROUP BY r.workflow_state, (r.status = 'sent')`,
    params,
  );
  const byState: Record<string, number> = {};
  let open = 0; let completedCount = 0; let daysSum = 0;
  for (const row of aggregate) {
    byState[row.workflow_state] = (byState[row.workflow_state] ?? 0) + Number(row.n);
    if (row.open) open += Number(row.n);
    completedCount += Number(row.completed);
    daysSum += Number(row.days_sum ?? 0);
  }
  return {
    rows: kept.map((row) => ({
      id: row.id, patientId: row.patient_id, patientName: row.full_name, patientNumber: row.patient_number,
      fromName: row.doctor_name, fromPartyId: row.doctor_party_id, toName: row.to_name, toPartyId: row.to_party_id,
      toSpecialty: row.to_specialty, teeth: row.teeth, workflowState: row.workflow_state,
      createdOn: row.created_on, completedOn: row.completed_on, blocksCaseTitle: row.blocks_title,
      days: Number(row.days), open: row.status === "sent",
    })),
    totals: {
      byState, open, completedCount,
      averageDaysToComplete: completedCount === 0 ? null : Math.round(daysSum / completedCount),
    },
    historyCapped,
  };
}

export interface ChairFlowEvent {
  /** وقت الحدث بتوقيت العيادة «YYYY-MM-DD HH:MM». */
  at: string;
  kind: "bypass" | "deferred";
  visitId: number;
  patientId: number | null;
  patientName: string;
  actor: string;
  detail: string;
}

export interface ChairFlowData {
  arrived: number;
  cleared: number;
  /** من استعلامٍ تجميعيٍّ بلا سقف — لا من صفوف التفصيل المقصوصة. */
  bypasses: number;
  deferred: number;
  events: ChairFlowEvent[];
  eventsCapped: boolean;
}

export const CHAIR_EVENT_ROW_CAP = 2000;

/**
 * زيارات الفترة وما أُقِرّت جاهزيته منها، وحوادث الفترة من سجل التدقيق: تجاوز البوابة الطارئ
 * (بسببه) وتأجيل الدفع (بفاتورته). مرشّح المريض يسري على الجميع.
 */
export async function loadChairFlow(filters: {
  from: string; to: string; patientId: number | null;
}): Promise<ChairFlowData> {
  await ensureSchema();
  const pool = getPool();
  const { rows: [counts] } = await pool.query<{ arrived: string; cleared: string }>(
    `SELECT COUNT(*)::text AS arrived, COUNT(cleared_at)::text AS cleared
       FROM visits
      WHERE (arrived_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
        AND ($4::int IS NULL OR patient_id = $4)`,
    [CLINIC_TIME_ZONE, filters.from, filters.to, filters.patientId],
  );
  const { rows: [eventCounts] } = await pool.query<{ bypasses: string; deferred: string }>(
    `SELECT COUNT(*) FILTER (WHERE l.action = 'visit.clearance_bypass')::text AS bypasses,
            COUNT(*) FILTER (WHERE l.action = 'visit.payment_deferred')::text AS deferred
       FROM audit_log l
       JOIN visits v ON v.id::text = l.entity_id
      WHERE l.entity = 'visit' AND l.action IN ('visit.clearance_bypass', 'visit.payment_deferred')
        AND (l.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
        AND ($4::int IS NULL OR v.patient_id = $4)`,
    [CLINIC_TIME_ZONE, filters.from, filters.to, filters.patientId],
  );
  const { rows } = await pool.query<{
    at_local: string; action: string; visit_id: number; patient_id: number | null; patient_name: string | null;
    actor: string; details: Record<string, unknown> | null;
  }>(
    `SELECT to_char(l.created_at AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS at_local, l.action, v.id AS visit_id, v.patient_id, COALESCE(p.full_name, v.patient_name) AS patient_name,
            l.actor, l.details
       FROM audit_log l
       JOIN visits v ON v.id::text = l.entity_id
       LEFT JOIN patients p ON p.id = v.patient_id
      WHERE l.entity = 'visit' AND l.action IN ('visit.clearance_bypass', 'visit.payment_deferred')
        AND (l.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
        AND ($4::int IS NULL OR v.patient_id = $4)
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ${CHAIR_EVENT_ROW_CAP}`,
    [CLINIC_TIME_ZONE, filters.from, filters.to, filters.patientId],
  );
  const text = (value: unknown) => (value === null || value === undefined || value === "" ? null : String(value));
  const bypasses = Number(eventCounts?.bypasses ?? 0);
  const deferred = Number(eventCounts?.deferred ?? 0);
  return {
    arrived: Number(counts?.arrived ?? 0),
    cleared: Number(counts?.cleared ?? 0),
    bypasses,
    deferred,
    eventsCapped: bypasses + deferred > rows.length,
    events: rows.map((row) => {
      const details = row.details ?? {};
      const bypass = row.action === "visit.clearance_bypass";
      return {
        at: row.at_local,
        kind: bypass ? "bypass" as const : "deferred" as const,
        visitId: row.visit_id,
        patientId: row.patient_id,
        patientName: row.patient_name ?? "—",
        actor: row.actor,
        detail: bypass
          ? [text(details["الحركة"]), text(details["الكرسي"]) ? `كرسي ${text(details["الكرسي"])}` : null, text(details["السبب"])]
            .filter(Boolean).join(" — ")
          : [text(details["الفاتورة"]) ? `فاتورة #${text(details["الفاتورة"])}` : "بلا فاتورة", text(details["العملة"])]
            .filter(Boolean).join(" — "),
      };
    }),
  };
}
