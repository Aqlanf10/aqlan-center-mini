import { describe, expect, it } from "vitest";
import { LAB_SHADE_CODES, labShadeSelectionForCode, parseLabShadeSpecification, readLabShadeSpecification } from "../lib/lab-shades";
const specification = () => ({ version: 1, teeth: [{ toothCode: 11, cervical: { guide: "vita_classical", code: "A2" }, body: { guide: "vita_3d_master", code: "0M3" }, incisal: null }] });
describe("structured lab shade model", () => {
  it("keeps classical16 and 3D26 plus three zero-M bleach shades separate", () => {
    expect(LAB_SHADE_CODES.vita_classical).toHaveLength(16);
    expect(LAB_SHADE_CODES.vita_3d_master).toHaveLength(29);
    expect(labShadeSelectionForCode("0M3")).toEqual({ guide: "vita_3d_master", code: "0M3" });
    for (const code of ["OM3", "0m3", "BL1", "ND1", "private text"]) expect(labShadeSelectionForCode(code)).toBeNull();
  });
  it("round trips explicit zones without inferring missing ones", () => {
    expect(parseLabShadeSpecification(specification(), [11])).toEqual({ ok: true, value: specification() });
    expect(parseLabShadeSpecification(null)).toEqual({ ok: true, value: null });
    expect(readLabShadeSpecification(undefined)).toEqual({ value: null, reviewWarning: null });
  });
  it("copies input and preserves FDI identity", () => {
    const input = specification(); const result = parseLabShadeSpecification(input);
    expect(result.ok).toBe(true);
    input.teeth[0].body.code = "1M1";
    if (result.ok) expect(result.value?.teeth[0].body?.code).toBe("0M3");
  });
  it.each([19, 20, 56, 11.5, 0, -1, 99])("rejects invalid FDI%s", toothCode => {
    expect(parseLabShadeSpecification({ ...specification(), teeth: [{ ...specification().teeth[0], toothCode }] }).ok).toBe(false);
  });
  it("rejects unselected teeth, duplicate teeth, unknown versions/keys and guide mismatch", () => {
    expect(parseLabShadeSpecification(specification(), [21]).ok).toBe(false);
    expect(parseLabShadeSpecification({ ...specification(), teeth: [specification().teeth[0], specification().teeth[0]] }).ok).toBe(false);
    for (const input of [undefined, "{}", [], { ...specification(), version: 2 }, { ...specification(), patientName: "private" }, { ...specification(), teeth: [{ ...specification().teeth[0], body: { guide: "vita_classical", code: "0M3" } }] }, { ...specification(), teeth: [{ ...specification().teeth[0], body: { guide: "vita_3d_master", code: "0M3", note: "private" } }] }]) expect(parseLabShadeSpecification(input).ok).toBe(false);
  });
  it("malformed stored data is not exposed as structured clinical instructions", () => {
    const read = readLabShadeSpecification({ ...specification(), note: "PRIVATE_CANARY" });
    expect(read.value).toBeNull(); expect(read.reviewWarning).toBeTruthy(); expect(JSON.stringify(read)).not.toContain("PRIVATE_CANARY");
  });
});
