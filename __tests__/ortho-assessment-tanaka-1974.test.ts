import { describe, expect, it } from "vitest";
import { deriveDraftAnalysisV2 } from "../lib/ortho-assessment-engine-v2";
import { deriveDraftAnalysisV2 as deriveLegacy } from "../lib/ortho-assessment-engine-2_1_0";
import { INCISORS, tanakaArchSpace } from "../lib/ortho-assessment-tanaka-1974-v1";
import { assessmentJsonHash, createPersistedAssessmentV2 } from "../lib/ortho-assessment-persisted-v2";
import { decodePersistedAssessmentV2Structure } from "../lib/ortho-assessment-read-v2";
import { tanakaCommandV2 } from "./fixtures/ortho-assessment-tanaka";
import { assessmentCommandV2 } from "./fixtures/ortho-assessment-schema2";
const derive = (draft = tanakaCommandV2().content, index = 0) => deriveDraftAnalysisV2(draft, draft.measurementSets[0], draft.analyses[index]);
const row = (draft: ReturnType<typeof tanakaCommandV2>["content"], id: string) => draft.observations.observations.find(r => r.id === id)!;
const widths = (teeth: readonly number[], value: number) => teeth.map(tooth => ({ tooth, value }));

describe("versioned Tanaka–Johnston arithmetic and admission", () => {
  it("uses actual target incisors and reports per-quadrant predictions separately", () => {
    const draft = tanakaCommandV2().content, before = JSON.stringify(draft);
    expect(derive(draft)).toMatchObject({ ok: true, value: { state: "ready", witness: {
      formula: { engineVersion: "ortho-model-2.2.1" }, clinicalApproval: "unapproved",
      result: { measuredLowerIncisorSumMm: 22, measuredTargetIncisorSumMm: 30,
        predictedCaninePremolarPerQuadrantMm: 22, predictedBothQuadrantsMm: 44,
        estimatedRequiredMm: 74, measuredAvailableMm: 72, availableMinusEstimatedRequiredMm: -2 },
    } } });
    expect(derive(draft, 1)).toMatchObject({ ok: true, value: { state: "ready", witness: { result: {
      predictedCaninePremolarPerQuadrantMm: 21.5, predictedBothQuadrantsMm: 43, estimatedRequiredMm: 65,
      measuredTargetIncisorSumMm: 22, measuredAvailableMm: 63, availableMinusEstimatedRequiredMm: -2,
    } } } });
    expect(JSON.stringify(draft)).toBe(before);
  });
  it("retains full precision and canonical tooth ordering independently of clinical admission", () => {
    // Decimal hand calculation:20.13/2+11=21.065;31.17+42.13=73.30.
    const lower = INCISORS.lower.map((tooth, i) => ({ tooth, value: [5.01, 5.02, 5.03, 5.07][i] }));
    const upper = INCISORS.upper.map((tooth, i) => ({ tooth, value: [8.01, 7.02, 8.03, 8.11][i] }));
    const checked = tanakaArchSpace("upper", lower, upper, 70.15); if (!checked.ok) throw Error(checked.code);
    expect(checked.value.predictedCaninePremolarPerQuadrantMm).toBeCloseTo(21.065, 10);
    expect(checked.value.estimatedRequiredMm).toBeCloseTo(73.30, 10);
    expect(checked.value.availableMinusEstimatedRequiredMm).toBeCloseTo(-3.15, 10);
    expect(checked.value.withinPublishedTablePredictorDomain).toBe(false);
    expect(tanakaArchSpace("upper", [...lower].reverse(), [...upper].reverse(), 70.15)).toEqual(checked);
  });
  it.each([0, -1, NaN, Infinity, "5.5"])("rejects invalid measured width%s without coercion", value => {
    expect(tanakaArchSpace("upper", widths(INCISORS.lower, value as number), widths(INCISORS.upper, 7), 70).ok).toBe(false);
  });
  it("rejects missing, duplicate, foreign and conflicting incisor inputs", () => {
    const lower = widths(INCISORS.lower, 5.5), upper = widths(INCISORS.upper, 7.5);
    for (const invalid of [lower.slice(1), [...lower, lower[0]], lower.map((r, i) => i === 0 ? { ...r, tooth: 11 } : r)])
      expect(tanakaArchSpace("upper", invalid, upper, 70).ok).toBe(false);
    expect(tanakaArchSpace("lower", lower, widths(INCISORS.lower, 6), 70)).toEqual({ ok: false, code: "conflicting_lower_incisor_measurements" });
  });
  it.each([-1, NaN, Infinity, null, "70"])("rejects invalid available space%s", value => {
    expect(tanakaArchSpace("upper", widths(INCISORS.lower, 5.5), widths(INCISORS.upper, 7.5), value as number).ok).toBe(false);
  });
  it("accepts an explicitly measured zero available space without replacing any missing tooth", () => {
    const draft = tanakaCommandV2().content; row(draft, "available_upper").value = { state: "measured", value: 0 };
    expect(derive(draft)).toMatchObject({ ok: true, value: { state: "ready", witness: { result: { availableMinusEstimatedRequiredMm: -74 } } } });
  });
  it("requires actual upper incisor data rather than substituting the lower sum", () => {
    const draft = tanakaCommandV2().content; row(draft, "width_12").value = { state: "unknown", reason: "Synthetic not supplied" };
    expect(derive(draft)).toMatchObject({ ok: true, value: { state: "incomplete", missing: [{ kind: "tooth_width", tooth: 12, observationId: "width_12" }] } });
    expect(derive(draft, 1)).toMatchObject({ ok: true, value: { state: "ready" } });
  });
  it.each(["primary", "permanent"])("does not apply the mixed variant to%s dentition", dentition => {
    const draft = tanakaCommandV2().content; row(draft, "dentition").value = { state: "recorded", text: dentition };
    expect(derive(draft)).toMatchObject({ ok: true, value: { state: "unsupported_dentition" } });
  });
  it.each(["tooth_absent", "not_erupted"] as const)("preserves inapplicable incisor state%s", state => {
    const draft = tanakaCommandV2().content; row(draft, "width_31").value = { state, reason: "Synthetic documented state" };
    expect(derive(draft)).toMatchObject({ ok: true, value: { state: "inapplicable", tooth: 31, reason: state } });
  });
  it.each(["unknown", "unavailable", "not_measured"] as const)("does not infer unerupted teeth from%s", state => {
    const draft = tanakaCommandV2().content; row(draft, "width_13").value = { state, reason: "Synthetic unavailable status" };
    expect(derive(draft)).toMatchObject({ ok: true, value: { state: "incomplete", missing: [{ kind: "unerupted_segment_status", tooth: 13 }] } });
  });
  it("will not replace a measured segment tooth or an absent tooth with a prediction", () => {
    const draft = tanakaCommandV2().content; row(draft, "width_13").value = { state: "measured", value: 7 };
    expect(derive(draft)).toMatchObject({ ok: true, value: { state: "inapplicable", tooth: 13, reason: "segment_width_already_measured" } });
    row(draft, "width_13").value = { state: "tooth_absent", reason: "Synthetic absent" };
    expect(derive(draft)).toMatchObject({ ok: true, value: { state: "inapplicable", tooth: 13, reason: "tooth_absent" } });
  });
  it.each([[20.5, "ready"], [27, "ready"], [20.4, "outside_supported_predictor_domain"], [27.1, "outside_supported_predictor_domain"]] as const)("enforces the explicit product domain at%smm", (sum, state) => {
    const draft = tanakaCommandV2().content; for (const tooth of INCISORS.lower) row(draft, `width_${tooth}`).value = { state: "measured", value: sum / 4 };
    expect(derive(draft)).toMatchObject({ ok: true, value: { state } });
  });
  it("captures only real dependency observations and refuses forged selection ownership", () => {
    const draft = tanakaCommandV2().content, upper = derive(draft); if (!upper.ok) throw Error(upper.code);
    expect(upper.value.dependencyObservationIds).toHaveLength(16);
    expect(upper.value.dependencyObservationIds).not.toContain("available_lower");
    expect(upper.value.dependencyObservationIds).not.toContain("width_18");
    expect(deriveDraftAnalysisV2(draft, draft.measurementSets[0], { ...draft.analyses[0], arch: "lower" } as typeof draft.analyses[number]))
      .toEqual({ ok: false, code: "analysis_selection_changed" });
  });
});

