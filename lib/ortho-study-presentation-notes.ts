import { journeyContentHash } from './ortho-case-journey-hash';
import type { StudySourceSelection } from './ortho-case-study';
import { MODEL_ANALYSIS_EVIDENCE_VERSION, validateModelAnalysisEvidence, type ModelAnalysisEvidence } from './ortho-study-model-analysis-evidence';

export interface StudyNotesPage {
  title: string; lines: string[]; sourceKeys: string[];
  panelId?: string; modelAnalyses?: ModelAnalysisEvidence[];
}
export interface StudyNotesProjection {
  caseId: number; revisionId: number; revisionHash: string; version: number;
  kind: 'draft' | 'documented'; capturedAt: string;
  sources: StudySourceSelection[]; pages: StudyNotesPage[]; projectionHash: string;
}
/** Image bytes/witnesses retain their existing independently checked contract.
 * This hash protects shared textual pages, source selections and exact notes. */
export function studyNotesProjectionHash(value: Omit<StudyNotesProjection, 'projectionHash'> | StudyNotesProjection): string {
  return journeyContentHash({ notesVersion: MODEL_ANALYSIS_EVIDENCE_VERSION, caseId: value.caseId,
    revisionId: value.revisionId, revisionHash: value.revisionHash, version: value.version, kind: value.kind,
    capturedAt: value.capturedAt, sources: value.sources,
    pages: value.pages.map(page => ({ title: page.title, lines: page.lines, sourceKeys: page.sourceKeys,
      panelId: page.panelId ?? null, modelAnalyses: page.modelAnalyses ?? [] })) });
}
export function validateStudyNotesProjection(value: StudyNotesProjection): void {
  if (!Array.isArray(value.sources) || !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 300
    || value.projectionHash !== studyNotesProjectionHash(value)) throw Error('study_presentation_projection_changed');
  const keys = new Set(value.sources.map(source => source.key));
  for (const page of value.pages) {
    if (page.sourceKeys.some(key => !keys.has(key)) || page.modelAnalyses !== undefined && !Array.isArray(page.modelAnalyses)) throw Error('study_presentation_source_binding');
    for (const evidence of page.modelAnalyses ?? []) validateModelAnalysisEvidence(evidence, page.panelId, page.sourceKeys, value.sources);
  }
}
export function studyPageNotes(value: StudyNotesProjection, page: StudyNotesPage, renderer: string) {
  return { renderer, notesVersion: MODEL_ANALYSIS_EVIDENCE_VERSION, projectionHash: value.projectionHash,
    caseId: value.caseId, revisionId: value.revisionId, revisionHash: value.revisionHash, capturedAt: value.capturedAt,
    panelId: page.panelId ?? null, sources: value.sources.filter(source => page.sourceKeys.includes(source.key)),
    modelAnalyses: page.modelAnalyses ?? [], disclosure: 'Clinical copy. Case-only labels do not anonymize clinical text or images. Not approved for educational publication.' };
}
