import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { presentSavedModelAnalysis, STUDY_MODEL_ANALYSIS_PRESENTATION, type SavedStudyModelAnalysis } from "../lib/ortho-study-model-analysis-presentation";
import { DISABLED_ASSESSMENT_METHODS } from "../lib/ortho-assessment-measurement-set-v2";
import { TANAKA_REFERENCE as currentReference } from "../lib/ortho-assessment-engine-2_2_1";
import { TANAKA_REFERENCE as historicalReference } from "../lib/ortho-assessment-engine-2_2_0";
import { createPersistedAssessmentV2, assessmentJsonHash, type AssessmentRevisionV2 } from "../lib/ortho-assessment-persisted-v2";
import { projectStudyAssessment } from "../lib/ortho-case-study-assessment-projection";
import { assessmentCommandV2 } from "./fixtures/ortho-assessment-schema2";

type Result = SavedStudyModelAnalysis["stored"]["result"];
type Selection = SavedStudyModelAnalysis["selection"];
const selection: Selection = { id: "selected", state: "draft", measurementSetId: "measurements", method: "arch_space", arch: "upper" };
function saved(result: Result, selected: Selection = selection): SavedStudyModelAnalysis {
  return { selection: structuredClone(selected), stored: { analysisId: selected.id, result,
    resultHash: createHash("sha256").update(JSON.stringify(result)).digest("hex") }, clinicalApproval: "unapproved" };
}
const space = (difference = -1) => saved({ state: "ready", dependencyObservationIds: ["width_11", "available_upper"], witness: {
  formula: { engineVersion: "ortho-model-2.1.0", formulaVersion: "available_minus_required_v2" }, reference: null, clinicalApproval: "unapproved",
  result: { state: "calculated", method: "arch_space", arch: "upper", availableMm: 70, requiredMm: 71.000004, availableMinusRequiredMm: difference },
} });
const bolton = (method: "bolton_anterior" | "bolton_overall") => saved({ state: "ready", dependencyObservationIds: ["width_11", "width_31"], witness: {
  formula: { engineVersion: "ortho-model-2.1.0", formulaVersion: "bolton_lower_over_upper_v1" }, clinicalApproval: "unapproved",
  reference: { id: `synthetic_${method}`, version: 1, percent: method === "bolton_anterior" ? 77.2 : 91.3, source: "Synthetic recorded original reference", sourceVerification: "primary_verified", review: "unapproved" },
  result: { state: "calculated", method, upperMm: 43, lowerMm: 42, ratioPercent: 97.67441860465117,
    upperReference: { lowerMinusExpectedMm: 1.123456789 }, lowerReference: { upperMinusExpectedMm: -2.987654321 } },
} }, { id: "selected", state: "draft", measurementSetId: "measurements", method });
function tanaka(historical = false, withinDomain = true): SavedStudyModelAnalysis {
  const result = { state: "calculated" as const, method: "tanaka_johnston_1974_approximation_v1" as const, arch: "upper" as const,
    measuredLowerIncisorSumMm: 20.5, measuredTargetIncisorSumMm: 30.1234567, predictedCaninePremolarPerQuadrantMm: 21.25,
    predictedBothQuadrantsMm: 42.5, estimatedRequiredMm: 72.6234567, measuredAvailableMm: 70,
    availableMinusEstimatedRequiredMm: -2.6234567, withinPublishedTablePredictorDomain: withinDomain };
  return saved({ state: "ready", dependencyObservationIds: ["width_31", "width_11", "available_upper"], witness: historical ? {
    formula: { engineVersion: "ortho-model-2.2.0", formulaVersion: "tanaka_johnston_1974_approximation_v1" },
    result, reference: structuredClone(historicalReference), clinicalApproval: "unapproved",
  } : { formula: { engineVersion: "ortho-model-2.2.1", formulaVersion: "tanaka_johnston_1974_decimal_domain_v2" },
    result, reference: structuredClone(currentReference), clinicalApproval: "unapproved" } },
  { id: "selected", state: "draft", measurementSetId: "measurements", method: "tanaka_johnston_1974", arch: "upper" });
}
const values = (input: SavedStudyModelAnalysis) => presentSavedModelAnalysis(input).clinicalRows.map(row => row[1]);

