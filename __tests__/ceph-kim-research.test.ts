/** Kim indices as research definitions — hand-calculated synthetic geometry only (face to +x, y down). Proves
 * arithmetic, sign rules and refusals, not clinical validity. */
import { describe, expect, it } from "vitest";
import { measure, type LandmarkMap } from "../lib/ceph";
import {
  evaluateKimApdi, evaluateKimCombinationFactor, evaluateKimExtractionIndex, evaluateKimOdi, evaluateKimPalatalTilt,
  KIM_REQUIRED_LANDMARKS, type KimLandmark, type KimResearchInput,
} from "../lib/ceph-core/kim-research";
import type { Point2D } from "../lib/ceph-core/geometry";

const deg = (r: number) => r * 180 / Math.PI;
const dir = (a: Point2D, b: Point2D) => deg(Math.atan2(b.y - a.y, b.x - a.x)); // from +x (anterior), y down
const grid = { basis: "synthetic-grid" as const, xMmPerUnit: 1, yMmPerUnit: 1 };
const base: Record<KimLandmark, Point2D> = {
  Po: { x: 0, y: 0 }, Or: { x: 100, y: 0 }, PNS: { x: 40, y: 60 }, ANS: { x: 130, y: 60 },
  A: { x: 120, y: 100 }, B: { x: 110, y: 170 }, Go: { x: 30, y: 140 }, Me: { x: 110, y: 200 },
};
const input = (landmarks: Partial<Record<KimLandmark, Point2D>>): KimResearchInput => ({ landmarks, calibration: grid });
const down = { ...base, ANS: { x: 130, y: 70 } };  // palatal plane slopes downward anteriorly
const up = { ...base, ANS: { x: 130, y: 50 } };    // upward anteriorly
const tilt = deg(Math.atan(10 / 90));
const fhAb = 180 - dir(base.A, base.B);            // posterior FH ray to A→B: 81.87°
const abMp = dir(base.A, base.B) - dir(base.Go, base.Me);
const map = (f: (p: Point2D) => Point2D) => (lm: Record<KimLandmark, Point2D>) =>
  Object.fromEntries(Object.entries(lm).map(([k, p]) => [k, f(p)])) as Record<KimLandmark, Point2D>;
const mirror = map((p) => ({ x: -p.x, y: p.y }));
const rotate = (t: number) => map((p) => ({ x: p.x * Math.cos(t) - p.y * Math.sin(t), y: p.x * Math.sin(t) + p.y * Math.cos(t) }));

describe("Kim palatal plane to FH, signed (secondary sources: + downward anteriorly, − upward)", () => {
  it("is 0 when parallel, +atan(10/90) downward, −atan(10/90) upward", () => {
    expect(evaluateKimPalatalTilt(input(base)).value).toBeCloseTo(0, 12);
    expect(evaluateKimPalatalTilt(input(down)).value).toBeCloseTo(tilt, 12);
    expect(evaluateKimPalatalTilt(input(up)).value).toBeCloseTo(-tilt, 12);
  });
  it("keeps the sign on a mirrored or rotated image", () => {
    expect(evaluateKimPalatalTilt(input(mirror(down))).value).toBeCloseTo(tilt, 12);
    expect(evaluateKimPalatalTilt(input(rotate(0.3)(up))).value).toBeCloseTo(-tilt, 12);
  });
  it("refuses a palatal plane traced back to front", () => {
    expect(evaluateKimPalatalTilt(input({ ...base, ANS: base.PNS, PNS: base.ANS }))).toMatchObject({ status: "not-computable", issue: "orientation-inconsistent" });
  });
});

