import { PATIENT_STATEMENT_TYPES, type PatientStatementType } from "./patient-statement-document";

export class StatementInputError extends Error {}
export interface PatientStatementOptions {
  type: PatientStatementType;
  from?: string;
  to?: string;
  treatmentId?: number;
}

export function isStatementDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Patient id belongs to the route/session, never to a copied report query. */
export function parsePatientStatementOptions(query: URLSearchParams, patientId: number): PatientStatementOptions {
  for (const key of ["type", "from", "to", "treatmentId", "patientId"]) {
    if (query.getAll(key).length > 1) throw new StatementInputError("خيارات الكشف غير صالحة.");
  }
  if (query.has("patientId") && query.get("patientId") !== String(patientId)) throw new StatementInputError("رقم المريض لا يطابق الكشف.");
  const rawType = query.get("type") ?? (query.has("from") || query.has("to") ? "period" : "detailed");
  if (!Object.hasOwn(PATIENT_STATEMENT_TYPES, rawType)) throw new StatementInputError("نوع الكشف غير صالح.");
  const type = rawType as PatientStatementType;
  if (type === "period") {
    const to = query.get("to");
    const from = query.get("from") ?? to;
    if (!isStatementDate(from) || !isStatementDate(to) || from > to) throw new StatementInputError("حدّد بداية الفترة ونهايتها بصورة صحيحة.");
    return { type, from, to };
  }
  if (query.has("from") || query.has("to")) throw new StatementInputError("الفترة متاحة في كشف الفترة فقط.");
  if (type === "treatment") {
    const raw = query.get("treatmentId");
    const treatmentId = Number(raw);
    if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(treatmentId) || treatmentId <= 0) throw new StatementInputError("اختر العلاج أو الاتفاق.");
    return { type, treatmentId };
  }
  if (query.has("treatmentId")) throw new StatementInputError("العلاج المحدد متاح في كشف العلاج فقط.");
  return { type };
}
