import { describe, expect, it } from "vitest";
import { computeAll, generateCephExpertDiagnosis } from "../lib/ceph";
import { cephAgeAtXray } from "../lib/ceph-patient-context";

describe("recorded Ceph patient context", () => {
  it("uses the radiograph year, with no current-year fallback or clamping", () => {
    expect(cephAgeAtXray(2000, "2013-01-01")).toBe(13);
    expect(cephAgeAtXray(2000, "2024-02-29")).toBe(24);
    expect(cephAgeAtXray(2000, null)).toBeUndefined();
    expect(cephAgeAtXray(null, "2013-01-01")).toBeUndefined();
    expect(cephAgeAtXray(2020, "2013-01-01")).toBeUndefined();
  });

  it.each(["2023-02-29", "2026-13-01", "invalid", "2026-10-15T00:00:00Z"])("rejects invalid or non-calendar source %s", date => {
    expect(cephAgeAtXray(2000, date)).toBeUndefined();
  });

  // Synthetic Class II geometry exercises the branch that previously assumed
  // growth when age was omitted. It does not validate treatment indications.
  const results = computeAll({ S: { x: 0, y: 0 }, N: { x: 100, y: 0 },
    A: { x: 100, y: 100 }, B: { x: 60, y: 100 } }, 1);
  it.each([undefined, NaN, Infinity, -1])("does not infer growth or adulthood from missing/invalid age %s", age => {
    const dx = generateCephExpertDiagnosis(results, { age });
    expect(dx.sagittalSkeletal.classification).toBe("Class II div 1");
    expect(dx.treatmentRecommendations.growthModification).toBe(false);
    expect(dx.treatmentRecommendations.orthognathicSurgery).toBe(false);
    expect(dx.formatted.recommendationsText).toContain("العمر وقت الأشعة غير متاح");
    expect(dx.formatted.recommendationsText).toContain("مسودة");
  });

  it("retains known-age behavior while labelling it as a draft", () => {
    const dx = generateCephExpertDiagnosis(results, { age: 13 });
    expect(dx.treatmentRecommendations.growthModification).toBe(true);
    expect(dx.formatted.recommendationsText).toContain("العمر وحده لا يثبت النمو المتبقي");
  });

  it("does not classify a non-finite ANB as normal", () => {
    const invalid = results.map(row => ({ ...row, value: row.code === "ANB" ? NaN : null }));
    expect(generateCephExpertDiagnosis(invalid).sagittalSkeletal.classification).toBe("Indeterminate");
  });
});