describe("Kim APDI (Kim & Vietas 1978: facial angle ± A-B plane angle ± palatal plane angle)", () => {
  it("is the posterior FH to A→B angle plus the signed palatal tilt", () => {
    expect(evaluateKimApdi(input(base)).value).toBeCloseTo(fhAb, 12);
    expect(evaluateKimApdi(input(down)).value).toBeCloseTo(fhAb + tilt, 12);
    expect(evaluateKimApdi(input(up)).value).toBeCloseTo(fhAb - tilt, 12);
    expect(fhAb).toBeCloseTo(81.87, 2);
  });
  it("equals the facial angle plus the signed A-B plane angle (three-angle form; N–Pog cancels)", () => {
    const N = { x: 115, y: -60 }, Pog = { x: 118, y: 190 };
    const facial = 180 - dir(N, Pog);                  // FH to N–Pog, posterior-inferior
    const abPlaneAngle = dir(N, Pog) - dir(base.A, base.B); // negative when B lies behind the facial plane
    expect(abPlaneAngle).toBeLessThan(0);
    expect(evaluateKimApdi(input(down)).value).toBeCloseTo(facial + abPlaneAngle + tilt, 12);
  });
  it("equals the angle between the posterior palatal ray and A→B (geometric form, obamiyi-2019)", () => {
    for (const lm of [base, down, up]) {
      const ppPost = { x: lm.PNS.x - lm.ANS.x, y: lm.PNS.y - lm.ANS.y }, ab = { x: lm.B.x - lm.A.x, y: lm.B.y - lm.A.y };
      const witness = deg(Math.acos((ppPost.x * ab.x + ppPost.y * ab.y) / Math.hypot(ppPost.x, ppPost.y) / Math.hypot(ab.x, ab.y)));
      expect(evaluateKimApdi(input(lm)).value).toBeCloseTo(witness, 10);
    }
  });
  it("grows when B moves forward (mesial, Class III direction) and shrinks when it moves back", () => {
    const fwd = evaluateKimApdi(input({ ...base, B: { x: 130, y: 170 } })).value!;
    const back = evaluateKimApdi(input({ ...base, B: { x: 90, y: 170 } })).value!;
    expect(fwd).toBeGreaterThan(fhAb);
    expect(back).toBeLessThan(fhAb);
  });
  it("is invariant to mirroring and rotation, and carries its components and evidence", () => {
    expect(evaluateKimApdi(input(mirror(down))).value).toBeCloseTo(fhAb + tilt, 12);
    expect(evaluateKimApdi(input(rotate(-0.4)(down))).value).toBeCloseTo(fhAb + tilt, 12);
    expect(evaluateKimApdi(input(down))).toMatchObject({ status: "ok", clinicalUseAllowed: false, normsStatus: "not-enabled",
      evidence: "primary-abstract-and-peer-reviewed-secondary", components: { palatalTilt: expect.closeTo(tilt, 12) } });
  });
});

describe("Kim ODI (A-B plane to Me–Go mandibular plane + signed palatal tilt)", () => {
  it("sums the two angles with the palatal sign rule", () => {
    expect(evaluateKimOdi(input(base)).value).toBeCloseTo(abMp, 12);
    expect(evaluateKimOdi(input(down)).value).toBeCloseTo(abMp + tilt, 12);
    expect(evaluateKimOdi(input(up)).value).toBeCloseTo(abMp - tilt, 12);
    expect(evaluateKimOdi(input(mirror(up))).value).toBeCloseTo(abMp - tilt, 12);
    expect(evaluateKimOdi(input(base)).evidence).toBe("peer-reviewed-secondary-only");
  });
  it("refuses a mandibular plane traced back to front", () => {
    expect(evaluateKimOdi(input({ ...base, Go: base.Me, Me: base.Go }))).toMatchObject({ issue: "orientation-inconsistent" });
  });
});

describe("no substitution, each index its own inputs", () => {
  it("names the missing palatal landmarks instead of assuming a tilt", () => {
    const { ANS: _ans, ...noAns } = base;
    expect(evaluateKimApdi(input(noAns))).toEqual(expect.objectContaining({ status: "not-computable", value: null, issue: "missing-landmark", missing: ["ANS"] }));
    expect(evaluateKimOdi(input(noAns))).toMatchObject({ status: "not-computable", value: null, missing: ["ANS"] });
  });
  it("declares different inputs per index", () => {
    expect(KIM_REQUIRED_LANDMARKS["kim-apdi/0.1.0-research"]).not.toContain("Go");
    expect(KIM_REQUIRED_LANDMARKS["kim-odi/0.1.0-research"]).toEqual(expect.arrayContaining(["Go", "Me", "ANS", "PNS"]));
  });
  it("returns CF and the Extraction Index as incomplete, with no value, even with every landmark", () => {
    expect(evaluateKimCombinationFactor(input(base))).toMatchObject({ status: "incomplete", value: null, issue: "primary-source-not-read" });
    expect(evaluateKimExtractionIndex(input(base))).toMatchObject({ status: "incomplete", value: null, issue: "definition-conflicts-across-secondary-sources" });
  });
  it("refuses non-synthetic calibration", () => {
    expect(evaluateKimApdi({ landmarks: base, calibration: { basis: "patient" } as never })).toMatchObject({ issue: "unsupported-research-basis" });
  });
});

describe("legacy Kim formulas compared on the same synthetic face (values unchanged; the differences are recorded)", () => {
  const legacy = base as unknown as LandmarkMap;
  it("legacy FH_AB is the supplement of the Kim/Downs posterior angle", () => {
    expect(measure("FH_AB", legacy, 1)).toBeCloseTo(180 - fhAb, 10);
  });
  it("legacy APDI therefore reads ~98° for this Class I-like face, where the research definition reads ~82°", () => {
    expect(measure("APDI", legacy, 1)).toBeCloseTo(180 - fhAb, 10);
    expect(evaluateKimApdi(input(base)).value).toBeCloseTo(fhAb, 10);
  });
  it("legacy palatal term is unsigned: an upward tilt is ADDED instead of subtracted", () => {
    const upLegacy = up as unknown as LandmarkMap;
    expect(measure("ODI", upLegacy, 1)).toBeCloseTo(abMp + tilt, 10);
    expect(evaluateKimOdi(input(up)).value).toBeCloseTo(abMp - tilt, 10);
  });
});
