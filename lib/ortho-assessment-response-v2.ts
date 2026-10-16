import { keys, plain, positiveId, type Checked } from "./ortho-assessment-model";
import { checkAnyAssessmentCommand, type AssessmentCommandV2 } from "./ortho-assessment-command-v2";
import { sameAssessmentStructure, verifyAnyAssessmentRevisionBrowser } from "./ortho-assessment-read-v2";
import type { AnyAssessmentRevision, AssessmentRevisionV2 } from "./ortho-assessment-persisted-v2";
import type { AssessmentSourceV2 } from "./ortho-assessment-v2";
export interface AssessmentScope { patientId: number; orthoCaseId: number; clinicalCaseId: number }
export interface AssessmentHistoryEntryV2 {
  schemaVersion: 1 | 2; id: number; version: number; supersedesRevisionId: number | null; recordedPatientId: number;
  recordingContext: "current" | "retrospective"; createdBy: string; createdAt: string; reason: string;
}
export type AssessmentSourceChoiceV2 = AssessmentSourceV2 & { label: string };
export interface AssessmentSourceStateV2 { source: AssessmentSourceV2; state: "available" | "unavailable" | "changed" }
interface AssessmentReadCommon {
  ok: true; representation: 2; patientId: number; orthoCaseId: number; recordingContext: "current" | "retrospective";
  clinicalWritable: boolean; history: AssessmentHistoryEntryV2[]; sourceStates: AssessmentSourceStateV2[];
  sources: { items: AssessmentSourceChoiceV2[]; truncated: boolean; imaging: "allowed" | "restricted" };
}
export type AssessmentReadResponseV2 = AssessmentReadCommon & (
  { state: "ready"; clinicalCaseId: number; revision: AnyAssessmentRevision | null }
  | { state: "bridge_missing"; clinicalCaseId: null; revision: null }
);
export interface AssessmentAppendResponse { ok: true; revision: AnyAssessmentRevision; replayed: boolean }
export interface AssessmentSaveExpectationV2 { scope: AssessmentScope; command: AssessmentCommandV2; previousVersion: number }
/** Recovered UI owns HTTP status and lifetime fences; this verifies exact body/hash.
 * Recheck caller ownership after await. A current GET never substitutes for this response.
 */
export async function confirmAssessmentAppendV2(raw: unknown, expected: AssessmentSaveExpectationV2): Promise<Checked<{ revision: AssessmentRevisionV2; replayed: boolean }>> {
  const fail = (): Checked<never> => ({ ok: false, code: "save_response_mismatch" });
  if (!plain(raw) || !keys(raw,["ok","revision","replayed"]) || raw.ok !== true || typeof raw.replayed !== "boolean"
    || !positiveId(expected.scope.patientId) || !positiveId(expected.scope.orthoCaseId) || !positiveId(expected.scope.clinicalCaseId)
    || !Number.isSafeInteger(expected.previousVersion) || expected.previousVersion < 0) return fail();
  const scope = { ...expected.scope }, previousVersion = expected.previousVersion;
  const command = checkAnyAssessmentCommand(expected.command);
  if (!command.ok || command.value.schemaVersion !== 2 || (command.value.expectedRevisionId === null) !== (previousVersion === 0)) return fail();
  const checked = await verifyAnyAssessmentRevisionBrowser(raw.revision, scope);
  if (!checked.ok || checked.value.schemaVersion !== 2) return fail();
  const revision = checked.value;
  if (revision.version !== previousVersion + 1 || revision.supersedesRevisionId !== command.value.expectedRevisionId
    || revision.reason !== command.value.reason || !sameAssessmentStructure(revision.content.draft,command.value.content)) return fail();
  return { ok: true, value: { revision, replayed: raw.replayed } };
}
