import { CASE_TEMPLATE_IDENTITY } from "./ortho-case-template";
import { canonicalJourneyJSON } from "./ortho-case-journey-json";
import { checkStudySaveCommand, type StudySaveCommand } from "./ortho-case-study";
import { readStudyEditorRead, readStudyEditorSaved, type StudyEditorRead, type StudyEditorSaved } from "./ortho-case-study-editor-contract";
import { journeyId, type JourneyScope } from "./ortho-case-journey-records";
export interface StudySaveExpectation { scope: JourneyScope; actorId: number; previousVersion: number; command: StudySaveCommand }
export async function studyBrowserHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJourneyJSON(value));
  if (bytes.length > 2 * 1024 * 1024 || !globalThis.crypto?.subtle) throw new Error("study_hash_unavailable");
  return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
}
export async function verifyStudyEditorRead(raw: unknown, scope: JourneyScope, selectedRevisionId: number | null = null): Promise<StudyEditorRead> {
  const read = readStudyEditorRead(raw, scope);
  if (selectedRevisionId !== null && !journeyId(selectedRevisionId)
    || (read.revision?.id ?? null) !== (selectedRevisionId ?? read.head?.id ?? null)) throw new Error("study_editor_requested_revision_mismatch");
  if (read.template.contentHash !== await studyBrowserHash(CASE_TEMPLATE_IDENTITY)
    || read.revision && read.revision.authoredHash !== await studyBrowserHash(read.revision.authored)) throw new Error("study_editor_hash_mismatch");
  return read;
}
export async function confirmStudyEditorSaved(raw: unknown, expected: StudySaveExpectation): Promise<StudyEditorSaved> {
  const command = checkStudySaveCommand(expected.command);
  if (!command.ok || !Number.isSafeInteger(expected.previousVersion) || expected.previousVersion < 0) throw new Error("invalid_study_save_expectation");
  const result = readStudyEditorSaved(raw, expected.scope), revision = result.revision, submitted = command.value;
  if (revision.actorId !== expected.actorId || revision.version !== expected.previousVersion + 1 || revision.predecessorId !== (submitted.expectedHead?.id ?? null)
    || submitted.kind === "documented" && revision.contentHash !== submitted.documentedFrom?.contentHash
    || revision.kind !== submitted.kind || revision.documentedFromId !== (submitted.documentedFrom?.id ?? null)
    || revision.baseDocumentedId !== (submitted.baseDocumentedRevision?.id ?? null)
    || revision.reason !== submitted.reason || canonicalJourneyJSON(revision.authored) !== canonicalJourneyJSON(submitted.content)
    || revision.authoredHash !== await studyBrowserHash(submitted.content)) throw new Error("study_saved_command_mismatch");
  return result;
}
