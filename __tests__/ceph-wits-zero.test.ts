import { describe, expect, it } from "vitest";
import { computeAll, measure, type LandmarkMap } from "../lib/ceph";

// Synthetic geometry: A and B are different points with the same projection
// on a horizontal occlusal plane. This is zero separation, not missing data.
const points: LandmarkMap = {
  A: { x: 50, y: 20 }, B: { x: 50, y: 80 },
  OcclP: { x: 10, y: 50 }, OcclA: { x: 90, y: 50 },
};

describe("WITS zero separation", () => {
  it("retains a measured zero in the calculation and result table", () => {
    expect(measure("WITS", points, 0.5)).toBe(0);
    expect(computeAll(points, 0.5).find(row => row.code === "WITS")?.value).toBe(0);
  });

  it.each([NaN, Infinity, 0, -1])("still requires valid calibration: %s", scale => {
    expect(measure("WITS", points, scale)).toBeNaN();
  });

  it("rejects a collapsed occlusal plane", () => {
    expect(measure("WITS", { ...points, OcclA: points.OcclP }, 0.5)).toBeNaN();
  });

  it("retains signed, scaled distances either side of zero", () => {
    expect(measure("WITS", { ...points, A: { x: 60, y: 20 } }, 0.5)).toBe(5);
    expect(measure("WITS", { ...points, A: { x: 40, y: 20 } }, 0.5)).toBe(-5);
  });
});
