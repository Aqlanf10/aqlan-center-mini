import { describe, expect, it } from "vitest";
import {
  CHANGE_LABEL, resolveCephComparisonOrder, isCephAcquisitionDate, compareAnalyses, comparable,
  comparisonSummary, type ComparableMeasurement,
} from "../lib/cephCompare";

const measurement = (
  code: string, value: number, mean: number | null,
): ComparableMeasurement => ({ code, name: `قياس ${code}`, unit: "°", value, mean });

describe("descriptive comparison does not claim reference absence or clinical stability", () => {
  it("labels withheld interpretation without claiming that reference data do not exist", () => {
    expect(CHANGE_LABEL.ungraded.en).toBe("Descriptive numeric difference; not clinically graded");
    expect(CHANGE_LABEL.ungraded.ar).not.toContain("بلا معيار");
  });
  it.each(["°", "mm", "%", ""])("does not apply a universal noise threshold to %s", unit => {
    for (const delta of [0, 0.2, 0.5, 0.6, 4]) {
      const before = { ...measurement("SNA", 90, 82), unit }, after = { ...before, value: 90 + delta };
      const result = compareAnalyses([before], [after]);
      expect(result.measurements[0]).toMatchObject({ delta: after.value - before.value, direction: "ungraded", gapBefore: null, gapAfter: null });
      expect(result.steady).toBe(0);
    }
  });
  it("cannot revive grading through the retired runtime option", () => {
    // @ts-expect-error The former grading override is no longer a supported API.
    const result = compareAnalyses([measurement("SNA", 90, 82)], [measurement("SNA", 84, 82)], { gradeChanges: true });
    expect(result.measurements[0].direction).toBe("ungraded"); expect(result.improved).toBe(0);
  });
});

describe("compareAnalyses — لا يُقارَن إلا ما قيس في الاثنتين", () => {
  it("القياس في واحدةٍ وحده يُقال اسمه ولا يُعرض فرقًا", () => {
    const comparison = compareAnalyses(
      [measurement("ANB", 5, 2), measurement("FMA", 30, 25)],
      [measurement("ANB", 3, 2)],
    );
    expect(comparison.measurements).toHaveLength(1);
    expect(comparison.onlyBefore).toEqual(["FMA"]);
    expect(comparison.onlyAfter).toEqual([]);
    expect(comparison.measurements[0]).toMatchObject({ key: "ANB", before: 5, after: 3, delta: -2 });
    expect(comparison.improved).toBe(0);
  });

  it("لا قياس مشترك — جملة الخلاصة تقولها صريحة", () => {
    const comparison = compareAnalyses([measurement("A", 1, 1)], [measurement("B", 2, 1)]);
    expect(comparison.measurements).toHaveLength(0);
    expect(comparisonSummary(comparison).ar).toContain("لا قياسَ مشتركًا");
  });
});

describe("comparable — من نتائج المحرك", () => {
  it("قيمةٌ غير رقمية تُسقط لا تُفسد المقارنة", () => {
    expect(comparable({
      code: "X", ar: "س", en: "X", unit: "mm", value: null,
      display: "—", mean: 5, tol: 2, status: null, severityStars: "",
      interpretationAr: "", interpretationEn: "", group: "sagittal", schools: [],
      source: "test",
    })).toBeNull();
  });
});

describe("acquisition date resolution", () => {
  it("uses only xrayDate, not a takenOn alias, upload time, phase, ID or caller order", () => {
    const one = { id: 9, takenOn: "2000-01-01", createdAt: "2026-10-01", phase: "pretreatment" };
    const two = { id: 4, takenOn: "2024-01-01", createdAt: "2025-01-01", phase: "posttreatment" };
    expect(resolveCephComparisonOrder(one, two)).toEqual({ state: "unresolved", reason: "missing_date" });
    expect(resolveCephComparisonOrder(two, one)).toEqual({ state: "unresolved", reason: "missing_date" });
  });
  it.each(["1900-02-29", "0000-01-01", "2024-00-01", "2024-01-00", "2024-13-01", "2024-04-31", "2024-02-30", "2024-1-1", "01/02/2024", "2024-01-01T00:00:00Z"])("rejects invalid or ambiguous calendar date %s", date => expect(isCephAcquisitionDate(date)).toBe(false));
  it.each(["2000-02-29", "2024-02-29", "1900-02-28", "0001-01-01"])("accepts exact calendar date %s", date => expect(isCephAcquisitionDate(date)).toBe(true));
  it("does not mutate the historical source while resolving either reference", () => {
    const one = Object.freeze<{ id: number; xrayDate: null }>({ id: 1, xrayDate: null }), two = Object.freeze<{ id: number; xrayDate: null }>({ id: 2, xrayDate: null });
    expect(resolveCephComparisonOrder(one, two, 2)).toMatchObject({ state: "resolved", before: two, after: one });
    expect(one.xrayDate).toBeNull(); expect(two.xrayDate).toBeNull();
  });
});

