import { ELASTIC_LABEL, PHASE_LABEL } from "./ortho";
/** New HTTP authoring only. Historical normalized receipt matching runs first. */
export function adjustmentEnumAdmissionError(source: Record<string, unknown>): string | null {
  if (source.phase != null && (typeof source.phase !== "string" || !Object.hasOwn(PHASE_LABEL, source.phase))) {
    return "مرحلة جلسة التقويم غير صالحة؛ اختر قيمة معروفة أو اتركها غير محددة.";
  }
  if (source.elastics != null && (typeof source.elastics !== "string" || !Object.hasOwn(ELASTIC_LABEL, source.elastics))) {
    return "صنف مطاطات الجلسة غير صالح؛ اختر قيمة معروفة.";
  }
  return null;
}
