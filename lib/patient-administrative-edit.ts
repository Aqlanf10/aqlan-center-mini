import type { Patient } from "./patient";
import { isPreferredChannel } from "./patient-identity";

export function patientIdentityEditMode(
  session: { role: string; permissions?: { canEditPatient?: boolean } | null } | null,
): "clinical" | "administrative" | null {
  if (session?.role === "admin" || (session?.role === "doctor" && session.permissions?.canEditPatient !== false)) return "clinical";
  if (session?.role === "reception") return "administrative";
  return null;
}

export const PATIENT_ADMIN_FIELDS = [
  "fullName", "phone", "altPhone", "email", "gender", "birthYear", "birthDate",
  "address", "guardianName", "guardianPhone", "referralSource", "referredBy",
] as const;

type DemographicField = typeof PATIENT_ADMIN_FIELDS[number];
export const PATIENT_ADMIN_PATCH_FIELDS = [...PATIENT_ADMIN_FIELDS, "flags", "preferredChannel"] as const;
type AdministrativeField = typeof PATIENT_ADMIN_PATCH_FIELDS[number];

export function isPatientAdministrativePatchField(field: string): field is AdministrativeField {
  return PATIENT_ADMIN_PATCH_FIELDS.some((key) => key === field);
}
export type AdministrativePatientChange = Partial<Pick<Patient, AdministrativeField>>;
export type ReceptionPatientForm = Record<DemographicField, string>;

export function makeReceptionPatientForm(patient: Pick<Patient, DemographicField>): ReceptionPatientForm {
  return {
    fullName: patient.fullName, phone: patient.phone ?? "", altPhone: patient.altPhone ?? "",
    email: patient.email ?? "", gender: patient.gender, birthYear: String(patient.birthYear ?? ""),
    birthDate: patient.birthDate ?? "", address: patient.address ?? "", guardianName: patient.guardianName ?? "",
    guardianPhone: patient.guardianPhone ?? "", referralSource: patient.referralSource ?? "",
    referredBy: patient.referredBy ?? "",
  };
}

function comparableBirthYear(value: string): string {
  return value.trim().replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

/** An incompatible date disappears from the preview, not from the input draft. */
export function visibleReceptionPatientBirthDate(form: ReceptionPatientForm): string {
  return form.birthDate && form.birthDate.slice(0, 4) === comparableBirthYear(form.birthYear) ? form.birthDate : "";
}

export function receptionPatientFormPatch(initial: ReceptionPatientForm, form: ReceptionPatientForm) {
  const patch = Object.fromEntries(PATIENT_ADMIN_FIELDS
    .filter((field) => field !== "birthYear" && field !== "birthDate" && initial[field] !== form[field])
    .map((field) => [field, form[field]]));

  const explicitlyChangedDate = form.birthDate !== initial.birthDate;
  if (explicitlyChangedDate && form.birthDate !== "" && visibleReceptionPatientBirthDate(form)) {
    // The server derives its year. A stale companion value must not become a second instruction.
    patch.birthDate = form.birthDate;
    return patch;
  }
  if (comparableBirthYear(initial.birthYear) !== comparableBirthYear(form.birthYear)) patch.birthYear = form.birthYear;
  // Only a change on the date control can create a blank draft value. A blank
  // preview from a year edit is never sent; the writer checks the current row.
  if (explicitlyChangedDate && form.birthDate === "") patch.birthDate = "";
  return patch;
}

export function readAdministrativePatientChange(
  payload: unknown, patientId: number, request: Record<string, unknown>,
): AdministrativePatientChange | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  if (row.id !== patientId) return null;
  const fields = new Set(Object.keys(request));
  if (fields.has("birthYear") || fields.has("birthDate")) {
    fields.add("birthYear");
    fields.add("birthDate");
  }

  const accepted: Array<[string, unknown]> = [];
  for (const key of fields) {
    if (!Object.hasOwn(row, key)) return null;
    const value = row[key];
    if (key === "flags") {
      if (!Array.isArray(value) || !value.every((flag) => typeof flag === "string")) return null;
    } else if (key === "preferredChannel") {
      if (value !== null && !isPreferredChannel(value)) return null;
    } else if (key === "fullName") {
      if (typeof value !== "string" || !value.trim()) return null;
    } else if (key === "gender") {
      if (value !== "male" && value !== "female" && value !== "unknown") return null;
    } else if (key === "birthYear") {
      if (value !== null && !Number.isInteger(value)) return null;
    } else if (!PATIENT_ADMIN_FIELDS.some((field) => field === key)
      || (value !== null && typeof value !== "string")) {
      return null;
    }
    accepted.push([key, value]);
  }
  return accepted.length ? Object.fromEntries(accepted) as AdministrativePatientChange : null;
}
