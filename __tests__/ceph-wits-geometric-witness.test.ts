import { describe, expect, it } from "vitest";
import { measure, type LandmarkMap, type Pt } from "../lib/ceph";
import { dot, projectOntoLine, unitVector, vector, positiveScale } from "../lib/ceph-core/geometry";

// Test-only mathematical witness, NOT a clinical Wits implementation.
// posterior -> anterior is an explicit anatomical direction, not screen x.
const witness = (a: Pt, b: Pt, posterior: Pt, anterior: Pt, scale = 1) => {
  const ao = projectOntoLine(a, posterior, anterior);
  const bo = projectOntoLine(b, posterior, anterior);
  return dot(vector(bo, ao), unitVector(vector(posterior, anterior))) * positiveScale(scale);
};
const A = { x: 5, y: 50 }, B = { x: 0, y: 80 };
const P = { x: 0, y: 60 }, Q = { x: 100, y: 60 };
const legacy = (a = A, b = B, p = P, q = Q) => measure("WITS", { A: a, B: b, OcclP: p, OcclA: q }, 1);

describe("Wits projection witness, without clinical or historical reinterpretation", () => {
  it("distinguishes valid coincident projections from the legacy NaN", () => {
    const a = { x: 0, y: 50 };
    expect(witness(a, B, P, Q)).toBe(0);
    expect(legacy(a)).toBeNaN(); // Characterization, never endorsement.
  });
  it("has the explicitly anterior positive sign and retains negative separations", () => {
    expect(witness(A, B, P, Q)).toBe(5);
    expect(witness(B, A, P, Q)).toBe(-5);
    expect(legacy()).toBe(5);
  });
  it("changes with plane inclination, not an assumed horizontal screen distance", () => {
    const theta = Math.PI / 18;
    const q = { x: 100 * Math.cos(theta), y: 60 + 100 * Math.sin(theta) };
    const expected = 5 * Math.cos(theta) - 30 * Math.sin(theta);
    expect(expected).toBeCloseTo(-0.285406565, 9);
    expect(witness(A, B, P, q)).toBeCloseTo(expected, 10);
    expect(witness(A, B, q, P)).toBeCloseTo(-expected, 10); // Reversed anatomical labels reverse sign.
  });
  it("preserves the geometric result under joint translation, rotation and image reflection", () => {
    const transforms = [
      (p: Pt): Pt => ({ x: p.x + 123, y: p.y - 87 }),
      (p: Pt): Pt => ({ x: -p.y, y: p.x }),
      (p: Pt): Pt => ({ x: -p.x, y: p.y }),
      (p: Pt): Pt => ({ x: p.x, y: -p.y }),
    ];
    for (const t of transforms) expect(witness(t(A), t(B), t(P), t(Q))).toBeCloseTo(5, 10);
    const mirror = (p: Pt) => ({ x: -p.x, y: p.y });
    expect(legacy(mirror(A), mirror(B), mirror(P), mirror(Q))).toBe(-5); // Historical screen-x sign defect.
  });
  it("preserves calibrated length when image coordinates and pixel scale change together", () => {
    const t = (p: Pt) => ({ x: 2 * p.x, y: 2 * p.y });
    expect(witness(t(A), t(B), t(P), t(Q), 0.5)).toBeCloseTo(5, 10);
    expect(() => witness(A, B, P, P)).toThrow();
    expect(() => witness(A, B, P, Q, 0)).toThrow();
  });
  it("checks AO and BO coordinates against independent Cartesian equations", () => {
    // Oblique line y = x + 10. The perpendicular through (x,y) has
    // equation yFoot = -xFoot + x + y, hence xFoot=(x+y-10)/2.
    const p = { x: 0, y: 10 }, q = { x: 20, y: 30 };
    for (const [point, expected] of [
      [{ x: 5, y: 50 }, { x: 22.5, y: 32.5 }],
      [{ x: 0, y: 80 }, { x: 35, y: 45 }],
    ]) {
      const foot = projectOntoLine(point, p, q);
      expect(foot.x).toBeCloseTo(expected.x, 12);
      expect(foot.y).toBeCloseTo(expected.y, 12);
      expect(foot.y - foot.x).toBeCloseTo(10, 12);
      expect((point.x - foot.x) + (point.y - foot.y)).toBeCloseTo(0, 12);
    }
    expect(witness(A, B, p, q)).toBeCloseTo(-12.5 * Math.sqrt(2), 12);
  });
  it("preserves zero and negative results after either image reflection", () => {
    for (const reflect of [(p: Pt) => ({ x: -p.x, y: p.y }), (p: Pt) => ({ x: p.x, y: -p.y })]) {
      const a0 = reflect({ x: 0, y: 50 });
      const rp = reflect(P), rq = reflect(Q);
      expect(witness(a0, reflect(B), rp, rq)).toBeCloseTo(0, 12);
      expect(witness(reflect(B), reflect(A), rp, rq)).toBeCloseTo(-5, 12);
      const ao = projectOntoLine(a0, rp, rq), bo = projectOntoLine(reflect(B), rp, rq);
      expect(ao.x).toBeCloseTo(bo.x, 12);
      expect(ao.y).toBeCloseTo(bo.y, 12);
    }
  });
  it("does not depend on N and does not mutate legacy inputs", () => {
    const original: LandmarkMap = Object.freeze({ A, B, OcclP: P, OcclA: Q, N: { x: 0, y: 0 } });
    const before = measure("WITS", original, 1);
    expect(measure("WITS", { ...original, N: { x: 20, y: 0 } }, 1)).toBe(before);
    expect(measure("WITS", original, 1)).toBe(before);
  });
});
