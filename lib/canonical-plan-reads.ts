import "server-only";
import { CLINIC_TIME_ZONE } from "./db";
import { CanonicalPatientReadRefusal, readCanonicalPatientRecord } from "./canonical-patient-reads";
import type { CanonicalSnapshotQuery } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { CLINICAL_PLAN_LIMIT, CLINICAL_PLAN_ITEM_LIMIT, CLINICAL_PLAN_TOTAL_ITEM_LIMIT, isCanonicalClinicalPlans,
  type CanonicalClinicalPlans, type CanonicalClinicalPlan, type CanonicalClinicalPlanItem } from "./canonical-plan-projection";

const MAX_BYTES = 2 * 1024 * 1024;
export class CanonicalPlanReadRefusal extends Error {
  constructor(readonly code: "plan_read_limit" | "plan_reference_unavailable" | "plan_stored_data_invalid", message: string) {
    super(message); this.name = "CanonicalPlanReadRefusal";
  }
}
export function canonicalPlanPatientId(raw: string, query: URLSearchParams) {
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2147483647 || [...query.keys()].length) {
    throw new CanonicalPatientReadRefusal("invalid_patient_query", "رقم المريض أو طلب الخطط غير صالح.");
  }
  return Number(raw);
}

// Explicit clinical columns: financial data never enters this reader, even for the owner.
const PLAN_COLUMNS = `p.id,p.title,p.status,p.start_date::text AS start_date,p.created_at,p.note,p.consent_at,p.consent_by,p.consent_note`;
const ITEM_COLUMNS = `i.id,i.plan_id,i.service_name,i.category,i.tooth_code,i.surfaces,i.quantity,i.status,i.done_at,i.note,
  i.planned_visit_number,i.session_count,doc.name AS doctor_name,c.site AS case_site`;
const ITEM_JOINS = "FROM plan_items i LEFT JOIN parties doc ON doc.id=i.doctor_id LEFT JOIN clinical_cases c ON c.id=i.case_id";
interface PlanRow {
  id: number; title: string; status: CanonicalClinicalPlan["status"]; start_date: string; created_at: Date; note: string | null;
  consent_at: Date | null; consent_by: string | null; consent_note: string | null;
}
interface ItemRow {
  id: number; plan_id: number; service_name: string; category: string | null; tooth_code: number | null; surfaces: string | null;
  quantity: number; status: CanonicalClinicalPlanItem["status"]; done_at: Date | null; note: string | null;
  planned_visit_number: number | null; session_count: number | null; sessions_completed: number; doctor_name: string | null; case_site: string | null;
}