describe("historical result witness compatibility", () => {
  it("preserves old payload bytes, result hashes and engine2.1.0 witnesses", () => {
    const draft = assessmentCommandV2().content;
    const expected = { schemaVersion: 2, verifierVersion: "ortho-assessment-payload-2.1.0", draft, results: draft.analyses.map(selection => {
      const checked = deriveLegacy(draft, draft.measurementSets[0], selection); if (!checked.ok) throw Error(checked.code);
      return { analysisId: selection.id, result: checked.value, resultHash: assessmentJsonHash(checked.value) };
    }) };
    const actual = createPersistedAssessmentV2(draft); if (!actual.ok) throw Error(actual.code);
    expect(JSON.stringify(actual.value)).toBe(JSON.stringify(expected));
    expect(decodePersistedAssessmentV2Structure(expected)).toEqual(actual);
  });
  it("opts into2.2.1 only for the explicit new method and rejects old-verifier relabeling", () => {
    const saved = createPersistedAssessmentV2(tanakaCommandV2().content); if (!saved.ok) throw Error(saved.code);
    expect(saved.value.verifierVersion).toBe("ortho-assessment-payload-2.2.1");
    expect(decodePersistedAssessmentV2Structure(saved.value)).toEqual(saved);
    expect(decodePersistedAssessmentV2Structure({ ...saved.value, verifierVersion: "ortho-assessment-payload-2.1.0" }))
      .toEqual({ ok: false, code: "method_not_supported_by_payload_verifier" });
    const forged = structuredClone(saved.value); forged.results[0].resultHash = "a".repeat(64);
    const result = forged.results[0].result;
    if (result.state !== "ready" || result.witness.result.state !== "calculated" || result.witness.result.method !== "tanaka_johnston_1974_approximation_v1") throw Error("wrong fixture");
    result.witness.result.estimatedRequiredMm = 999;
    forged.results[0].resultHash = assessmentJsonHash(result);
    expect(decodePersistedAssessmentV2Structure(forged)).toEqual({ ok: false, code: "result_reconstruction_mismatch" });
  });
  it("does not activate the historical disabled Tanaka selection", () => {
    const draft = assessmentCommandV2().content;
    draft.analyses = [{ state: "draft", id: "old_tanaka", measurementSetId: "current", method: "tanaka_johnston" }];
    expect(createPersistedAssessmentV2(draft)).toMatchObject({ ok: true, value: { verifierVersion: "ortho-assessment-payload-2.1.0",
      results: [{ result: { state: "ready", witness: { result: { state: "unavailable" }, formula: { engineVersion: "ortho-model-2.1.0" } } } }] } });
  });
});
