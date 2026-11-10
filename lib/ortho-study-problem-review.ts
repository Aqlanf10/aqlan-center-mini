import { journeyHash, journeyId, type JourneyScope } from "./ortho-case-journey-records";
import { problemSourceIdentity, readProblemSourceRef, type ProblemSourceRef } from "./ortho-problem-sources";

/** A saved clinician review, never a fresh diagnosis or a live problem label. */
export interface StudyProblemReview extends JourneyScope {
  schemaVersion: 1; id: number; problemId: number; problemLabelAtReview: string;
  actorId: number; reviewedBy: string; reviewedAt: string; reason: string; supersedesReviewId: number | null;
  source: {
    ref: ProblemSourceRef; identity: string; title: string; category: string; summary: string;
    site: string | null; recordedBy: string; recordedAt: string; requiresImages: boolean;
    assessmentVersion: number | null; snapshotHash: string;
    /** Facial reviews pin the original document; other historical codecs are unchanged. */
    facialDocument?: { id: number; sha256: string };
  };
}
function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key))) throw Error("invalid_study_problem_review_fields");
  return raw as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && value.length <= max && (empty || !!value.trim())
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value);
}
export function readStudyProblemReview(raw: unknown, scope: JourneyScope): StudyProblemReview {
  const r = object(raw, ["schemaVersion", "id", "patientId", "orthoCaseId", "clinicalCaseId", "problemId", "problemLabelAtReview",
    "actorId", "reviewedBy", "reviewedAt", "reason", "supersedesReviewId", "source"]);
  const facial = !!r.source && typeof r.source === "object" && Object.hasOwn(r.source, "facialDocument");
  const s = object(r.source, ["ref", "identity", "title", "category", "summary", "site", "recordedBy", "recordedAt", "requiresImages", "assessmentVersion", "snapshotHash", ...(facial ? ["facialDocument"] : [])]);
  const ref = readProblemSourceRef(s.ref), assessment = ref?.kind === "assessment_observation" || ref?.kind === "assessment_analysis";
  if (r.schemaVersion !== 1 || r.patientId !== scope.patientId || r.orthoCaseId !== scope.orthoCaseId || r.clinicalCaseId !== scope.clinicalCaseId
    || !journeyId(r.id) || !journeyId(r.problemId) || !journeyId(r.actorId)
    || !text(r.problemLabelAtReview, 2000) || !text(r.reviewedBy, 4000, true) || !text(r.reason, 1000)
    || !text(r.reviewedAt, 100) || !Number.isFinite(Date.parse(r.reviewedAt))
    || r.supersedesReviewId !== null && (!journeyId(r.supersedesReviewId) || r.supersedesReviewId >= r.id)
    || !ref || s.identity !== problemSourceIdentity(ref) || !text(s.title, 4000, true) || !text(s.category, 4000, true)
    || !text(s.summary, 20000, true) || s.site !== null && !text(s.site, 1000, true)
    || !text(s.recordedBy, 4000, true) || !text(s.recordedAt, 100, true) || typeof s.requiresImages !== "boolean"
    || ["ceph_diagnosis", "facial_review"].includes(ref.kind) && !s.requiresImages || !journeyHash(s.snapshotHash)
    || (assessment ? !journeyId(s.assessmentVersion) : s.assessmentVersion !== null)
    || facial !== (ref.kind === "facial_review")) throw Error("invalid_study_problem_review");
  if (facial) {
    const doc = object(s.facialDocument, ["id", "sha256"]);
    if (!journeyId(doc.id) || !journeyHash(doc.sha256) || ref.member !== `document_${doc.id}_review`) throw Error("invalid_study_problem_review");
  }
  return raw as StudyProblemReview;
}
