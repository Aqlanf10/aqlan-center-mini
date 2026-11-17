import { describe, expect, it } from "vitest";
import { angleBetweenRays, signedDistanceToLine, type Point2D } from "../lib/ceph-core/geometry";
import { evaluateSteinerCore, type SteinerCoreStudy } from "../lib/ceph-core/steiner-core";

// Independent arithmetic witnesses, not clinical or population reference cases.
const p = (x: number, y: number): Point2D => ({ x, y });
const study: SteinerCoreStudy = {
  revision: 1, imageGeometryRevision: 1, projection: "lateral-2d",
  coordinateConvention: "pixel-column-right-row-down", orientation: { anterior: "right" },
  calibration: { kind: "patient-plane", rowScale: 1, columnScale: 1, imageGeometryRevision: 1, provenance: "synthetic grid", scopeConfirmed: true },
  landmarks: [
    { id: "N", column: 0, row: 0 }, { id: "S", column: -10, row: 0 },
    { id: "A", column: 0, row: 10 }, { id: "B", column: -10, row: 10 },
    { id: "U1_TIP", column: 3, row: 4 }, { id: "U1_APEX", column: 0, row: 0 },
    { id: "L1_TIP", column: 0, row: 0 }, { id: "L1_APEX", column: -3, row: 4 },
    { id: "U1_LABIAL", column: 4, row: 6 }, { id: "L1_LABIAL", column: 0, row: 4 },
  ],
};

describe("independent integer-grid verification (not clinical validation)", () => {
  it("checks ray branches with an independent cosine oracle across integer vectors", () => {
    for (let ax = -3; ax <= 3; ax++) for (let ay = -3; ay <= 3; ay++) {
      if (!ax && !ay) continue;
      for (let bx = -3; bx <= 3; bx++) for (let by = -3; by <= 3; by++) {
        if (!bx && !by) continue;
        const cosine = (ax * bx + ay * by) / Math.sqrt((ax * ax + ay * ay) * (bx * bx + by * by));
        const expected = Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
        expect(angleBetweenRays(p(ax, ay), p(bx, by))).toBeCloseTo(expected, 5);
      }
    }
  });
  it("matches a Cartesian line equation rather than reusing vector helpers", () => {
    // Line through (1,2) and (4,6): 4x - 3y + 2 = 0.
    for (let x = -6; x <= 6; x++) for (let y = -6; y <= 6; y++) {
      expect(signedDistanceToLine(p(x, y), p(1, 2), p(4, 6))).toBeCloseTo(-(4 * x - 3 * y + 2) / 5, 12);
    }
  });
  it("checks all eight constructions with a non-normative, hand-calculated grid", () => {
    const expected = [90, 45, 45, Math.acos(4 / 5) * 180 / Math.PI,
      Math.acos(7 / Math.sqrt(50)) * 180 / Math.PI,
      Math.acos(-7 / 25) * 180 / Math.PI, 4, Math.sqrt(8)];
    const result = evaluateSteinerCore(study);
    result.measures.forEach((m, i) => {
      expect(m.status).toBe("ok");
      expect(m.value).toBeCloseTo(expected[i], 10);
      expect(m.clinicalUseAllowed).toBe(false);
    });
    expect(result.normsStatus).toBe("not-enabled");
  });
  it("does not turn an underflowed crown coordinate into a valid zero distance", () => {
    const result = evaluateSteinerCore({ ...study,
      calibration: { ...study.calibration, columnScale: Number.MIN_VALUE },
      landmarks: study.landmarks.map(v => v.id === "U1_LABIAL" ? { ...v, column: 0.25 } : v),
    });
    expect(result.measures.find(m => m.id === "U1_NA_DISTANCE")).toMatchObject({
      status: "not-computable", value: null, issue: { code: "numeric-range-exceeded", landmark: "U1_LABIAL" },
    });
  });
});
