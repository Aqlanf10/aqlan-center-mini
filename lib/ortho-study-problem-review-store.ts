import type { DbClient } from "./db";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { journeyFail, type JourneyAuthority, type JourneyOwner } from "./ortho-case-journey-authority";
import { journeyClinicalSources } from "./ortho-case-journey-clinical-sources";
import { addStudySourceTargets, prepareStudyAssessmentAccess, requirePreparedAssessmentReference, type StudyAssessmentAccess } from "./ortho-case-study-assessment-access";
import { readStudyProblemReview, type StudyProblemReview } from "./ortho-study-problem-review";
import type { ProblemSourceCandidate } from "./ortho-problem-sources";

export async function readStudyProblemReviews(client: DbClient, owner: JourneyOwner, ids: readonly number[]): Promise<Map<number, StudyProblemReview>> {
  if (!ids.length) return new Map();
  const meta = (await client.query<{ bytes: string }>(`SELECT coalesce(sum(octet_length(source_snapshot::text)),0)::text bytes
    FROM ortho_problem_source_reviews WHERE id=ANY($1::int[]) AND patient_id=$2 AND ortho_case_id=$3 AND clinical_case_id=$4`,
  [ids, owner.patientId, owner.orthoCaseId, owner.clinicalCaseId])).rows[0];
  if (Number(meta.bytes) > 2097152) journeyFail(409, "study_problem_sources_budget");
  const rows = (await client.query<{ id: number; problem_id: number; problem_label: string; actor_user_id: number; created_by: string;
    created_at: Date; reason: string; supersedes_review_id: number | null; source_identity: string; source_version: string; source_snapshot: ProblemSourceCandidate }>(
    `SELECT r.id,r.problem_id,r.problem_label,r.actor_user_id,r.created_by,r.created_at,r.reason,r.supersedes_review_id,r.source_identity,r.source_version,r.source_snapshot
     FROM ortho_problem_source_reviews r JOIN patient_problems p ON p.id=r.problem_id
     WHERE r.id=ANY($1::int[]) AND r.patient_id=$2 AND r.ortho_case_id=$3 AND r.clinical_case_id=$4
       AND p.patient_id=$2 AND p.case_id=$4 ORDER BY r.id`, [ids, owner.patientId, owner.orthoCaseId, owner.clinicalCaseId])).rows;
  const result = new Map<number, StudyProblemReview>();
  for (const row of rows) {
    const source = row.source_snapshot;
    if (!source || source.identity !== row.source_identity || source.ref?.version !== row.source_version || source.available !== true
      || !source.snapshot || typeof source.snapshot !== "object") journeyFail(409, "invalid_problem_source_history");
    const assessment = source.ref.kind === "assessment_analysis" || source.ref.kind === "assessment_observation";
    // Analysis snapshots retain their selection/witness; the immutable parent
    // revision supplies its version without inferring it from the current head.
    let assessmentVersion: number | null = null;
    if (assessment) {
      const original = (await client.query<{ version: number; content_sha256: string }>(`SELECT version,content_sha256 FROM ortho_assessment_revisions
        WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3 AND clinical_case_id=$4`, [source.ref.id, owner.patientId, owner.orthoCaseId, owner.clinicalCaseId])).rows[0];
      if (!original || `sha256:${original.content_sha256}` !== source.ref.version) journeyFail(403, "study_problem_assessment_unavailable");
      assessmentVersion = original.version;
    }
    try {
      const value = readStudyProblemReview({ schemaVersion: 1, id: row.id, patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId,
        problemId: row.problem_id, problemLabelAtReview: row.problem_label, actorId: row.actor_user_id, reviewedBy: row.created_by,
        reviewedAt: row.created_at.toISOString(), reason: row.reason, supersedesReviewId: row.supersedes_review_id,
        source: { ref: source.ref, identity: source.identity, title: source.title, category: source.category, summary: source.summary, site: source.site,
          recordedBy: source.sourceActor, recordedAt: source.sourceDate, requiresImages: source.requiresImages, assessmentVersion, snapshotHash: journeyContentHash(source) } }, owner);
      result.set(row.id, value);
    } catch { journeyFail(409, "invalid_problem_source_history"); }
  }
  return result;
}
export async function prepareStudyProblemReviewAccess(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority,
  reviews: readonly StudyProblemReview[], cache: StudyAssessmentAccess) {
  if (reviews.some(r => r.source.requiresImages) && !authority.canViewImages) journeyFail(403, "study_problem_images_restricted");
  const assessments = reviews.filter(r => r.source.assessmentVersion !== null);
  if (assessments.length) {
    const clinical = await journeyClinicalSources(client, owner, authority, ["assessment"], cache, true);
    const selected = assessments.map(({ source }) => {
      const revision = clinical.assessments.find(r => r.id === source.ref.id && r.version === source.assessmentVersion && `sha256:${r.contentHash}` === source.ref.version);
      if (!revision) journeyFail(403, "study_problem_assessment_unavailable"); return revision;
    });
    await prepareStudyAssessmentAccess(client, owner, authority, selected, cache);
  }
  addStudySourceTargets(cache, reviews.flatMap(r => r.source.ref.kind === "ceph_diagnosis" ? [{ kind: "ceph_study" as const, id: r.source.ref.id }] : []));
}
export async function requireStudyProblemReviewRead(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority,
  review: StudyProblemReview, cache: StudyAssessmentAccess) {
  const current = (await readStudyProblemReviews(client, owner, [review.id])).get(review.id);
  if (!current || journeyContentHash(current) !== journeyContentHash(review)) journeyFail(403, "study_problem_review_unavailable");
  if (review.source.requiresImages && !authority.canViewImages) journeyFail(403, "study_problem_images_restricted");
  const source = review.source;
  if (source.assessmentVersion !== null) {
    requirePreparedAssessmentReference(cache, { id: source.ref.id, version: source.assessmentVersion, contentHash: source.ref.version.slice(7) }, authority, false);
  } else if (source.ref.kind === "ceph_diagnosis") {
    if (!cache.current?.has(`ceph_study:${source.ref.id}`)) journeyFail(403, "study_problem_ceph_unavailable");
    const row = (await client.query("SELECT id FROM ceph_analyses WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3 AND status<>'discarded'", [source.ref.id, owner.patientId, owner.orthoCaseId])).rows[0];
    if (!row) journeyFail(403, "study_problem_ceph_unavailable");
  } else {
    const row = (await client.query("SELECT id FROM patient_diagnoses WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3", [source.ref.id, owner.patientId, owner.orthoCaseId])).rows[0];
    if (!row) journeyFail(403, "study_problem_diagnosis_unavailable");
  }
}
