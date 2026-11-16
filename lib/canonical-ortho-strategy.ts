import "server-only";
import { patientInDoctorScopeWith } from "./db";
import { runCanonicalReadSnapshot, type CanonicalSnapshotQuery, type CanonicalSnapshotScope } from "./canonical-read-snapshot";
import { CanonicalPatientReadRefusal } from "./canonical-patient-reads";
import { canonicalOrthoCaseId } from "./canonical-ortho-reads";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { permitsOrthoDocumentation, orthoDocumentationContext } from "./ortho-documentation-context";
import { readOrthoStrategyHistoryWith, OrthoStrategyStoreFault, type OrthoStrategyReadResult } from "./ortho-treatment-strategy-store";
import { projectStrategyRevision, type StrategyCanonicalContext, type StrategyRevision, type StrategyScope } from "./ortho-treatment-strategy";

const MAX_REFERENCES = 128;
function fail(status: number, code: string, message: string): never { throw new OrthoStrategyStoreFault(status, code, message); }
export function canonicalStrategyQuery(raw: string, params: URLSearchParams) {
  const caseId = canonicalOrthoCaseId(raw, new URLSearchParams());
  if ([...params.keys()].some(key => !["revisionId", "edit"].includes(key)) || params.getAll("revisionId").length > 1 || params.getAll("edit").length > 1 || params.has("edit") && params.get("edit") !== "1") fail(400, "invalid_query", "طلب سجل الخطة غير صالح.");
  const revisionId = params.has("revisionId") ? canonicalOrthoCaseId(params.get("revisionId")!, new URLSearchParams()) : undefined;
  return { caseId, revisionId, edit: params.get("edit") === "1" };
}
/** Read current link states only. Authored snapshots remain historical; current
 * foreign records contribute no names, sites, financial fields or other content. */
async function contextWith(q: CanonicalSnapshotQuery, scope: StrategyScope, revisions: StrategyRevision[], planVisible: boolean): Promise<StrategyCanonicalContext> {
  const problemIds = [...new Set(revisions.flatMap(r => r.rows.map(row => row.problem.id)))];
  const itemIds = [...new Set(revisions.flatMap(r => r.rows.flatMap(row => row.planItems.map(item => item.id))))];
  if (problemIds.length + itemIds.length > MAX_REFERENCES) fail(409, "strategy_reference_limit", "مراجع السجل تتجاوز حد القراءة الآمنة؛ لم يُختصر السجل.");
  const problems = problemIds.length ? (await q.query<{ id: number; patient_id: number; case_id: number | null; status: string | null }>(
    "SELECT id,patient_id,case_id,status FROM patient_problems WHERE id=ANY($1::int[])", [problemIds],
  )).rows : [];
  const items = planVisible && itemIds.length ? (await q.query<{ id: number; patient_id: number; case_id: number | null; status: string | null }>(
    "SELECT i.id,t.patient_id,i.case_id,i.status FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id WHERE i.id=ANY($1::int[])", [itemIds],
  )).rows : [];
  return { patientId: scope.patientId, orthoCase: { id: scope.orthoCaseId, patientId: scope.patientId },
    clinicalCase: { id: scope.clinicalCaseId, patientId: scope.patientId, orthoCaseId: scope.orthoCaseId },
    problems: problems.map(p => ({ id: p.id, patientId: p.patient_id, caseId: p.case_id, status: p.patient_id === scope.patientId ? p.status : null, label: "", site: null })),
    problemLookupState: "ready", planVisibility: planVisible ? "allowed" : "restricted",
    planItems: items.map(i => ({ id: i.id, patientId: i.patient_id, caseId: i.case_id, status: i.patient_id === scope.patientId ? i.status : null,
      serviceName: "", toothCode: null, caseSite: null })), clinicalWriteAllowed: false, planLinksWritable: false };
}

/** Explicit editing read only. Fetch one sentinel beyond the accepted reference
 * budget, then refuse the whole choice set; never truncate a clinical selection. */
async function editorChoices(q: CanonicalSnapshotQuery, scope: StrategyScope, plansWritable: boolean) {
  const problems = (await q.query<{ id: number; patient_id: number; case_id: number; label: string; site: string | null; status: string | null }>(
    "SELECT id,patient_id,case_id,label,site,status FROM patient_problems WHERE patient_id=$1 AND case_id=$2 ORDER BY id LIMIT $3",
    [scope.patientId, scope.clinicalCaseId, MAX_REFERENCES + 1])).rows;
  if (problems.length > MAX_REFERENCES) fail(409, "strategy_choice_limit", "خيارات التوثيق تتجاوز حد القراءة الآمنة؛ لم تُختصر القائمة. يبقى السجل المرجعي متاحًا.");
  const items = plansWritable ? (await q.query<{ id: number; patient_id: number; case_id: number; service_name: string; tooth_code: number | null; case_site: string | null; status: string | null }>(
    `SELECT i.id,t.patient_id,i.case_id,i.service_name,i.tooth_code,c.site AS case_site,i.status
     FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id JOIN clinical_cases c ON c.id=i.case_id
     WHERE t.patient_id=$1 AND c.patient_id=$1 AND i.case_id=$2 ORDER BY i.id LIMIT $3`,
    [scope.patientId, scope.clinicalCaseId, MAX_REFERENCES + 1 - problems.length])).rows : [];
  if (problems.length + items.length > MAX_REFERENCES) fail(409, "strategy_choice_limit", "خيارات التوثيق تتجاوز حد القراءة الآمنة؛ لم تُختصر القائمة. يبقى السجل المرجعي متاحًا.");
  return { problems: problems.map(p => ({ id: p.id, patientId: p.patient_id, caseId: p.case_id, label: p.label, site: p.site, status: p.status })),
    planItems: items.map(i => ({ id: i.id, patientId: i.patient_id, caseId: i.case_id, serviceName: i.service_name, toothCode: i.tooth_code, caseSite: i.case_site, status: i.status })) };
}

