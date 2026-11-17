/** C1 — SN-GoMe and SN-GoGn as separate research definitions. Hand-calculated synthetic geometry only: these
 * tests prove arithmetic and refusal behaviour, not clinical validity. */
import { describe, expect, it } from "vitest";
import {
  evaluateSnGoGnResearch, evaluateSnGoMeResearch, SN_GOGN_RESEARCH_DEFINITION, SN_GOME_RESEARCH_DEFINITION,
  type MandibularPlaneResearchInput,
} from "../lib/ceph-core/mandibular-plane-research";
import { LEGACY_DEFINITION_VERSIONS } from "../lib/ceph-evidence/definition-versions";
import { MEASUREMENT_EVIDENCE } from "../lib/ceph-evidence/measurement-register";
import { WITS_RESEARCH_DEFINITION } from "../lib/ceph-core/wits-research";

const deg = (radians: number) => radians * 180 / Math.PI;
const grid = { basis: "synthetic-grid" as const, xMmPerUnit: 1, yMmPerUnit: 1 };
// SN horizontal; Go–Me rises 10 over 10 (45°); anatomic Gn rises 5 over 10 (atan 0.5).
const base: MandibularPlaneResearchInput = { s: { x: 0, y: 0 }, n: { x: 10, y: 0 }, go: { x: 0, y: 20 }, me: { x: 10, y: 30 }, calibration: grid };
const mirror = (input: MandibularPlaneResearchInput): MandibularPlaneResearchInput => {
  const m = (p?: { x: number; y: number }) => p && { x: -p.x, y: p.y };
  const gn = input.gnathion;
  return { ...input, s: m(input.s), n: m(input.n), go: m(input.go), me: m(input.me),
    gnathion: gn && (gn.kind === "anatomic" ? { kind: "anatomic", point: m(gn.point)! } : { kind: "constructed", pogonion: m(gn.pogonion)! }) };
};

describe("C1 SN to mandibular plane, two versioned research definitions", () => {
  it("SN-GoMe: 45° on the hand-built grid, labelled as research, no norm, no clinical use", () => {
    expect(evaluateSnGoMeResearch(base)).toMatchObject({ definitionId: SN_GOME_RESEARCH_DEFINITION, status: "ok", unit: "deg",
      clinicalUseAllowed: false, normsStatus: "not-enabled" });
    expect(evaluateSnGoMeResearch(base).value).toBeCloseTo(45, 12);
  });

  it("SN-GoGn with ANATOMIC gnathion differs from SN-GoMe: atan(5/10) on the same grid", () => {
    const result = evaluateSnGoGnResearch({ ...base, gnathion: { kind: "anatomic", point: { x: 10, y: 25 } } });
    expect(result).toMatchObject({ definitionId: SN_GOGN_RESEARCH_DEFINITION, status: "ok", gnathionKind: "anatomic", clinicalUseAllowed: false });
    expect(result.value).toBeCloseTo(deg(Math.atan(0.5)), 12);
  });

  it("SN-GoGn with CONSTRUCTED gnathion lies on Go–Me, so it equals SN-GoMe exactly (independent intersection check)", () => {
    const pog = { x: 12, y: 28 };
    const result = evaluateSnGoGnResearch({ ...base, gnathion: { kind: "constructed", pogonion: pog } });
    // N + t(Pog − N) meets y = x + 20 at t = 30/26 → (10 + 60/26, 28·30/26), on Go–Me by construction.
    const t = 30 / 26, gn = { x: 10 + 2 * t, y: 28 * t };
    expect(gn.y - gn.x).toBeCloseTo(20, 12);
    expect(result).toMatchObject({ status: "ok", gnathionKind: "constructed" });
    expect(result.value).toBeCloseTo(evaluateSnGoMeResearch(base).value!, 12);
  });

  it("refuses SN-GoGn without an explicit gnathion type — there is no default", () => {
    expect(evaluateSnGoGnResearch(base)).toMatchObject({ status: "not-computable", value: null, issue: "gnathion-kind-required" });
    expect(evaluateSnGoGnResearch({ ...base, gnathion: { kind: "guessed" } as never })).toMatchObject({ issue: "unknown-gnathion-kind" });
  });

  it("names missing landmarks and never fills them in", () => {
    expect(evaluateSnGoMeResearch({ ...base, me: undefined })).toMatchObject({ status: "not-computable", value: null, issue: "missing-landmark", missing: ["Me"] });
    expect(evaluateSnGoGnResearch({ ...base, me: undefined, gnathion: { kind: "constructed", pogonion: { x: 12, y: 28 } } }))
      .toMatchObject({ status: "not-computable", issue: "missing-landmark", missing: ["Me"] });
    // Anatomic gnathion does not need Me: its absence is not a reason to refuse.
    expect(evaluateSnGoGnResearch({ ...base, me: undefined, gnathion: { kind: "anatomic", point: { x: 10, y: 25 } } }).status).toBe("ok");
  });

  it("refuses a constructed gnathion when the facial and mandibular planes are parallel, and a gnathion on gonion", () => {
    const parallel = evaluateSnGoGnResearch({ ...base, gnathion: { kind: "constructed", pogonion: { x: 20, y: 10 } } }); // N→Pog ∥ Go→Me
    expect(parallel).toMatchObject({ status: "not-computable", issue: "unstable-intersection" });
    expect(evaluateSnGoGnResearch({ ...base, gnathion: { kind: "anatomic", point: { x: 0, y: 20 } } })).toMatchObject({ issue: "gnathion-equals-gonion" });
  });

  it("is invariant to mirroring and to the order the plane endpoints were traced", () => {
    const anatomic = { ...base, gnathion: { kind: "anatomic" as const, point: { x: 10, y: 25 } } };
    expect(evaluateSnGoMeResearch(mirror(base)).value).toBeCloseTo(45, 12);
    expect(evaluateSnGoGnResearch(mirror(anatomic)).value).toBeCloseTo(deg(Math.atan(0.5)), 12);
    expect(evaluateSnGoMeResearch({ ...base, s: base.n, n: base.s, go: base.me, me: base.go }).value).toBeCloseTo(45, 12);
  });

  it("applies unequal x/y calibration before the angle (never on raw pixels)", () => {
    // x doubled: Go–Me becomes (20, 10) against SN (20, 0) → atan(0.5).
    expect(evaluateSnGoMeResearch({ ...base, calibration: { ...grid, xMmPerUnit: 2 } }).value).toBeCloseTo(deg(Math.atan(0.5)), 12);
    expect(evaluateSnGoMeResearch({ ...base, calibration: { basis: "patient-plane" } as never })).toMatchObject({ issue: "unsupported-research-basis" });
  });
});

describe("C1 legacy definition versions", () => {
  it("never relabels stored values and links each defect to an exported research definition", () => {
    const registered = new Set(MEASUREMENT_EVIDENCE.map(entry => entry.code));
    const known = new Set<string>([SN_GOME_RESEARCH_DEFINITION, SN_GOGN_RESEARCH_DEFINITION, WITS_RESEARCH_DEFINITION]);
    for (const version of LEGACY_DEFINITION_VERSIONS) {
      expect(registered.has(version.legacyCode)).toBe(true);
      expect(version.relabelStoredValues).toBe(false);
      for (const id of version.researchDefinitions) expect(known.has(id)).toBe(true);
      expect(version.stillOpen.length).toBeGreaterThan(0);
    }
    expect(LEGACY_DEFINITION_VERSIONS.find(v => v.legacyCode === "SNGOGN")!.storedValueMeansEn).toMatch(/Go–Me/);
  });
});
