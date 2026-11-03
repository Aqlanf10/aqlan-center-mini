import { canonicalJourneyJSON } from "./ortho-case-journey-json";
import { positiveProblemId, problemSourceIdentity, readProblemSourceRef, type ProblemSourceCandidate, type ProblemSourceCommand, type ProblemSourceRead, type ProblemSourceReceipt } from "./ortho-problem-sources";
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, limit = 4000): v is string => typeof v === "string" && v.length <= limit;
function candidate(v: unknown): v is ProblemSourceCandidate {
  if (!obj(v)) return false; const ref = readProblemSourceRef(v.ref);
  return !!ref && v.identity === problemSourceIdentity(ref) && text(v.title) && text(v.category) && text(v.summary, 20000)
    && (v.proposedLabel === null || text(v.proposedLabel, 2000)) && (v.site === null || text(v.site, 1000))
    && obj(v.target) && obj(v.snapshot) && text(v.sourceActor) && text(v.sourceDate, 100) && typeof v.available === "boolean" && typeof v.requiresImages === "boolean";
}
export function readProblemSourceRead(v: unknown, scope: { patientId: number; orthoCaseId: number }): ProblemSourceRead {
  if (!obj(v) || v.ok !== true || v.patientId !== scope.patientId || v.orthoCaseId !== scope.orthoCaseId || !positiveProblemId(v.clinicalCaseId)
    || typeof v.writable !== "boolean" || !Array.isArray(v.candidates) || v.candidates.length > 512 || !v.candidates.every(candidate)
    || new Set(v.candidates.map(c => c.identity)).size !== v.candidates.length || !Array.isArray(v.problems) || v.problems.length > 500
    || !v.problems.every(p => obj(p) && positiveProblemId(p.id) && text(p.label, 2000) && (p.site === null || text(p.site, 1000)) && ["active", "inactive", "resolved"].includes(String(p.status)))
    || !Array.isArray(v.reviews) || v.reviews.length > 500 || !v.reviews.every(r => obj(r) && positiveProblemId(r.id) && positiveProblemId(r.problemId)
      && candidate(r.source) && r.sourceIdentity === r.source.identity && r.sourceVersion === r.source.ref.version && text(r.problemLabel, 2000)
      && text(r.createdBy) && text(r.createdAt, 100) && text(r.reason, 1000) && (r.supersedesReviewId === null || positiveProblemId(r.supersedesReviewId))
      && ["current", "newer_version", "unavailable"].includes(String(r.currentSourceState)))) throw Error("invalid_problem_sources_read");
  return v as ProblemSourceRead;
}
export async function verifyProblemSourceReceipt(v: unknown, scope: { patientId: number; orthoCaseId: number; clinicalCaseId: number; actorId: number }, command: ProblemSourceCommand, status: number): Promise<ProblemSourceReceipt> {
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJourneyJSON(command))))].map(n => n.toString(16).padStart(2, "0")).join("");
  if (!obj(v) || v.ok !== true || v.patientId !== scope.patientId || v.orthoCaseId !== scope.orthoCaseId || v.clinicalCaseId !== scope.clinicalCaseId || v.actorId !== scope.actorId
    || v.commandId !== command.commandId || v.requestFingerprint !== hash || !positiveProblemId(v.reviewId) || !positiveProblemId(v.problemId)
    || command.action === "link" && v.problemId !== command.problemId || v.sourceIdentity !== problemSourceIdentity(command.source) || v.sourceVersion !== command.source.version
    || typeof v.replayed !== "boolean" || status !== (v.replayed ? 200 : 201)) throw Error("problem_review_receipt_mismatch");
  return v as ProblemSourceReceipt;
}
