/** Narrow view of the canonical study store. No second writer, source lookup,
 * clinical projection or authority engine. */
import { CASE_TEMPLATE_VERSION } from "./ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "./ortho-case-study-template";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { getOrthoCaseStudy, saveOrthoCaseStudy } from "./ortho-case-study-store";
import type { JourneyOwnerInput } from "./ortho-case-journey-authority";
import type { StudyRevision } from "./ortho-case-study-history";
import type { StudySavedContent } from "./ortho-case-study-capture";
import type { StudyEditorRead, StudyEditorRevision, StudyEditorSaved } from "./ortho-case-study-editor-contract";
function editorRevision(revision: StudyRevision<StudySavedContent>): StudyEditorRevision {
  return { patientId: revision.patientId, orthoCaseId: revision.orthoCaseId, clinicalCaseId: revision.clinicalCaseId,
    id: revision.id, actorId: revision.actorId, version: revision.version, kind: revision.kind, contentHash: revision.contentHash,
    predecessorId: revision.predecessorId, documentedFromId: revision.documentedFromId, baseDocumentedId: revision.baseDocumentedId,
    createdAt: revision.createdAt, reason: revision.reason, authoredHash: journeyContentHash(revision.content.authored), authored: revision.content.authored };
}
export async function getOrthoStudyEditor(input: JourneyOwnerInput & { revisionId?: number }) {
  const result = await getOrthoCaseStudy(input); if (!result.ok) return result;
  const output: StudyEditorRead = { ok: true, patientId: result.patientId, orthoCaseId: result.orthoCaseId, clinicalCaseId: result.clinicalCaseId,
    template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH },
    revision: result.revision ? editorRevision(result.revision) : null, head: result.head, canAppend: result.canAppend, history: result.history };
  return output;
}
export async function saveOrthoStudyEditor(input: JourneyOwnerInput & { command: unknown }) {
  const result = await saveOrthoCaseStudy(input); if (!result.ok) return result;
  const revision = editorRevision(result.revision);
  const output: StudyEditorSaved = { ok: true, replayed: result.replayed, patientId: revision.patientId,
    orthoCaseId: revision.orthoCaseId, clinicalCaseId: revision.clinicalCaseId, revision };
  return output;
}
