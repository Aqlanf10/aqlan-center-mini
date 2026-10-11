import { describe, expect, it } from "vitest";
import { computeMmPerPixel, measure, type LandmarkMap } from "../lib/ceph";
import { boltonArithmetic, permanentArchSpaceArithmetic } from "../lib/ortho-assessment-arithmetic-2_1_0";

// Independent expected numbers from dot's checksummed evidence/fixtures, not
// outputs copied from production functions. Numerical tolerance is not clinical
// validation. Source text + access limits: docs/review/ortho-union-science/.
const widths = (ids: number[], values: number[]) => ids.map((tooth, index) => ({ tooth, value: values[index] }));
const upper = widths([13, 12, 11, 21, 22, 23], [8, 7, 9, 9, 7, 8]);
const lower = widths([43, 42, 41, 31, 32, 33], [6, 5, 7, 7, 5, 6]);
describe("independent scientific arithmetic fixtures; no clinical decision", () => {
  it("G01: source calibration gives 12.5 mm, invariant under uniform resize", () => {
    const original: LandmarkMap = { Co: { x: 10, y: 10 }, A: { x: 40, y: 50 } };
    expect(measure("MAX_LEN", original, computeMmPerPixel({ x: 0, y: 0 }, { x: 100, y: 0 }, 25))).toBe(12.5);
    expect(measure("MAX_LEN", { Co: { x: 20, y: 20 }, A: { x: 80, y: 100 } }, computeMmPerPixel({ x: 0, y: 0 }, { x: 200, y: 0 }, 25))).toBe(12.5);
  });
  it("G03: SNA/SNB use N as vertex; ANB retains its sign", () => {
    const p: LandmarkMap = { N: { x: 0, y: 0 }, S: { x: -10, y: 0 }, A: { x: 0, y: 10 }, B: { x: -5, y: 5 * Math.sqrt(3) } };
    expect(measure("SNA", p, NaN)).toBeCloseTo(90, 9);
    expect(measure("SNB", p, NaN)).toBeCloseTo(60, 9);
    expect(measure("ANB", p, NaN)).toBeCloseTo(30, 9);
    expect(measure("ANB", { ...p, A: p.B, B: p.A }, NaN)).toBeCloseTo(-30, 9);
    expect(measure("SNA", { ...p, S: p.N }, NaN)).toBeNaN();
  });
  it("G04: a tilted plane contributes only the signed parallel displacement", () => {
    expect(measure("WITS", { OcclP: { x: 0, y: 0 }, OcclA: { x: 3, y: 4 }, A: { x: 10, y: 5 }, B: { x: 0, y: 0 } }, 0.2)).toBeCloseTo(2, 9);
  });
  it("B01: 75 percent with two distinct signed reference residuals", () => {
    const result = boltonArithmetic("anterior", upper, lower, 77.2);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.code);
    expect(result.value.ratioPercent).toBe(75);
    expect(result.value.upperReferenceLowerResidualMm).toBeCloseTo(-1.056, 9);
    expect(result.value.lowerReferenceUpperResidualMm).toBeCloseTo(1.36787564766839, 9);
    expect(boltonArithmetic("anterior", [...upper].reverse(), [...lower].reverse(), 77.2)).toEqual(result);
  });
  it("B02: the explicit twelve-tooth sets give 91.3 percent and zero residuals", () => {
    const result = boltonArithmetic("overall", widths([16,15,14,13,12,11,21,22,23,24,25,26], Array(12).fill(10)), widths([46,45,44,43,42,41,31,32,33,34,35,36], Array(12).fill(9.13)), 91.3);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.code);
    expect(result.value.ratioPercent).toBeCloseTo(91.3, 9);
    expect(result.value.upperReferenceLowerResidualMm).toBeCloseTo(0, 9);
    expect(result.value.lowerReferenceUpperResidualMm).toBeCloseTo(0, 9);
  });
  it.each([
    upper.slice(1), [upper[0], ...upper.slice(0, 5)], [{ tooth: 53, value: 8 }, ...upper.slice(1)],
    [{ tooth: 13, value: 0 }, ...upper.slice(1)], [{ tooth: 13, value: -1 }, ...upper.slice(1)],
    [{ tooth: 13, value: Infinity }, ...upper.slice(1)], [{ tooth: 13, value: NaN }, ...upper.slice(1)],
  ])("B02: rejects incomplete, duplicated, primary or invalid-width teeth (%#)", (...rows) => {
    expect(boltonArithmetic("anterior", rows, lower, 77.2).ok).toBe(false);
  });
  it.each([[65, -5], [70, 0], [75, 5]])("S01: available %i mm retains discrepancy %i mm", (available, expected) => {
    expect(permanentArchSpaceArithmetic("upper", widths([15,14,13,12,11,21,22,23,24,25], Array(10).fill(7)), available)).toEqual({ ok: true, value: { arch: "upper", requiredMm: 70, availableMm: available, discrepancyMm: expected, formula: "available_minus_required_v2" } });
  });
});
