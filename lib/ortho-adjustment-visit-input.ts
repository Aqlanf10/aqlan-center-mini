/** New HTTP linkage admission only. Absent/null preserves intentional auto-selection.
 * visits.id is PostgreSQL SERIAL/int4; this bound is storage, not clinical policy. */
export function isAdjustmentVisitInput(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value.trim()))) return false;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647;
}
export const ADJUSTMENT_VISIT_INPUT_ERROR = "معرّف الزيارة المحددة غير صالح؛ لم تُربط الجلسة بزيارة أخرى.";
