import { describe, expect, it } from "vitest";
import { buildWireSessionView, buildWireTimeline, normalizeWireCode, type WireTimelineInput } from "@/lib/ortho-wire-timeline";

/**
 * OW-1 (docs/review/ortho-wire-timeline-photo-records-contract-20261118.md, v2.1).
 * Synthetic data only. Blank wire = unchanged (owner decision); a removal is
 * shown only with documented evidence; no installation date or duration is invented.
 */

type Adj = WireTimelineInput["adjustments"][number];
let nextId = 1;
const adj = (doneOn: string, upperWire: string | null, lowerWire: string | null = null, extra: Partial<Adj> = {}): Adj => ({
  id: nextId++, doneOn, phase: null, upperWire, lowerWire, elastics: "none", elasticNote: null, ...extra,
});
const base = (adjustments: Adj[], extra: Partial<WireTimelineInput> = {}): WireTimelineInput => ({
  case: { slot: "022", appliance: "fixed_metal", arches: "both", upperWire: null, lowerWire: null },
  adjustments, documentedRemovals: [], hasMore: false, ...extra,
});
const timeline = (input: WireTimelineInput) => {
  const result = buildWireTimeline(input);
  if (result.kind !== "timeline") throw new Error("expected a timeline");
  return result;
};
const lane = (input: WireTimelineInput, arch: "upper" | "lower") => {
  const found = timeline(input).lanes.find(item => item.arch === arch);
  if (!found) throw new Error(`no ${arch} lane`);
  return found;
};

