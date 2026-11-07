/** Versioned arithmetic for the Tanaka–Johnston1974 approximation.
 * Tanaka & Johnston1974 DOI10.14219/jada.archive.1974.0158, pp798–801.
 * Eligibility, observation ownership, image calibration where relevant, population applicability,
 * historical witnesses and clinician review are required separately.
 */
export type Width = { tooth: number; value: number };
export type Checked<T> = { ok: true; value: T } | { ok: false; code: string };
export const INCISORS = { lower: [31, 32, 41, 42], upper: [11, 12, 21, 22] } as const;
function exactSum(rows: readonly Width[], teeth: readonly number[]): Checked<number> {
  if (!Array.isArray(rows) || rows.length !== teeth.length || new Set(rows.map(r => r?.tooth)).size !== teeth.length
    || rows.some(r => !r || !teeth.includes(r.tooth) || typeof r.value !== "number" || !Number.isFinite(r.value) || r.value <= 0))
    return { ok: false, code: "invalid_exact_incisor_widths" };
  const value = teeth.reduce((sum, tooth) => sum + rows.find(r => r.tooth === tooth)!.value, 0);
  return Number.isFinite(value) ? { ok: true, value } : { ok: false, code: "numeric_overflow" };
}
export function tanakaArchSpace(
  arch: "upper" | "lower", lowerIncisors: readonly Width[], targetIncisors: readonly Width[], availableMm: number,
): Checked<{
  method: "tanaka_johnston_1974_approximation_v1"; arch: "upper" | "lower";
  measuredLowerIncisorSumMm: number; measuredTargetIncisorSumMm: number;
  predictedCaninePremolarPerQuadrantMm: number; predictedBothQuadrantsMm: number;
  estimatedRequiredMm: number; measuredAvailableMm: number; availableMinusEstimatedRequiredMm: number;
  withinPublishedTablePredictorDomain: boolean;
}> {
  if ((arch !== "upper" && arch !== "lower") || typeof availableMm !== "number" || !Number.isFinite(availableMm) || availableMm < 0)
    return { ok: false, code: "invalid_arch_or_available_space" };
  const predictor = exactSum(lowerIncisors, INCISORS.lower); if (!predictor.ok) return predictor;
  const target = exactSum(targetIncisors, INCISORS[arch]); if (!target.ok) return target;
  if (arch === "lower" && INCISORS.lower.some(tooth => lowerIncisors.find(r => r.tooth === tooth)!.value !== targetIncisors.find(r => r.tooth === tooth)!.value))
    return { ok: false, code: "conflicting_lower_incisor_measurements" };
  const segment = predictor.value / 2 + (arch === "upper" ? 11 : 10.5);
  const both = 2 * segment, required = target.value + both;
  if (![segment, both, required, availableMm - required].every(Number.isFinite)) return { ok: false, code: "numeric_overflow" };
  return { ok: true, value: { method: "tanaka_johnston_1974_approximation_v1", arch,
    measuredLowerIncisorSumMm: predictor.value, measuredTargetIncisorSumMm: target.value,
    predictedCaninePremolarPerQuadrantMm: segment, predictedBothQuadrantsMm: both,
    estimatedRequiredMm: required, measuredAvailableMm: availableMm,
    availableMinusEstimatedRequiredMm: availableMm - required,
    // Product admission policy must explicitly decide how to handle this flag.
    // The table range is not a universal biological normal range.
    withinPublishedTablePredictorDomain: predictor.value >= 20.5 && predictor.value <= 27 } };
}
