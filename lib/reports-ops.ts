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
export async function loadInternalReferrals(filters: {
  from: string; to: string; doctorId: number | null; patientId: number | null;
}): Promise<InternalReferralReportRow[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; patient_id: number; full_name: string; patient_number: string | null;
    doctor_name: string | null; doctor_party_id: number | null; to_name: string; to_party_id: number | null;
    to_specialty: string; teeth: string | null; workflow_state: string; status: string;
    created_on: string; completed_on: string | null; blocks_title: string | null; days: string;
  }>(
    `SELECT r.id, r.patient_id, p.full_name, p.patient_number, r.doctor_name, r.doctor_party_id,
            r.to_name, r.to_party_id, r.to_specialty, r.teeth, r.workflow_state, r.status,
            (r.created_at AT TIME ZONE $1)::date::text AS created_on,
            (r.completed_at AT TIME ZONE $1)::date::text AS completed_on,
            b.title AS blocks_title,
            FLOOR(EXTRACT(EPOCH FROM COALESCE(r.completed_at, NOW()) - r.created_at) / 86400)::text AS days
       FROM patient_referrals r
       JOIN patients p ON p.id = r.patient_id
       LEFT JOIN clinical_cases b ON b.id = r.blocks_case_id
      WHERE r.kind = 'internal' AND r.workflow_state IS NOT NULL
        AND ((r.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date OR r.status = 'sent')
        AND ($4::int IS NULL OR r.doctor_party_id = $4 OR r.to_party_id = $4)
        AND ($5::int IS NULL OR r.patient_id = $5)
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 2000`,
    [CLINIC_TIME_ZONE, filters.from, filters.to, filters.doctorId, filters.patientId],
  );
  return rows.map((row) => ({
    id: row.id, patientId: row.patient_id, patientName: row.full_name, patientNumber: row.patient_number,
    fromName: row.doctor_name, fromPartyId: row.doctor_party_id, toName: row.to_name, toPartyId: row.to_party_id,
    toSpecialty: row.to_specialty, teeth: row.teeth, workflowState: row.workflow_state,
    createdOn: row.created_on, completedOn: row.completed_on, blocksCaseTitle: row.blocks_title,
    days: Number(row.days), open: row.status === "sent",
  }));
}

export interface ChairFlowEvent {
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
  events: ChairFlowEvent[];
}

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
  const { rows } = await pool.query<{
    created_at: Date; action: string; visit_id: number; patient_id: number | null; patient_name: string | null;
    actor: string; details: Record<string, unknown> | null;
  }>(
    `SELECT l.created_at, l.action, v.id AS visit_id, v.patient_id, COALESCE(p.full_name, v.patient_name) AS patient_name,
            l.actor, l.details
       FROM audit_log l
       JOIN visits v ON v.id::text = l.entity_id
       LEFT JOIN patients p ON p.id = v.patient_id
      WHERE l.entity = 'visit' AND l.action IN ('visit.clearance_bypass', 'visit.payment_deferred')
        AND (l.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
        AND ($4::int IS NULL OR v.patient_id = $4)
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 2000`,
    [CLINIC_TIME_ZONE, filters.from, filters.to, filters.patientId],
  );
  const text = (value: unknown) => (value === null || value === undefined || value === "" ? null : String(value));
  return {
    arrived: Number(counts?.arrived ?? 0),
    cleared: Number(counts?.cleared ?? 0),
    events: rows.map((row) => {
      const details = row.details ?? {};
      const bypass = row.action === "visit.clearance_bypass";
      return {
        at: row.created_at.toISOString(),
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
