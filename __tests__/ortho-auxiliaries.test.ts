import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUXILIARY_LIST_ERROR, AUXILIARY_OTHER_LIMIT, AUXILIARY_OTHER_REQUIRED, AUXILIARY_OTHER_TOO_LONG, AUXILIARY_OTHER_WITHOUT_CHOICE,
  ORTHO_AUXILIARY_KEYS, ORTHO_AUXILIARY_LABEL, auxiliariesText, parseAuxiliariesInput,
} from "../lib/ortho-auxiliaries";
import { adjustmentCommandStorageKey, adjustmentNewCommandError, createAdjustmentCommand, readAdjustmentCommand } from "../lib/ortho-adjustment-command";
import { sessionDetailFields } from "../lib/ortho-session-display";
import { ORTHO_ADJUSTMENT_AUXILIARIES_SQL } from "../lib/ortho-adjustment-auxiliaries-schema";

// Owner, #483 2026-11-13 23:20 UTC: optional auxiliary appliances in the adjustment session, documentation only.
// Dot, #483 6867852606: nullable with no default; "not recorded" differs from an explicit "none"; the server
// checks the keys and the length of «آخر».
const scope = { patientId: 19, caseId: 41, authority: "user:7" };
const body = { doneOn: "2026-11-05", upperWire: "", lowerWire: "", elastics: "none", elasticNote: "", done: "synthetic", nextWeeks: 4 };
function storage() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } };
}

describe("auxiliary appliance list (owner #483)", () => {
  it("is exactly the owner's list, in the owner's order, with «آخر» last", () => {
    expect(Object.values(ORTHO_AUXILIARY_LABEL)).toEqual(["Hyrax / MARPE", "Nance Button", "TPA", "TAD / Mini-screw",
      "Closed Coil NiTi", "Open Coil", "Power Chain", "Laceback / Bendback", "Bite Turbo", "Carriere Motion", "Herbst",
      "Forsus", "Twin Block", "Lip Bumper", "Lingual Holding Arch", "Quad Helix", "آخر"]);
    expect(ORTHO_AUXILIARY_KEYS).toHaveLength(17);
  });
  it("uses the same keys, order and limit as migration 0132, whose bytes match the numbered file", () => {
    expect(readFileSync("migrations/0132_ortho_adjustment_auxiliaries.sql", "utf8")).toBe(ORTHO_ADJUSTMENT_AUXILIARIES_SQL);
    const listed = ORTHO_ADJUSTMENT_AUXILIARIES_SQL.match(/ARRAY\[([^\]]+)\]::text\[\]/)?.[1].replace(/\s+/g, "");
    expect(listed).toBe(ORTHO_AUXILIARY_KEYS.map((key) => `'${key}'`).join(","));
    expect(ORTHO_ADJUSTMENT_AUXILIARIES_SQL).toContain(`char_length(other) BETWEEN 1 AND ${AUXILIARY_OTHER_LIMIT}`);
    // Nullable, no default, no backfill.
    expect(ORTHO_ADJUSTMENT_AUXILIARIES_SQL.match(/ADD COLUMN [^;]+;/g)).toEqual([
      "ADD COLUMN auxiliaries TEXT[];", "ADD COLUMN auxiliary_other TEXT;"]);
    expect(ORTHO_ADJUSTMENT_AUXILIARIES_SQL).not.toMatch(/DEFAULT|UPDATE\s|INSERT\s|DROP\s/i);
  });
});

