import type { PrescriptionRecord } from "./db";
import { isInstructionsLang, MAX_FIELD, MAX_ITEMS, MAX_TEXT, type RxItem } from "./prescription";

/** The existing endpoint has a fixed latest-50 window, not pagination or a total. */
export const PRESCRIPTION_HISTORY_LIMIT = 50;
export type SavedPrescription = PrescriptionRecord;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
// prescriptions.id is SERIAL; its FKs are INTEGER. Native pg int4 is a number,
// unlike the unrelated BIGSERIAL record families. Never coerce an ID string.
export const prescriptionIdentity = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const optionalIdentity = (value: unknown) => value === null || prescriptionIdentity(value);
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit;
const nullableText = (value: unknown) => value === null || typeof value === "string";
const instant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const invalid = (): never => { throw new Error("Invalid saved prescription history"); };

function readItem(value: unknown): RxItem {
  if (!object(value) || !text(value.name, MAX_FIELD) || !value.name.trim()
    || !text(value.dose, MAX_FIELD) || !text(value.form, MAX_FIELD)
    || !text(value.frequency, MAX_FIELD) || !text(value.duration, MAX_FIELD)
    || !text(value.instructions, MAX_TEXT) || !text(value.instructionsEn, MAX_TEXT)) return invalid();
  // Do not sanitize, truncate or fill in clinical details in this read-only view.
  return { name: value.name, dose: value.dose, form: value.form, frequency: value.frequency,
    duration: value.duration, instructions: value.instructions, instructionsEn: value.instructionsEn };
}

/** All-or-nothing admission: no partial "history" from malformed or foreign rows. */
export function readPatientPrescriptionHistory(payload: unknown, patientId: number): SavedPrescription[] {
  if (!prescriptionIdentity(patientId) || !object(payload) || !Array.isArray(payload.prescriptions)
    || payload.prescriptions.length > PRESCRIPTION_HISTORY_LIMIT) return invalid();
  const seen = new Set<number>();
  return payload.prescriptions.map((value): SavedPrescription => {
    // Text columns are passed through by toPrescription; historical originals
    // are not subject to today's writer length policy. Its item projection is
    // already canonical sanitized data and may explicitly contain zero items.
    if (!object(value) || !prescriptionIdentity(value.id) || seen.has(value.id)
      || value.patientId !== patientId || !optionalIdentity(value.visitId) || !optionalIdentity(value.doctorPartyId)
      || !nullableText(value.diagnosis) || !nullableText(value.notes)
      || !isInstructionsLang(value.instructionsLang) || !Array.isArray(value.items)
      || value.items.length > MAX_ITEMS
      || (value.status !== "active" && value.status !== "void")
      || !nullableText(value.voidReason) || !nullableText(value.voidedBy)
      || !(value.voidedAt === null || instant(value.voidedAt))
      || typeof value.createdBy !== "string" || !instant(value.createdAt)) return invalid();
    seen.add(value.id);
    return {
      id: value.id, patientId, visitId: value.visitId as number | null, doctorPartyId: value.doctorPartyId as number | null,
      diagnosis: value.diagnosis as string | null, notes: value.notes as string | null,
      instructionsLang: value.instructionsLang, items: value.items.map(readItem), status: value.status,
      voidReason: value.voidReason as string | null, voidedBy: value.voidedBy as string | null,
      voidedAt: value.voidedAt as string | null, createdBy: value.createdBy, createdAt: value.createdAt,
    };
  });
}

export function savedPrescriptionPrintHref(patientId: number, row: SavedPrescription): string | null {
  return prescriptionIdentity(patientId) && row.patientId === patientId && prescriptionIdentity(row.id)
    ? `/print/prescription/${patientId}?rx=${row.id}` : null;
}

/** Explicit UTC avoids inventing a clinic zone or changing date across hydration. */
export function savedPrescriptionIssuedAt(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, 19)} UTC`;
}