describe("saved model-analysis clinical presentation", () => {
  it("accepts the actual saved projection without rehashing its canonically reordered witness", () => {
    const content = createPersistedAssessmentV2(assessmentCommandV2().content);
    if (!content.ok) throw Error(content.code);
    const revision: AssessmentRevisionV2 = { schemaVersion: 2, id: 101, patientId: 102, recordedPatientId: 102,
      orthoCaseId: 103, clinicalCaseId: 104, version: 1, supersedesRevisionId: null,
      createdAt: "2026-11-10T00:00:00.000Z", createdBy: "Synthetic reviewer", reason: "Synthetic projection compatibility",
      recordingContext: "current", contentHash: assessmentJsonHash(content.value), content: content.value };
    const projected = projectStudyAssessment(revision, { measurementSetIds: ["current"], analysisIds: content.value.draft.analyses.map(row => row.id) });
    expect(projected.analyses).toHaveLength(4);
    for (const input of projected.analyses) {
      const original = content.value.results.find(row => row.analysisId === input.selection.id)!;
      expect(input.stored.resultHash).toBe(original.resultHash);
      expect(input.stored.resultHash).not.toBe(assessmentJsonHash(input.stored.result)); // Key order differs, values do not.
      const actual = presentSavedModelAnalysis(input);
      expect(actual.exactWitness).toEqual({ selection: input.selection, stored: input.stored });
      expect(actual.provenanceRows).toContainEqual(["بصمة النتيجة SHA256", original.resultHash]);
    }
  });
  it.each([-1, 0, 2.3456789])("preserves exact arch-space values and signed difference %s without recalculation or rounding", difference => {
    const input = space(difference), actual = presentSavedModelAnalysis(input);
    expect(actual.version).toBe(STUDY_MODEL_ANALYSIS_PRESENTATION);
    expect(actual.title).toBe("تحليل المسافة / Arch space");
    expect(actual.clinicalRows).toContainEqual(["المسافة المطلوبة / Required space", "71.000004 mm"]);
    expect(actual.clinicalRows).toContainEqual(["المسافة المتاحة / Available space", "70 mm"]);
    // This presentation fixture deliberately supplies an independently recorded
    // difference; the helper must display it, not silently derive available-required.
    expect(actual.clinicalRows).toContainEqual(["المتاح ناقص المطلوب / Available − required", `${difference} mm`]);
    expect(actual.provenanceRows).toContainEqual(["مرجع النتيجة المحفوظ", "لا يوجد مرجع مسجل في هذه النتيجة"]);
    expect(actual.provenanceRows).toContainEqual(["بصمة النتيجة SHA256", input.stored.resultHash]);
    expect(JSON.stringify(actual.clinicalRows)).not.toMatch(/requiredMm|availableMinusRequiredMm|dependencyObservationIds/);
  });
  it.each(["bolton_anterior", "bolton_overall"] as const)("keeps both reference-relative signed differences distinct for %s", method => {
    const actual = presentSavedModelAnalysis(bolton(method));
    expect(actual.clinicalRows).toEqual(expect.arrayContaining([
      ["مجموع عروض الأسنان العلوية / Upper sum", "43 mm"], ["مجموع عروض الأسنان السفلية / Lower sum", "42 mm"],
      ["نسبة السفلي إلى العلوي / Lower-to-upper ratio", "97.67441860465117 %"],
      ["السفلي ناقص السفلي المتوقع بمرجع علوي / Lower − expected lower", "1.123456789 mm"],
      ["العلوي ناقص العلوي المتوقع بمرجع سفلي / Upper − expected upper", "-2.987654321 mm"],
      ["النسبة المرجعية المحفوظة / Stored reference ratio", method === "bolton_anterior" ? "77.2 %" : "91.3 %"],
    ]));
    expect(actual.provenanceRows).toContainEqual(["المصدر كما حُفظ", "Synthetic recorded original reference"]);
    expect(JSON.stringify(actual.clinicalRows)).not.toMatch(/extraction|IPR|crowding|تزاحم|قلع|إجراء مطلوب/i);
  });
  it.each([false, true])("preserves complete measured/predicted Tanaka values and historical=%s reference witness", historical => {
    const input = tanaka(historical), actual = presentSavedModelAnalysis(input);
    expect(values(input)).toEqual(expect.arrayContaining(["20.5 mm", "30.1234567 mm", "21.25 mm", "42.5 mm", "72.6234567 mm", "70 mm", "-2.6234567 mm", "لم تُقيّم / Not assessed"]));
    expect(actual.clinicalRows).toContainEqual(["الناب والضاحكان لكل جهة — تقدير / Predicted segment per side", "21.25 mm"]);
    expect(actual.clinicalRows).toContainEqual(["ضمن مجال مدخل الجداول المنشورة — كما حُفظ", "نعم / Yes"]);
    expect(actual.provenanceRows).toContainEqual(["إصدار سياسة المجال المحفوظ", historical ? "tanaka_whole_arch_mixed_v1" : "tanaka_whole_arch_mixed_decimal_v2"]);
    expect(actual.provenanceRows).toContainEqual(["رابط المصدر كما حُفظ", currentReference.sourceUrl]);
    expect(actual.provenanceRows.some(([label]) => label === "أساس مقارنة المجال المحفوظ")).toBe(!historical);
    expect(actual.exactWitness).toEqual({ selection: input.selection, stored: input.stored });
    expect(presentSavedModelAnalysis(tanaka(historical, false)).clinicalRows).toContainEqual(["ضمن مجال مدخل الجداول المنشورة — كما حُفظ", "لا / No"]);
  });
  it.each(DISABLED_ASSESSMENT_METHODS)("keeps disabled selection %s unavailable with its original reason", method => {
    const input = saved({ state: "ready", dependencyObservationIds: ["dentition"], witness: {
      formula: { engineVersion: "ortho-model-2.1.0", formulaVersion: `${method}_disabled_reference_pending` },
      result: { state: "unavailable", reason: "Synthetic recorded protocol/reference pending reason" }, reference: null, clinicalApproval: "unapproved",
    } }, { id: "selected", state: "draft", measurementSetId: "measurements", method });
    expect(values(input)).toContain("الحساب غير متاح لهذا الاختيار / Calculation unavailable");
    expect(values(input)).toContain("Synthetic recorded protocol/reference pending reason");
    expect(values(input).some(value => /^0 (mm|%)$/.test(value))).toBe(false);
  });
  it("preserves every missing input in order without inventing a measurement or reference", () => {
    const input = saved({ state: "incomplete", dependencyObservationIds: ["dentition", "width_11"], missing: [
      { kind: "dentition", observationId: "dentition" }, { kind: "tooth_width", tooth: 11, observationId: "width_11" },
      { kind: "available_space", arch: "lower", observationId: null },
      { kind: "unerupted_segment_status", tooth: 13, observationId: null },
      { kind: "tooth_width", tooth: 11, observationId: "width_11" },
    ] });
    const actual = presentSavedModelAnalysis(input);
    expect(actual.clinicalRows.filter(([label]) => label.startsWith("المدخل الناقص"))).toEqual([
      ["المدخل الناقص 1", "نوع الأسنان / Dentition"], ["المدخل الناقص 2", "عرض السن — FDI 11"],
      ["المدخل الناقص 3", "المسافة المتاحة — سفلي / Lower"], ["المدخل الناقص 4", "توثيق حالة الجزء غير البازغ — FDI 13"],
      ["المدخل الناقص 5", "عرض السن — FDI 11"],
    ]);
    expect(actual.provenanceRows).toContainEqual(["مرجع المدخل الناقص 3", "لا يوجد مرجع ملاحظة مسجل"]);
    expect(actual.exactWitness.stored.result).toEqual(input.stored.result);
    expect(values(input).some(value => /^0 (mm|%)$/.test(value))).toBe(false);
  });
  it.each(["tooth_absent", "not_erupted", "segment_width_already_measured", "target_not_applicable"] as const)("does not invent a diagnosis for inapplicable reason %s", reason => {
    const input = saved({ state: "inapplicable", dependencyObservationIds: ["width_13"], tooth: 13, reason });
    const actual = presentSavedModelAnalysis(input);
    expect(actual.clinicalRows).toContainEqual(["السن المسجل", "FDI 13"]);
    expect(actual.clinicalRows.find(([label]) => label === "السبب المسجل")?.[1]).toBeTruthy();
    expect(actual.exactWitness.stored.result).toEqual(input.stored.result);
  });
  it.each(["tanaka_whole_arch_mixed_v1", "tanaka_whole_arch_mixed_decimal_v2"] as const)("shows recorded domain limits with policy %s without calling them normal", policyVersion => {
    const input = saved({ state: "outside_supported_predictor_domain", dependencyObservationIds: ["width_31"], predictorSumMm: 27.0000000001, minimumMm: 20.5, maximumMm: 27, policyVersion }, tanaka().selection);
    const actual = presentSavedModelAnalysis(input);
    expect(values(input)).toEqual(expect.arrayContaining(["27.0000000001 mm", "20.5 mm", "27 mm"]));
    expect(actual.provenanceRows).toContainEqual(["إصدار سياسة المجال المحفوظ", policyVersion]);
    expect(actual.clinicalRows).toContainEqual(["حدود التفسير", "هذا مجال دعم التطبيق للمدخل التنبؤي، وليس مجالًا طبيعيًا بيولوجيًا أو تشخيصًا."]);
  });
  it("does not guess the actual dentition from an unsupported state", () => {
    const actual = presentSavedModelAnalysis(saved({ state: "unsupported_dentition", dependencyObservationIds: ["dentition"] }));
    expect(actual.clinicalRows).toContainEqual(["حالة الحساب", "نوع الأسنان المسجل غير مدعوم لهذا التحليل / Unsupported recorded dentition"]);
    expect(JSON.stringify(actual.clinicalRows)).not.toMatch(/permanent|mixed|primary|دائمة|مختلطة|لبنية/);
  });
  it("always preserves the unapproved warning and makes an independent exact witness without mutating input", () => {
    for (const input of [space(), bolton("bolton_anterior"), tanaka(), saved({ state: "unsupported_dentition", dependencyObservationIds: [] })]) {
      const before = structuredClone(input), actual = presentSavedModelAnalysis(input);
      expect(actual.clinicalRows).toContainEqual(["الاعتماد السريري / Clinical approval", "مسودة حسابية؛ غير معتمدة سريريًا / Draft calculation; clinically unapproved"]);
      expect(input).toEqual(before);
      expect(actual.exactWitness.selection).not.toBe(input.selection);
      expect(actual.exactWitness.stored.result).not.toBe(input.stored.result);
      actual.exactWitness.stored.result.dependencyObservationIds.push("synthetic_later_mutation");
      expect(input).toEqual(before);
    }
  });
});

