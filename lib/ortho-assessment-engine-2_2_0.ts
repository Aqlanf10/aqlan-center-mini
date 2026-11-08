/** Adds a versioned prediction without changing engine2.1.0 or any old witness. */
import { keys, plain, type Checked } from "./ortho-assessment-model";
import { checkVersionedAssessmentDraftV2, type VersionedAssessmentDraftV2, type AssessmentMeasurementSetV2, type VersionedDraftAnalysisSelectionV2 } from "./ortho-assessment-measurement-set-v2";
import { deriveDraftAnalysisV2 as deriveLegacy, type DraftAnalysisReadinessV2 as LegacyReadiness,
  type AssessmentResultWitnessV2 as LegacyWitness, type MissingAnalysisInputV2 as LegacyMissing,
  type AssessmentReferenceV2 as LegacyReference, type AssessmentArithmeticResultV2 as LegacyArithmetic } from "./ortho-assessment-engine-2_1_0";
import { INCISORS, tanakaArchSpace, type Width } from "./ortho-assessment-tanaka-1974-v1";

export const ASSESSMENT_ENGINE_VERSION = "ortho-model-2.2.0" as const;
export const TANAKA_REFERENCE = {
  id: "tanaka_johnston_1974", version: 1, kind: "prediction",
  source: "Tanaka & Johnston1974, DOI10.14219/jada.archive.1974.0158, pp798–801",
  sourceUrl: "https://uwcscholar.uwc.ac.za/bitstreams/f992423a-c0f1-44d8-86d1-128545c59ccd/download",
  sourceVerification: "primary_verified", review: "unapproved", populationApplicability: "not_assessed",
  policyVersion: "tanaka_whole_arch_mixed_v1", supportedPredictorDomainMm: { min: 20.5, max: 27 },
} as const;
export const TANAKA_SEGMENT_TEETH = { upper: [13, 14, 15, 23, 24, 25], lower: [33, 34, 35, 43, 44, 45] } as const;
type Prediction = Extract<ReturnType<typeof tanakaArchSpace>, { ok: true }>["value"];
export type AssessmentReferenceV2 = LegacyReference | typeof TANAKA_REFERENCE;
export type AssessmentArithmeticResultV2 = LegacyArithmetic | ({ state: "calculated" } & Prediction);
export type AssessmentResultWitnessV2 = LegacyWitness | {
  formula: { engineVersion: typeof ASSESSMENT_ENGINE_VERSION; formulaVersion: "tanaka_johnston_1974_approximation_v1" };
  result: { state: "calculated" } & Prediction; reference: typeof TANAKA_REFERENCE; clinicalApproval: "unapproved";
};
export type MissingAnalysisInputV2 = LegacyMissing | { kind: "unerupted_segment_status"; tooth: number; observationId: string | null };
export type DraftAnalysisReadinessV2 = Exclude<LegacyReadiness, { state: "ready" | "incomplete" | "inapplicable" }>
  | { state: "incomplete"; dependencyObservationIds: string[]; missing: MissingAnalysisInputV2[] }
  | { state: "inapplicable"; dependencyObservationIds: string[]; tooth: number;
    reason: "tooth_absent" | "not_erupted" | "segment_width_already_measured" | "target_not_applicable" }
  | { state: "outside_supported_predictor_domain"; dependencyObservationIds: string[]; predictorSumMm: number; minimumMm: 20.5; maximumMm: 27; policyVersion: "tanaka_whole_arch_mixed_v1" }
  | { state: "ready"; dependencyObservationIds: string[]; witness: AssessmentResultWitnessV2 };
const result = (value: DraftAnalysisReadinessV2): Checked<DraftAnalysisReadinessV2> => ({ ok: true, value });

