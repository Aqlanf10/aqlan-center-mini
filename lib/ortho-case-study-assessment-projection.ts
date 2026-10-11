/** Pure projection of an already strictly decoded, currently authorized revision.
 * No clinical inference, formula execution, approval, or fresh source admission. */
import { CLINICAL_FIELDS_V2, blankClinicalObservationV2, clinicalFieldIdV2, type ClinicalFieldV2 } from "./ortho-assessment-findings-v2";
import type { AssessmentRevisionV2 } from "./ortho-assessment-persisted-v2";
import type { AssessmentObservationV2 } from "./ortho-assessment-v2";
import { canonicalJourneyJSON } from "./ortho-case-journey-hash";

export const STUDY_ASSESSMENT_PROJECTION_VERSION = "ortho-study-assessment-panels-v1" as const;
export const STUDY_CLINICAL_PANEL_FIELDS = {
  interview: ["chiefComplaint", "medicalHistory", "dentalHistory", "familyHistory", "growthHistory"],
  "face-overview": ["facialSymmetry"],
  "face-profile": ["facialProfile"],
  smile: ["lips", "smile"],
  "facial-fifths": ["facialFifths"],
  "facial-thirds": ["facialThirds"],
  occlusal: ["upperMidline", "lowerMidline", "upperArchForm", "lowerArchForm", "curveOfSpee", "toothFindings"],
  "dental-relations": ["rightMolarRelation", "leftMolarRelation", "rightCanineRelation", "leftCanineRelation", "anteriorCrossbite", "posteriorCrossbite", "overjet", "overbite"],
} as const satisfies Record<string, readonly ClinicalFieldV2[]>;
export type StudyClinicalPanel = keyof typeof STUDY_CLINICAL_PANEL_FIELDS;
export interface StudyAssessmentSelection { measurementSetIds: readonly string[]; analysisIds: readonly string[] }

function sameDefinition(observation: AssessmentObservationV2, field: ClinicalFieldV2): boolean {
  const expected = blankClinicalObservationV2(field);
  return observation.id === expected.id && observation.definition === expected.definition
    && observation.definitionVersion === expected.definitionVersion && observation.unit === expected.unit
    && canonicalJourneyJSON(observation.target) === canonicalJourneyJSON(expected.target);
}
function uniqueIds(ids: readonly string[], maximum: number): void {
  if (!Array.isArray(ids) || ids.length > maximum || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) {
    throw new Error("invalid_assessment_projection_selection");
  }
}
function copy<T>(value: T): T { return JSON.parse(canonicalJourneyJSON(value)) as T; }

export function projectStudyAssessment(revision: AssessmentRevisionV2, selection: StudyAssessmentSelection) {
  if (revision.schemaVersion !== 2 || revision.content.schemaVersion !== 2) throw new Error("unsupported_assessment_projection");
  uniqueIds(selection.measurementSetIds, 12);
  uniqueIds(selection.analysisIds, 36);
  const draft = revision.content.draft;
  const byId = new Map(draft.observations.observations.map(row => [row.id, row]));
  const mapped = new Set<string>();
  const panels = Object.fromEntries(Object.entries(STUDY_CLINICAL_PANEL_FIELDS).map(([panel, fields]) => {
    const observations: AssessmentObservationV2[] = [];
    for (const field of fields) {
      const observation = byId.get(clinicalFieldIdV2(field));
      if (observation && sameDefinition(observation, field)) { observations.push(copy(observation)); mapped.add(observation.id); }
    }
    return [panel, observations];
  })) as Record<StudyClinicalPanel, AssessmentObservationV2[]>;
  const measurementSets = selection.measurementSetIds.map(id => {
    const set = draft.measurementSets.find(row => row.id === id);
    if (!set) throw new Error("missing_selected_measurement_set");
    return copy(set);
  });
  const castIds = new Set<string>();
  for (const set of measurementSets) {
    set.toothWidthObservationIds.forEach(id => castIds.add(id));
    if (set.upperAvailableObservationId !== null) castIds.add(set.upperAvailableObservationId);
    if (set.lowerAvailableObservationId !== null) castIds.add(set.lowerAvailableObservationId);
  }
  if (measurementSets.length && draft.observations.dentitionObservationId !== null) castIds.add(draft.observations.dentitionObservationId);
  const castObservations = [...castIds].map(id => {
    const observation = byId.get(id);
    if (!observation) throw new Error("missing_selected_measurement_observation");
    mapped.add(id); return copy(observation);
  });
  const analyses = selection.analysisIds.map(id => {
    const authored = draft.analyses.find(row => row.id === id);
    const stored = revision.content.results.find(row => row.analysisId === id);
    if (!authored || !stored || !selection.measurementSetIds.includes(authored.measurementSetId)) throw new Error("missing_selected_stored_analysis");
    // Keep the stored engine/reference/witness/result status. Never derive again here.
    return { selection: copy(authored), stored: copy(stored), clinicalApproval: "unapproved" as const };
  });
  const knownIds = new Set(CLINICAL_FIELDS_V2.map(([field]) => clinicalFieldIdV2(field)));
  const unmapped = draft.observations.observations.filter(row => !mapped.has(row.id)).map(row => ({
    observation: copy(row), reason: knownIds.has(row.id) ? "clinical_definition_mismatch" as const : "not_selected_or_unmapped" as const,
  }));
  return {
    projectionVersion: STUDY_ASSESSMENT_PROJECTION_VERSION,
    revision: { id: revision.id, version: revision.version, contentHash: revision.contentHash, schemaVersion: revision.schemaVersion,
      recordedAt: revision.createdAt, recordedBy: revision.createdBy, recordingContext: revision.recordingContext },
    clinicalApproval: "unapproved" as const,
    panels, cast: { measurementSets, observations: castObservations }, analyses,
    unmappedCount: unmapped.length, unmapped,
    // This photo layout has no inferred clinical facts.
    intraoralOverview: { clinicalFindings: "not_projected" as const },
  };
}
