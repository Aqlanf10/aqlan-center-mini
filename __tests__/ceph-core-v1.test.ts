import { describe, expect, it } from "vitest";
import {
  angleBetweenRays, convertLinearMagnificationBasis, distance2D, GeometryError,
  intersectLines, isotropicScaleFromReference, projectOntoLine, signedDistanceToLine,
  type Point2D,
} from "../lib/ceph-core/geometry";
import {
  CORE_LANDMARK_IDS, evaluateSteinerCore, STEINER_CORE_VERSION,
  type CoreLandmarkId, type CoreMeasurementId, type SteinerCoreStudy,
} from "../lib/ceph-core/steiner-core";

const pt = (x: number, y: number): Point2D => ({ x, y });
const polar = (r: number, d: number): Point2D => pt(r * Math.cos(d * Math.PI / 180), r * Math.sin(d * Math.PI / 180));
const add = (a: Point2D, b: Point2D): Point2D => pt(a.x + b.x, a.y + b.y);
const scale = (a: Point2D, k: number): Point2D => pt(a.x * k, a.y * k);
const rotate = (p: Point2D, t: number): Point2D => pt(p.x * Math.cos(t) - p.y * Math.sin(t), p.x * Math.sin(t) + p.y * Math.cos(t));
type PhysicalFixture = Record<CoreLandmarkId, Point2D>;
function physical(): PhysicalFixture {
  const na = polar(50, 262), nb = polar(80, 260);
  return {
    N: pt(0, 0), S: pt(-70, 0), A: na, B: nb,
    U1_TIP: pt(-4, -50), U1_APEX: add(pt(-4, -50), scale(polar(1, 284), -20)),
    L1_TIP: pt(-5, -55), L1_APEX: add(pt(-5, -55), scale(polar(1, 235), 20)),
    U1_LABIAL: add(scale(na, 0.8), scale(pt(-na.y / 50, na.x / 50), 4)),
    L1_LABIAL: add(scale(nb, 0.8), scale(pt(-nb.y / 80, nb.x / 80), 4)),
  };
}
function study(points = physical(), rowScale = 0.1, columnScale = 0.1, anterior: "right" | "left" = "right"): SteinerCoreStudy {
  return {
    revision: 1, imageGeometryRevision: 1, projection: "lateral-2d",
    coordinateConvention: "pixel-column-right-row-down", orientation: { anterior },
    calibration: { kind: "patient-plane", rowScale, columnScale, imageGeometryRevision: 1, provenance: "synthetic known reference", scopeConfirmed: true },
    landmarks: CORE_LANDMARK_IDS.map(id => ({
      id, column: 1000 + (anterior === "right" ? 1 : -1) * points[id].x / columnScale,
      row: 1000 - points[id].y / rowScale,
    })),
  };
}
function measurement(input: unknown, id: CoreMeasurementId) {
  const result = evaluateSteinerCore(input).measures.find(m => m.id === id);
  if (!result) throw new Error("Missing result " + id);
  return result;
}
function value(input: unknown, id: CoreMeasurementId): number {
  const result = measurement(input, id);
  expect(result.status).toBe("ok");
  if (result.value === null) throw new Error("Unexpected null result " + id);
  return result.value;
}
function deepFreeze<T>(input: T): T {
  if (input && typeof input === "object") {
    Object.values(input).forEach(deepFreeze);
    Object.freeze(input);
  }
  return input;
}
const GOLDEN: Record<CoreMeasurementId, number> = {
  SNA: 82, SNB: 80, ANB: 2, U1_NA_ANGLE: 22, L1_NB_ANGLE: 25,
  INTERINCISAL: 131, U1_NA_DISTANCE: 4, L1_NB_DISTANCE: 4,
};