describe("sealed comparison requires exact calculation provenance", () => {
  const sealed = (value: number, provenanceKey = '["aqlan-ceph:SNA","v1","source-a",null,"round1"]') =>
    ({...measurement("SNA", value, null),provenanceKey});
  it("refuses the same code with different units", () => {
    expect(compareAnalyses([measurement("SNA",80,null)],[{...measurement("SNA",82,null),unit:"mm"}]).measurements).toEqual([]);
  });
  it("refuses a witnessed value paired with a current or unversioned value", () => {
    expect(compareAnalyses([sealed(80)],[measurement("SNA",82,null)]).measurements).toEqual([]);
  });
  it("refuses equal version labels with different implementation hashes", () => {
    expect(compareAnalyses([sealed(80)],[sealed(82,'["aqlan-ceph:SNA","v1","source-b",null,"round1"]')]).measurements).toEqual([]);
  });
  it("reports compatible raw differences without clinical grading or inferred improvement", () => {
    const result=compareAnalyses([sealed(80)],[sealed(82)]);
    expect(result.measurements).toEqual([expect.objectContaining({delta:2,gapBefore:null,gapAfter:null,direction:"ungraded"})]);
    expect(comparisonSummary(result).en).toContain("Descriptive numeric differences only");
  });
  it("refuses nonfinite results rather than serializing a spurious difference", () => {
    expect(compareAnalyses([sealed(Infinity)],[sealed(82)]).measurements).toEqual([]);
  });
});

describe("finite comparison outputs",()=>{
  it("withholds overflowing differences between finite sealed endpoints",()=>{
    const before={...measurement("WITS",-1e308,null),unit:"mm",provenanceKey:"same-witnessed-calculation"};
    const after={...before,value:1e308};
    expect(compareAnalyses([before],[after]).measurements).toEqual([]);
  });
  it("withholds overflowing normative gaps rather than grading them",()=>{
    const result=compareAnalyses([measurement("SNA",1e308,-1e308)],[measurement("SNA",1e308,-1e308)]);
    expect(result.measurements[0]).toMatchObject({gapBefore:null,gapAfter:null,direction:"ungraded"});
  });
});


describe("comparison reference suitability safety", () => {
  it.each([
    [90, 84, 82, 82], // Built-in mean suggests toward, selected mean 100 would suggest away.
    [90, 84, 100, 100],
    [90, 84, 100, 82], // Different endpoint means would invent a shared target.
    [90, 91, 82, 90], // Changing the mean reverses the direction versus a fixed 82.
    [90, 90, 82, 90], // Unchanged raw value cannot establish clinical stability.
    [90, 89.8, 82, 82], // No universal clinical noise threshold is established.
    [90, 84, null, null],
  ])("withholds grades for values %s/%s and population means %s/%s", (before, after, firstMean, secondMean) => {
    const result = compareAnalyses([measurement("SNA", before, firstMean)], [measurement("SNA", after, secondMean)]);
    expect(result).toMatchObject({ interpretation: { mode: "descriptive_only", reason: "reference_suitability_not_established" }, improved: 0, worsened: 0, steady: 0 });
    expect(result.measurements[0]).toMatchObject({ before, after, delta: after - before, gapBefore: null, gapAfter: null, direction: "ungraded" });
    expect(comparisonSummary(result).en).toContain("Normative reference suitability and consistency for this comparison have not been established");
  });
  it("does not carry engine built-in means into a comparative target", () => {
    const row = { code: "SNA", ar: "SNA", en: "SNA", unit: "°", value: 90, mean: 82 } as Parameters<typeof comparable>[0];
    expect(comparable(row)).toMatchObject({ value: 90, mean: null });
  });
  it("does not summarize injected legacy grades as conclusions", () => {
    const result = compareAnalyses([measurement("SNA", 90, 82)], [measurement("SNA", 84, 82)]);
    Object.assign(result, { improved: 1, worsened: 0, steady: 0 });
    Object.assign(result.measurements[0], { direction: "improved", gapBefore: 8, gapAfter: 2 });
    expect(comparisonSummary(result).en).not.toContain("moved toward norm");
  });
});
