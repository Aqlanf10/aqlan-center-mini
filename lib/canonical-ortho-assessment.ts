import "server-only";
import { patientInDoctorScopeWith } from "./db";
import { runCanonicalReadSnapshot, type CanonicalSnapshotQuery, type CanonicalSnapshotScope } from "./canonical-read-snapshot";
import { CanonicalPatientReadRefusal, PATIENT_CARE_CAPABILITIES } from "./canonical-patient-reads";
import { canonicalOrthoCaseId } from "./canonical-ortho-reads";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assessmentFail } from "./ortho-assessment-authority";
import { permitsOrthoDocumentation, orthoDocumentationContext } from "./ortho-documentation-context";
import { readOrthoAssessmentHistoryWith } from "./ortho-assessment-store";
import { collectAssessmentSourceClosure, readAssessmentExternalSourcesWith, assessmentSourceStates } from "./ortho-assessment-versioned-sources";
import { assessmentRevisionSources } from "./ortho-assessment-persisted-v2";
import { ASSESSMENT_HISTORY_MAX_BYTES } from "./ortho-assessment-limits";
import type { AssessmentReadResponseV2, AssessmentScope } from "./ortho-assessment-response-v2";
import type { AssessmentSourceV2 } from "./ortho-assessment-v2";

export function canonicalAssessmentQuery(raw: string, params: URLSearchParams) {
  const caseId = canonicalOrthoCaseId(raw, new URLSearchParams());
  if ([...params.keys()].some(key => !["acceptSchema", "revisionId"].includes(key) || params.getAll(key).length !== 1)) {
    assessmentFail(400, "invalid_query", "طلب التقييم غير صالح.");
  }
  if (!["2", "1,2"].includes(params.get("acceptSchema") ?? "")) assessmentFail(409, "schema_negotiation_required", "يلزم قارئ يدعم الإصدار الثاني؛ لم يُعتبر السجل فارغًا.");
  const revisionId = params.has("revisionId") ? canonicalOrthoCaseId(params.get("revisionId")!, new URLSearchParams()) : undefined;
  return { caseId, revisionId };
}

/** Same-snapshot clinical data read. Nothing in this function grants mutation or
 * uses the legacy authority, source-picker or transaction-owning reader. */