describe("buildWireTimeline (OW-1)", () => {
  it("builds documented segments for a full 022 sequence with documented-period labels", () => {
    const upper = lane(base([
      adj("2026-01-04", "014 NiTi"), adj("2026-02-01", "014 NiTi"),
      adj("2026-03-01", "016×022 NiTi"), adj("2026-04-26", "019×025 SS"),
    ]), "upper");
    expect(upper.segments.map(s => [s.kind, s.text, s.firstDocumentedOn, s.lastSessionOn, s.documentedWeeks, s.endedBy])).toEqual([
      ["wire", "014 NiTi", "2026-01-04", "2026-02-01", 4, "change"],
      ["wire", "016×022 NiTi", "2026-03-01", "2026-03-01", 0, "change"],
      ["wire", "019×025 SS", "2026-04-26", "2026-04-26", 0, "current"],
    ]);
    expect(upper.segments[0].catalogue?.material).toBe("NiTi");
    expect(upper.segments[2].catalogue?.phase).toBe("working");
  });

  it("R2: blank sessions are unchanged and stay inside the previous wire segment", () => {
    const input = base([adj("2026-01-04", "016 NiTi"), adj("2026-02-01", null), adj("2026-03-01", null), adj("2026-04-05", "016×022 NiTi")]);
    const [first, second] = lane(input, "upper").segments;
    expect(first).toMatchObject({ kind: "wire", text: "016 NiTi", firstDocumentedOn: "2026-01-04", lastSessionOn: "2026-03-01", endedBy: "change" });
    expect(first.sessionIds).toHaveLength(3);
    expect(first.blankSessionIds).toHaveLength(2);
    expect(second).toMatchObject({ text: "016×022 NiTi", firstDocumentedOn: "2026-04-05" });
  });

  it("R3: a documented removal ends the segment; later blanks stay 'no wire'", () => {
    const a = adj("2026-01-04", "016 NiTi"); const r = adj("2026-02-01", null); const b = adj("2026-03-01", null);
    const upper = lane(base([a, r, b], { documentedRemovals: [{ adjustmentId: r.id, arch: "upper" }] }), "upper");
    expect(upper.segments.map(s => [s.kind, s.firstDocumentedOn, s.lastSessionOn, s.endedBy])).toEqual([
      ["wire", "2026-01-04", "2026-01-04", "removal"],
      ["none", "2026-02-01", "2026-03-01", "current"],
    ]);
  });

  it("R3: a blank session without removal evidence never ends the segment", () => {
    const upper = lane(base([adj("2026-01-04", "016 NiTi"), adj("2026-02-01", null)]), "upper");
    expect(upper.segments).toHaveLength(1);
    expect(upper.segments[0]).toMatchObject({ kind: "wire", endedBy: "current", lastSessionOn: "2026-02-01" });
  });

  it("R3: removal evidence for one arch does not touch the other, and never overrides a recorded wire", () => {
    const a = adj("2026-01-04", "016 NiTi", "014 NiTi"); const r = adj("2026-02-01", null, null);
    const c = adj("2026-03-01", "016 NiTi", "016 NiTi");
    const input = base([a, r, c], { documentedRemovals: [{ adjustmentId: r.id, arch: "upper" }, { adjustmentId: c.id, arch: "lower" }] });
    expect(lane(input, "upper").segments.map(s => [s.kind, s.endedBy])).toEqual([["wire", "removal"], ["none", "change"], ["wire", "current"]]);
    expect(lane(input, "lower").segments.map(s => [s.kind, s.text, s.endedBy])).toEqual([["wire", "014 NiTi", "change"], ["wire", "016 NiTi", "current"]]);
  });

  it("R4: the current segment ends at its last session, never at today", () => {
    const upper = lane(base([adj("2026-01-04", "016 NiTi"), adj("2026-01-18", null)]), "upper");
    expect(upper.segments[0]).toMatchObject({ lastSessionOn: "2026-01-18", documentedWeeks: 2, endedBy: "current" });
  });

  it("R5: blank sessions before any recorded wire form an unknown segment", () => {
    const upper = lane(base([adj("2026-01-04", null), adj("2026-02-01", null), adj("2026-03-01", "016 NiTi")]), "upper");
    expect(upper.segments[0]).toMatchObject({ kind: "unknown", text: null, firstDocumentedOn: null, documentedWeeks: null, endedBy: "change" });
    expect(upper.segments[1]).toMatchObject({ kind: "wire", firstDocumentedOn: "2026-03-01" });
  });

  it("R6: hasMore marks the timeline truncated and the first segment as limited to shown sessions", () => {
    const result = timeline(base([adj("2026-01-04", "016 NiTi"), adj("2026-02-01", "016×022 NiTi")], { hasMore: true }));
    expect(result.truncated).toBe(true);
    const upper = result.lanes.find(item => item.arch === "upper")!;
    expect(upper.segments[0].limitedToShown).toBe(true);
    expect(upper.segments[1].limitedToShown).toBe(false);
    expect(timeline(base([adj("2026-01-04", "016 NiTi")])).truncated).toBe(false);
  });

  it("R7: matching tolerates spaces, case and x/× only, and keeps the recorded text verbatim", () => {
    expect(normalizeWireCode(" 016x022  niti ")).toBe(normalizeWireCode("016×022 NiTi"));
    expect(normalizeWireCode("16x22 NiTi")).not.toBe(normalizeWireCode("016×022 NiTi"));
    const upper = lane(base([adj("2026-01-04", "016x022 niti"), adj("2026-02-01", "016×022 NiTi"), adj("2026-03-01", "16x22"), adj("2026-04-01", "Bioforce 18")]), "upper");
    expect(upper.segments.map(s => [s.text, s.catalogueStatus])).toEqual([
      ["016x022 niti", "match"], ["16x22", "off_catalogue"], ["Bioforce 18", "off_catalogue"],
    ]);
    expect(upper.segments[0].variants).toEqual(["016x022 niti", "016×022 NiTi"]);
  });

  it("R8: a recorded phase that differs from the catalogue phase is kept beside it", () => {
    const upper = lane(base([adj("2026-01-04", "019×025 SS", null, { phase: "finishing" })]), "upper");
    expect(upper.segments[0]).toMatchObject({ recordedPhase: "finishing", phaseDiffers: true });
    expect(upper.segments[0].catalogue?.phase).toBe("working");
  });

  it("R9: a single-arch case hides the untreated lane unless a wire is recorded there", () => {
    const upperOnly = { slot: "022" as const, appliance: "fixed_metal" as const, arches: "upper" as const, upperWire: null, lowerWire: null };
    expect(timeline(base([adj("2026-01-04", "016 NiTi")], { case: upperOnly })).lanes.map(l => l.arch)).toEqual(["upper"]);
    const withLower = timeline(base([adj("2026-01-04", "016 NiTi", "014 NiTi")], { case: upperOnly }));
    expect(withLower.lanes.map(l => [l.arch, l.treated])).toEqual([["upper", true], ["lower", false]]);
  });

  it("R10: appliances without archwires have no timeline", () => {
    for (const appliance of ["aligners", "removable", "functional"] as const) {
      expect(buildWireTimeline(base([adj("2026-01-04", "016 NiTi")], {
        case: { slot: "022", appliance, arches: "both", upperWire: null, lowerWire: null },
      })).kind).toBe("not_applicable");
    }
  });

  it("R11: out-of-order and other-slot wires get neutral flags only", () => {
    const upper = lane(base([adj("2026-01-04", "019×025 SS"), adj("2026-02-01", "016 NiTi"), adj("2026-03-01", "017×025 TMA")]), "upper");
    expect(upper.segments.map(s => [s.catalogueStatus, s.outOfOrder])).toEqual([["match", false], ["match", true], ["other_slot", false]]);
  });

  it("R13: a case wire that differs from the last derived wire reports both, choosing neither", () => {
    const result = timeline(base([adj("2026-01-04", "016 NiTi")], {
      case: { slot: "022", appliance: "fixed_metal", arches: "both", upperWire: "016×022 NiTi", lowerWire: null },
    }));
    expect(result.mismatches).toEqual([{ arch: "upper", caseWire: "016×022 NiTi", lastWire: "016 NiTi" }]);
    expect(timeline(base([adj("2026-01-04", "016x022 niti")], {
      case: { slot: "022", appliance: "fixed_metal", arches: "both", upperWire: "016×022 NiTi", lowerWire: null },
    })).mismatches).toEqual([]);
  });

  it("R14: elastics form documented periods without extending to today", () => {
    const result = timeline(base([
      adj("2026-01-04", "016 NiTi", null, { elastics: "none" }),
      adj("2026-02-01", null, null, { elastics: "class_ii", elasticNote: "3/16" }),
      adj("2026-03-01", null, null, { elastics: "class_ii" }),
      adj("2026-04-05", null, null, { elastics: "none" }),
    ]));
    expect(result.elastics.map(p => [p.elastics, p.firstDocumentedOn, p.lastSessionOn, p.sessions, p.note])).toEqual([
      ["none", "2026-01-04", "2026-01-04", 1, null],
      ["class_ii", "2026-02-01", "2026-03-01", 2, "3/16"],
      ["none", "2026-04-05", "2026-04-05", 1, null],
    ]);
  });

  it("orders by doneOn then id, regardless of the read's descending order", () => {
    const first = adj("2026-01-04", "014 NiTi"); const sameDayA = adj("2026-02-01", "016 NiTi"); const sameDayB = adj("2026-02-01", "018 NiTi");
    const upper = lane(base([sameDayB, sameDayA, first]), "upper");
    expect(upper.segments.map(s => s.text)).toEqual(["014 NiTi", "016 NiTi", "018 NiTi"]);
  });

  it("keeps calendar dates verbatim (no timezone conversion)", () => {
    const upper = lane(base([adj("2026-03-31", "016 NiTi"), adj("2026-04-01", null)]), "upper");
    expect(upper.segments[0]).toMatchObject({ firstDocumentedOn: "2026-03-31", lastSessionOn: "2026-04-01" });
  });

  it("an empty history yields empty lanes, not invented segments", () => {
    const result = timeline(base([], { case: { slot: "022", appliance: "fixed_metal", arches: "both", upperWire: "016 NiTi", lowerWire: null } }));
    expect(result.lanes.every(l => l.segments.length === 0)).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it("refuses malformed input rather than guessing", () => {
    expect(() => buildWireTimeline(base([adj("2026-02-30", "016 NiTi")]))).toThrow();
    expect(() => buildWireTimeline(base([adj("2026-01-04", "016 NiTi")], { documentedRemovals: [{ adjustmentId: 999999, arch: "upper" }] }))).not.toThrow();
  });
});

describe("buildWireSessionView (redesign 6993812820: one row per session, same semantics)", () => {
  const view = (input: WireTimelineInput) => {
    const result = buildWireSessionView(input);
    if (result.kind !== "sessions") throw new Error("expected sessions");
    return result;
  };

  it("one row per session, newest first, with fixed upper/lower/elastics columns", () => {
    const a = adj("2026-01-04", "014 NiTi", "014 NiTi"); const b = adj("2026-02-01", null, null, { elastics: "class_ii" });
    const c = adj("2026-03-01", "016 NiTi", "014 NiTi", { elastics: "class_ii" });
    const result = view(base([a, b, c]));
    expect(result.rows.map(r => [r.doneOn, r.upper?.kind, r.upper?.text, r.lower?.kind, r.lower?.text, r.elastics.kind, r.elastics.elastics])).toEqual([
      ["2026-03-01", "change", "016 NiTi", "same", "014 NiTi", "same", "class_ii"],
      ["2026-02-01", "unchanged", null, "unchanged", null, "change", "class_ii"],
      ["2026-01-04", "first", "014 NiTi", "first", "014 NiTi", "first", "none"],
    ]);
  });

  it("a blank session names no wire; a documented removal is distinct; blanks after it stay unchanged", () => {
    const a = adj("2026-01-04", "016 NiTi"); const r = adj("2026-02-01", null); const b = adj("2026-03-01", null);
    const result = view(base([a, r, b], { documentedRemovals: [{ adjustmentId: r.id, arch: "upper" }] }));
    expect(result.rows.map(row => [row.upper?.kind, row.upper?.text])).toEqual([["unchanged", null], ["removal", null], ["first", "016 NiTi"]]);
    expect(result.summary.find(s => s.arch === "upper")).toMatchObject({ kind: "none", text: null, firstDocumentedOn: "2026-02-01" });
  });

  it("sessions before any recorded wire are 'unknown', never an inferred wire", () => {
    const result = view(base([adj("2026-01-04", null), adj("2026-02-01", "016 NiTi")]));
    expect(result.rows.map(row => row.upper?.kind)).toEqual(["first", "unknown"]);
  });

  it("the summary gives the last documented wire per arch with its first documented date, not today", () => {
    const result = view(base([adj("2026-01-04", "014 NiTi", "014 NiTi"), adj("2026-03-01", "016 NiTi", null), adj("2026-04-05", null, null)]));
    expect(result.summary).toEqual([
      { arch: "upper", treated: true, kind: "wire", text: "016 NiTi", firstDocumentedOn: "2026-03-01", lastSessionOn: "2026-04-05", documentedWeeks: 5 },
      { arch: "lower", treated: true, kind: "wire", text: "014 NiTi", firstDocumentedOn: "2026-01-04", lastSessionOn: "2026-04-05", documentedWeeks: 13 },
    ]);
  });

  it("keeps neutral catalogue flags on change cells only, and hides untreated arches with no record", () => {
    const upperOnly = { slot: "022" as const, appliance: "fixed_metal" as const, arches: "upper" as const, upperWire: null, lowerWire: null };
    const result = view(base([adj("2026-01-04", "019×025 SS"), adj("2026-02-01", "016 NiTi"), adj("2026-03-01", "Bioforce 18")], { case: upperOnly }));
    expect(result.arches).toEqual(["upper"]);
    expect(result.rows.every(row => row.lower === null)).toBe(true);
    expect(result.rows.map(row => [row.upper?.kind, row.upper?.catalogueStatus, row.upper?.outOfOrder])).toEqual([
      ["change", "off_catalogue", false], ["change", "match", true], ["first", "match", false],
    ]);
  });

  it("not applicable without archwires; truncation and mismatches carried over", () => {
    expect(buildWireSessionView(base([adj("2026-01-04", "016 NiTi")], { case: { slot: "022", appliance: "aligners", arches: "both", upperWire: null, lowerWire: null } })).kind).toBe("not_applicable");
    const result = view(base([adj("2026-01-04", "016 NiTi")], { hasMore: true, case: { slot: "022", appliance: "fixed_metal", arches: "both", upperWire: "019×025 SS", lowerWire: null } }));
    expect(result.truncated).toBe(true);
    expect(result.mismatches).toEqual([{ arch: "upper", caseWire: "019×025 SS", lastWire: "016 NiTi" }]);
  });
});

