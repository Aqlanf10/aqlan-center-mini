import { describe, expect, it } from "vitest";
import { deriveDraftAnalysisV2 } from "../lib/ortho-assessment-engine-v2";
import { deriveDraftAnalysisV2 as derive2_2_0 } from "../lib/ortho-assessment-engine-2_2_0";
import { assessmentJsonHash, createPersistedAssessmentV2 } from "../lib/ortho-assessment-persisted-v2";
import { decodePersistedAssessmentV2Structure } from "../lib/ortho-assessment-read-v2";
import { confirmAssessmentAppendV2 } from "../lib/ortho-assessment-response-v2";
import { tanakaCommandV2 } from "./fixtures/ortho-assessment-tanaka";
import { tanakaArchSpaceWithDecimalDomainV2 } from "../lib/ortho-assessment-tanaka-domain-v2";

function command(widths: number[]) {
  const command = tanakaCommandV2();
  for (const [i, tooth] of [31, 32, 41, 42].entries()) command.content.observations.observations.find(r => r.id === `width_${tooth}`)!.value = { state: "measured", value: widths[i] };
  return command;
}
function derive(widths: number[], historical = false) {
  const draft = command(widths).content;
  return (historical ? derive2_2_0 : deriveDraftAnalysisV2)(draft, draft.measurementSets[0], draft.analyses[0]);
}
function historicalPayload(widths: number[]) {
  const draft = command(widths).content;
  return { schemaVersion: 2 as const, verifierVersion: "ortho-assessment-payload-2.2.0" as const, draft,
    results: draft.analyses.map(selection => {
      const result = derive2_2_0(draft, draft.measurementSets[0], selection); if (!result.ok) throw Error(result.code);
      return { analysisId: selection.id, result: result.value, resultHash: assessmentJsonHash(result.value) };
    }) };
}
const endpoints = [
  { widths: [4, 4.06, 5.97, 6.47], sum: 20.5, upperPrediction: 21.25 },
  { widths: [4.03, 7, 7.99, 7.98], sum: 27, upperPrediction: 24.5 },
];
describe("versioned canonical-decimal Tanaka predictor admission", () => {
  it.each(endpoints)("accepts the exact decimal endpoint $sum while leaving historical refusal unchanged", ({ widths, upperPrediction }) => {
    expect(derive(widths, true)).toMatchObject({ ok: true, value: { state: "outside_supported_predictor_domain" } });
    const result = derive(widths); expect(result).toMatchObject({ ok: true, value: { state: "ready", witness: {
      formula: { engineVersion: "ortho-model-2.2.1" }, clinicalApproval: "unapproved",
      reference: { policyVersion: "tanaka_whole_arch_mixed_decimal_v2", populationApplicability: "not_assessed" },
      result: { withinPublishedTablePredictorDomain: true },
    } } });
    if (!result.ok || result.value.state !== "ready" || result.value.witness.result.state !== "calculated" || result.value.witness.result.method !== "tanaka_johnston_1974_approximation_v1") throw Error("missing Tanaka result");
    expect(result.value.witness.result.predictedCaninePremolarPerQuadrantMm).toBeCloseTo(upperPrediction, 11);
  });
  it.each([
    [4, 4.06, 5.97, 6.46999999999999],
    [4.03, 7, 7.99, 7.98000000000001],
  ])("does not widen the domain with rounded or epsilon admission: %j", (...widths) => {
    expect(derive(widths)).toMatchObject({ ok: true, value: { state: "outside_supported_predictor_domain", policyVersion: "tanaka_whole_arch_mixed_decimal_v2" } });
  });
  it.each([
    [5, 5, 5, 5.499999999999999],
    [6, 7, 7, 7.000000000000001],
  ])("rejects canonical decimals outside the domain even when binary sum equals the endpoint: %j", (...widths) => {
    expect(derive(widths, true)).toMatchObject({ ok: true, value: { state: "ready" } });
    expect(derive(widths)).toMatchObject({ ok: true, value: { state: "outside_supported_predictor_domain" } });
  });
  it("handles canonical exponential notation without rounding away tiny positive widths", () => {
    const widths = (values: number[]) => [31, 32, 41, 42].map((tooth, i) => ({ tooth, value: values[i] }));
    const exact = widths([1e-7, 6.5, 7, 6.9999999]);
    expect(tanakaArchSpaceWithDecimalDomainV2("lower", exact, exact, 80)).toMatchObject({ ok: true, value: { withinPublishedTablePredictorDomain: true } });
    const above = widths([5e-324, 9, 9, 9]);
    expect(tanakaArchSpaceWithDecimalDomainV2("lower", above, above, 80)).toMatchObject({ ok: true, value: { withinPublishedTablePredictorDomain: false } });
  });
  it("uses the new verifier only for newly created Tanaka payloads", () => {
    const saved = createPersistedAssessmentV2(command(endpoints[0].widths).content); if (!saved.ok) throw Error(saved.code);
    expect(saved.value.verifierVersion).toBe("ortho-assessment-payload-2.2.1");
    expect(decodePersistedAssessmentV2Structure(saved.value)).toEqual(saved);
    expect(decodePersistedAssessmentV2Structure({ ...saved.value, verifierVersion: "ortho-assessment-payload-2.2.0" }))
      .toEqual({ ok: false, code: "result_reconstruction_mismatch" });
  });
  it.each([...endpoints.map(e => e.widths), [5.5, 5.5, 5.5, 5.5]])("reconstructs old payload bytes and hashes unchanged: %j", (...widths) => {
    const payload = historicalPayload(widths), bytes = JSON.stringify(payload), hash = assessmentJsonHash(payload);
    const decoded = decodePersistedAssessmentV2Structure(payload); if (!decoded.ok) throw Error(decoded.code);
    expect(JSON.stringify(decoded.value)).toBe(bytes); expect(assessmentJsonHash(decoded.value)).toBe(hash);
  });
  it("is independent of input observation and tooth-membership order", () => {
    const draft = command(endpoints[0].widths).content;
    const first = deriveDraftAnalysisV2(draft, draft.measurementSets[0], draft.analyses[0]);
    draft.observations.observations.reverse(); draft.measurementSets[0].toothWidthObservationIds.reverse();
    expect(deriveDraftAnalysisV2(draft, draft.measurementSets[0], draft.analyses[0])).toEqual(first);
  });
  it("acknowledges old request replay and new browser witnesses using their stored verifier", async () => {
    const authored = command(endpoints[0].widths), previous = historicalPayload(endpoints[0].widths);
    const current = createPersistedAssessmentV2(authored.content); if (!current.ok) throw Error(current.code);
    const scope = { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3 };
    for (const content of [previous, current.value]) {
      const revision = { ...scope, id: 4, recordedPatientId: 1, schemaVersion: 2, version: 1, supersedesRevisionId: null,
        createdAt: "2026-11-05T00:00:00.000Z", createdBy: "Synthetic examiner", reason: authored.reason,
        recordingContext: "current", contentHash: assessmentJsonHash(content), content };
      const confirmed = await confirmAssessmentAppendV2({ ok: true, replayed: content === previous, revision },
        { scope, command: authored, previousVersion: 0 });
      expect(confirmed).toEqual({ ok: true, value: { revision, replayed: content === previous } });
    }
  });
  it("rejects a forged new domain result even if its hash is recalculated", () => {
    const saved = createPersistedAssessmentV2(command(endpoints[0].widths).content); if (!saved.ok) throw Error(saved.code);
    const forged = structuredClone(saved.value), entry = forged.results[0];
    if (entry.result.state !== "ready" || entry.result.witness.result.state !== "calculated" || entry.result.witness.result.method !== "tanaka_johnston_1974_approximation_v1") throw Error("wrong synthetic fixture");
    entry.result.witness.result.withinPublishedTablePredictorDomain = false;
    entry.resultHash = assessmentJsonHash(entry.result);
    expect(decodePersistedAssessmentV2Structure(forged)).toEqual({ ok: false, code: "result_reconstruction_mismatch" });
  });
});
