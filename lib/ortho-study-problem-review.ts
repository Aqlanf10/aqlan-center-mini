import { journeyHash, journeyId, type JourneyScope } from "./ortho-case-journey-records";
import { problemSourceIdentity, readProblemSourceRef, type ProblemSourceRef } from "./ortho-problem-sources";

/** Immutable documentary description of an explicit clinician review. Full
 * measurement witnesses remain in the original, hash-addressed source record. */
export interface StudyProblemReview {
  schemaVersion: 1; id: number; patientId: number; orthoCaseId: number; clinicalCaseId: number;
  problemId: number; problemLabelAtReview: string; actorId: number; reviewedBy: string; reviewedAt: string;
  reason: string; supersedesReviewId: number | null;
  source: { ref: ProblemSourceRef; identity: string; title: string; category: string; summary: string;
    site: string | null; recordedBy: string; recordedAt: string; requiresImages: boolean;
    assessmentVersion: number | null; snapshotHash: string };
}
function object(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("invalid_study_problem_review");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw Error("invalid_study_problem_review_fields");
  return value;
}
function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && value.length <= max && (empty || !!value.trim());
}
export function readStudyProblemReview(raw: unknown, scope: JourneyScope): StudyProblemReview {
  const r = object(raw, ["schemaVersion", "id", "patientId", "orthoCaseId", "clinicalCaseId", "problemId", "problemLabelAtReview",
    "actorId", "reviewedBy", "reviewedAt", "reason", "supersedesReviewId", "source"]);
  const s = object(r.source, ["ref", "identity", "title", "category", "summary", "site", "recordedBy", "recordedAt", "requiresImages", "assessmentVersion", "snapshotHash"]);
  const ref = readProblemSourceRef(s.ref), assessment = ref?.kind === "assessment_observation" || ref?.kind === "assessment_analysis";
  if (r.schemaVersion !== 1 || r.patientId !== scope.patientId || r.orthoCaseId !== scope.orthoCaseId || r.clinicalCaseId !== scope.clinicalCaseId
    || !journeyId(r.id) || !journeyId(r.problemId) || !journeyId(r.actorId)
    || !text(r.problemLabelAtReview, 2000) || !text(r.reviewedBy, 4000, true) || !text(r.reason, 1000)
    || !text(r.reviewedAt, 100) || !Number.isFinite(Date.parse(r.reviewedAt))
    || r.supersedesReviewId !== null && (!journeyId(r.supersedesReviewId) || r.supersedesReviewId >= r.id)
    || !ref || s.identity !== problemSourceIdentity(ref) || !text(s.title, 4000, true) || !text(s.category, 4000, true)
    || !text(s.summary, 20000, true) || s.site !== null && !text(s.site, 1000, true)
    || !text(s.recordedBy, 4000, true) || !text(s.recordedAt, 100, true) || typeof s.requiresImages !== "boolean"
    || ref.kind === "ceph_diagnosis" && !s.requiresImages || !journeyHash(s.snapshotHash)
    || (assessment ? !journeyId(s.assessmentVersion) : s.assessmentVersion !== null)) throw Error("invalid_study_problem_review");
  return raw as StudyProblemReview;
}
