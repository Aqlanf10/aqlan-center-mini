import "server-only";
import { CLINIC_TIME_ZONE } from "./db";
import { readCanonicalPatientRecord } from "./canonical-patient-reads";
import type { CanonicalSnapshotQuery, CanonicalSnapshotScope } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { isDependencyMet } from "./cases";
import { CASE_READ_LIMITS, isCanonicalPatientCases, type CanonicalPatientCases } from "./canonical-case-projection";
import { planDependencyVersion } from "./canonical-plan-dependency-version";
import { clinicalProblemStatusVersion } from "./canonical-problem-status-version";
import { clinicalCaseStatusVersion } from "./canonical-case-status-version";

const MAX_BYTES = 2 * 1024 * 1024;
export class CanonicalCaseReadRefusal extends Error {
  constructor(readonly code: "case_read_limit" | "case_reference_unavailable" | "case_stored_data_invalid", message: string) { super(message); this.name = "CanonicalCaseReadRefusal"; }
}
const visibleCase = "($2::boolean OR (c.ortho_case_id IS NULL AND c.specialty <> 'orthodontics'))";
// Clinical facts only. No agreement, invoice, price or funding source is queried.
const CASES = `SELECT c.id,'specialty'::text kind,c.ortho_case_id AS "orthoCaseId",c.specialty,c.title,c.site,c.problem,
  d.name AS "responsibleName",CASE WHEN o.id IS NULL THEN c.status WHEN o.status IN ('active','retention') THEN 'active' WHEN o.status='completed' THEN 'completed' WHEN o.status='discontinued' THEN 'closed' ELSE o.status END status,
  c.started_on::text AS "startedOn",(CASE WHEN o.id IS NULL THEN c.completed_at ELSE o.closed_at END)::text AS "completedAt",
  CASE WHEN o.id IS NULL THEN c.outcome ELSE o.closed_note END outcome,c.xmin::text AS "versionXmin",c.ctid::text AS "versionTid"
  FROM clinical_cases c LEFT JOIN ortho_cases o ON o.id=c.ortho_case_id AND o.patient_id=c.patient_id
  LEFT JOIN parties d ON d.id=COALESCE(o.responsible_doctor_id,c.responsible_party_id)
  WHERE c.patient_id=$1 AND ${visibleCase}
  UNION ALL SELECT NULL,'ortho',o.id,'orthodontics','تقويم الأسنان',NULL,NULL,d.name,
  CASE WHEN o.status IN ('active','retention') THEN 'active' WHEN o.status='completed' THEN 'completed' WHEN o.status='discontinued' THEN 'closed' ELSE o.status END,
  o.start_date::text,o.closed_at::text,o.closed_note,NULL,NULL FROM ortho_cases o
  LEFT JOIN treatment_plans t ON t.id=o.plan_id AND t.patient_id=o.patient_id
  LEFT JOIN parties d ON d.id=COALESCE(o.responsible_doctor_id,t.primary_doctor_id)
  WHERE o.patient_id=$1 AND $2::boolean AND NOT EXISTS(SELECT 1 FROM clinical_cases c WHERE c.ortho_case_id=o.id)`;
const PROBLEMS = `SELECT p.id,p.label,p.site,p.specialty,p.status,CASE WHEN ${visibleCase} THEN p.case_id ELSE NULL END AS "caseId",
  p.noted_by AS "notedBy",p.noted_at::text AS "notedAt",p.resolved_by AS "resolvedBy",p.resolved_at::text AS "resolvedAt",p.xmin::text AS "versionXmin",p.ctid::text AS "versionTid"
  FROM patient_problems p LEFT JOIN clinical_cases c ON c.id=p.case_id AND c.patient_id=p.patient_id WHERE p.patient_id=$1`;
