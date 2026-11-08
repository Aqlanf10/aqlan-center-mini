import { describe, expect, it } from "vitest";
import { computeAll, generateCephExpertDiagnosis, MEASUREMENTS, type MeasurementResult } from "../lib/ceph";

function readings(values: Record<string, number | null>): MeasurementResult[] {
  return computeAll({}, NaN).filter(row => row.code in values).map(row => ({ ...row, value: values[row.code] }));
}
function expectNoTreatment(dx: ReturnType<typeof generateCephExpertDiagnosis>) {
  expect(dx.treatmentRecommendations).toMatchObject({ extractionDecision: "not-specified", growthModification: false,
    expansion: false, anchorageOrTADs: false, orthognathicSurgery: false });
  expect(dx.formatted.recommendationsText).not.toMatch(/Four Premolars|Twin Block|Herbst|Facemask|RPE|Quad-Helix|Le Fort|BSSO/);
}
describe("cephalometric narrative never substitutes for a clinical treatment assessment", () => {
  it.each([{ mean: null, tol: 2 }, { mean: 25, tol: null }, { mean: NaN, tol: 2 }, { mean: 25, tol: 0 }])("keeps numeric observations unclassified without a valid reference %j", reference => {
    const definition = MEASUREMENTS.find(row => row.code === "FMA")!;
    const old = { mean: definition.mean, tol: definition.tol };
    try {
      Object.assign(definition, reference);
      const dx = generateCephExpertDiagnosis(readings({ FMA: 35 }));
      expect(dx.verticalSkeletal.pattern).toBe("Indeterminate");
      expect(dx.verticalSkeletal.detailsAr.join(" ")).toContain("FMA = 35");
      expect(dx.verticalSkeletal.detailsAr.join(" ")).toContain("لا مرجع تصنيفي متاح");
      expect(JSON.stringify(dx)).not.toMatch(/NaN|Infinity/);
      expectNoTreatment(dx);
    } finally { Object.assign(definition, old); }
  });
  it.each([[], computeAll({}, NaN), readings({ ANB: NaN, FMA: Infinity, U1NA_A: -Infinity })].map(results => [results]))("does not turn empty or invalid measurements into normal anatomy or treatment", results => {
    const dx = generateCephExpertDiagnosis(results);
    expectNoTreatment(dx);
    expect(dx.sagittalSkeletal).toMatchObject({ classification: "Indeterminate", severity: "indeterminate", maxilla: "indeterminate", mandible: "indeterminate" });
    expect(dx.verticalSkeletal.pattern).toBe("Indeterminate");
    expect(dx.dentalAnalysis).toMatchObject({ upperIncisor: "indeterminate", lowerIncisor: "indeterminate" });
    expect(dx.aestheticProfile.lipCompetenceAr).toContain("فحص سريري");
    expect(dx.formatted.finalDx).not.toMatch(/طبيعي|متوازن|متناسق/);
    expect(JSON.stringify(dx)).not.toMatch(/NaN|Infinity/);
  });
  it.each([undefined, { age: 9 }, { age: 14 }, { age: 25 }, { age: NaN }])("does not prescribe extraction, appliances, expansion, TADs or surgery from cephalometrics/age: %j", patient => {
    for (const values of [
      { ANB: 10, SNA: 86, SNB: 72, U1NA_A: 42, IMPA: 118, FMA: 38 },
      { ANB: -8, SNA: 72, SNB: 88, U1NA_A: 12, IMPA: 80, FMA: 15 },
      { ANB: 2, SNA: 82, SNB: 80, U1NA_A: 22, IMPA: 90, FMA: 25 },
    ]) expectNoTreatment(generateCephExpertDiagnosis(readings(values), patient));
  });
  it("never mistakes Class III for Class II in compensation or soft-tissue profile", () => {
    const dx = generateCephExpertDiagnosis(readings({ ANB: -3, U1NA_A: 22, IMPA: 110 }));
    expect(dx.sagittalSkeletal.classification).toBe("Class III");
    expect(dx.dentalAnalysis.compensationAr).not.toContain("للصنف الثاني");
    expect(dx.aestheticProfile.profileTypeAr).not.toContain("محدب");
    expect(dx.aestheticProfile.profileTypeAr).toContain("غير محدد");
  });
  it("does not infer an Angle division from ANB and incisor inclination", () => {
    const dx = generateCephExpertDiagnosis(readings({ ANB: 7, U1NA_A: 12 }));
    expect(dx.sagittalSkeletal.classification).toBe("Class II");
    expect(dx.formatted.finalDx).not.toMatch(/div [12]|نموذج [12]/);
  });
  it("preserves numeric observations and labels contradictory vertical evidence indeterminate", () => {
    const dx = generateCephExpertDiagnosis(readings({ ANB: 2, FMA: 35, SNGOGN: 20, E_LINE_UL: 2, NASOLABIAL: 90 }));
    expect(dx.formatted.skeletal).toContain("ANB = 2");
    expect(dx.verticalSkeletal.pattern).toBe("Indeterminate");
    expect(dx.verticalSkeletal.detailsAr.join(" ")).toContain("FMA = 35");
    expect(dx.verticalSkeletal.detailsAr.join(" ")).toContain("SN-GoGn = 20");
    expect(dx.aestheticProfile.eLineAr).toContain("2 مم");
    expect(dx.aestheticProfile.lipCompetenceAr).toContain("فحص سريري");
  });
});
