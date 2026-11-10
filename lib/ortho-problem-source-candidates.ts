import type { DbClient } from "./db";
import type { JourneyAuthority, JourneyOwner } from "./ortho-case-journey-authority";
import { journeyFail } from "./ortho-case-journey-authority";
import { AssessmentStoreFault } from "./ortho-assessment-authority";
import { ASSESSMENT_COLUMNS, captureAssessmentExternalSources, collectAssessmentSourceClosure, decodeAssessmentStoredRow, assessmentSourceStates, type AssessmentStoredRow } from "./ortho-assessment-versioned-sources";
import { assessmentRevisionSources } from "./ortho-assessment-persisted-v2";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { problemSourceIdentity, type ProblemSourceCandidate, type ProblemSourceRef } from "./ortho-problem-sources";
import { readPanoramicFindingId } from "./ortho-panoramic-findings";
import { readCurrentStudyCephProvenance } from "./ortho-case-study-sources";
import { discoverFacialProblemSources, readFacialProblemSources } from "./ortho-problem-facial-sources";
import { DIAGNOSIS_FIELDS } from "./diagnosis";

const MAX_SOURCE_BYTES = 262144;
function admit(bytes: unknown) { const n = Number(bytes); if (!Number.isSafeInteger(n) || n < 0 || n > MAX_SOURCE_BYTES) journeyFail(409, "problem_source_budget", "حجم المصدر يتطلب قراءة مخصصة؛ لم يُعتبر فارغاً."); }
const date = (v: Date | string) => v instanceof Date ? v.toISOString() : v;
const siteOf = (target: { kind: string; tooth?: number; arch?: string; side?: string }) => target.kind === "tooth" ? `FDI ${target.tooth}` : target.kind === "arch" ? (target.arch === "upper" ? "الفك العلوي" : "الفك السفلي") : target.side ? target.side : null;
/** Current sources under a held patient/access lock. Every candidate retains its
 * source revision; no labels or interpretation are synthesized from numbers. */
