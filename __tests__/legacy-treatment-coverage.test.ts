import { describe, expect, it } from "vitest";
import { validateLineSite, type LineSite } from "../lib/invoice-clinical-linkage";
import { legacyCoverageContains, legacyCoverageOverlaps, legacyCoverageStateFromContext, legacyCoverageStateFromSnapshot,
  type LegacyCoverageSnapshotRow, type LegacyCoverageState } from "../lib/legacy-treatment-coverage";

const expected = { agreementId: 7, serviceId: 11, anchorToothCode: 15 };
const snapshot = (): LegacyCoverageSnapshotRow => ({ agreement_id: 7, format_version: 1, service_id: 11,
  service_category: "bridge", anchor_tooth_code: 15, snapshot_mode: "multi_tooth_episode",
  snapshot_tooth_codes: [14, 15, 16], snapshot_scope: null, snapshot_surfaces: null,
  recorded_by: "synthetic-reception", recorded_at: "2026-10-07T12:34:56.123456Z" });
function site(category: string, toothCode: number | null, patch: Partial<Parameters<typeof validateLineSite>[0]> = {}): LineSite {
  const checked = validateLineSite({ category, toothCode, ...patch });
  if (!checked.ok) throw new Error(checked.reason);
  return checked.site;
}
function state(category: string, toothCode: number | null, patch: Partial<Parameters<typeof validateLineSite>[0]> = {}): LegacyCoverageState {
  const selected = site(category, toothCode, patch);
  return legacyCoverageStateFromSnapshot({ ...snapshot(), service_category: category, anchor_tooth_code: selected.toothCode,
    snapshot_mode: selected.mode, snapshot_tooth_codes: selected.episodeTeeth ?? (selected.toothCode === null ? [] : [selected.toothCode]),
    snapshot_scope: selected.scope, snapshot_surfaces: selected.surfaces }, { ...expected, anchorToothCode: selected.toothCode });
}

describe("immutable legacy coverage resolver", () => {
  it("retains the full canonical tooth set and the original non-minimum anchor", () => {
    const resolved = legacyCoverageStateFromSnapshot(snapshot(), expected);
    expect(resolved).toEqual({ kind: "verified", coverage: { ...expected, formatVersion: 1,
      storedCategory: "bridge", recordedBy: "synthetic-reception", recordedAt: "2026-10-07T12:34:56.123456Z",
      site: { mode: "multi_tooth_episode", toothCode: 15, episodeTeeth: [14, 15, 16], surfaces: null, scope: null } } });
    if (resolved.kind !== "verified") throw new Error("coverage");
    expect(Object.isFrozen(resolved.coverage)).toBe(true);
    expect(Object.isFrozen(resolved.coverage.site)).toBe(true);
    expect(Object.isFrozen(resolved.coverage.site.episodeTeeth)).toBe(true);
  });
  it("never infers absent snapshots from anchors, mutable labels, current categories or consent", () => {
    expect(legacyCoverageStateFromSnapshot(null, expected)).toEqual({ kind: "unknown", reason: "missing_snapshot" });
    expect(legacyCoverageStateFromContext({ ...expected, agreementCount: 1, snapshot: null, caseSite: "14,15,16", category: "bridge", consentAt: "2020-01-01" }))
      .toEqual({ kind: "unknown", reason: "missing_snapshot" });
    expect(legacyCoverageStateFromSnapshot({ ...snapshot(), format_version: 2 }, expected)).toEqual({ kind: "unknown", reason: "unsupported_format" });
  });
  it.each([
    { agreement_id: 8 }, { service_id: 12 }, { anchor_tooth_code: 14 },
  ])("rejects immutable identity drift: %j", (patch) => {
    expect(legacyCoverageStateFromSnapshot({ ...snapshot(), ...patch }, expected)).toMatchObject({ kind: "conflict", reason: "identity_mismatch" });
  });
  it.each([
    { format_version: null }, { format_version: "1" }, { snapshot_tooth_codes: [16, 14, 15] },
    { snapshot_tooth_codes: [14, 15, 15, 16] }, { snapshot_tooth_codes: [14, 16] },
    { snapshot_tooth_codes: [14, 15, 19] }, { snapshot_tooth_codes: [14, 15, null] },
    { snapshot_tooth_codes: ["14", "15", "16"] }, { snapshot_tooth_codes: [] },
    { service_category: "rct" }, { service_category: "consultation" }, { snapshot_scope: "upper" },
    { snapshot_surfaces: "M" }, { recorded_by: "" }, { recorded_by: " synthetic-reception " },
    { recorded_at: "invalid" }, { recorded_at: new Date(NaN) }, { snapshot_mode: "unknown" },
  ])("refuses malformed stored evidence without silently normalizing it: %j", (patch) => {
    expect(legacyCoverageStateFromSnapshot({ ...snapshot(), ...patch }, expected).kind).toBe("conflict");
  });
  it("validates one uniform context and refuses missing/ambiguous identity", () => {
    expect(legacyCoverageStateFromContext({ ...expected, agreementCount: 1, snapshot: snapshot() }))
      .toEqual(legacyCoverageStateFromSnapshot(snapshot(), expected));
    for (const patch of [{ agreementCount: 0 }, { agreementCount: 2 }, { agreementCount: "1" }, { agreementId: "7" }, { serviceId: 0 }, { anchorToothCode: 19 }]) {
      expect(legacyCoverageStateFromContext({ ...expected, agreementCount: 1, snapshot: snapshot(), ...patch }).kind).toBe("conflict");
    }
  });
  it("supports every clinical category without silently widening tooth or named scope", () => {
    for (const category of ["rct", "post", "implant", "extraction", "surgery", "crown", "veneer", "bridge", "filling", "sealant", "cleaning"]) {
      expect(state(category, 51).kind).toBe("verified");
    }
    for (const scope of ["upper", "lower", "both"]) expect(state("ortho", null, { scope }).kind).toBe("verified");
    for (const scope of ["upper", "lower", "full_mouth"]) expect(state("cleaning", null, { scope }).kind).toBe("verified");
    expect(state("whitening", null).kind).toBe("verified");
    const teeth = [11,12,13,14,15,16,17,18,21,22,23,24,25,26,27,28,31,32,33,34,35,36,37,38,41,42,43,44,45,46,47,48];
    expect(state("bridge", 15, { episodeTeeth: teeth }).kind).toBe("verified");
    expect(legacyCoverageStateFromSnapshot({ ...snapshot(), snapshot_tooth_codes: [...teeth, 51] }, expected).kind).toBe("conflict");
  });
});