export function deriveDraftAnalysisV2(content: VersionedAssessmentDraftV2, set: AssessmentMeasurementSetV2 | undefined, selection: VersionedDraftAnalysisSelectionV2): Checked<DraftAnalysisReadinessV2> {
  // Validate the complete versioned input before projecting an old-method call.
  // Filtering must never hide an invalid unrelated selection.
  const checked = checkVersionedAssessmentDraftV2(content); if (!checked.ok) return checked;
  if (selection?.method !== "tanaka_johnston_1974") return deriveLegacy({
    ...checked.value, analyses: checked.value.analyses.filter(a => a.method !== "tanaka_johnston_1974"),
  }, set, selection);
  if (!plain(selection) || !keys(selection, ["state", "id", "measurementSetId", "method", "arch"]) || selection.state !== "draft")
    return { ok: false, code: "analysis_selection_changed" };
  const draft = checked.value, chosen = draft.analyses.find(a => a.id === selection.id);
  if (!chosen || chosen.method !== selection.method || chosen.arch !== selection.arch || chosen.measurementSetId !== selection.measurementSetId)
    return { ok: false, code: "analysis_selection_changed" };
  const owned = draft.measurementSets.find(s => s.id === selection.measurementSetId);
  if (!owned || !set || set.id !== owned.id) return { ok: false, code: "measurement_set_unavailable" };
  const rows = draft.observations.observations, dependencies: string[] = [], missing: MissingAnalysisInputV2[] = [];
  const take = (id: string | null) => {
    if (id !== null && !dependencies.includes(id)) dependencies.push(id);
    return rows.find(r => r.id === id);
  };
  const dentition = take(draft.observations.dentitionObservationId);
  if (!dentition || dentition.value.state !== "recorded") missing.push({ kind: "dentition", observationId: draft.observations.dentitionObservationId });
  else if (dentition.value.text !== "mixed") return result({ state: "unsupported_dentition", dependencyObservationIds: dependencies });
  const toothRow = (tooth: number) => {
    const row = rows.find(r => owned.toothWidthObservationIds.includes(r.id) && r.definition === "mesiodistal_width" && r.target.kind === "tooth" && r.target.tooth === tooth);
    if (row) take(row.id); return row;
  };
  const predictor: Width[] = [], target: Width[] = [];
  for (const tooth of new Set<number>([...INCISORS.lower, ...INCISORS[selection.arch]])) {
    const row = toothRow(tooth);
    if (row?.value.state === "tooth_absent" || row?.value.state === "not_erupted")
      return result({ state: "inapplicable", dependencyObservationIds: dependencies, tooth, reason: row.value.state });
    if (!row || row.value.state !== "measured") missing.push({ kind: "tooth_width", tooth, observationId: row?.id ?? null });
    else {
      if (INCISORS.lower.some(t => t === tooth)) predictor.push({ tooth, value: row.value.value });
      if (INCISORS[selection.arch].some(t => t === tooth)) target.push({ tooth, value: row.value.value });
    }
  }
  // This first supported variant predicts two entire unerupted segments. Never
  // replace a known width or invent an unvalidated partial-eruption hybrid.
  for (const tooth of TANAKA_SEGMENT_TEETH[selection.arch]) {
    const row = toothRow(tooth);
    if (row?.value.state === "tooth_absent" || row?.value.state === "not_applicable" || row?.value.state === "measured")
      return result({ state: "inapplicable", dependencyObservationIds: dependencies, tooth,
        reason: row.value.state === "measured" ? "segment_width_already_measured" : row.value.state === "tooth_absent" ? "tooth_absent" : "target_not_applicable" });
    if (!row || row.value.state !== "not_erupted") missing.push({ kind: "unerupted_segment_status", tooth, observationId: row?.id ?? null });
  }
  const availableId = selection.arch === "upper" ? owned.upperAvailableObservationId : owned.lowerAvailableObservationId;
  const available = take(availableId);
  if (!available || available.value.state !== "measured") missing.push({ kind: "available_space", arch: selection.arch, observationId: availableId });
  if (missing.length) return result({ state: "incomplete", dependencyObservationIds: dependencies, missing });
  if (!available || available.value.state !== "measured") return { ok: false, code: "available_space_unavailable" };
  const arithmetic = tanakaArchSpace(selection.arch, predictor, target, available.value.value); if (!arithmetic.ok) return arithmetic;
  if (!arithmetic.value.withinPublishedTablePredictorDomain) return result({ state: "outside_supported_predictor_domain", dependencyObservationIds: dependencies,
    predictorSumMm: arithmetic.value.measuredLowerIncisorSumMm, minimumMm: 20.5, maximumMm: 27, policyVersion: "tanaka_whole_arch_mixed_v1" });
  return result({ state: "ready", dependencyObservationIds: dependencies, witness: {
    formula: { engineVersion: ASSESSMENT_ENGINE_VERSION, formulaVersion: "tanaka_johnston_1974_approximation_v1" },
    result: { state: "calculated", ...arithmetic.value }, reference: structuredClone(TANAKA_REFERENCE), clinicalApproval: "unapproved",
  } });
}
