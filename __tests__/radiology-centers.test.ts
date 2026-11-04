import { describe, expect, it } from "vitest";
import { MAX_RADIOLOGY_CENTERS_BYTES, RADIOLOGY_CENTERS_KEY, parseRadiologyCenters } from "../lib/radiology-centers";
import { SETTING_DEFAULTS } from "../lib/settings";
import { validateTypedSetting } from "../lib/settings-validate";
import { settingDefinition } from "../lib/settings-definitions";
import { canManageCategory } from "../lib/settings-permissions";
const center = { id: "11111111-1111-4111-8111-111111111111", name: "مركز الأشعة", address: "صنعاء — شارع المركز", active: true };
const parse = (value: unknown) => parseRadiologyCenters(JSON.stringify(value));
describe("central radiology catalogue", () => {
  it("starts empty with no enabled example destinations", () => {
    expect(SETTING_DEFAULTS[RADIOLOGY_CENTERS_KEY]).toBe("[]");
    expect(parseRadiologyCenters("[]")).toEqual({ ok: true, centers: [] });
  });
  it("retains inactive centers and stable IDs; trims human-readable fields", () => {
    expect(parse([{ ...center, name: ` ${center.name} `, active: false }])).toEqual({ ok: true, centers: [{ ...center, active: false }] });
  });
  it("requires complete typed records and canonical UUIDs", () => {
    for (const value of [null, {}, "[]", [null], [{ ...center, id: "legacy-1" }], [{ ...center, active: "true" }], [{ ...center, extra: 1 }], [{ id: center.id }]]) expect(parse(value).ok).toBe(false);
    expect(parseRadiologyCenters("[").ok).toBe(false);
  });
  it("rejects duplicate IDs, including disabled entries", () => {
    expect(parse([center, { ...center, active: false }]).ok).toBe(false);
  });
  it("bounds names, addresses, entry count and raw UTF8 input before parsing", () => {
    for (const patch of [{ name: " " }, { address: "" }, { name: "x".repeat(161) }, { address: "x".repeat(401) }]) expect(parse([{ ...center, ...patch }]).ok).toBe(false);
    const many = Array.from({ length: 100 }, (_, i) => ({ ...center, id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111` }));
    expect(parse(many).ok).toBe(true);
    expect(parse([...many, center]).ok).toBe(false);
    expect(parseRadiologyCenters(" ".repeat(MAX_RADIOLOGY_CENTERS_BYTES) + "[]").ok).toBe(false);
    expect(parseRadiologyCenters('"' + "ع".repeat(130_000) + '"').ok).toBe(false);
  });
  it("rejects control and bidi override characters in both display fields", () => {
    for (const control of ["\0", "\n", "\t", "\u007f", "\u0085", "\u202e", "\u2066"]) {
      expect(parse([{ ...center, name: "اسم" + control }]).ok).toBe(false);
      expect(parse([{ ...center, address: "عنوان" + control }]).ok).toBe(false);
    }
  });
  it("registers the server validation and existing clinical permission without autogrants", () => {
    expect(settingDefinition(RADIOLOGY_CENTERS_KEY)?.category).toBe("clinical");
    expect(validateTypedSetting(RADIOLOGY_CENTERS_KEY, JSON.stringify([center]))).toBeNull();
    expect(validateTypedSetting(RADIOLOGY_CENTERS_KEY, '[{}]')).not.toBeNull();
    expect(canManageCategory("admin", "clinical")).toBe(true);
    for (const role of ["doctor", "reception", "assistant"]) expect(canManageCategory(role, "clinical")).toBe(false);
  });
});