describe("shared legacy overlap and containment", () => {
  it("finds secondary teeth, partial episode overlap, containment and truly disjoint episodes", () => {
    const bridge = legacyCoverageStateFromSnapshot(snapshot(), expected);
    expect(legacyCoverageOverlaps(bridge, site("bridge", 16, { episodeTeeth: [16, 17] }))).toBe(true);
    expect(legacyCoverageContains(bridge, site("bridge", 16, { episodeTeeth: [16, 17] }))).toBe(false);
    expect(legacyCoverageContains(bridge, site("bridge", 14, { episodeTeeth: [14, 16] }))).toBe(true);
    expect(legacyCoverageContains(bridge, site("bridge", 16))).toBe(true);
    expect(legacyCoverageOverlaps(bridge, site("bridge", 17, { episodeTeeth: [17, 18] }))).toBe(false);
    expect(legacyCoverageContains(bridge, site("bridge", 17))).toBe(false);
  });
  it("protects all permanent and primary members of immutable upper/lower/both scopes", () => {
    const upper = state("ortho", null, { scope: "upper" }), both = state("ortho", null, { scope: "both" });
    for (const tooth of [11, 28, 51, 65]) {
      expect(legacyCoverageOverlaps(upper, site("bridge", tooth))).toBe(true);
      expect(legacyCoverageContains(upper, site("bridge", tooth))).toBe(true);
    }
    for (const tooth of [31, 48, 71, 85]) expect(legacyCoverageOverlaps(upper, site("bridge", tooth))).toBe(false);
    expect(legacyCoverageOverlaps(upper, site("ortho", null, { scope: "lower" }))).toBe(false);
    expect(legacyCoverageOverlaps(upper, site("ortho", null, { scope: "both" }))).toBe(true);
    expect(legacyCoverageContains(upper, site("ortho", null, { scope: "both" }))).toBe(false);
    expect(legacyCoverageContains(both, site("ortho", null, { scope: "upper" }))).toBe(true);
    expect(legacyCoverageContains(state("cleaning", 31), site("cleaning", null, { scope: "lower" }))).toBe(false);
    expect(legacyCoverageContains(state("cleaning", null, { scope: "full_mouth" }), site("cleaning", 85))).toBe(true);
  });
  it("keeps surfaces conservative: overlap is not permission to split or invent coverage", () => {
    const known = state("filling", 26, { surfaces: "M,O,D" }), unknown = state("filling", 26);
    expect(legacyCoverageContains(known, site("filling", 26, { surfaces: "MO" }))).toBe(true);
    expect(legacyCoverageOverlaps(known, site("filling", 26, { surfaces: "B" }))).toBe(true);
    expect(legacyCoverageContains(known, site("filling", 26, { surfaces: "B" }))).toBe(false);
    expect(legacyCoverageContains(known, site("filling", 26))).toBe(false);
    expect(legacyCoverageContains(unknown, site("filling", 26, { surfaces: "M" }))).toBe(false);
    expect(legacyCoverageContains(unknown, site("filling", 26))).toBe(false);
    expect(legacyCoverageOverlaps(unknown, site("filling", 26))).toBe(true);
    expect(legacyCoverageOverlaps(known, site("filling", 27))).toBe(false);
    const filling = { ...snapshot(), service_category: "filling", anchor_tooth_code: 15, snapshot_mode: "tooth_surfaces", snapshot_tooth_codes: [15], snapshot_surfaces: "MOD" };
    expect(legacyCoverageStateFromSnapshot(filling, expected).kind).toBe("conflict"); // Stored order is MDOBL, never silently repaired.
  });
  it("fails closed for unknown/conflict evidence and malformed incoming sites", () => {
    for (const unavailable of [{ kind: "unknown", reason: "missing_snapshot" }, { kind: "conflict", reason: "identity_mismatch" }] as const) {
      expect(legacyCoverageOverlaps(unavailable, site("rct", 48))).toBe(true);
      expect(legacyCoverageContains(unavailable, site("rct", 48))).toBe(false);
    }
    const bridge = legacyCoverageStateFromSnapshot(snapshot(), expected);
    for (const malformed of [{ ...site("bridge", 14), episodeTeeth: [16, 14] }, { ...site("rct", 48), toothCode: 19 }, { ...site("rct", 48), scope: "unknown" }]) {
      expect(legacyCoverageOverlaps(bridge, malformed as LineSite)).toBe(true);
      expect(legacyCoverageContains(bridge, malformed as LineSite)).toBe(false);
    }
  });
});
