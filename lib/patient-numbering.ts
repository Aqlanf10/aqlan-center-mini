/** File numbers are public aliases, NEVER internal patient IDs. Bigints remain strings. */
export const PATIENT_NUMBER_MINIMUM = 7000n;
export const PATIENT_NUMBER_MAXIMUM = 9223372036854775807n;
export function parsePatientNumber(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:P-)?[0-9]{1,19}$/.test(value.trim())) return null;
  const digits = value.trim().replace(/^P-/, "");
  const n = BigInt(digits);
  if (n < 1n || n > PATIENT_NUMBER_MAXIMUM) return null;
  return `P-${n.toString().padStart(5, "0")}`;
}
export function parseNumberingFloor(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9]{1,19}$/.test(value)) return null;
  const n = BigInt(value);
  return n >= PATIENT_NUMBER_MINIMUM && n <= PATIENT_NUMBER_MAXIMUM ? n.toString() : null;
}
export function parseNumberingVersion(value: unknown): string | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return null;
  return BigInt(value) <= PATIENT_NUMBER_MAXIMUM ? value : null;
}
export function numberingReason(value: unknown): string | null {
  return typeof value === "string" && value.trim().length >= 3 && value.trim().length <= 300 ? value.trim() : null;
}
export type NumberingPreview = {
  minimumNext: string; version: string; sequenceValue: string; sequenceCalled: boolean;
  maximumCurrent: string; maximumRetired: string; nextNumber: string | null; exhausted: boolean;
};
export type PatientNumberSnapshot = { patientId: number; patientNumber: string; version: string };
