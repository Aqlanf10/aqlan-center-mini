/** A clinician's explicit, one-way end of active treatment. Device deliveries,
 * debonding and recall remain separate records with their own real dates. */
import { PHASE_ORDER, type OrthoPhase, type CaseStatus } from "./ortho";
import { readOccurrenceEvidence, type OccurrenceEvidence } from "./ortho-case-occurrence";
import { journeyId, journeyHash, type JourneyScope } from "./ortho-case-journey-records";
export interface RetentionTransitionCommand {
  schemaVersion: 1; clientRequestId: string; expectedPhase: OrthoPhase; confirmed: true;
  reason: string; occurrence: OccurrenceEvidence; retentionPlan: string;
}
export interface RetentionTransitionRecord extends JourneyScope {
  id: number; recordedPatientId: number; actorId: number; createdBy: string; createdAt: string;
  command: RetentionTransitionCommand; requestFingerprint: string;
}
export interface RetentionTransitionRead extends JourneyScope {
  ok: true; status: CaseStatus; phase: OrthoPhase; canTransition: boolean; transition: RetentionTransitionRecord | null;
}
function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_retention_transition");
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r,k))) throw new Error("invalid_retention_transition"); return r;
}
function text(raw: unknown, max: number) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(raw)) throw new Error("invalid_retention_transition_text"); return raw;
}
export function readRetentionTransitionCommand(raw: unknown): RetentionTransitionCommand {
  const r = object(raw, ["schemaVersion","clientRequestId","expectedPhase","confirmed","reason","occurrence","retentionPlan"]);
  if (r.schemaVersion !== 1 || r.confirmed !== true || typeof r.clientRequestId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(r.clientRequestId)
    || !PHASE_ORDER.includes(r.expectedPhase as OrthoPhase)) throw new Error("invalid_retention_transition");
  const occurrence = readOccurrenceEvidence(r.occurrence);
  if (!occurrence.sourceNote.trim()) throw new Error("retention_transition_source_required");
  return { schemaVersion: 1, clientRequestId: r.clientRequestId, expectedPhase: r.expectedPhase as OrthoPhase, confirmed: true,
    reason: text(r.reason,500), occurrence, retentionPlan: text(r.retentionPlan,4000) };
}
export function readRetentionTransitionRecord(raw: unknown, expected: Pick<JourneyScope,"patientId" | "orthoCaseId">): RetentionTransitionRecord {
  const r = object(raw, ["id","patientId","orthoCaseId","clinicalCaseId","recordedPatientId","actorId","createdBy","createdAt","command","requestFingerprint"]);
  if (![r.id,r.patientId,r.orthoCaseId,r.clinicalCaseId,r.recordedPatientId,r.actorId].every(journeyId)
    || r.patientId !== expected.patientId || r.orthoCaseId !== expected.orthoCaseId || !journeyHash(r.requestFingerprint)
    || typeof r.createdAt !== "string" || !Number.isFinite(Date.parse(r.createdAt)) || new Date(r.createdAt).toISOString() !== r.createdAt) throw new Error("invalid_retention_transition_record");
  return { id:r.id as number, patientId:r.patientId as number, orthoCaseId:r.orthoCaseId as number, clinicalCaseId:r.clinicalCaseId as number,
    recordedPatientId:r.recordedPatientId as number, actorId:r.actorId as number, createdBy:text(r.createdBy,200), createdAt:r.createdAt,
    command:readRetentionTransitionCommand(r.command), requestFingerprint:r.requestFingerprint };
}
export function readRetentionTransitionRead(raw: unknown, expected: Pick<JourneyScope,"patientId" | "orthoCaseId">): RetentionTransitionRead {
  const r=object(raw,["ok","patientId","orthoCaseId","clinicalCaseId","status","phase","canTransition","transition"]);
  if(r.ok!==true || r.patientId!==expected.patientId || r.orthoCaseId!==expected.orthoCaseId || !journeyId(r.clinicalCaseId)
    || !["active","retention","completed","discontinued"].includes(r.status as string) || !PHASE_ORDER.includes(r.phase as OrthoPhase)
    || typeof r.canTransition!=="boolean") throw new Error("invalid_retention_transition_read");
  const transition=r.transition===null?null:readRetentionTransitionRecord(r.transition,expected);
  if(transition && transition.clinicalCaseId!==r.clinicalCaseId || r.canTransition && (r.status!=="active" || transition)) throw new Error("invalid_retention_transition_read");
  return {ok:true,patientId:expected.patientId,orthoCaseId:expected.orthoCaseId,clinicalCaseId:r.clinicalCaseId,status:r.status as CaseStatus,phase:r.phase as OrthoPhase,canTransition:r.canTransition,transition};
}