describe("independent geometry, not clinical validation", () => {
  it.each([[0, 1, 0], [90, 0, 1], [135, -1, 1], [180, -1, 0]])("ray angle %i", (expected, x, y) => {
    expect(angleBetweenRays(pt(1, 0), pt(x, y))).toBeCloseTo(expected, 10);
  });
  it("preserves very small angles rather than acos cancellation", () => {
    expect(angleBetweenRays(pt(1, 0), pt(1, 1e-9))).toBeCloseTo(1e-9 * 180 / Math.PI, 13);
  });
  it("handles large finite vectors without multiplication overflow", () => {
    expect(angleBetweenRays(pt(1e300, 0), pt(0, 1e300))).toBe(90);
  });
  it("rejects zero and non-finite vectors", () => {
    expect(() => angleBetweenRays(pt(0, 0), pt(1, 0))).toThrow("degenerate-vector");
    expect(() => angleBetweenRays(pt(NaN, 0), pt(1, 0))).toThrow("invalid-coordinate");
  });
  it("3-4-5 and zero distances are valid", () => {
    expect(distance2D(pt(0, 0), pt(3, 4))).toBe(5);
    expect(distance2D(pt(1, 1), pt(1, 1))).toBe(0);
  });
  it("signed distances depend on a declared direction", () => {
    expect(signedDistanceToLine(pt(2, 3), pt(0, 0), pt(10, 0))).toBe(3);
    expect(signedDistanceToLine(pt(2, 3), pt(10, 0), pt(0, 0))).toBe(-3);
    expect(signedDistanceToLine(pt(2, -3), pt(0, 0), pt(10, 0))).toBe(-3);
  });
  it("projects to a real line and refuses a degenerate one", () => {
    expect(projectOntoLine(pt(3, 4), pt(0, 0), pt(10, 0))).toEqual(pt(3, 0));
    expect(() => projectOntoLine(pt(3, 4), pt(0, 0), pt(0, 0))).toThrow("degenerate-vector");
  });
  it("line intersection and near-parallel rejection", () => {
    expect(intersectLines(pt(0, 0), pt(10, 0), pt(3, -4), pt(3, 4))).toEqual(pt(3, 0));
    expect(() => intersectLines(pt(0, 0), pt(1, 0), pt(0, 1), pt(1, 1))).toThrow("unstable-intersection");
    expect(() => intersectLines(pt(0, 0), pt(1, 0), pt(0, 1), pt(1, 1 + 1e-12))).toThrow("unstable-intersection");
  });
  it("calibration is positive, finite and independent of display zoom", () => {
    expect(isotropicScaleFromReference(pt(0, 0), pt(100, 0), 10)).toBe(0.1);
    expect(() => isotropicScaleFromReference(pt(0, 0), pt(0, 0), 10)).toThrow(GeometryError);
    expect(() => isotropicScaleFromReference(pt(0, 0), pt(Infinity, 0), 10)).toThrow(GeometryError);
    expect(() => isotropicScaleFromReference(pt(0, 0), pt(10, 0), 0)).toThrow("invalid-reference-length");
  });
  it.each([1e-308, -1e-308, Number.MIN_VALUE, Number.MAX_VALUE])("equal magnification bases preserve %s exactly", v => {
    expect(convertLinearMagnificationBasis(v, 1e308, 1e308)).toBe(v);
  });
  it.each([[1e-308, 1e308, 1], [1, 1e-308, 1e308], [1e308, 1, 1e308]])("unrepresentable conversion fails explicitly %#", (v, from, to) => {
    expect(() => convertLinearMagnificationBasis(v, from, to)).toThrow("numeric-range-exceeded");
  });
  it("magnification basis conversion is explicit and reversible", () => {
    expect(convertLinearMagnificationBasis(100, 1, 1.08)).toBe(108);
    expect(convertLinearMagnificationBasis(108, 1.08, 1)).toBeCloseTo(100, 12);
    expect(convertLinearMagnificationBasis(-4, 1.08, 1.08)).toBe(-4);
    expect(() => convertLinearMagnificationBasis(4, 0, 1)).toThrow("invalid-scale");
  });
});

