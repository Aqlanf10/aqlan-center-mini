import { describe, expect, it } from "vitest";
import { measure, type LandmarkMap } from "../lib/ceph";

// Independent synthetic geometry, no patient landmarks or population norm.
// Horizontal occlusal axis y=20: A(10,5) and B(10,40) both project to(10,20).
const points: LandmarkMap = { A: { x: 10, y: 5 }, B: { x: 10, y: 40 }, OcclA: { x: 50, y: 20 }, OcclP: { x: 0, y: 20 } };
describe("WITS zero is distinct from an undefined occlusal axis", () => {
  it("returns zero millimetres for coincident projections on a defined calibrated axis", () => {
    expect(measure("WITS", points, 0.5)).toBe(0);
  });
  it("retains signed nonzero distances: 6px anterior is +3mm, posterior is -3mm", () => {
    expect(measure("WITS", { ...points, A: { x: 16, y: 5 } }, 0.5)).toBe(3);
    expect(measure("WITS", { ...points, A: { x: 4, y: 5 } }, 0.5)).toBe(-3);
  });
  it("still refuses a zero-length plane and missing calibration, even at zero separation", () => {
    expect(measure("WITS", { ...points, OcclP: points.OcclA }, 0.5)).toBeNaN();
    expect(measure("WITS", points, 0)).toBeNaN();
    expect(measure("WITS", points, Number.NaN)).toBeNaN();
  });
});
