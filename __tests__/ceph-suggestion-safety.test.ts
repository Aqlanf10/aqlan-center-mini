import { describe, expect, it } from "vitest";
import { computeAll, generateCephExpertDiagnosis, pixelsToMm, type MeasurementResult } from "../lib/ceph";
import { cephAcquisitionAge, createCephSuggestionLifetime, matchesCephSuggestionIdentity } from "../lib/ceph-suggestion-safety";

const reading = (code: string, value: number | null): MeasurementResult => ({
  code, value, ar: code, en: code, unit: "°", group: "sagittal", schools: [],
  display: value == null ? "—" : String(value), mean: 0, tol: 1, status: null, source: "synthetic",
});

describe("Ceph missing evidence remains unknown", () => {
  it.each([undefined, 9, 14, 24])("empty evidence does not imply normal anatomy, growth or treatment at age %s", (age) => {
    const result = generateCephExpertDiagnosis([], { age });
    expect(result.sagittalSkeletal).toMatchObject({ classification: "Indeterminate", severity: "unknown", maxilla: "unknown", mandible: "unknown" });
    expect(result.verticalSkeletal.pattern).toBe("Indeterminate");
    expect(result.verticalSkeletal.descriptionAr).toContain("غير محددة");
    expect(result.dentalAnalysis).toMatchObject({ upperIncisor: "unknown", lowerIncisor: "unknown" });
    expect(result.dentalAnalysis.interincisalAr).toContain("غير مقاسة");
    expect(result.aestheticProfile.profileTypeAr).toContain("غير مقاس");
    expect(result.aestheticProfile.lipCompetenceAr).toContain("فحصًا سريريًا");
    expect(result.review).toMatchObject({ state: "draft", growthAssessment: "not-assessed" });
    expect(result.treatmentRecommendations).toMatchObject({ extractionDecision: "not-specified", growthModification: false,
      expansion: false, anchorageOrTADs: false, orthognathicSurgery: false });
  });

  it.each([NaN, Infinity, -Infinity, null])("nonfinite/missing values do not become normal: %s", (value) => {
    const result = generateCephExpertDiagnosis([reading("SNA", value), reading("SNB", value), reading("ANB", value), reading("IMPA", value)]);
    expect(result.sagittalSkeletal.classification).toBe("Indeterminate");
    expect(result.sagittalSkeletal.maxilla).toBe("unknown");
    expect(result.sagittalSkeletal.mandible).toBe("unknown");
    expect(result.dentalAnalysis.lowerIncisor).toBe("unknown");
  });

  it("one available reading does not fill the unrelated anatomy or select treatment", () => {
    const result = generateCephExpertDiagnosis([reading("SNA", 82)]);
    expect(result.sagittalSkeletal.maxilla).toBe("normal");
    expect(result.sagittalSkeletal.mandible).toBe("unknown");
    expect(result.sagittalSkeletal.classification).toBe("Indeterminate");
    expect(result.dentalAnalysis.upperIncisor).toBe("unknown");
    expect(result.treatmentRecommendations.extractionDecision).toBe("not-specified");
  });

  it("an isolated elevated ANB or Wits does not invent a missing incisor division", () => {
    for (const item of [reading("ANB", 7), reading("WITS", 5)]) {
      const result = generateCephExpertDiagnosis([item]);
      expect(result.sagittalSkeletal.classification).toBe("Class II");
      expect(result.dentalAnalysis.upperIncisor).toBe("unknown");
    }
  });

  it("even extreme complete readings do not create extraction, TAD, expansion, growth or surgery instructions", () => {
    const result = generateCephExpertDiagnosis([
      reading("SNA", 75), reading("SNB", 88), reading("ANB", -13), reading("FMA", 40),
      reading("U1NA_A", 42), reading("IMPA", 110), reading("E_LINE_UL", 4), reading("E_LINE_LL", 5),
    ], { age: 24 });
    expect(result.treatmentRecommendations).toMatchObject({ extractionDecision: "not-specified", growthModification: false,
      expansion: false, anchorageOrTADs: false, orthognathicSurgery: false });
    expect(result.treatmentRecommendations.growthModificationAr).toBeUndefined();
    expect(result.treatmentRecommendations.orthognathicSurgeryAr).toBeUndefined();
  });
});

describe("Ceph calibration and acquisition context", () => {
  it.each([0, -1, NaN, Infinity, -Infinity])("invalid scale %s yields no measured millimeters", (scale) => {
    expect(Number.isNaN(pixelsToMm(10, scale))).toBe(true);
    const results = computeAll({ Co: { x: 0, y: 0 }, A: { x: 30, y: 40 } }, scale);
    expect(results.find((item) => item.code === "MAX_LEN")?.value).toBeNull();
  });
  it("valid scale keeps zero signed distance valid and known length exact", () => {
    expect(pixelsToMm(0, 0.2)).toBe(0);
    expect(pixelsToMm(-10, 0.2)).toBe(-2);
  });
  it.each([null, undefined, "", "2026-02-30", "not-a-date"])("missing or invalid acquisition date %s never uses current year", (date) => {
    expect(cephAcquisitionAge(2010, date)).toBeUndefined();
  });
  it("known acquisition date gives approximate age at acquisition, preserving a historical year", () => {
    expect(cephAcquisitionAge(2010, "2020-10-11")).toBe(10);
    expect(cephAcquisitionAge(2021, "2020-10-11")).toBeUndefined();
    expect(cephAcquisitionAge(null, "2020-10-11")).toBeUndefined();
    expect(cephAcquisitionAge(2010.5, "2020-10-11")).toBeUndefined();
  });
});

describe("Ceph response identity and lifetime", () => {
  const identity = { analysisId: 11, patientId: 21, documentId: 31 };
  const source = { ...identity, state: "draft", source: "local-measurement-summary", engineVersion: "v1",
    acquisitionAgeYears: null, agePrecision: "unknown", growthAssessment: "not-assessed" };
  it("requires explicit matching draft/source identity", () => {
    expect(matchesCephSuggestionIdentity(source, identity)).toBe(true);
    for (const change of [{ patientId: 22 }, { analysisId: 12 }, { documentId: 32 }, { state: "approved" }, { source: "unknown" }, { growthAssessment: "growing" }]) {
      expect(matchesCephSuggestionIdentity({ ...source, ...change }, identity)).toBe(false);
    }
  });
  it("retires an A response through A→B→A and cannot release a newer pending request", () => {
    const lifetime = createCephSuggestionLifetime();
    lifetime.setOwner("A");
    const first = lifetime.begin()!;
    expect(lifetime.begin()).toBeNull();
    lifetime.setOwner("B"); lifetime.setOwner("A");
    const second = lifetime.begin()!;
    expect(first.current()).toBe(false);
    first.finish();
    expect(lifetime.busy()).toBe(true);
    expect(second.current()).toBe(true);
    second.finish();
    expect(lifetime.busy()).toBe(false);
  });
  it("unmount invalidates response even after a new mount", () => {
    const lifetime = createCephSuggestionLifetime(); lifetime.setOwner("A");
    const request = lifetime.begin()!;
    lifetime.unmount(); lifetime.mount();
    expect(request.current()).toBe(false);
  });
});