export async function readClinicalPlansWith(q: CanonicalSnapshotQuery, patientId: number): Promise<CanonicalClinicalPlans> {
  const identifiers = (await q.query<{ id: number }>("SELECT id FROM treatment_plans WHERE patient_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2", [patientId, CLINICAL_PLAN_LIMIT + 1])).rows;
  const ids = identifiers.slice(0, CLINICAL_PLAN_LIMIT).map(row => row.id);
  if (!ids.length) return { projection: "patient-plan-clinical", clinicTimeZone: CLINIC_TIME_ZONE, patientId, plans: [], hasMore: false };
  const count = (await q.query<{ total: string; maximum: string }>(`SELECT COALESCE(sum(n),0)::text AS total,COALESCE(max(n),0)::text AS maximum
    FROM (SELECT count(*) n FROM plan_items WHERE plan_id=ANY($1::int[]) GROUP BY plan_id) counts`, [ids])).rows[0];
  if (!count || Number(count.total) > CLINICAL_PLAN_TOTAL_ITEM_LIMIT || Number(count.maximum) > CLINICAL_PLAN_ITEM_LIMIT) {
    throw new CanonicalPlanReadRefusal("plan_read_limit", "بنود الخطط تتجاوز حد القراءة الآمنة؛ لم تُختصر تفاصيلها.");
  }
  // Do not display a foreign patient's case or count a session attached to their visit.
  const invalid = (await q.query<{ invalid: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM plan_items i LEFT JOIN clinical_cases c ON c.id=i.case_id LEFT JOIN visits v ON v.id=i.visit_id
    WHERE i.plan_id=ANY($1::int[]) AND ((i.case_id IS NOT NULL AND c.patient_id IS DISTINCT FROM $2)
      OR (i.visit_id IS NOT NULL AND v.patient_id IS DISTINCT FROM $2))
    UNION ALL SELECT 1 FROM treatment_sessions s JOIN plan_items i ON i.id=s.plan_item_id
    LEFT JOIN visits v ON v.id=s.visit_id LEFT JOIN planned_visits pv ON pv.id=s.planned_visit_id
    WHERE i.plan_id=ANY($1::int[]) AND ((s.visit_id IS NOT NULL AND v.patient_id IS DISTINCT FROM $2)
      OR (s.planned_visit_id IS NOT NULL AND pv.patient_id IS DISTINCT FROM $2))) AS invalid`, [ids, patientId])).rows[0]?.invalid;
  if (invalid !== false) throw new CanonicalPlanReadRefusal("plan_reference_unavailable", "تعذّر التحقق من ملكية مراجع الخطة؛ لم تُعرض تفاصيل جزئية.");
  const bytes = (await q.query<{ bytes: string }>(`SELECT (
    COALESCE((SELECT sum(octet_length(to_jsonb(data)::text)) FROM (SELECT ${PLAN_COLUMNS} FROM treatment_plans p WHERE p.id=ANY($1::int[])) data),0)
    +COALESCE((SELECT sum(octet_length(to_jsonb(data)::text)) FROM (SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE i.plan_id=ANY($1::int[])) data),0))::text AS bytes`, [ids])).rows[0]?.bytes;
  if (!bytes || !Number.isFinite(Number(bytes)) || Number(bytes) > MAX_BYTES) throw new CanonicalPlanReadRefusal("plan_read_limit", "الخطط تتجاوز حد القراءة الآمنة؛ لم تُختصر الملاحظات أو البنود.");
  const plans = (await q.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM treatment_plans p WHERE p.id=ANY($1::int[]) ORDER BY p.created_at DESC,p.id DESC`, [ids])).rows;
  const items = (await q.query<ItemRow>(`SELECT ${ITEM_COLUMNS},
    (SELECT count(*)::int FROM treatment_sessions s WHERE s.plan_item_id=i.id AND s.status='done') AS sessions_completed
    ${ITEM_JOINS} WHERE i.plan_id=ANY($1::int[]) ORDER BY i.plan_id,i.sort_order,i.id`, [ids])).rows;
  const body: CanonicalClinicalPlans = { projection: "patient-plan-clinical", clinicTimeZone: CLINIC_TIME_ZONE, patientId, hasMore: identifiers.length > CLINICAL_PLAN_LIMIT,
    plans: plans.map(p => ({ id: p.id, title: p.title, status: p.status, startDate: p.start_date, createdAt: p.created_at.toISOString(), note: p.note,
      consentAt: p.consent_at?.toISOString() ?? null, consentBy: p.consent_by, consentNote: p.consent_note,
      items: items.filter(i => i.plan_id === p.id).map(i => ({ id: i.id, serviceName: i.service_name, category: i.category, toothCode: i.tooth_code,
        surfaces: i.surfaces, quantity: i.quantity, status: i.status, doneAt: i.done_at?.toISOString() ?? null, note: i.note,
        plannedVisitNumber: i.planned_visit_number, sessionCount: i.session_count, sessionsCompleted: i.sessions_completed, doctorName: i.doctor_name, caseSite: i.case_site })),
    })),
  };
  if (!isCanonicalClinicalPlans(body, patientId)) throw new CanonicalPlanReadRefusal("plan_stored_data_invalid", "تعذّر التحقق من البيانات السريرية المحفوظة؛ لم تُستبدل بقيم افتراضية.");
  return body;
}

export function readCanonicalClinicalPlans(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:plans.clinical", patientId, q => readClinicalPlansWith(q, patientId), MAX_BYTES);
}
