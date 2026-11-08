/** Admission correction for newly authored Tanaka results. Historical2.2.0,
 * its arithmetic and verifier remain unchanged and independently readable. */
import type { Checked } from "./ortho-assessment-model";
import { checkVersionedAssessmentDraftV2, type VersionedAssessmentDraftV2, type AssessmentMeasurementSetV2, type VersionedDraftAnalysisSelectionV2 } from "./ortho-assessment-measurement-set-v2";
import { deriveDraftAnalysisV2 as derive2_2_0, TANAKA_REFERENCE as REFERENCE_2_2_0,
  type DraftAnalysisReadinessV2 as LegacyReadiness, type AssessmentResultWitnessV2 as LegacyWitness,
  type AssessmentReferenceV2 as LegacyReference } from "./ortho-assessment-engine-2_2_0";
import { INCISORS, type Width } from "./ortho-assessment-tanaka-1974-v1";
import { TANAKA_DECIMAL_DOMAIN_POLICY, tanakaArchSpaceWithDecimalDomainV2 } from "./ortho-assessment-tanaka-domain-v2";
export { TANAKA_SEGMENT_TEETH } from "./ortho-assessment-engine-2_2_0";
export type { MissingAnalysisInputV2, AssessmentArithmeticResultV2 } from "./ortho-assessment-engine-2_2_0";

export const ASSESSMENT_ENGINE_VERSION = "ortho-model-2.2.1" as const;
export const TANAKA_REFERENCE = { ...REFERENCE_2_2_0, policyVersion: TANAKA_DECIMAL_DOMAIN_POLICY,
  predictorDomainComparison: "sum_of_canonical_decimal_inputs" } as const;
type Prediction = Extract<ReturnType<typeof tanakaArchSpaceWithDecimalDomainV2>, { ok: true }>["value"];
export type AssessmentReferenceV2 = LegacyReference | typeof TANAKA_REFERENCE;
export type AssessmentResultWitnessV2 = LegacyWitness | {
  formula: { engineVersion: typeof ASSESSMENT_ENGINE_VERSION; formulaVersion: "tanaka_johnston_1974_decimal_domain_v2" };
  result: { state: "calculated" } & Prediction; reference: typeof TANAKA_REFERENCE; clinicalApproval: "unapproved";
};
export type DraftAnalysisReadinessV2 = Exclude<LegacyReadiness, { state: "ready" | "outside_supported_predictor_domain" }>
  | { state: "ready"; dependencyObservationIds: string[]; witness: AssessmentResultWitnessV2 }
  | { state: "outside_supported_predictor_domain"; dependencyObservationIds: string[]; predictorSumMm: number;
    minimumMm: 20.5; maximumMm: 27; policyVersion: "tanaka_whole_arch_mixed_v1" | typeof TANAKA_DECIMAL_DOMAIN_POLICY };

export function deriveDraftAnalysisV2(content: VersionedAssessmentDraftV2, set: AssessmentMeasurementSetV2 | undefined, selection: VersionedDraftAnalysisSelectionV2): Checked<DraftAnalysisReadinessV2> {
  // Reuse every existing selection/ownership/source/applicability/eruption check.
  // Other methods keep their exact2.1.0 witnesses, not relabelled predictions.
  const legacy = derive2_2_0(content, set, selection);
  if (!legacy.ok || selection.method !== "tanaka_johnston_1974"
    || !["ready", "outside_supported_predictor_domain"].includes(legacy.value.state)) return legacy;
  const checked = checkVersionedAssessmentDraftV2(content); if (!checked.ok) return checked;
  const draft = checked.value, owned = draft.measurementSets.find(s => s.id === selection.measurementSetId)!;
  const widths = (teeth: readonly number[]): Width[] => teeth.map(tooth => {
    const row = draft.observations.observations.find(r => owned.toothWidthObservationIds.includes(r.id)
      && r.definition === "mesiodistal_width" && r.target.kind === "tooth" && r.target.tooth === tooth)!;
    // The pinned engine above proved these exact selected dependencies measured.
    if (row.value.state !== "measured") throw Error("tanaka_admission_dependency_changed");
    return { tooth, value: row.value.value };
  });
  const availableId = selection.arch === "upper" ? owned.upperAvailableObservationId : owned.lowerAvailableObservationId;
  const available = draft.observations.observations.find(r => r.id === availableId)!;
  if (available.value.state !== "measured") return { ok: false, code: "available_space_unavailable" };
  const arithmetic = tanakaArchSpaceWithDecimalDomainV2(selection.arch, widths(INCISORS.lower), widths(INCISORS[selection.arch]), available.value.value);
  if (!arithmetic.ok) return arithmetic;
  const dependencyObservationIds = legacy.value.dependencyObservationIds;
  if (!arithmetic.value.withinPublishedTablePredictorDomain) return { ok: true, value: {
    state: "outside_supported_predictor_domain", dependencyObservationIds,
    predictorSumMm: arithmetic.value.measuredLowerIncisorSumMm, minimumMm: 20.5, maximumMm: 27, policyVersion: TANAKA_DECIMAL_DOMAIN_POLICY,
  } };
  return { ok: true, value: { state: "ready", dependencyObservationIds, witness: {
    formula: { engineVersion: ASSESSMENT_ENGINE_VERSION, formulaVersion: "tanaka_johnston_1974_decimal_domain_v2" },
    result: { state: "calculated", ...arithmetic.value }, reference: structuredClone(TANAKA_REFERENCE), clinicalApproval: "unapproved",
  } } };
}
