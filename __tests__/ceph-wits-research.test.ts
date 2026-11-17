import { describe, expect, it } from "vitest";
import { evaluateWitsResearch, type WitsResearchInput } from "../lib/ceph-core/wits-research";
import type { Point2D } from "../lib/ceph-core/geometry";
const base: WitsResearchInput = { a: { x: 5, y: 50 }, b: { x: 0, y: 80 }, plane: { posterior: { x: 0, y: 60 }, anterior: { x: 100, y: 60 }, construction: "synthetic-directed-line" }, calibration: { basis: "synthetic-grid", xMmPerUnit: 1, yMmPerUnit: 1 } };
const map = (fn: (p: Point2D) => Point2D): WitsResearchInput => ({ ...base, a: fn(base.a), b: fn(base.b), plane: { ...base.plane, anterior: fn(base.plane.anterior), posterior: fn(base.plane.posterior) } });
describe("versioned research-only directed projection proposal", () => {
  it("accepts zero and signed values without enabling clinical use", () => {
    expect(evaluateWitsResearch(base)).toMatchObject({ value: 5, clinicalUseAllowed: false, normsStatus: "not-enabled" });
    expect(evaluateWitsResearch({ ...base, a: { x: 0, y: 50 } }).value).toBe(0);
    expect(evaluateWitsResearch({ ...base, a: base.b, b: base.a }).value).toBe(-5);
  });
  it("preserves anatomical sign under transformations including mirror", () => {
    for (const fn of [(p: Point2D) => ({ x: -p.x, y: p.y }), (p: Point2D) => ({ x: -p.y, y: p.x }), (p: Point2D) => ({ x: p.x + 100, y: p.y - 35 })]) expect(evaluateWitsResearch(map(fn)).value).toBeCloseTo(5, 10);
  });
  it("keeps zero and negative separation under both image reflections", () => {
    for (const reflect of [(p: Point2D) => ({ x: -p.x, y: p.y }), (p: Point2D) => ({ x: p.x, y: -p.y })]) {
      const reflected = map(reflect);
      const zero = evaluateWitsResearch({ ...reflected, a: reflect({ x: 0, y: 50 }) });
      const negative = evaluateWitsResearch({ ...reflected, a: reflected.b, b: reflected.a });
      expect(zero).toMatchObject({ status: "ok", value: 0, clinicalUseAllowed: false });
      expect(negative).toMatchObject({ status: "ok", value: -5, clinicalUseAllowed: false });
    }
  });
  it("uses physical aspect and correct calibration under anisotropic resizing", () => {
    expect(evaluateWitsResearch({ ...map(p => ({ x: p.x * 2, y: p.y * 3 })), calibration: { basis: "synthetic-grid", xMmPerUnit: 0.5, yMmPerUnit: 1 / 3 } }).value).toBeCloseTo(5, 10);
    const t = Math.PI / 18;
    expect(evaluateWitsResearch({ ...base, plane: { ...base.plane, anterior: { x: 100 * Math.cos(t), y: 60 + 100 * Math.sin(t) } } }).value).toBeCloseTo(5 * Math.cos(t) - 30 * Math.sin(t), 10);
  });
  it("rejects degenerate geometry, invalid calibration and clinical substitution", () => {
    expect(evaluateWitsResearch({ ...base, plane: { ...base.plane, anterior: base.plane.posterior } }).issue).toBe("degenerate-vector");
    expect(evaluateWitsResearch({ ...base, calibration: { ...base.calibration, xMmPerUnit: 0 } }).status).toBe("not-computable");
    expect(evaluateWitsResearch({ ...base, calibration: { ...base.calibration, basis: "patient-plane" } } as unknown as WitsResearchInput).issue).toBe("unsupported-research-basis");
    expect(evaluateWitsResearch({ ...base, a: { x: NaN, y: 0 } }).status).toBe("not-computable");
  });
});
