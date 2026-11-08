/** Browser-safe editor projection. Clinical capture payloads stay on the canonical
 * saved-study reader; editing requires authored selections and exact revision IDs. */
import { CASE_TEMPLATE_VERSION } from "./ortho-case-template";
import { readStudyDraftContent, STUDY_TEMPLATE_KEY, type StudyDraftContent, type StudyRevisionRef } from "./ortho-case-study";
import { journeyHash, journeyId, type JourneyScope } from "./ortho-case-journey-records";
export interface StudyEditorRevision extends JourneyScope {
  id: number; version: number; kind: "draft" | "documented"; contentHash: string; actorId: number;
  predecessorId: number | null; documentedFromId: number | null; baseDocumentedId: number | null;
  createdAt: string; reason: string; authoredHash: string; authored: StudyDraftContent;
}
export interface StudyEditorHistory {
  id: number; version: number; kind: "draft" | "documented"; contentHash: string; createdAt: string;
  predecessorId: number | null; documentedFromId: number | null; baseDocumentedId: number | null;
}
export interface StudyEditorRead extends JourneyScope {
  ok: true; template: StudyDraftContent["template"]; revision: StudyEditorRevision | null;
  head: StudyRevisionRef | null; canAppend: boolean; history: StudyEditorHistory[];
}
export interface StudyEditorSaved extends JourneyScope { ok: true; replayed: boolean; revision: StudyEditorRevision }
function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_study_editor_response");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error("invalid_study_editor_response");
  return value;
}
function scope(value: Record<string, unknown>, expected: JourneyScope) {
  for (const key of ["patientId", "orthoCaseId", "clinicalCaseId"] as const) {
    if (!journeyId(expected[key]) || value[key] !== expected[key]) throw new Error("study_editor_scope_changed");
  }
}
const nullableId = (value: unknown): value is number | null => value === null || journeyId(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function metadata(raw: Record<string, unknown>): StudyEditorHistory {
  if (!journeyId(raw.id) || !journeyId(raw.version) || raw.kind !== "draft" && raw.kind !== "documented" || !journeyHash(raw.contentHash)
    || !timestamp(raw.createdAt) || !nullableId(raw.predecessorId) || !nullableId(raw.documentedFromId) || !nullableId(raw.baseDocumentedId)
    || [raw.predecessorId, raw.documentedFromId, raw.baseDocumentedId].some(reference => reference !== null && reference === raw.id)
    || (raw.version === 1) !== (raw.predecessorId === null) || (raw.kind === "draft") !== (raw.documentedFromId === null)) throw new Error("invalid_study_editor_revision");
  return { id: raw.id, version: raw.version, kind: raw.kind, contentHash: raw.contentHash, createdAt: raw.createdAt,
    predecessorId: raw.predecessorId, documentedFromId: raw.documentedFromId, baseDocumentedId: raw.baseDocumentedId };
}
export function readStudyEditorRevision(raw: unknown, expected: JourneyScope): StudyEditorRevision {
  const value = object(raw, ["patientId", "orthoCaseId", "clinicalCaseId", "id", "version", "kind", "contentHash", "predecessorId", "documentedFromId", "baseDocumentedId", "createdAt", "actorId", "reason", "authoredHash", "authored"]);
  scope(value, expected); const info = metadata(value);
  if (!journeyId(value.actorId) || !journeyHash(value.authoredHash) || typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 500) throw new Error("invalid_study_editor_revision");
  return { ...expected, ...info, actorId: value.actorId, reason: value.reason, authoredHash: value.authoredHash, authored: readStudyDraftContent(value.authored) };
}
export function readStudyEditorSaved(raw: unknown, expected: JourneyScope): StudyEditorSaved {
  const value = object(raw, ["ok", "replayed", "patientId", "orthoCaseId", "clinicalCaseId", "revision"]); scope(value, expected);
  if (value.ok !== true || typeof value.replayed !== "boolean") throw new Error("invalid_study_editor_save");
  return { ok: true, replayed: value.replayed, ...expected, revision: readStudyEditorRevision(value.revision, expected) };
}
export function readStudyEditorRead(raw: unknown, expected: JourneyScope): StudyEditorRead {
  const value = object(raw, ["ok", "patientId", "orthoCaseId", "clinicalCaseId", "template", "revision", "head", "canAppend", "history"]); scope(value, expected);
  if (value.ok !== true || typeof value.canAppend !== "boolean" || !Array.isArray(value.history) || value.history.length > 5000) throw new Error("invalid_study_editor_read");
  const template = object(value.template, ["key", "version", "contentHash"]);
  if (template.key !== STUDY_TEMPLATE_KEY || template.version !== CASE_TEMPLATE_VERSION || !journeyHash(template.contentHash)) throw new Error("study_template_changed");
  const history = value.history.map(row => metadata(object(row, ["id", "version", "kind", "contentHash", "createdAt", "predecessorId", "documentedFromId", "baseDocumentedId"])));
  const ids = new Set<number>();
  const prior = new Map<number, StudyEditorHistory>();
  history.forEach((row, index) => {
    if (ids.has(row.id) || row.version !== index + 1 || row.predecessorId !== (history[index - 1]?.id ?? null)
      || row.baseDocumentedId !== null && prior.get(row.baseDocumentedId)?.kind !== "documented"
      || row.kind === "documented" && (history[index - 1]?.kind !== "draft" || row.documentedFromId !== history[index - 1]?.id
        || row.contentHash !== history[index - 1]?.contentHash || row.baseDocumentedId !== history[index - 1]?.baseDocumentedId)) throw new Error("invalid_study_editor_history");
    ids.add(row.id); prior.set(row.id, row);
  });
  const latest = history.at(-1); let head: StudyRevisionRef | null = null;
  if (value.head !== null) {
    const reference = object(value.head, ["id", "contentHash"]);
    if (!journeyId(reference.id) || !journeyHash(reference.contentHash) || latest?.id !== reference.id || latest.contentHash !== reference.contentHash) throw new Error("invalid_study_editor_head");
    head = { id: reference.id, contentHash: reference.contentHash };
  } else if (latest) throw new Error("invalid_study_editor_head");
  const revision = value.revision === null ? null : readStudyEditorRevision(value.revision, expected);
  if (revision && !history.some(row => row.id === revision.id && row.contentHash === revision.contentHash && row.kind === revision.kind && row.version === revision.version
      && row.predecessorId === revision.predecessorId && row.documentedFromId === revision.documentedFromId
      && row.baseDocumentedId === revision.baseDocumentedId && row.createdAt === revision.createdAt)
    || !revision && history.length) throw new Error("invalid_study_editor_selection");
  return { ok: true, ...expected, template: { key: STUDY_TEMPLATE_KEY, version: CASE_TEMPLATE_VERSION, contentHash: template.contentHash }, revision, head, canAppend: value.canAppend, history };
}