export async function readOrthoAssessmentSnapshotWith(q: CanonicalSnapshotQuery, authority: CanonicalSnapshotScope, caseId: number, revisionId?: number): Promise<AssessmentReadResponseV2> {
  const found = (await q.query<{ patient_id: number; status: string }>(
    "SELECT c.patient_id,c.status FROM ortho_cases c JOIN patients p ON p.id=c.patient_id WHERE c.id=$1", [caseId],
  )).rows[0];
  if (!found || authority.patientScope.kind === "own" && !await patientInDoctorScopeWith(q, authority.patientScope.clinicianPartyId, found.patient_id)) {
    throw new CanonicalPatientReadRefusal("patient_not_found", "الحالة غير موجودة ضمن مرضاك.");
  }
  if (!permitsOrthoDocumentation(found.status)) assessmentFail(409, "unsupported_case_state", "مرحلة الحالة غير مدعومة في هذا الإصدار.");
  const bridges = (await q.query<{ id: number; patient_id: number; specialty: string }>(
    "SELECT id,patient_id,specialty FROM clinical_cases WHERE ortho_case_id=$1", [caseId],
  )).rows;
  if (bridges.length > 1 || bridges.some(b => b.patient_id !== found.patient_id || b.specialty !== "orthodontics")) assessmentFail(409, "scope_mismatch", "رابط الحالة السريري يحتاج تحققًا.");
  const imaging = authority.granted("clinical.xrays.view");
  const care = PATIENT_CARE_CAPABILITIES.some(capability => authority.granted(capability));
  const common = { ok: true as const, representation: 2 as const, patientId: found.patient_id, orthoCaseId: caseId,
    recordingContext: orthoDocumentationContext(found.status), clinicalWritable: false };
  if (!bridges.length) {
    if ((await q.query("SELECT id FROM ortho_assessment_revisions WHERE ortho_case_id=$1 LIMIT 1", [caseId])).rows.length) assessmentFail(409, "scope_mismatch", "سجل موجود فقد رابطه السريري؛ لم يُخفَ السجل.");
    if (revisionId !== undefined) assessmentFail(404, "revision_not_found", "المراجعة غير متاحة.");
    return { ...common, state: "bridge_missing", clinicalCaseId: null, revision: null, history: [], sourceStates: [], sources: { items: [], truncated: false, imaging: imaging ? "allowed" : "restricted" } };
  }
  const scope: AssessmentScope = { patientId: found.patient_id, orthoCaseId: caseId, clinicalCaseId: bridges[0].id };
  const saved = await readOrthoAssessmentHistoryWith(q, scope);
  const selected = revisionId === undefined ? saved.revisions[0] ?? null : saved.revisions.find(r => r.id === revisionId) ?? null;
  if (revisionId !== undefined && !selected) assessmentFail(404, "revision_not_found", "المراجعة غير متاحة.");
  // History includes native reasons. Do not leak a restricted ancestor via history
  // or an older revisionId. Check every graph, including copied observations.
  const closures = new Map<number, Awaited<ReturnType<typeof collectAssessmentSourceClosure>>>();
  const union = new Map<string, Pick<AssessmentSourceV2, "kind" | "id">>();
  for (const revision of saved.revisions) {
    const closure = await collectAssessmentSourceClosure(q, scope, assessmentRevisionSources(revision));
    if ([...closure.revisions.values()].some(r => r.version >= revision.version)) assessmentFail(409, "future_assessment_source", "تسلسل مراجع التقييم غير صالح.");
    for (const source of closure.external) {
      if ((source.kind === "document" || source.kind === "ceph_study") ? !imaging : !care) assessmentFail(403, "source_restricted", "التقييم أو مصادره محجوبة بالصلاحية الحالية.");
      union.set(`${source.kind}:${source.id}`, { kind: source.kind, id: source.id });
      if (union.size > 128) assessmentFail(409, "source_reference_limit", "مراجع السجل تتجاوز حد القراءة الآمنة؛ لم يُختصر السجل.");
    }
    closures.set(revision.id, closure);
  }
  const current = await readAssessmentExternalSourcesWith(q, scope, [...union.values()]);
  // Removed/changed sources still owned by this patient retain historical evidence;
  // a missing/foreign source cannot establish current ownership. Never erase or
  // rewrite the historical content to make the read succeed.
  if ([...union.keys()].some(key => !current.historicallyReadable.has(key))) assessmentFail(403, "source_restricted", "التقييم أو مصادره محجوبة بالصلاحية الحالية.");
  const closure = selected ? closures.get(selected.id)! : { external: [], revisions: new Map() };
  return { ...common, ...scope, state: "ready", revision: selected,
    history: saved.revisions.map(r => ({ schemaVersion: r.schemaVersion, id: r.id, version: r.version, supersedesRevisionId: r.supersedesRevisionId, recordedPatientId: r.recordedPatientId,
      recordingContext: r.recordingContext, createdBy: r.createdBy, createdAt: r.createdAt, reason: r.reason })),
    sourceStates: assessmentSourceStates(closure, current),
    // No editing choices are admitted by this read-only slice. Explicitly incomplete
    // hints, rather than a claim that the patient has no potential source records.
    sources: { items: [], truncated: true, imaging: imaging ? "allowed" : "restricted" },
  };
}
export function readCanonicalOrthoAssessment(session: VerifiedDurableSession, caseId: number, revisionId?: number) {
  return runCanonicalReadSnapshot(session, "read:ortho.assessment", (q, scope) => readOrthoAssessmentSnapshotWith(q, scope, caseId, revisionId), { errorPrefix: "STAFF_READ", maxBytes: ASSESSMENT_HISTORY_MAX_BYTES });
}