export async function readProblemSourceCandidates(client: DbClient, scope: JourneyOwner, actor: JourneyAuthority): Promise<ProblemSourceCandidate[]> {
  // recordPatientDiagnosis owns this existing patient-wide namespace before
  // locking the case/latest diagnosis. Join it before source locks so a review
  // cannot select an obsolete head or invert that writer's case/diagnosis order.
  await client.query("SELECT pg_advisory_xact_lock(73127, $1::int)", [scope.patientId]);
  const out: ProblemSourceCandidate[] = [];
  const add = (ref: ProblemSourceRef, rest: Omit<ProblemSourceCandidate, "identity" | "ref">) => out.push({ identity: problemSourceIdentity(ref), ref, ...rest });
  try {
    const studies = actor.canViewImages ? (await client.query<{ id: number }>("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND ortho_case_id=$2 AND status<>'discarded' ORDER BY id LIMIT 51", [scope.patientId, scope.orthoCaseId])).rows : [];
    if (studies.length > 50) journeyFail(409, "problem_source_budget");
    const facial = actor.canViewImages ? await discoverFacialProblemSources(client, scope) : [];
    const facialSources = facial.map(r => ({ kind: "document" as const, id: Number(r.document_id) }));
    let capture: Awaited<ReturnType<typeof captureAssessmentExternalSources>> | null = null;
    const cephSources = studies.map(s => ({kind:"ceph_study" as const,id:Number(s.id)}));
    const meta = (await client.query<{ id: number; bytes: number }>("SELECT id,octet_length(content::text) AS bytes FROM ortho_assessment_revisions WHERE patient_id=$1 AND ortho_case_id=$2 ORDER BY version DESC LIMIT 1", [scope.patientId, scope.orthoCaseId])).rows[0];
    if (meta) {
      if (actor.session.role !== "admin" && actor.session.role !== "doctor") journeyFail(403, "problem_assessment_clinical_restricted");
      admit(meta.bytes);
      const row = (await client.query<AssessmentStoredRow>(`SELECT ${ASSESSMENT_COLUMNS} FROM ortho_assessment_revisions WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3`, [meta.id, scope.patientId, scope.orthoCaseId])).rows[0];
      const revision = decodeAssessmentStoredRow(row, scope);
      if (revision.schemaVersion !== 2) journeyFail(409, "unsupported_assessment_source");
      const direct = assessmentRevisionSources(revision), closure = await collectAssessmentSourceClosure(client, scope, direct);
      const requiresImages = closure.external.some(s => s.kind === "document" || s.kind === "ceph_study");
      if (requiresImages && !actor.canViewImages) journeyFail(403, "problem_images_restricted");
      // Lock the complete external union once, documents before ceph/visits.
      capture = await captureAssessmentExternalSources(client, scope, [...closure.external,...cephSources,...facialSources], actor.canViewImages);
      const graph = {states:assessmentSourceStates(closure,capture)};
      const available = graph.states.every(s => s.state === "available"), version = `sha256:${revision.contentHash}`;
      for (const observation of revision.content.draft.observations.observations) {
        if (observation.definition === "dentition" || !["recorded", "measured", "tooth_absent", "not_erupted"].includes(observation.value.state)) continue;
        const panoramic = readPanoramicFindingId(observation.id);
        const recorded = observation.value.state === "recorded" ? observation.value.text : null;
        const summary = observation.value.state === "measured" ? `${observation.value.value} ${observation.unit}` : recorded ?? (observation.value.state === "tooth_absent" ? "السن مسجل كغائب" : "السن مسجل كغير بازغ");
        add({ kind: "assessment_observation", id: revision.id, member: observation.id, version }, {
          category: panoramic ? "قراءة بانوراما" : observation.value.state === "measured" ? "قياس يحتاج تفسير الطبيب" : "ملاحظة فحص محفوظة",
          title: observation.label, summary, proposedLabel: recorded, site: siteOf(observation.target), target: observation.target,
          snapshot: { observation, revisionVersion: revision.version, sourceStates: graph.states }, sourceActor: revision.createdBy, sourceDate: revision.createdAt, available, requiresImages,
        });
      }
      for (const result of revision.content.results) {
        if (result.result.state !== "ready" || result.result.witness.result.state !== "calculated") continue;
        const selection = revision.content.draft.analyses.find(a => a.id === result.analysisId)!;
        const target = "arch" in selection ? { kind: "arch", arch: selection.arch } : { kind: "case" };
        const arithmetic = result.result.witness.result;
        const numeric = (value: number) => Number(value.toFixed(3));
        const summary = arithmetic.method === "arch_space"
          ? `المتاح: ${numeric(arithmetic.availableMm)} mm · المطلوب: ${numeric(arithmetic.requiredMm)} mm · المتاح ناقص المطلوب: ${numeric(arithmetic.availableMinusRequiredMm)} mm`
          : arithmetic.method === "tanaka_johnston_1974_approximation_v1"
            ? `تقدير Tanaka–Johnston: القواطع السفلية المقاسة ${numeric(arithmetic.measuredLowerIncisorSumMm)} mm · قواطع الفك المقاسة ${numeric(arithmetic.measuredTargetIncisorSumMm)} mm · تقدير الناب والضاحكين لكل جهة ${numeric(arithmetic.predictedCaninePremolarPerQuadrantMm)} mm · المتاح المقاس ${numeric(arithmetic.measuredAvailableMm)} mm · المطلوب المقدّر ${numeric(arithmetic.estimatedRequiredMm)} mm · المتاح ناقص المقدّر ${numeric(arithmetic.availableMinusEstimatedRequiredMm)} mm · ملاءمة المرجع للمريض غير معتمدة`
          : `مجموع العلوي: ${numeric(arithmetic.upperMm)} mm · مجموع السفلي: ${numeric(arithmetic.lowerMm)} mm · نسبة السفلي إلى العلوي: ${numeric(arithmetic.ratioPercent)}%`;
        add({ kind: "assessment_analysis", id: revision.id, member: result.analysisId, version }, {
          category: "نتيجة حسابية تحتاج تفسير الطبيب", title: selection.method === "arch_space" ? "تحليل المسافة" : selection.method === "tanaka_johnston_1974" ? "تقدير المسافة المختلطة Tanaka–Johnston" : selection.method === "bolton_anterior" ? "بولتون الأمامي" : "بولتون الكلي", summary, proposedLabel: null,
          site: siteOf(target), target, snapshot: { selection, result, observations: revision.content.draft.observations.observations.filter(o => result.result.dependencyObservationIds.includes(o.id)) },
          sourceActor: revision.createdBy, sourceDate: revision.createdAt, available, requiresImages,
        });
      }
    }
    const dm = (await client.query<{ id: number; bytes: number }>("SELECT id,octet_length(content::text) AS bytes FROM patient_diagnoses WHERE patient_id=$1 AND ortho_case_id=$2 ORDER BY id DESC LIMIT 1", [scope.patientId, scope.orthoCaseId])).rows[0];
    if (dm) {
      admit(dm.bytes);
      const dx = (await client.query<{ id: number; content: Record<string, unknown>; version: number; created_by: string; created_at: Date }>("SELECT id,content,version,created_by,created_at FROM patient_diagnoses WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3 FOR SHARE", [dm.id, scope.patientId, scope.orthoCaseId])).rows[0];
      if (!dx || !dx.content || typeof dx.content !== "object" || Array.isArray(dx.content)) journeyFail(409, "invalid_diagnosis_source");
      const version = `sha256:${journeyContentHash({ ...dx, created_at: date(dx.created_at) })}`;
      for (const field of DIAGNOSIS_FIELDS()) {
        const text = dx.content[field.key]; if (text === null || text === undefined || text === "") continue;
        if (typeof text !== "string" || text.length > 2000) journeyFail(409, "invalid_diagnosis_source");
        add({ kind: "clinical_diagnosis", id: dx.id, member: field.key, version }, { category: "تشخيص سريري محفوظ", title: field.label, summary: text,
          proposedLabel: text, site: null, target: { kind: "case" }, snapshot: { field: field.key, text, revisionVersion: dx.version }, sourceActor: dx.created_by, sourceDate: date(dx.created_at), available: true, requiresImages: false });
      }
    }
    // An unassigned historical cephalogram is never silently attached to a case.
    if (actor.canViewImages) {
      capture ??= await captureAssessmentExternalSources(client, scope, [...cephSources,...facialSources], true);
      out.push(...await readFacialProblemSources(client, scope, facial));
      for (const study of studies) {
        const source = capture.get(`ceph_study:${study.id}`); if (!source) continue;
        const row = (await client.query<Record<string, unknown>>("SELECT patient_id,document_id,status,ref_set,cal_x1,cal_y1,cal_x2,cal_y2,cal_mm,mm_per_pixel FROM ceph_analyses WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3", [study.id,scope.patientId,scope.orthoCaseId])).rows[0];
        if (!row) continue;
        const { provenance, diagnoses } = await readCurrentStudyCephProvenance(client, Number(study.id), row);
        // Draft and legacy interpretations have no independently checkable completion
        // evidence. They never enter the reviewed-problem candidate workflow.
        if (provenance.state !== "versioned" || provenance.witness.schemaVersion !== 2) continue;
        const dx = diagnoses[0];
        const witnessedSource = { ...source, version: `sha256:${journeyContentHash({source, completion:provenance.witnessSha256})}` };
        if (!dx) continue;
        for (const [member, title] of [["skeletal", "الهيكلي"], ["dental", "السني"], ["soft_tissue", "الأنسجة الرخوة"], ["final_dx", "خلاصة التشخيص"], ["note", "الملاحظة"]]) {
          const value = dx[member]; if (value === null || value === "") continue;
          if (typeof value !== "string" || value.length > 4000) journeyFail(409, "invalid_ceph_diagnosis_source");
          add({ kind: "ceph_diagnosis", id: Number(study.id), member, version: witnessedSource.version }, { category: "تفسير سيفالو محفوظ يحتاج مراجعة الطبيب", title: `سيفالو #${study.id} · ${title}`,
            summary: value, proposedLabel: value.length <= 2000 ? value : null, site: null, target: { kind: "case" }, snapshot: { studyId: Number(study.id), field: member, text: value, source: witnessedSource, completionWitnessSha256: provenance.witnessSha256 },
            sourceActor: String(dx.created_by ?? "غير معلوم"), sourceDate: dx.updated_at instanceof Date ? dx.updated_at.toISOString() : String(dx.updated_at ?? ""), available: true, requiresImages: true });
        }
      }
    }
    if (out.length > 512 || Buffer.byteLength(JSON.stringify(out)) > 2097152) journeyFail(409, "problem_source_budget");
    return out;
  } catch (error) {
    if (error instanceof AssessmentStoreFault) journeyFail(error.status, error.code, error.message);
    throw error;
  }
}
