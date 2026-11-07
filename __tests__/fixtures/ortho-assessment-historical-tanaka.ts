/** Pinned fixture for the existing candidate 2.2.0 payload. Never use the current
 * creator to test a historical migration boundary. */
import { deriveDraftAnalysisV2 } from "../../lib/ortho-assessment-engine-2_2_0";
import { assessmentJsonHash, type PersistedAssessmentContentV2 } from "../../lib/ortho-assessment-persisted-v2";
import type { AssessmentDraftV2 } from "../../lib/ortho-assessment-measurement-set-v2";
export function historicalTanakaPayload(draft: AssessmentDraftV2): PersistedAssessmentContentV2 {
  return { schemaVersion: 2, verifierVersion: "ortho-assessment-payload-2.2.0", draft,
    results: draft.analyses.map(selection => {
      const checked = deriveDraftAnalysisV2(draft, draft.measurementSets.find(set => set.id === selection.measurementSetId), selection);
      if (!checked.ok) throw Error(checked.code);
      return { analysisId: selection.id, result: checked.value, resultHash: assessmentJsonHash(checked.value) };
    }) };
}
