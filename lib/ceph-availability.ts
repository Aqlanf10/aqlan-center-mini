/**
 * C2 — why a cephalometric measurement has no value, or why its value is not fully measured.
 *
 * Built on top of the legacy `measure()` without changing it: the value reported here is always exactly the
 * legacy value (so saved and approved results are untouched). This module only explains outcomes:
 *   - `not-computable`: the legacy value is NaN; the reason is diagnosed in a fixed order (unknown code →
 *     missing landmarks → invalid coordinates → calibration → degenerate geometry). Nothing is filled in.
 *   - `measured-with-assumption`: the legacy formula returned a number although part of it was NOT measured
 *     (it substituted a fixed component). The number is kept as the legacy shows it, but flagged so it is not
 *     read as fully measured. Changing these formulas is a clinical decision (C5), not made here.
 */
import { MEASUREMENTS, measure, type LandmarkCode, type LandmarkMap, type MeasurementDef } from "./ceph";

export type NotComputableReason =
  | "unknown-measurement" | "missing-landmarks" | "invalid-landmark-coordinates"
  | "missing-calibration" | "degenerate-geometry";

/** A component the legacy formula substitutes when it cannot measure it. */
export type LegacyAssumption = "palatal-plane-tilt-assumed-3deg" | "nasolabial-adjustment-assumed-zero";

export type MeasurementAvailability =
  | { readonly status: "measured"; readonly value: number }
  | { readonly status: "measured-with-assumption"; readonly value: number; readonly assumptions: readonly LegacyAssumption[]; readonly missing: readonly LandmarkCode[] }
  | { readonly status: "not-computable"; readonly reason: NotComputableReason; readonly missing?: readonly LandmarkCode[]; readonly invalid?: readonly LandmarkCode[] };

export const NOT_COMPUTABLE_MESSAGE_AR: Readonly<Record<NotComputableReason, string>> = {
  "unknown-measurement": "قياس غير معروف في سجل التعريفات.",
  "missing-landmarks": "نقاط ناقصة",
  "invalid-landmark-coordinates": "إحداثيات غير صالحة للنقاط",
  "missing-calibration": "يحتاج معايرة المقياس (مم/بكسل) قبل حسابه.",
  "degenerate-geometry": "النقاط متطابقة أو على خط واحد، فالهندسة لا تسمح بالحساب.",
};

export const ASSUMPTION_MESSAGE_AR: Readonly<Record<LegacyAssumption, string>> = {
  "palatal-plane-tilt-assumed-3deg": "ميل المستوى الحنكي غير مقيس؛ الصيغة القديمة افترضته 3°",
  "nasolabial-adjustment-assumed-zero": "الزاوية الأنفية الشفوية غير مقيسة؛ الصيغة القديمة افترضت تعديلها صفرًا",
};

const DEFS = new Map(MEASUREMENTS.map((def) => [def.code, def]));
const def = (code: string): MeasurementDef | undefined => DEFS.get(code);
const finitePoint = (p: { x: number; y: number }) => Number.isFinite(p.x) && Number.isFinite(p.y);
const absent = (code: string, L: LandmarkMap): LandmarkCode[] => (def(code)?.needs ?? []).filter((c) => L[c] == null);

/** Legacy substitutions, read from the legacy formulas in lib/ceph.ts (pinned by test). */
const ASSUMES: Readonly<Record<string, readonly { readonly component: string; readonly assumption: LegacyAssumption }[]>> = {
  APDI: [{ component: "PP_FH", assumption: "palatal-plane-tilt-assumed-3deg" }],
  ODI: [{ component: "PP_FH", assumption: "palatal-plane-tilt-assumed-3deg" }],
  CF: [{ component: "PP_FH", assumption: "palatal-plane-tilt-assumed-3deg" }],
  EXT_INDEX: [{ component: "PP_FH", assumption: "palatal-plane-tilt-assumed-3deg" }, { component: "NASOLABIAL", assumption: "nasolabial-adjustment-assumed-zero" }],
};

export function explainMeasurement(code: string, L: LandmarkMap, mmPerPixel: number): MeasurementAvailability {
  const d = def(code);
  if (!d) return { status: "not-computable", reason: "unknown-measurement" };
  const value = measure(code, L, mmPerPixel);
  if (Number.isFinite(value)) {
    const assumed = (ASSUMES[code] ?? []).filter(({ component }) => !Number.isFinite(measure(component, L, mmPerPixel)));
    if (!assumed.length) return { status: "measured", value };
    const missing = [...new Set(assumed.flatMap(({ component }) => absent(component, L)))];
    return { status: "measured-with-assumption", value, assumptions: [...new Set(assumed.map((a) => a.assumption))], missing };
  }
  const missing = absent(code, L);
  if (missing.length) return { status: "not-computable", reason: "missing-landmarks", missing };
  const invalid = d.needs.filter((c) => !finitePoint(L[c]!));
  if (invalid.length) return { status: "not-computable", reason: "invalid-landmark-coordinates", invalid };
  // The legacy value depends on the scale iff it becomes finite with a valid one: diagnosed from the formula itself.
  if (!(Number.isFinite(mmPerPixel) && mmPerPixel > 0) && Number.isFinite(measure(code, L, 1))) {
    return { status: "not-computable", reason: "missing-calibration" };
  }
  return { status: "not-computable", reason: "degenerate-geometry" };
}

/** One Arabic line for the table cell / print: never a number, only the reason. */
export function availabilityMessageAr(a: MeasurementAvailability): string | null {
  if (a.status === "measured") return null;
  if (a.status === "measured-with-assumption") {
    const lack = a.missing.length ? ` (ناقص: ${a.missing.join("، ")})` : "";
    return `قيمة غير مقيسة بالكامل: ${a.assumptions.map((x) => ASSUMPTION_MESSAGE_AR[x]).join("؛ ")}${lack}.`;
  }
  const base = NOT_COMPUTABLE_MESSAGE_AR[a.reason];
  if (a.reason === "missing-landmarks") return `${base}: ${a.missing!.join("، ")}.`;
  if (a.reason === "invalid-landmark-coordinates") return `${base}: ${a.invalid!.join("، ")}.`;
  return base;
}

export function explainAll(L: LandmarkMap, mmPerPixel: number): ReadonlyMap<string, MeasurementAvailability> {
  return new Map(MEASUREMENTS.map((d) => [d.code, explainMeasurement(d.code, L, mmPerPixel)]));
}
