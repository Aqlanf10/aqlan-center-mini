import { PATIENT_NUMBER_MAXIMUM, parseNumberingFloor, parseNumberingVersion, parsePatientNumber, type NumberingPreview, type PatientNumberSnapshot } from "./patient-numbering";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const projection = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= PATIENT_NUMBER_MAXIMUM + 1n;
/** Current aliases may be legacy spellings; never silently normalize the confirmation value. */
export function readPatientNumberSnapshot(value: unknown, patientId: number): PatientNumberSnapshot | null {
  if (!record(value) || !Number.isSafeInteger(patientId) || patientId <= 0 || value.patientId !== patientId
    || typeof value.patientNumber !== "string" || !value.patientNumber.trim() || !parseNumberingVersion(value.version)) return null;
  return {patientId, patientNumber: value.patientNumber, version: value.version as string};
}
/** Check bounded integers before UI BigInt use, and refuse contradictory preview arithmetic. */
export function readNumberingPreview(value: unknown): NumberingPreview | null {
  if (!record(value) || !parseNumberingFloor(value.minimumNext) || !parseNumberingVersion(value.version)
    || !parseNumberingVersion(value.sequenceValue) || typeof value.sequenceCalled !== "boolean"
    || !projection(value.maximumCurrent) || !projection(value.maximumRetired) || typeof value.exhausted !== "boolean") return null;
  const minimumNext = value.minimumNext as string, version = value.version as string, sequenceValue = value.sequenceValue as string;
  const next = [BigInt(minimumNext), BigInt(sequenceValue) + (value.sequenceCalled ? 1n : 0n),
    BigInt(value.maximumCurrent) + 1n, BigInt(value.maximumRetired) + 1n].reduce((a,b)=>a>b?a:b);
  const exhausted = next > PATIENT_NUMBER_MAXIMUM;
  const nextNumber = exhausted ? null : parsePatientNumber(next.toString());
  if (value.exhausted !== exhausted || value.nextNumber !== nextNumber) return null;
  return {minimumNext, version, sequenceValue, sequenceCalled:value.sequenceCalled,
    maximumCurrent:value.maximumCurrent, maximumRetired:value.maximumRetired, nextNumber, exhausted};
}
