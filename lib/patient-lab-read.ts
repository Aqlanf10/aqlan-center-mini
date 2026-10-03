import type { LabOrder } from "./lab";
import { LAB_STATUS_LABEL } from "./lab";

export interface PatientLabSnapshot {
  orders: LabOrder[];
  labs: { labName: string; labPhone: string | null }[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nullableText = (value: unknown) => value === null || typeof value === "string";
export const validPatientLabId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;

/** The canonical GET supplies an envelope, including for an empty result. A
 * failed/malformed or cross-patient response must never become actionable data. */
export function decodePatientLabSnapshot(value: unknown, patientId: number): PatientLabSnapshot | null {
  if (!validPatientLabId(patientId) || !record(value) || !Array.isArray(value.orders) || !Array.isArray(value.labs)) return null;
  const ids = new Set<number>();
  for (const order of value.orders) {
    if (!record(order) || !validPatientLabId(order.id) || ids.has(order.id) || order.patientId !== patientId
      || typeof order.status !== "string" || !Object.hasOwn(LAB_STATUS_LABEL, order.status)
      || !["patientName", "labName", "workType", "sentDate", "dueDate"].every((key) => typeof order[key] === "string")
      || !["patientNumber", "patientPhone", "labPhone", "details", "toothNumbers", "shade", "note"].every((key) => nullableText(order[key]))
      || !["normal", "urgent", "rush"].includes(String(order.priority))) return null;
    ids.add(order.id);
  }
  if (!value.labs.every((lab) => record(lab) && typeof lab.labName === "string" && nullableText(lab.labPhone))) return null;
  return value as unknown as PatientLabSnapshot;
}