// Include cancelled plans explicitly: a dependency may legitimately refer to one of
// their items. Omitting that endpoint would misrepresent the saved graph.
const ITEMS = `SELECT i.id,i.plan_id AS "planId",t.title AS "planTitle",t.status AS "planStatus",i.service_name AS "serviceName",i.category,
  i.tooth_code AS "toothCode",i.surfaces,i.status,d.name AS "doctorName",CASE WHEN ${visibleCase} THEN i.case_id ELSE NULL END AS "caseId",
  i.priority,i.sort_order AS "sortOrder" FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id
  LEFT JOIN clinical_cases c ON c.id=i.case_id AND c.patient_id=t.patient_id LEFT JOIN parties d ON d.id=i.doctor_id WHERE t.patient_id=$1`;
const DEPS = `SELECT d.item_id AS "itemId",d.requires_item_id AS "requiresItemId",d.requirement,d.note,d.created_by AS "createdBy",r.status AS "requiredStatus",
  d.created_at::text AS "createdAt",d.xmin::text AS "rowXmin",d.ctid::text AS "rowTid"
  FROM plan_item_dependencies d JOIN plan_items i ON i.id=d.item_id JOIN treatment_plans t ON t.id=i.plan_id
  JOIN plan_items r ON r.id=d.requires_item_id JOIN treatment_plans rt ON rt.id=r.plan_id
  WHERE t.patient_id=$1 AND rt.patient_id=$1`;

