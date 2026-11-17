/**
 * Baseline characterization, not endorsement of legacy clinical correctness.
 * These assertions distinguish an intentional, versioned future correction from
 * silent changes to existing snapshots. See docs/ceph/independent-core-v1.md.
 */
import { describe, expect, it } from "vitest";
import { computeAll, enrichWithRefs, measure, pixelsToMm, projectOnLine, type LandmarkMap } from "../lib/ceph";
import { compareAnalyses, type ComparableMeasurement } from "../lib/cephCompare";
import { superimposeOnSN } from "../lib/cephSuperimpose";
import { evaluateSteinerCore } from "../lib/ceph-core/steiner-core";

describe("legacy baseline characterization, not a clinical specification", () => {
  it("legacy SNGOGN uses Me rather than Gn", () => {
    const p: LandmarkMap = { S: { x: 0, y: 0 }, N: { x: 10, y: 0 }, Go: { x: 0, y: 10 }, Me: { x: 10, y: 20 } };
    expect(measure("SNGOGN", p, 1)).toBeCloseTo(45, 10);
    expect(measure("SNGOGN", { ...p, Gn: { x: -50, y: 60 } }, 1)).toBe(measure("SNGOGN", p, 1));
  });
  it("legacy Wits returns NaN for coincident valid projections", () => {
    expect(measure("WITS", { OcclA: { x: 10, y: 0 }, OcclP: { x: 0, y: 0 }, A: { x: 5, y: 2 }, B: { x: 5, y: 8 } }, 1)).toBeNaN();
  });
  it("legacy degenerate line returns its endpoint", () => {
    expect(projectOnLine({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
  it("legacy scale conversion accepts zero and negative values", () => {
    expect(pixelsToMm(10, 0)).toBe(0);
    expect(pixelsToMm(10, -1)).toBe(-10);
  });
  it("legacy compound analysis supplies 3 degrees for absent palatal plane", () => {
    const p: LandmarkMap = { Po: { x: 0, y: 0 }, Or: { x: 10, y: 0 }, A: { x: 0, y: 0 }, B: { x: 0, y: 10 } };
    expect(measure("PP_FH", p, 1)).toBeNaN();
    expect(measure("APDI", p, 1)).toBeCloseTo(measure("FH_AB", p, 1) + 3, 10);
  });
  it("legacy raw status and rounded severity disagree at the boundary", () => {
    const theta = 84.04 * Math.PI / 180;
    const p: LandmarkMap = { N: { x: 0, y: 0 }, S: { x: 10, y: 0 }, A: { x: 10 * Math.cos(theta), y: 10 * Math.sin(theta) } };
    const sna = computeAll(p, 1).find(m => m.code === "SNA");
    expect(sna).toMatchObject({ value: 84, status: "above", severityStars: "" });
  });
  it("legacy missing references fall back to embedded mean and tolerance", () => {
    const p: LandmarkMap = { N: { x: 0, y: 0 }, S: { x: 10, y: 0 }, A: { x: 0, y: 10 } };
    const raw = computeAll(p, 1), enriched = enrichWithRefs(raw, {});
    expect(enriched[0].refMean).toBe(raw[0].mean);
    expect(enriched[0].refSd).toBe(raw[0].tol);
  });
  const comparable = (value: number, unit = "mm"): ComparableMeasurement => ({ code: "same-code", name: "synthetic", unit, value, mean: null });
  it("legacy comparison does not gate incompatible units", () => {
    expect(compareAnalyses([comparable(1)], [comparable(2, "deg")]).measurements[0]).toMatchObject({ before: 1, after: 2, delta: 1, unit: "deg" });
  });
  it("legacy comparison chooses the last duplicate code", () => {
    expect(compareAnalyses([comparable(1), comparable(4)], [comparable(7)]).measurements[0].delta).toBe(3);
  });
  it("legacy registration accepts zero SN length", () => {
    const input = { points: { S: { x: 0, y: 0 }, N: { x: 0, y: 0 } }, mmPerPixel: 1 };
    expect(superimposeOnSN(input, input).ok).toBe(true);
  });
  it("legacy registration may return ok with non-finite landmarks", () => {
    const input = { points: { S: { x: NaN, y: 0 }, N: { x: 10, y: 0 } }, mmPerPixel: 1 };
    const result = superimposeOnSN(input, input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.cranialBaseBefore).toBeNaN();
  });
  it("new core rejects legacy-shaped input without modifying its frozen points", () => {
    const points = Object.freeze({ S: Object.freeze({ x: 0, y: 0 }), N: Object.freeze({ x: 10, y: 0 }), A: Object.freeze({ x: 0, y: 10 }) });
    const before = computeAll(points, 1);
    expect(evaluateSteinerCore({ invalidLegacyShape: points }).measures.every(m => m.status === "not-computable")).toBe(true);
    expect(computeAll(points, 1)).toEqual(before);
  });
});