export async function readOrthoStrategySnapshotWith(q: CanonicalSnapshotQuery, authority: CanonicalSnapshotScope, caseId: number, revisionId?: number, edit = false): Promise<Extract<OrthoStrategyReadResult, { ok: true }>> {
  if (edit && !authority.granted("clinical.ortho.edit")) fail(403, "capability_denied", "غير مصرّح لك بتوثيق خطة هذه الحالة.");
  const found = (await q.query<{ patient_id: number; status: string }>(
    "SELECT c.patient_id,c.status FROM ortho_cases c JOIN patients p ON p.id=c.patient_id WHERE c.id=$1", [caseId],
  )).rows[0];
  if (!found || authority.patientScope.kind === "own" && !await patientInDoctorScopeWith(q, authority.patientScope.clinicianPartyId, found.patient_id)) {
    throw new CanonicalPatientReadRefusal("patient_not_found", "الحالة غير موجودة ضمن مرضاك.");
  }
  if (!permitsOrthoDocumentation(found.status)) fail(409, "unsupported_case_state", "مرحلة الحالة غير مدعومة في هذا الإصدار.");
  const bridges = (await q.query<{ id: number; patient_id: number; specialty: string }>(
    "SELECT id,patient_id,specialty FROM clinical_cases WHERE ortho_case_id=$1", [caseId],
  )).rows;
  if (bridges.length > 1 || bridges.some(b => b.patient_id !== found.patient_id || b.specialty !== "orthodontics")) fail(409, "scope_mismatch", "رابط الحالة السريري يحتاج تحققًا.");
  const planVisible = authority.granted("clinical.plans.view");
  const planLinksWritable = edit && planVisible && authority.granted("clinical.plans.edit");
  const common = { ok: true as const, patientId: found.patient_id, orthoCaseId: caseId,
    recordingContext: orthoDocumentationContext(found.status), planVisible,
    clinicalWritable: edit, planLinksWritable, canRevise: false, choices: { problems: [], planItems: [] } };
  if (!bridges.length) {
    if ((await q.query("SELECT id FROM ortho_strategy_revisions WHERE ortho_case_id=$1 LIMIT 1", [caseId])).rows.length) fail(409, "scope_mismatch", "سجل موجود فقد رابطه السريري؛ لم يُخفَ السجل.");
    if (revisionId !== undefined) fail(404, "revision_not_found", "المراجعة غير متاحة.");
    return { ...common, state: "bridge_missing", clinicalCaseId: null, revision: null, history: [] };
  }
  const scope = { patientId: found.patient_id, orthoCaseId: caseId, clinicalCaseId: bridges[0].id };
  const saved = await readOrthoStrategyHistoryWith(q, scope);
  const selected = revisionId === undefined ? saved.revisions[0] ?? null : saved.revisions.find(r => r.id === revisionId) ?? null;
  if (revisionId !== undefined && !selected) fail(404, "revision_not_found", "المراجعة غير متاحة.");
  const context = await contextWith(q, scope, saved.revisions, planVisible);
  const projected = selected ? projectStrategyRevision(selected, context) : null;
  if (projected && !projected.ok) fail(409, "invalid_stored_revision", "تعذّر التحقق من سجل الخطة؛ لم يُعتبر فارغًا.");
  const choices = edit ? await editorChoices(q, scope, planLinksWritable) : common.choices;
  const canRevise = edit && ([selected, saved.revisions[0] ?? null].every(r => !r?.rows.some(row => row.planItems.length)) || planLinksWritable);
  return { ...common, ...scope, canRevise, choices, state: "ready", revision: projected?.ok ? projected.value : null,
    history: saved.revisions.map(r => ({ revisionId: r.id, version: r.version, supersedesRevisionId: r.supersedesRevisionId,
      recordedPatientId: r.recordedPatientId, recordingContext: r.recordingContext, createdBy: r.createdBy, createdAt: r.createdAt, reason: r.reason })) };
}
export function readCanonicalOrthoStrategy(session: VerifiedDurableSession, caseId: number, revisionId?: number, edit = false) {
  return runCanonicalReadSnapshot(session, "read:ortho.strategy", (q, scope) => readOrthoStrategySnapshotWith(q, scope, caseId, revisionId, edit), { errorPrefix: "STAFF_READ", maxBytes: 8 * 1024 * 1024 });
}
