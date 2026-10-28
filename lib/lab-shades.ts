import { ALL_TEETH } from "./dental";

/** VITA VM 13 full IFU, classification table: classical A1–D4 and 3D-MASTER.
 * https://mam.vita-zahnfabrik.com/portal/ecms_mdb_download.php?fallback=en&id=127206&neuste_version=1&sprache=en
 * Shade codes, not screen colours: a display cannot replace a physical shade guide.
 */
export const LAB_SHADE_GUIDES = ["vita_classical", "vita_3d_master"] as const;
export type LabShadeGuide = typeof LAB_SHADE_GUIDES[number];
export const LAB_SHADE_GUIDE_LABELS: Record<LabShadeGuide, string> = {
  vita_classical: "VITA classical A1–D4", vita_3d_master: "VITA SYSTEM 3D-MASTER",
};
export const LAB_SHADE_CODES: Record<LabShadeGuide, readonly string[]> = {
  vita_classical: ["A1", "A2", "A3", "A3.5", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4", "D2", "D3", "D4"],
  vita_3d_master: ["0M1", "0M2", "0M3", "1M1", "1M2", "2L1.5", "2L2.5", "2M1", "2M2", "2M3", "2R1.5", "2R2.5", "3L1.5", "3L2.5", "3M1", "3M2", "3M3", "3R1.5", "3R2.5", "4L1.5", "4L2.5", "4M1", "4M2", "4M3", "4R1.5", "4R2.5", "5M1", "5M2", "5M3"],
};
export const LAB_SHADE_ZONES = ["cervical", "body", "incisal"] as const;
export type LabShadeZone = typeof LAB_SHADE_ZONES[number];
export const LAB_SHADE_ZONE_LABELS: Record<LabShadeZone, string> = {
  cervical: "عنق السن", body: "جسم السن", incisal: "الحافة القاطعة / الإطباقية",
};
export interface LabShadeSelection { guide: LabShadeGuide; code: string }
export interface LabToothShade {
  toothCode: number;
  cervical: LabShadeSelection | null;
  body: LabShadeSelection | null;
  incisal: LabShadeSelection | null;
}
export interface LabShadeSpecification { version: 1; teeth: LabToothShade[] }
export type LabShadeParseResult = { ok: true; value: LabShadeSpecification | null } | { ok: false; error: string };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
export function labShadeSelectionForCode(code: string): LabShadeSelection | null {
  const guide = LAB_SHADE_GUIDES.find(item => LAB_SHADE_CODES[item].includes(code));
  return guide ? { guide, code } : null;
}
export function isLabShadeSelection(value: unknown): value is LabShadeSelection {
  return record(value) && exactKeys(value, ["guide", "code"]) && typeof value.guide === "string"
    && LAB_SHADE_GUIDES.includes(value.guide as LabShadeGuide) && typeof value.code === "string"
    && LAB_SHADE_CODES[value.guide as LabShadeGuide].includes(value.code);
}
/** Strict typed boundary. Never silently coerce legacy codes or retain unknown/free-text keys. */
export function parseLabShadeSpecification(input: unknown, selectedTeeth?: readonly number[]): LabShadeParseResult {
  if (input === null) return { ok: true, value: null };
  const invalid = (): LabShadeParseResult => ({ ok: false, error: "مواصفات ألوان الأسنان غير صالحة؛ راجع أرقام الأسنان ودليل اللون والمناطق." });
  if (!record(input) || !exactKeys(input, ["version", "teeth"]) || input.version !== 1 || !Array.isArray(input.teeth) || input.teeth.length > ALL_TEETH.length) return invalid();
  const seen = new Set<number>();
  const teeth: LabToothShade[] = [];
  for (const item of input.teeth) {
    if (!record(item) || !exactKeys(item, ["toothCode", ...LAB_SHADE_ZONES]) || typeof item.toothCode !== "number"
      || !ALL_TEETH.includes(item.toothCode) || seen.has(item.toothCode)
      || (selectedTeeth !== undefined && !selectedTeeth.includes(item.toothCode))) return invalid();
    if (LAB_SHADE_ZONES.some(zone => item[zone] !== null && !isLabShadeSelection(item[zone]))) return invalid();
    seen.add(item.toothCode);
    const copy = (zone: LabShadeZone) => item[zone] === null ? null : { ...(item[zone] as LabShadeSelection) };
    teeth.push({ toothCode: item.toothCode, cervical: copy("cervical"), body: copy("body"), incisal: copy("incisal") });
  }
  return { ok: true, value: { version: 1, teeth: teeth.sort((a, b) => a.toothCode - b.toothCode) } };
}
/** Read old NULLs safely; malformed stored objects remain visibly untrusted, never inferred. */
export function readLabShadeSpecification(input: unknown, selectedTeeth?: readonly number[]): { value: LabShadeSpecification | null; reviewWarning: string | null } {
  const result = parseLabShadeSpecification(input === undefined ? null : input, selectedTeeth);
  return result.ok ? { value: result.value, reviewWarning: null } : {
    value: null, reviewWarning: "مواصفات اللون التفصيلية غير صالحة ولم تُرفق؛ راجعها داخل العيادة قبل التنفيذ.",
  };
}
