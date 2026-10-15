import { assessmentFinite, type Checked } from "./ortho-assessment-model";
/** Arithmetic only. Applicability, provenance, reference and clinical approval are separate checks. */
export const SPACE_TEETH = { upper: [15,14,13,12,11,21,22,23,24,25], lower: [45,44,43,42,41,31,32,33,34,35] } as const;
export const BOLTON_TEETH = {
  anterior: { upper:[13,12,11,21,22,23], lower:[43,42,41,31,32,33] },
  overall: { upper:[16,15,14,13,12,11,21,22,23,24,25,26], lower:[46,45,44,43,42,41,31,32,33,34,35,36] },
} as const;
export interface ToothWidthMm { tooth: number; value: number }
function sumExact(rows: readonly ToothWidthMm[], teeth: readonly number[]): Checked<number> {
  if (!Array.isArray(rows) || rows.length !== teeth.length || new Set(rows.map(r => r?.tooth)).size !== rows.length
    || rows.some(r => !r || !teeth.includes(r.tooth) || !assessmentFinite(r.value) || r.value <= 0)) return { ok:false,code:"invalid_exact_tooth_widths" };
  const value = teeth.reduce((sum,tooth) => sum + rows.find(r => r.tooth === tooth)!.value,0);
  return Number.isFinite(value) ? { ok:true,value } : { ok:false,code:"numeric_overflow" };
}
export function permanentArchSpaceArithmetic(arch: "upper" | "lower", widths: readonly ToothWidthMm[], availableMm: number): Checked<{
  arch: "upper" | "lower"; requiredMm: number; availableMm: number; discrepancyMm: number; formula: "available_minus_required_v2";
}> {
  if ((arch !== "upper" && arch !== "lower") || !assessmentFinite(availableMm) || availableMm < 0) return { ok:false,code:"invalid_available_space" };
  const required = sumExact(widths,SPACE_TEETH[arch]); if (!required.ok) return required;
  return { ok:true,value:{arch,requiredMm:required.value,availableMm,discrepancyMm:availableMm-required.value,formula:"available_minus_required_v2"} };
}
/** No default norm. Caller supplies an exact versioned reference percent after its own reference checks. */
export function boltonArithmetic(mode: "anterior" | "overall", upper: readonly ToothWidthMm[], lower: readonly ToothWidthMm[], referencePercent: number): Checked<{
  upperSumMm: number; lowerSumMm: number; ratioPercent: number;
  upperReferenceLowerResidualMm: number; lowerReferenceUpperResidualMm: number;
  formula: "bolton_lower_over_upper_v1";
}> {
  if ((mode !== "anterior" && mode !== "overall") || !assessmentFinite(referencePercent,1000) || referencePercent <= 0)
    return { ok:false,code:"invalid_reference_percent" };
  const u=sumExact(upper,BOLTON_TEETH[mode].upper),l=sumExact(lower,BOLTON_TEETH[mode].lower);
  if (!u.ok) return u; if (!l.ok) return l;
  const ratio=referencePercent/100;
  const value={upperSumMm:u.value,lowerSumMm:l.value,ratioPercent:100*l.value/u.value,
    upperReferenceLowerResidualMm:l.value-ratio*u.value,lowerReferenceUpperResidualMm:u.value-l.value/ratio,
    formula:"bolton_lower_over_upper_v1" as const};
  return Object.values(value).every(x => typeof x !== "number" || Number.isFinite(x))
    ? {ok:true,value} : {ok:false,code:"numeric_overflow"};
}