describe("strict saved-shape boundary", () => {
  it.each([
    ["unrecognized top-level field", (input: SavedStudyModelAnalysis) => Object.assign(input, { future: true })],
    ["clinical approval promotion", (input: SavedStudyModelAnalysis) => Object.assign(input, { clinicalApproval: "approved" })],
    ["selection mismatch", (input: SavedStudyModelAnalysis) => { input.selection.id = "another"; }],
    ["unknown selection", (input: SavedStudyModelAnalysis) => Object.assign(input.selection, { method: "future_analysis" })],
    ["invalid hash encoding", (input: SavedStudyModelAnalysis) => { input.stored.resultHash = "not-a-sha256"; }],
    ["new result field", (input: SavedStudyModelAnalysis) => Object.assign(input.stored.result, { future: true })],
    ["unknown state", (input: SavedStudyModelAnalysis) => Object.assign(input.stored.result, { state: "future_state" })],
    ["unknown nested calculation field", (input: SavedStudyModelAnalysis) => { if (input.stored.result.state === "ready") Object.assign(input.stored.result.witness.result, { future: true }); }],
    ["unknown engine", (input: SavedStudyModelAnalysis) => { if (input.stored.result.state === "ready") Object.assign(input.stored.result.witness.formula, { engineVersion: "future_engine" }); }],
    ["nonfinite measurement", (input: SavedStudyModelAnalysis) => { if (input.stored.result.state === "ready") Object.assign(input.stored.result.witness.result, { availableMm: Number.NaN }); }],
  ] as const)("refuses %s instead of a JSON fallback or silent omission", (name, mutate) => {
    const input = space(); mutate(input);
    // Keep an internally consistent hash except in its syntax test: unknown
    // shapes still fail independently of canonical source integrity validation.
    if (name !== "invalid hash encoding") input.stored.resultHash = createHash("sha256").update(JSON.stringify(input.stored.result)).digest("hex");
    expect(() => presentSavedModelAnalysis(input)).toThrow("invalid_saved_model_analysis_presentation");
  });
  it("refuses new reference fields even when the result hash is internally consistent", () => {
    const input = tanaka();
    if (input.stored.result.state !== "ready") throw Error("Synthetic fixture");
    Object.assign(input.stored.result.witness.reference!, { futurePopulationClaim: "approved" });
    input.stored.resultHash = createHash("sha256").update(JSON.stringify(input.stored.result)).digest("hex");
    expect(() => presentSavedModelAnalysis(input)).toThrow("invalid_saved_model_analysis_presentation");
  });
  it("has no runtime calculation, source lookup, database or rounding dependency", () => {
    const source = readFileSync(new URL("../lib/ortho-study-model-analysis-presentation.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/import\s+(?!type)[^;]+from\s+["'][^"']*(?:engine|arithmetic|persisted|store|db)[^"']*["']/);
    expect(source).not.toMatch(/\bderiveDraftAnalysis|\.toFixed\(|Math\.round\(/);
  });
});
