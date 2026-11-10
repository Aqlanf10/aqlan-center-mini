import type { DbClient } from "./db";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { journeyId } from "./ortho-case-journey-records";
import { journeyFail, type JourneyAuthority, type JourneyOwner } from "./ortho-case-journey-authority";
import { journeyClinicalSources } from "./ortho-case-journey-clinical-sources";
import { addStudySourceTargets, prepareStudyAssessmentAccess, requirePreparedAssessmentReference, type StudyAssessmentAccess } from "./ortho-case-study-assessment-access";
import { readFacialRevision } from "./ortho-facial-records";
import { problemSourceIdentity, readProblemSourceRef, type ProblemSourceCandidate } from "./ortho-problem-sources";
import { readStudyProblemReview, type StudyProblemReview } from "./ortho-study-problem-review";

/** Immutable discovery only. The caller locks the complete external union and
 * then rechecks current ownership before exposing or persisting the capture. */
export async function readStudyProblemReviews(client: DbClient, owner: JourneyOwner, selectedIds: readonly number[]) {
  const result = new Map<number, StudyProblemReview>(), ids = [...new Set(selectedIds)];
  if (!ids.length) return result;
  if (ids.length > 500 || ids.some(id => !journeyId(id))) journeyFail(409, "study_problem_sources_budget");
  const meta = (await client.query<{ bytes: string }>(`SELECT coalesce(sum(octet_length(source_snapshot::text)),0)::text bytes
    FROM ortho_problem_source_reviews WHERE id=ANY($1::int[]) AND patient_id=$2 AND ortho_case_id=$3 AND clinical_case_id=$4`,
  [ids, owner.patientId, owner.orthoCaseId, owner.clinicalCaseId])).rows[0];
  if (!meta || !/^\d+$/.test(meta.bytes) || BigInt(meta.bytes) > 2097152n) journeyFail(409, "study_problem_sources_budget");
  const rows = (await client.query<{ id: number; problem_id: number; problem_label: string; actor_user_id: number; created_by: string;
    created_at: Date; reason: string; supersedes_review_id: number | null; source_identity: string; source_version: string; source_snapshot: ProblemSourceCandidate }>(
    `SELECT r.id,r.problem_id,r.problem_label,r.actor_user_id,r.created_by,r.created_at,r.reason,r.supersedes_review_id,r.source_identity,r.source_version,r.source_snapshot
     FROM ortho_problem_source_reviews r JOIN patient_problems p ON p.id=r.problem_id
     WHERE r.id=ANY($1::int[]) AND r.patient_id=$2 AND r.ortho_case_id=$3 AND r.clinical_case_id=$4
       AND p.patient_id=$2 AND p.case_id=$4 AND p.specialty='orthodontics' ORDER BY r.id`,
  [ids, owner.patientId, owner.orthoCaseId, owner.clinicalCaseId])).rows;
  for (const row of rows) {
    const source = row.source_snapshot, ref = readProblemSourceRef(source?.ref);
    if (!ref || !ids.includes(row.id) || result.has(row.id) || source.identity !== row.source_identity
      || problemSourceIdentity(ref) !== row.source_identity || ref.version !== row.source_version || source.available !== true
      || !source.snapshot || typeof source.snapshot !== "object" || Array.isArray(source.snapshot)) journeyFail(409, "invalid_problem_source_history");
    let assessmentVersion: number | null = null;
    if (ref.kind === "assessment_analysis" || ref.kind === "assessment_observation") {
      const original = (await client.query<{ version: number; content_sha256: string }>(`SELECT version,content_sha256 FROM ortho_assessment_revisions
        WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3 AND clinical_case_id=$4`, [ref.id, owner.patientId, owner.orthoCaseId, owner.clinicalCaseId])).rows[0];
      if (!original || `sha256:${original.content_sha256}` !== ref.version) journeyFail(403, "study_problem_assessment_unavailable");
      assessmentVersion = original.version;
    }
    let facialDocument: StudyProblemReview["source"]["facialDocument"];
    try {
      if (ref.kind === "facial_review") {
        const snapshot = source.snapshot as { revision?: unknown };
        const stored = snapshot.revision as { patientId?: unknown } | undefined;
        if (!journeyId(stored?.patientId)) throw Error("invalid_facial_review");
        // A patient merge may change the live FK. The original review/hash is retained.
        const facial = readFacialRevision(stored, { patientId: stored.patientId, orthoCaseId: owner.orthoCaseId });
        if (facial.id !== ref.id || facial.clinicalCaseId !== owner.clinicalCaseId
          || `sha256:${journeyContentHash(facial)}` !== ref.version
          || journeyContentHash(facial.command) !== facial.requestFingerprint
          || journeyContentHash({ content: facial.command.content, results: facial.results }) !== facial.contentHash
          || facial.command.content.review.state !== "reviewed" || !facial.command.content.review.note.trim()
          || source.summary !== facial.command.content.review.note) throw Error("invalid_facial_review");
        facialDocument = { id: facial.documentId, sha256: facial.command.content.image.sha256 };
      }
      const value = readStudyProblemReview({ schemaVersion: 1, id: row.id, patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId,
        problemId: row.problem_id, problemLabelAtReview: row.problem_label, actorId: row.actor_user_id, reviewedBy: row.created_by,
        reviewedAt: row.created_at.toISOString(), reason: row.reason, supersedesReviewId: row.supersedes_review_id,
        source: { ref, identity: source.identity, title: source.title, category: source.category, summary: source.summary, site: source.site,
          recordedBy: source.sourceActor, recordedAt: source.sourceDate, requiresImages: source.requiresImages, assessmentVersion,
          snapshotHash: journeyContentHash(source), ...(facialDocument ? { facialDocument } : {}) } }, owner);
      result.set(row.id, value);
    } catch { journeyFail(409, "invalid_problem_source_history"); }
  }
  return result;
}

