/** A clinician explicitly reviews a saved source. Numeric results never become
 * a diagnosis just because the source or a candidate row exists. */
export const PROBLEM_SOURCE_KINDS = ["assessment_observation", "assessment_analysis", "clinical_diagnosis", "ceph_diagnosis"] as const;
export type ProblemSourceKind = typeof PROBLEM_SOURCE_KINDS[number];
export type ProblemSourceRef = { kind: ProblemSourceKind; id: number; member: string; version: string };
export type ProblemSourceCandidate = { identity: string; ref: ProblemSourceRef; category: string; title: string; summary: string;
  proposedLabel: string | null; site: string | null; target: unknown; snapshot: unknown; sourceActor: string; sourceDate: string;
  available: boolean; requiresImages: boolean };
export type ProblemSourceCommand = { schemaVersion: 1; commandId: string; source: ProblemSourceRef; expectedReviewId: number | null;
  action: "create" | "link"; problemId: number | null; label: string | null; reason: string; clinicianReviewed: true };
export const problemSourceIdentity = (ref: ProblemSourceRef) => `${ref.kind}:${ref.kind === "ceph_diagnosis" ? `${ref.id}:` : ""}${ref.member}`;
export const positiveProblemId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join("|") === keys.sort().join("|");
export function readProblemSourceRef(v: unknown): ProblemSourceRef | null {
  if (!object(v) || !exact(v, ["kind", "id", "member", "version"]) || !PROBLEM_SOURCE_KINDS.includes(v.kind as ProblemSourceKind)
    || !positiveProblemId(v.id) || typeof v.member !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(v.member)
    || typeof v.version !== "string" || !/^sha256:[a-f0-9]{64}$/.test(v.version)) return null;
  return v as ProblemSourceRef;
}
export function readProblemSourceCommand(v: unknown): ProblemSourceCommand | null {
  if (!object(v) || !exact(v, ["schemaVersion", "commandId", "source", "expectedReviewId", "action", "problemId", "label", "reason", "clinicianReviewed"])
    || v.schemaVersion !== 1 || v.clinicianReviewed !== true || typeof v.commandId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(v.commandId)
    || v.expectedReviewId !== null && !positiveProblemId(v.expectedReviewId) || !readProblemSourceRef(v.source)
    || typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 1000) return null;
  if (v.action === "create") {
    if (v.problemId !== null || typeof v.label !== "string" || !v.label.trim() || v.label.length > 2000) return null;
  } else if (v.action !== "link" || !positiveProblemId(v.problemId) || v.label !== null) return null;
  return v as ProblemSourceCommand;
}
export type ProblemSourceReview = { id: number; problemId: number; sourceIdentity: string; sourceVersion: string; source: ProblemSourceCandidate;
  problemLabel: string; createdBy: string; createdAt: string; reason: string; supersedesReviewId: number | null;
  currentSourceState: "current" | "newer_version" | "unavailable" };
export type ProblemSourceRead = { ok: true; patientId: number; orthoCaseId: number; clinicalCaseId: number; writable: boolean;
  candidates: ProblemSourceCandidate[]; problems: { id: number; label: string; site: string | null; status: string }[]; reviews: ProblemSourceReview[] };
export type ProblemSourceReceipt = { ok: true; patientId: number; orthoCaseId: number; clinicalCaseId: number; commandId: string;
  actorId: number; requestFingerprint: string; reviewId: number; problemId: number; sourceIdentity: string; sourceVersion: string; replayed: boolean };
