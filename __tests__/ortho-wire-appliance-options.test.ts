import { describe, expect, it } from "vitest";
import { APPLIANCE_LABEL, ARCHWIRE_CATALOG, WIRE_SEQUENCE, archwireChoices, nextWire, usesArchwires, wiresFor, type Appliance } from "../lib/ortho";

// Owner, #483 2026-11-13: expand wire and appliance options without changing the session steps,
// the usual sequence or the "next wire" suggestion, and keep every saved value valid.
describe("archwire catalog", () => {
  it("covers every family the owner listed, round and rectangular, with unique codes", () => {
    const labels = ARCHWIRE_CATALOG.map(group => group.label).join(" ");
    for (const family of ["NiTi", "حراري", "CuNiTi", "SS", "TMA", "مضفور"]) expect(labels).toContain(family);
    const codes = ARCHWIRE_CATALOG.flatMap(group => group.codes);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.some(code => !code.includes("×"))).toBe(true);
    expect(codes.some(code => code.includes("×"))).toBe(true);
    for (const code of codes) expect(code.length).toBeLessThanOrEqual(40); // the server's wire limit
  });
  it("leaves the usual sequence and the next-wire suggestion unchanged", () => {
    expect(WIRE_SEQUENCE["022"].map(wire => wire.code)).toEqual(["012 NiTi", "014 NiTi", "016 NiTi", "016×022 NiTi", "017×025 NiTi", "019×025 NiTi", "019×025 SS", "019×025 TMA"]);
    expect(WIRE_SEQUENCE["018"]).toHaveLength(6);
    expect(nextWire("022", "014 NiTi")?.code).toBe("016 NiTi");
    expect(nextWire("022", "019×025 TMA")).toBeNull();
    // A catalog-only wire is accepted as recorded but never inserted into the sequence:
    // the suggestion treats it like any other code outside the sequence.
    expect(nextWire("022", "018×025 SS")).toEqual(nextWire("022", "SYN code outside every list"));
  });
  it("orders choices as recorded, then the slot sequence, then the catalog, with no duplicates", () => {
    const choices = archwireChoices("022", ["014 NiTi", "SYN legacy 0.0175 coaxial", "", null, undefined, "SYN legacy 0.0175 coaxial"]);
    expect(choices.sequence).toEqual(wiresFor("022").map(wire => wire.code));
    expect(choices.recorded).toEqual(["SYN legacy 0.0175 coaxial"]);
    const all = [...choices.recorded, ...choices.sequence, ...choices.groups.flatMap(group => group.codes)];
    expect(new Set(all).size).toBe(all.length);
    for (const code of ARCHWIRE_CATALOG.flatMap(group => group.codes)) expect(all).toContain(code);
    expect(archwireChoices(null, []).sequence).toEqual([]);
  });
});

describe("appliance types", () => {
  it("keeps every saved value with its meaning and adds the new fixed types", () => {
    const saved: Record<string, string> = { fixed_metal: "ثابت معدني", fixed_ceramic: "ثابت خزفي", aligners: "شفّاف متحرّك", removable: "متحرّك", functional: "وظيفي" };
    for (const [key, label] of Object.entries(saved)) expect(APPLIANCE_LABEL[key as Appliance]).toBe(label);
    for (const key of ["self_ligating_metal", "self_ligating_ceramic", "lingual", "sapphire"] as const) {
      expect(APPLIANCE_LABEL[key]).toBeTruthy(); expect(usesArchwires(key)).toBe(true);
    }
    for (const key of ["aligners", "removable", "functional"] as const) expect(usesArchwires(key)).toBe(false);
    expect(usesArchwires(null)).toBe(false);
  });
});
