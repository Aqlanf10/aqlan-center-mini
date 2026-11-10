import { journeyContentHash } from './ortho-case-journey-hash';
import { presentSavedModelAnalysis, type SavedStudyModelAnalysis } from './ortho-study-model-analysis-presentation';
import { checkAssessmentObservationV2, observationIdV2, type AssessmentObservationV2 } from './ortho-assessment-v2';
import type { AssessmentRevisionV2 } from './ortho-assessment-persisted-v2';
import type { AssessmentMeasurementSetV2 } from './ortho-assessment-measurement-set-v2';
import type { StudySourceSelection } from './ortho-case-study';

export const MODEL_ANALYSIS_EVIDENCE_VERSION = 'ortho-model-analysis-evidence-v1';
export const STUDY_PRESENTATION_NOTES_LIMIT = 4 * 1024 * 1024;
export interface ModelAnalysisEvidence {
  version: typeof MODEL_ANALYSIS_EVIDENCE_VERSION;
  panelInstanceId: string;
  source: StudySourceSelection;
  measurementSet: AssessmentMeasurementSetV2;
  /** Null is an explicitly absent dependency, never a fabricated observation. */
  inputs: { observationId: string; observation: AssessmentObservationV2 | null }[];
  exactWitness: Pick<SavedStudyModelAnalysis, 'selection' | 'stored'>;
  witnessHash: string;
}
function fail(): never { throw Error('study_model_evidence_invalid'); }
function fields(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail();
}
export function modelAnalysisEvidenceHash(value: Omit<ModelAnalysisEvidence, 'witnessHash'> | ModelAnalysisEvidence) {
  const { witnessHash: _ignored, ...evidence } = value as ModelAnalysisEvidence;
  return journeyContentHash(evidence);
}
export function validateModelAnalysisEvidence(value: ModelAnalysisEvidence, panelId: string | undefined | null,
  sourceKeys: readonly string[], sources: readonly StudySourceSelection[]): void {
  fields(value, ['version', 'panelInstanceId', 'source', 'measurementSet', 'inputs', 'exactWitness', 'witnessHash']);
  if (value.version !== MODEL_ANALYSIS_EVIDENCE_VERSION || !panelId || value.panelInstanceId !== panelId
    || !sourceKeys.includes(value.source?.key) || value.source.kind !== 'assessment'
    || !sources.some(source => journeyContentHash(source) === journeyContentHash(value.source))) fail();
  fields(value.exactWitness, ['selection', 'stored']);
  presentSavedModelAnalysis({ ...value.exactWitness, clinicalApproval: 'unapproved' });
  fields(value.measurementSet, ['id', 'toothWidthObservationIds', 'upperAvailableObservationId', 'lowerAvailableObservationId']);
  const set = value.measurementSet, dependencies = value.exactWitness.stored.result.dependencyObservationIds;
  if (set.id !== value.exactWitness.selection.measurementSetId || !Array.isArray(set.toothWidthObservationIds)
    || set.toothWidthObservationIds.length > 52 || set.toothWidthObservationIds.some(id => !observationIdV2(id))
    || new Set(set.toothWidthObservationIds).size !== set.toothWidthObservationIds.length
    || [set.upperAvailableObservationId, set.lowerAvailableObservationId].some(id => id !== null && !observationIdV2(id))
    || !Array.isArray(value.inputs) || value.inputs.length !== dependencies.length) fail();
  for (const [index, input] of value.inputs.entries()) {
    fields(input, ['observationId', 'observation']);
    if (input.observationId !== dependencies[index]) fail();
    if (input.observation !== null) {
      const checked = checkAssessmentObservationV2(input.observation);
      if (!checked.ok || input.observation.id !== input.observationId) fail();
    }
  }
  if (value.witnessHash !== modelAnalysisEvidenceHash(value)) fail();
}
/** Only call with the canonical decoded saved assessment selected by this panel. */
export function captureModelAnalysisEvidence(revision: AssessmentRevisionV2, source: StudySourceSelection,
  panelInstanceId: string, analysis: SavedStudyModelAnalysis): ModelAnalysisEvidence {
  const exactWitness = presentSavedModelAnalysis(analysis).exactWitness;
  const set = revision.content.draft.measurementSets.find(set => set.id === analysis.selection.measurementSetId);
  if (!set || source.kind !== 'assessment' || source.id !== revision.id || source.version !== revision.version
    || source.contentHash !== revision.contentHash
    || !revision.content.draft.analyses.some(selection => journeyContentHash(selection) === journeyContentHash(analysis.selection))
    || !revision.content.results.some(result => journeyContentHash(result) === journeyContentHash(analysis.stored))) fail();
  const value: ModelAnalysisEvidence = structuredClone({ version: MODEL_ANALYSIS_EVIDENCE_VERSION, panelInstanceId, source,
    measurementSet: set, inputs: analysis.stored.result.dependencyObservationIds.map(observationId => ({ observationId,
      observation: revision.content.draft.observations.observations.find(row => row.id === observationId) ?? null })), exactWitness, witnessHash: '' });
  value.witnessHash = modelAnalysisEvidenceHash(value);
  validateModelAnalysisEvidence(value, panelInstanceId, [source.key], [source]);
  return value;
}
/** Count the exact serialized notes for every page, including duplicates. */
export function checkedStudyPageNotes(notes: readonly unknown[]): string[] {
  const serialized: string[] = []; let total = 0;
  for (const note of notes) {
    const text = JSON.stringify(note);
    total += new TextEncoder().encode(text).byteLength;
    if (total > STUDY_PRESENTATION_NOTES_LIMIT) throw Error('study_presentation_notes_limit');
    serialized.push(text);
  }
  return serialized;
}
