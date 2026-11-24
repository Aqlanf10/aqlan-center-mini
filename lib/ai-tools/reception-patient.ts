import { searchPatients } from "../db";
import { readOperationalPatient } from "../patient-operational-read";

/** Keep assistant summaries within the desk's operational patient view. Actual
 * collection and receipt reprinting go through their scoped interactive routes. */
export async function receptionPatientLookup(identifier: string | number) {
  const term = String(identifier);
  const id = typeof identifier === "number" ? identifier : /^\d+$/.test(term) ? Number(term) : 0;
  const direct = id > 0 && id < 100000 ? await readOperationalPatient(id, "reception") : null;
  const rows = direct ? [direct] : typeof identifier === "number" ? [] : await searchPatients(term, 8);
  const matches = rows.map(({ id, fullName, patientNumber, phone }) => ({ id, fullName, patientNumber, phone }));
  const text = matches.length
    ? matches.map(row => `${row.fullName} — ${row.patientNumber}${row.phone ? " — " + row.phone : ""}`).join("\n") + "\nللتحصيل أو طباعة سند، افتح شاشة التحصيل للمريض."
    : "لم يُعثر على ملف مطابق.";
  return { matches, text };
}