async function boundedRows<T>(q: CanonicalSnapshotQuery, sql: string, args: unknown[], limit: number): Promise<T[]> {
  const count = Number((await q.query<{ n: string }>(`SELECT count(*)::text n FROM (${sql}) data`, args)).rows[0]?.n);
  if (!Number.isSafeInteger(count) || count > limit) throw new CanonicalCaseReadRefusal("case_read_limit", "السجل يتجاوز حد القراءة الآمنة؛ لم تُختصر الحالات أو الاعتماديات.");
  const bytes = Number((await q.query<{ n: string }>(`SELECT COALESCE(sum(octet_length(to_jsonb(data)::text)),0)::text n FROM (${sql}) data`, args)).rows[0]?.n);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_BYTES) throw new CanonicalCaseReadRefusal("case_read_limit", "تفاصيل السجل تتجاوز حد القراءة الآمنة؛ لم تُختصر النصوص.");
  return (await q.query<T>(`SELECT * FROM (${sql}) data`, args)).rows;
}
export async function readPatientCasesWith(q: CanonicalSnapshotQuery, scope: CanonicalSnapshotScope, patientId: number): Promise<CanonicalPatientCases> {
  const planVisible = scope.granted("clinical.plans.view"), orthoVisible = scope.granted("clinical.ortho.view");
  // Validate references before any joined clinical content, in the same RR snapshot.
  const invalid = (await q.query<{ invalid: boolean }>(`SELECT EXISTS(
    SELECT 1 FROM clinical_cases c LEFT JOIN ortho_cases o ON o.id=c.ortho_case_id WHERE c.patient_id=$1 AND ${visibleCase}
      AND c.ortho_case_id IS NOT NULL AND (o.patient_id IS DISTINCT FROM $1 OR c.specialty <> 'orthodontics')
    UNION ALL SELECT 1 FROM ortho_cases o LEFT JOIN treatment_plans t ON t.id=o.plan_id
      WHERE $2::boolean AND o.patient_id=$1 AND o.plan_id IS NOT NULL AND t.patient_id IS DISTINCT FROM $1
    UNION ALL SELECT 1 FROM ortho_cases o JOIN clinical_cases c ON c.ortho_case_id=o.id
      WHERE $2::boolean AND o.patient_id=$1 AND c.patient_id IS DISTINCT FROM $1
    UNION ALL SELECT 1 FROM patient_problems p LEFT JOIN clinical_cases c ON c.id=p.case_id
      WHERE p.patient_id=$1 AND p.case_id IS NOT NULL AND c.patient_id IS DISTINCT FROM $1) invalid`, [patientId, orthoVisible])).rows[0]?.invalid;
  if (invalid !== false) throw new CanonicalCaseReadRefusal("case_reference_unavailable", "تعذّر التحقق من مراجع الحالات؛ لم تُعرض بيانات جزئية.");
  if (planVisible) {
    const invalidPlan = (await q.query<{ invalid: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id LEFT JOIN clinical_cases c ON c.id=i.case_id
      WHERE t.patient_id=$1 AND i.case_id IS NOT NULL AND c.patient_id IS DISTINCT FROM $1
      UNION ALL SELECT 1 FROM plan_item_dependencies d JOIN plan_items i ON i.id=d.item_id JOIN treatment_plans t ON t.id=i.plan_id
      LEFT JOIN plan_items r ON r.id=d.requires_item_id LEFT JOIN treatment_plans rt ON rt.id=r.plan_id
      WHERE t.patient_id=$1 AND rt.patient_id IS DISTINCT FROM $1) invalid`, [patientId])).rows[0]?.invalid;
    if (invalidPlan !== false) throw new CanonicalCaseReadRefusal("case_reference_unavailable", "تعذّر التحقق من مراجع بنود الخطة؛ لم تُعرض بيانات جزئية.");
  }
  const args: [number, boolean] = [patientId, orthoVisible];
  const cases = (await boundedRows<Omit<CanonicalPatientCases["cases"][number], "version"> & { versionXmin: string; versionTid: string }>(q, CASES, args, CASE_READ_LIMITS.cases))
    .map(({ versionXmin, versionTid, ...row }) => ({ ...row, version: row.kind === "specialty" && row.id !== null && row.orthoCaseId === null
      ? clinicalCaseStatusVersion({ ...row, id: row.id, patientId, versionXmin, versionTid }) : null }));
  const problems = (await boundedRows<Omit<CanonicalPatientCases["problems"][number], "version"> & { versionXmin: string; versionTid: string }>(q, PROBLEMS, args, CASE_READ_LIMITS.problems))
    .map(({versionXmin,versionTid,...row}) => ({...row,version:clinicalProblemStatusVersion({...row,patientId,versionXmin,versionTid})}));
  const items = planVisible ? await boundedRows<CanonicalPatientCases["items"][number]>(q, ITEMS, args, CASE_READ_LIMITS.items) : [];
  const dependencies = planVisible ? (await boundedRows<Omit<CanonicalPatientCases["dependencies"][number], "met" | "version"> & { requiredStatus: string; createdAt: string; rowXmin: string; rowTid: string }>(q, DEPS, [patientId], CASE_READ_LIMITS.dependencies))
    .map(({ requiredStatus, createdAt, rowXmin, rowTid, ...d }) => ({ ...d, version: planDependencyVersion({ ...d, createdAt, rowXmin, rowTid }), met: isDependencyMet(d.requirement, requiredStatus) })) : [];
  cases.sort((a, b) => b.startedOn.localeCompare(a.startedOn) || (b.id ?? 0) - (a.id ?? 0) || (b.orthoCaseId ?? 0) - (a.orthoCaseId ?? 0));
  problems.sort((a, b) => b.notedAt.localeCompare(a.notedAt) || b.id - a.id);
  items.sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000) || a.planId - b.planId || a.sortOrder - b.sortOrder || a.id - b.id);
  dependencies.sort((a, b) => a.itemId - b.itemId || a.requiresItemId - b.requiresItemId);
  const body: CanonicalPatientCases = { projection: "patient-cases-clinical", clinicTimeZone: CLINIC_TIME_ZONE, patientId, planVisible, orthoVisible, cases, problems, items, dependencies };
  if (!isCanonicalPatientCases(body, patientId)) throw new CanonicalCaseReadRefusal("case_stored_data_invalid", "تعذّر التحقق من البيانات السريرية المحفوظة؛ لم تُستبدل بقيم افتراضية.");
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BYTES) throw new CanonicalCaseReadRefusal("case_read_limit", "السجل يتجاوز حد القراءة الآمنة؛ لم تُعرض نتيجة جزئية.");
  return body;
}
export function readCanonicalPatientCases(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:patients.clinical", patientId, (q, scope) => readPatientCasesWith(q, scope, patientId), MAX_BYTES);
}
