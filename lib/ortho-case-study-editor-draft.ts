import { canonicalJourneyJSON } from "./ortho-case-journey-json";
import { readStudyDraftContent, type StudyDraftContent, type StudyRevisionRef } from "./ortho-case-study";
import { journeyHash, journeyId } from "./ortho-case-journey-records";
import type { StudyEditorRead } from "./ortho-case-study-editor-contract";
export interface StudyEditorDraft {
  content: StudyDraftContent; reason: string; expectedHead: StudyRevisionRef | null;
  previousVersion: number; baseDocumentedRevision: StudyRevisionRef | null;
}
function reference(value: unknown): StudyRevisionRef | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_study_draft_reference");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 2 || !journeyId(raw.id) || !journeyHash(raw.contentHash)) throw new Error("invalid_study_draft_reference");
  return { id: raw.id, contentHash: raw.contentHash };
}
export function readStudyEditorDraft(serialized: string): StudyEditorDraft {
  if (serialized.length > 2 * 1024 * 1024) throw new Error("study_draft_limit");
  const raw: unknown = JSON.parse(serialized);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_study_editor_draft");
  const value = raw as Record<string, unknown>;
  const fields = ["content", "reason", "expectedHead", "previousVersion", "baseDocumentedRevision"];
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field)) || typeof value.reason !== "string" || value.reason.length > 500
    || typeof value.previousVersion !== "number" || !Number.isSafeInteger(value.previousVersion) || value.previousVersion < 0) throw new Error("invalid_study_editor_draft");
  const expectedHead = reference(value.expectedHead);
  if ((expectedHead === null) !== (value.previousVersion === 0)) throw new Error("invalid_study_draft_head");
  return { content: readStudyDraftContent(value.content), reason: value.reason, expectedHead, previousVersion: value.previousVersion,
    baseDocumentedRevision: reference(value.baseDocumentedRevision) };
}
export function initialStudyEditorDraft(read: StudyEditorRead): StudyEditorDraft {
  const selected = read.revision;
  const base = selected?.kind === "documented" ? selected : selected?.baseDocumentedId ? read.history.find(row => row.id === selected.baseDocumentedId) : null;
  return { content: selected ? readStudyDraftContent(selected.authored) : {
    template: { ...read.template }, identityDisclosure: "case_only", sources: [], groups: [], mediaUses: [], comment: "",
    panels: [{ instanceId: "cover1", layoutKey: "cover", included: true, state: "not_recorded", sourceKeys: [], images: [], comment: "" }],
  }, reason: "", expectedHead: read.head ? { ...read.head } : null, previousVersion: read.history.at(-1)?.version ?? 0,
    baseDocumentedRevision: base ? { id: base.id, contentHash: base.contentHash } : null };
}
export function serializeStudyEditorDraft(value: StudyEditorDraft): string {
  const serialized = canonicalJourneyJSON(value); readStudyEditorDraft(serialized); return serialized;
}