export async function prepareStudyProblemReviewAccess(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority,
  reviews: readonly StudyProblemReview[], cache: StudyAssessmentAccess) {
  if (reviews.some(review => review.source.requiresImages) && !authority.canViewImages) journeyFail(403, "study_problem_images_restricted");
  const assessments = reviews.filter(review => review.source.assessmentVersion !== null);
  if (assessments.length) {
    const clinical = await journeyClinicalSources(client, owner, authority, ["assessment"], cache, true);
    const selected = assessments.map(({ source }) => {
      const revision = clinical.assessments.find(r => r.id === source.ref.id && r.version === source.assessmentVersion && `sha256:${r.contentHash}` === source.ref.version);
      if (!revision) journeyFail(403, "study_problem_assessment_unavailable"); return revision;
    });
    await prepareStudyAssessmentAccess(client, owner, authority, selected, cache);
  }
  addStudySourceTargets(cache, reviews.flatMap(({ source }) => source.ref.kind === "ceph_diagnosis"
    ? [{ kind: "ceph_study" as const, id: source.ref.id }] : []));
  addStudySourceTargets(cache, reviews.flatMap(({ source }) => source.facialDocument
    ? [{ kind: "document" as const, id: source.facialDocument.id }] : []));
}

/** Read access follows the current case/problem/source. The saved label and
 * observation stay historical even when newer clinical reviews exist. */
export async function requireStudyProblemReviewRead(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority,
  review: StudyProblemReview, cache: StudyAssessmentAccess): Promise<boolean> {
  const current = (await readStudyProblemReviews(client, owner, [review.id])).get(review.id);
  if (!current || journeyContentHash({ ...current, patientId: review.patientId }) !== journeyContentHash(review)) journeyFail(403, "study_problem_review_unavailable");
  if (review.source.requiresImages && !authority.canViewImages) journeyFail(403, "study_problem_images_restricted");
  const source = review.source;
  if (source.assessmentVersion !== null) {
    return requirePreparedAssessmentReference(cache, { id: source.ref.id, version: source.assessmentVersion, contentHash: source.ref.version.slice(7) }, authority, false)
      || source.requiresImages;
  }
  if (source.ref.kind === "ceph_diagnosis") {
    if (!cache.current?.has(`ceph_study:${source.ref.id}`)) journeyFail(403, "study_problem_ceph_unavailable");
    const row = (await client.query("SELECT id FROM ceph_analyses WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3 AND status<>'discarded'", [source.ref.id, owner.patientId, owner.orthoCaseId])).rows[0];
    if (!row) journeyFail(403, "study_problem_ceph_unavailable");
  } else if (source.ref.kind === "facial_review") {
    const doc = source.facialDocument!;
    if (!cache.current?.has(`document:${doc.id}`)) journeyFail(403, "study_problem_facial_unavailable");
    const row = (await client.query(`SELECT f.id FROM ortho_facial_revisions f JOIN patient_documents d ON d.id=f.document_id
      WHERE f.id=$1 AND f.patient_id=$2 AND f.ortho_case_id=$3 AND f.clinical_case_id=$4
        AND d.id=$5 AND d.patient_id=$2 AND d.ortho_case_id=$3 AND d.sha256=$6 AND d.removed_at IS NULL
        AND (d.photo_stage IS NULL OR d.photo_stage<>'archived') AND d.photo_view='extraoral_frontal'`,
    [source.ref.id, owner.patientId, owner.orthoCaseId, owner.clinicalCaseId, doc.id, doc.sha256])).rows[0];
    if (!row) journeyFail(403, "study_problem_facial_unavailable");
  } else {
    const row = (await client.query("SELECT id FROM patient_diagnoses WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3", [source.ref.id, owner.patientId, owner.orthoCaseId])).rows[0];
    if (!row) journeyFail(403, "study_problem_diagnosis_unavailable");
  }
  return source.requiresImages;
}
