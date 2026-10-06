import { describe, expect, it } from "vitest";
import { ALL_TEETH } from "../lib/dental";
import { emptyPeriodontalSites, parsePeriodontalCommand, parsePeriodontalSites, periodontalDepth } from "../lib/periodontal";

const command = () => {
  const sites = emptyPeriodontalSites(); sites[0].depthMm = "3.50";
  return { toothCode: 16, expectedHeadId: null, requestKey: "perio:test-0001", sites };
};
describe("periodontal measurement DTOs (no database)", () => {
  it("starts with six independent unknown sites, without healthy defaults", () => {
    const first = emptyPeriodontalSites(); const second = emptyPeriodontalSites();
    expect(first).toHaveLength(6);
    expect(new Set(first.map((site) => `${site.surface}:${site.position}`)).size).toBe(6);
    expect(first.every((site) => site.depthMm === null && site.bleeding === null)).toBe(true);
    first[0].bleeding = false;
    expect(second.every((site) => site.bleeding === null)).toBe(true);
  });
  it("keeps missing, zero and false distinct and preserves exact decimal values", () => {
    const draft = command(); draft.sites[1].depthMm = "0"; draft.sites[2].bleeding = false;
    draft.sites[3].depthMm = "0.00000000000001";
    const checked = parsePeriodontalCommand(draft); expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error(checked.message);
    expect(checked.value.sites.map((site) => site.depthMm)).toEqual(["3.5", "0", null, "0.00000000000001", null, null]);
    expect(checked.value.sites.map((site) => site.bleeding)).toEqual([null, null, false, null, null, null]);
    expect(draft.sites[0].depthMm).toBe("3.50");
  });
  it.each([null, "0", "1", "9", "10", "30.125", "9999999999999999"])("accepts exact storage spelling %s without diagnostic thresholds", (value) => {
    expect(periodontalDepth(value).ok).toBe(true);
  });
  it.each([undefined, true, false, 0, 3.5, NaN, Infinity, -1, "-1", "+1", " 2", "2 ", "", "02", ".5", "5.", "1e3", "NaN", "Infinity", "1,5", "99999999999999999", {}, []])("rejects malformed or coercible depth %s", (value) => {
    expect(periodontalDepth(value).ok).toBe(false);
  });
  it.each(ALL_TEETH)("retains canonical FDI tooth %s", (toothCode) => {
    expect(parsePeriodontalCommand({ ...command(), toothCode }).ok).toBe(true);
  });
  it.each(["16", 0, 19, 49, 56, 86, 16.5, NaN, Infinity, true, null])("rejects invalid tooth %s", (toothCode) => {
    expect(parsePeriodontalCommand({ ...command(), toothCode }).ok).toBe(false);
  });
  it.each([undefined, "2", 0, -1, 1.5, 2_147_483_648, true])("requires an explicit valid expected head %s", (expectedHeadId) => {
    expect(parsePeriodontalCommand({ ...command(), expectedHeadId }).ok).toBe(false);
  });
  it("does not drop unsupported visit, author, provider or recession data", () => {
    for (const extra of [{ visitId: 3 }, { recordedBy: "admin" }, { doctorId: 4 }, { recession: 1 }]) {
      expect(parsePeriodontalCommand({ ...command(), ...extra }).ok).toBe(false);
    }
    const draft = command(); Object.assign(draft.sites[0], { recession: 2 });
    expect(parsePeriodontalCommand(draft).ok).toBe(false);
  });
  it("requires six unique positions and explicit nulls, rejecting BOP coercion", () => {
    const draft = command();
    expect(parsePeriodontalSites(draft.sites.slice(1)).ok).toBe(false);
    expect(parsePeriodontalSites([...draft.sites, draft.sites[0]]).ok).toBe(false);
    expect(parsePeriodontalSites([draft.sites[0], draft.sites[0], ...draft.sites.slice(2)]).ok).toBe(false);
    for (const extra of [{ bleeding: "false" }, { depthMm: undefined }, { surface: "buccal" }, { position: 0 }]) {
      expect(parsePeriodontalSites([{ ...draft.sites[0], ...extra }, ...draft.sites.slice(1)]).ok).toBe(false);
    }
  });
  it("canonicalizes site ordering and decimal spelling without changing the source", () => {
    const draft = command(); draft.sites.reverse(); const before = structuredClone(draft);
    const checked = parsePeriodontalCommand(draft); expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error(checked.message);
    expect(checked.value.sites[0]).toMatchObject({ surface: "facial", position: "mesial", depthMm: "3.5" });
    checked.value.sites[0].depthMm = "6";
    expect(draft).toEqual(before);
  });
  it("refuses an entirely unrecorded submission but accepts explicit negative BOP alone", () => {
    const draft = { ...command(), sites: emptyPeriodontalSites() };
    expect(parsePeriodontalCommand(draft).ok).toBe(false);
    draft.sites[0].bleeding = false; expect(parsePeriodontalCommand(draft).ok).toBe(true);
  });
  it.each(["", "short", " ".repeat(8), "x".repeat(129), true, null])("rejects malformed replay key %s", (requestKey) => {
    expect(parsePeriodontalCommand({ ...command(), requestKey }).ok).toBe(false);
  });
  it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])("refuses every final line terminator %j without changing its fingerprint spelling", (terminator) => {
    for (const depth of ["3", "3.50", "0", "0.0001"]) {
      expect(periodontalDepth(depth + terminator).ok).toBe(false);
      const draft = command(); draft.sites[0].depthMm = depth + terminator;
      expect(parsePeriodontalCommand(draft).ok).toBe(false);
    }
    for (const key of ["perio:valid-key", "x".repeat(127), "x".repeat(128)]) {
      expect(parsePeriodontalCommand({ ...command(), requestKey: key + terminator }).ok).toBe(false);
    }
  });
  it("accepts an exact 128-character key but rejects every extra raw character", () => {
    const requestKey = "x".repeat(128);
    expect(parsePeriodontalCommand({ ...command(), requestKey }).ok).toBe(true);
    for (const tail of ["x", " ", "\t", "\0"]) {
      expect(parsePeriodontalCommand({ ...command(), requestKey: requestKey + tail }).ok).toBe(false);
    }
  });
});
