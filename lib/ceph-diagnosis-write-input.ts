/** Admission for new authenticated writes only. Historical normalization and
 * saved-snapshot decoding deliberately retain their existing contracts. */
export interface CephDiagnosisWriteInput {
  skeletal?: string | null;
  dental?: string | null;
  softTissue?: string | null;
  note?: string | null;
  finalDx: string;
}
export function isCephDiagnosisWriteInput(value: unknown): value is CephDiagnosisWriteInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (typeof input.finalDx !== "string" || !input.finalDx.trim() || input.finalDx.trim().length > 2000) return false;
  return ["skeletal", "dental", "softTissue", "note"].every(key =>
    !Object.hasOwn(input, key) || input[key] === null
    || (typeof input[key] === "string" && input[key].trim().length <= 2000));
}