describe("server admission of auxiliaries", () => {
  it("keeps «not recorded» and an explicit «none» apart", () => {
    expect(parseAuxiliariesInput({})).toEqual({ ok: true, value: { auxiliaries: null, auxiliaryOther: null } });
    expect(parseAuxiliariesInput({ auxiliaries: null, auxiliaryOther: null })).toEqual({ ok: true, value: { auxiliaries: null, auxiliaryOther: null } });
    expect(parseAuxiliariesInput({ auxiliaries: [] })).toEqual({ ok: true, value: { auxiliaries: [], auxiliaryOther: null } });
  });
  it("returns the list in catalog order and the trimmed «آخر» name", () => {
    expect(parseAuxiliariesInput({ auxiliaries: ["other", "power_chain", "tad"], auxiliaryOther: "  SYN Pendulum  " }))
      .toEqual({ ok: true, value: { auxiliaries: ["tad", "power_chain", "other"], auxiliaryOther: "SYN Pendulum" } });
  });
  it.each([
    ["an unknown key", { auxiliaries: ["headgear"] }, AUXILIARY_LIST_ERROR],
    ["a duplicate", { auxiliaries: ["tpa", "tpa"] }, AUXILIARY_LIST_ERROR],
    ["a non-array", { auxiliaries: "tpa" }, AUXILIARY_LIST_ERROR],
    ["a non-string entry", { auxiliaries: [1] }, AUXILIARY_LIST_ERROR],
    ["a prototype key", { auxiliaries: ["toString"] }, AUXILIARY_LIST_ERROR],
    ["«آخر» without a name", { auxiliaries: ["other"] }, AUXILIARY_OTHER_REQUIRED],
    ["«آخر» with a blank name", { auxiliaries: ["other"], auxiliaryOther: "   " }, AUXILIARY_OTHER_REQUIRED],
    ["an over-long «آخر» name", { auxiliaries: ["other"], auxiliaryOther: "x".repeat(AUXILIARY_OTHER_LIMIT + 1) }, AUXILIARY_OTHER_TOO_LONG],
    ["a name without «آخر»", { auxiliaries: ["tpa"], auxiliaryOther: "SYN" }, AUXILIARY_OTHER_WITHOUT_CHOICE],
    ["a name with no list", { auxiliaryOther: "SYN" }, AUXILIARY_OTHER_WITHOUT_CHOICE],
    ["an empty name with no list", { auxiliaryOther: "" }, AUXILIARY_OTHER_WITHOUT_CHOICE],
  ])("refuses %s, never trims or drops it", (_label, source, message) => {
    expect(parseAuxiliariesInput(source as Record<string, unknown>)).toEqual({ ok: false, message });
  });
  it("accepts the limit exactly", () => {
    expect(parseAuxiliariesInput({ auxiliaries: ["other"], auxiliaryOther: "x".repeat(AUXILIARY_OTHER_LIMIT) }).ok).toBe(true);
  });
});

describe("client command keeps old saved requests valid", () => {
  it("reads a command stored before 0132 (no auxiliary keys) unchanged", () => {
    const store = storage();
    const command = createAdjustmentCommand(store, scope, body);
    expect(JSON.parse(command.body)).not.toHaveProperty("auxiliaries");
    expect(readAdjustmentCommand(store, scope)).toEqual(command);
  });
  it("stores an explicit none and a list with «آخر» exactly", () => {
    for (const extra of [{ auxiliaries: [] }, { auxiliaries: ["tad", "other"], auxiliaryOther: "SYN Pendulum" }]) {
      const store = storage();
      const command = createAdjustmentCommand(store, scope, { ...body, ...extra });
      expect(JSON.parse(command.body)).toMatchObject(extra);
      expect(readAdjustmentCommand(store, scope)).toEqual(command);
    }
  });
  it("refuses bad auxiliaries before a key is minted, and a tampered stored list", () => {
    expect(adjustmentNewCommandError({ ...body, auxiliaries: ["other"] })).toBe(AUXILIARY_OTHER_REQUIRED);
    expect(adjustmentNewCommandError({ ...body, auxiliaryOther: "SYN" })).toBe("قائمة الأجهزة المساعدة غير صالحة؛ لم يبدأ الحفظ.");
    const store = storage();
    expect(() => createAdjustmentCommand(store, scope, { ...body, auxiliaries: ["unknown"] })).toThrow(AUXILIARY_LIST_ERROR);
    expect(store.getItem(adjustmentCommandStorageKey(scope))).toBeNull();
    const command = createAdjustmentCommand(store, scope, { ...body, auxiliaries: ["tpa"] });
    store.setItem(adjustmentCommandStorageKey(scope), JSON.stringify({ ...command, body: JSON.stringify({ ...body, auxiliaries: ["tpa", "tpa"] }) }));
    expect(() => readAdjustmentCommand(store, scope)).toThrow();
    store.setItem(adjustmentCommandStorageKey(scope), JSON.stringify({ ...command, body: JSON.stringify({ ...body, auxiliaryOther: null }) }));
    expect(() => readAdjustmentCommand(store, scope)).toThrow();
  });
});

describe("session history display", () => {
  const entry = { id: 5, doneOn: "2026-11-01", phase: null, note: null, visitId: null, visitSigned: null, nextWeeks: 4, recordedBy: "SYN" };
  const field = (extra: object) => sessionDetailFields({ ...entry, ...extra }).find((row) => row.label === "الأجهزة المساعدة المسجلة")?.value;
  it("shows old sessions as not recorded, never as none", () => {
    expect(field({})).toBe("غير مسجّلة في هذه الجلسة");
    expect(field({ auxiliaries: null })).toBe("غير مسجّلة في هذه الجلسة");
    expect(field({ auxiliaries: [] })).toBe("لا أجهزة مساعدة (سُجّل صراحةً)");
    expect(field({ auxiliaries: ["tad", "other"], auxiliaryOther: "SYN Pendulum" })).toBe("TAD / Mini-screw، آخر: SYN Pendulum");
    expect(auxiliariesText(["legacy_unknown"], null)).toBe("legacy_unknown");
  });
});