describe("Steiner Core-8 research contract", () => {
  it.each(Object.entries(GOLDEN))("independent golden geometry: %s=%f", (id, expected) => {
    expect(value(study(), id as CoreMeasurementId)).toBeCloseTo(expected, 10);
  });
  it("does not turn the golden construction into clinical norms", () => {
    const r = evaluateSteinerCore(study());
    expect(r.analysisVersion).toBe(STEINER_CORE_VERSION);
    expect(r.clinicalUseAllowed).toBe(false);
    expect(r.normsStatus).toBe("not-enabled");
    expect(r.measures.every(m => !m.clinicalUseAllowed && !("mean" in m) && !("sd" in m) && !("classification" in m))).toBe(true);
    expect(measurement(study(), "INTERINCISAL").evidence).toBe("figure-review-pending");
    expect(measurement(study(), "U1_NA_DISTANCE").evidence).toBe("figure-review-pending");
  });
  it("ANB stays negative, not an absolute NA/NB angle", () => {
    const p = physical(); p.A = polar(50, 260); p.B = polar(80, 264);
    expect(value(study(p), "ANB")).toBeCloseTo(-4, 10);
  });
  it("opposite angular branches do not silently produce an ANB", () => {
    const p = physical(); p.A = polar(50, 100);
    expect(measurement(study(p), "ANB")).toMatchObject({ status: "not-computable", issue: { code: "anb-branch-ambiguous" } });
  });
  it("incisor crown references are not inferred from the incisal tips", () => {
    const p = physical(), original = study(p);
    p.U1_TIP = pt(200, -200);
    expect(value(study(p), "U1_NA_DISTANCE")).toBeCloseTo(4, 10);
    const noCrown = { ...original, landmarks: original.landmarks.filter(p => p.id !== "U1_LABIAL") };
    expect(measurement(noCrown, "U1_NA_DISTANCE")).toMatchObject({ status: "not-computable", issue: { code: "missing-landmark", landmark: "U1_LABIAL" } });
    expect(value(noCrown, "U1_NA_ANGLE")).toBeCloseTo(22, 10);
  });
  it("swapping an apex and tip is flagged, not silently folded to 22 degrees", () => {
    const p = physical(); [p.U1_TIP, p.U1_APEX] = [p.U1_APEX, p.U1_TIP];
    const r = measurement(study(p), "U1_NA_ANGLE");
    expect(r.status).toBe("needs-review");
    expect(r.value).toBeCloseTo(158, 10);
  });
  it("swapping lower apex/tip is flagged, not silently folded to 25 degrees", () => {
    const p = physical(); [p.L1_TIP, p.L1_APEX] = [p.L1_APEX, p.L1_TIP];
    const r = measurement(study(p), "L1_NB_ANGLE");
    expect(r.status).toBe("needs-review");
    expect(r.value).toBeCloseTo(155, 10);
  });
  it("corrected anisotropic row/column spacing preserves all measures", () => {
    const s = study(physical(), 0.3, 0.25);
    for (const [id, expected] of Object.entries(GOLDEN)) expect(value(s, id as CoreMeasurementId)).toBeCloseTo(expected, 10);
  });
  it("mirrored source with correct anatomical orientation preserves signed measures", () => {
    const s = study(physical(), 0.1, 0.1, "left");
    for (const [id, expected] of Object.entries(GOLDEN)) expect(value(s, id as CoreMeasurementId)).toBeCloseTo(expected, 10);
  });
  it("wrong orientation is not guessed or silently repaired", () => {
    const s = study(physical(), 0.1, 0.1, "left");
    expect(value({ ...s, orientation: { anterior: "right" } }, "U1_NA_DISTANCE")).toBeCloseTo(-4, 10);
  });
  it.each(["ratio-only", "detector-plane"] as const)("%s permits angles but not patient distances", kind => {
    const s = study(), input = { ...s, calibration: { ...s.calibration, kind } };
    expect(value(input, "SNA")).toBeCloseTo(82, 10);
    expect(measurement(input, "U1_NA_DISTANCE")).toMatchObject({ status: "not-computable", value: null, issue: { code: "uncalibrated-patient-distance" } });
  });
  it.each([1e-300, 1, 1e300])("ratio-only scale is invariant to common factor %s", factor => {
    const s = study(physical(), 0.3, 0.25);
    const input = { ...s, calibration: { ...s.calibration, kind: "ratio-only", rowScale: 0.3 * factor, columnScale: 0.25 * factor } };
    for (const [id, expected] of Object.entries(GOLDEN)) {
      if (!id.endsWith("DISTANCE")) expect(value(input, id as CoreMeasurementId)).toBeCloseTo(expected, 9);
    }
  });
  it("unrepresentable aspect ratio is rejected rather than flattened to zero", () => {
    const s = study();
    const input = { ...s, calibration: { ...s.calibration, kind: "ratio-only", rowScale: Number.MIN_VALUE, columnScale: Number.MAX_VALUE } };
    expect(evaluateSteinerCore(input).measures.every(m => m.status === "not-computable" && m.issue.code === "invalid-scale")).toBe(true);
  });
  it("absence affects only measurements depending on that landmark", () => {
    const s = study(), input = { ...s, landmarks: s.landmarks.filter(p => p.id !== "A") };
    const blocked = evaluateSteinerCore(input).measures.filter(m => m.status === "not-computable").map(m => m.id);
    expect(blocked).toEqual(["SNA", "ANB", "U1_NA_ANGLE", "U1_NA_DISTANCE"]);
    expect(value(input, "SNB")).toBeCloseTo(80, 10);
  });
  it("invalid coordinates do not poison independent measurements", () => {
    const s = study(), input = { ...s, landmarks: s.landmarks.map(p => p.id === "A" ? { ...p, row: NaN } : p) };
    expect(measurement(input, "SNA")).toMatchObject({ value: null, issue: { code: "invalid-coordinate" } });
    expect(value(input, "SNB")).toBeCloseTo(80, 10);
    expect(JSON.stringify(evaluateSteinerCore(input))).not.toMatch(/NaN|Infinity/);
  });
  it("stores raw precision without attaching a rounded clinical class", () => {
    const p = physical(); p.A = polar(50, 264.04);
    expect(value(study(p), "SNA")).toBeCloseTo(84.04, 10);
    expect(measurement(study(p), "SNA")).not.toHaveProperty("classification");
  });
  it("never mutates frozen input or accepts display transforms as geometry", () => {
    const s = deepFreeze(study()), before = JSON.stringify(s);
    const a = evaluateSteinerCore(s), b = evaluateSteinerCore({ ...s, displayTransform: { zoom: 12, pan: [200, -900], rotation: 1 } });
    expect(b).toEqual(a);
    expect(JSON.stringify(s)).toBe(before);
  });
  it("resampling with the inverse spacing update preserves physical distances", () => {
    const s = study();
    const resized = { ...s, imageGeometryRevision: 2, calibration: { ...s.calibration, rowScale: 0.05, columnScale: 0.05, imageGeometryRevision: 2 }, landmarks: s.landmarks.map(p => ({ ...p, row: p.row * 2, column: p.column * 2 })) };
    for (const [id, expected] of Object.entries(GOLDEN)) expect(value(resized, id as CoreMeasurementId)).toBeCloseTo(expected, 10);
  });
  it("does not add a second magnification correction to a supplied calibrated scale", () => {
    const s = study();
    expect(value({ ...s, imagerPixelSpacing: [0.108, 0.108], magnification: 1.08 }, "U1_NA_DISTANCE")).toBeCloseTo(4, 10);
  });
  it("rejects a duplicate id without first-wins or last-wins behavior", () => {
    const s = study(), input = { ...s, landmarks: [...s.landmarks.slice(0, 9), s.landmarks[0]] };
    expect(evaluateSteinerCore(input).measures.every(m => m.status === "not-computable" && m.issue.code === "duplicate-landmark-id")).toBe(true);
  });
  it.each([
    [null, "invalid-study"], [[], "invalid-study"],
    [{ ...study(), revision: 0 }, "invalid-revision"],
    [{ ...study(), imageGeometryRevision: 1.5 }, "invalid-revision"],
    [{ ...study(), projection: "pa-2d" }, "unsupported-projection"],
    [{ ...study(), coordinateConvention: "unknown" }, "unsupported-coordinate-convention"],
    [{ ...study(), orientation: null }, "unknown-orientation"],
    [{ ...study(), calibration: null }, "unknown-aspect-ratio"],
    [{ ...study(), calibration: { ...study().calibration, kind: "unknown" } }, "unknown-aspect-ratio"],
    [{ ...study(), calibration: { ...study().calibration, imageGeometryRevision: 2 } }, "stale-calibration"],
    [{ ...study(), calibration: { ...study().calibration, rowScale: 0 } }, "invalid-scale"],
    [{ ...study(), calibration: { ...study().calibration, columnScale: -1 } }, "invalid-scale"],
    [{ ...study(), calibration: { ...study().calibration, rowScale: Infinity } }, "invalid-scale"],
    [{ ...study(), calibration: { ...study().calibration, scopeConfirmed: false } }, "unverified-patient-calibration"],
    [{ ...study(), calibration: { ...study().calibration, provenance: " " } }, "unverified-patient-calibration"],
    [{ ...study(), landmarks: {} }, "invalid-landmark-collection"],
    [{ ...study(), landmarks: [{ id: "__proto__", column: 0, row: 0 }] }, "unknown-landmark-id"],
  ])("fails closed on malformed study %#", (input, issue) => {
    const r = evaluateSteinerCore(input);
    expect(r.measures).toHaveLength(8);
    expect(r.measures.every(m => m.status === "not-computable" && m.value === null && m.issue.code === issue)).toBe(true);
  });
  it("500 deterministic rigid transforms preserve 4000 core measurements", () => {
    let seed = 123456789;
    const rand = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 500; i++) {
      const theta = rand() * 2 * Math.PI, shift = pt(rand() * 200 - 100, rand() * 200 - 100);
      const p = physical();
      for (const id of CORE_LANDMARK_IDS) p[id] = add(rotate(p[id], theta), shift);
      const input = study(p, 0.05 + rand(), 0.05 + rand(), i % 2 ? "left" : "right");
      for (const [id, expected] of Object.entries(GOLDEN)) expect(value(input, id as CoreMeasurementId)).toBeCloseTo(expected, 8);
    }
  });
});
