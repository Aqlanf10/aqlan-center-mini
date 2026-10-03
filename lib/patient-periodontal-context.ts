import { readSpecialtyContext } from "./patient-specialty-workspaces";
import { readStructuredClinical } from "./visit-structured-clinical";
import type { PerioCaseOption, PerioVisitContext } from "@/components/periodontics/workspace-model";

export interface PeriodontalContext {
  currentVisit: PerioVisitContext | null;
  doctors: { id: number; name: string }[];
  cases: PerioCaseOption[];
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const unavailable = () => new Error("تعذّر تأكيد سياق فحص اللثة كاملًا. حدّث الزيارة والأطباء والحالات قبل الإدخال.");

/** Undefined is unknown, while null is an explicit successful no-open-visit read. */
export function periodontalVisitId(summary: unknown): number | null | undefined {
  if (!record(summary) || !Object.hasOwn(summary, "openVisit")) return undefined;
  if (summary.openVisit === null) return null;
  return record(summary.openVisit) && id(summary.openVisit.id) ? summary.openVisit.id : undefined;
}

/** Allowlist the three existing protected reads; never manufacture a doctor or case. */
export function readPeriodontalContext(patientId: number, visitId: number | null,
  visitPayload: unknown, doctorPayload: unknown, casesPayload: unknown): PeriodontalContext {
  if (!id(patientId) || (visitId !== null && !id(visitId)) || !Array.isArray(doctorPayload)) throw unavailable();
  const seenDoctors = new Set<number>();
  const doctors = doctorPayload.map((row) => {
    if (!record(row) || !id(row.id) || row.kind !== "doctor" || typeof row.name !== "string" || !row.name.trim() || seenDoctors.has(row.id)) throw unavailable();
    seenDoctors.add(row.id); return { id: row.id, name: row.name };
  });
  const caseSnapshot = readSpecialtyContext(casesPayload, patientId);
  const cases = caseSnapshot.cases.flatMap((row): PerioCaseOption[] => row.kind === "specialty" && row.id !== null
    ? [{ id: row.id, patientId: row.patientId, title: row.title, specialty: row.specialty, status: row.status }] : []);
  if (visitId === null) {
    if (visitPayload !== null) throw unavailable();
    return { currentVisit: null, doctors, cases };
  }
  if (!record(visitPayload) || visitPayload.id !== visitId || visitPayload.patientId !== patientId || !timestamp(visitPayload.arrivedAt)) throw unavailable();
  const saved = readStructuredClinical(visitPayload.structuredClinical, visitId, patientId);
  if (saved.status !== "ready" || visitPayload.signedAt !== saved.signedAt) throw unavailable();
  if (saved.visitCaseId !== null) {
    const linked = cases.find((row) => row.id === saved.visitCaseId);
    if (!linked) throw unavailable();
    // Existing visit-case binding is authoritative. An incompatible unsigned visit
    // must be resolved through canonical case/visit workflows, never silently relinked.
    if (!saved.signedAt && (linked.specialty !== "periodontics" || !["active", "waiting"].includes(linked.status))) {
      throw new Error("الزيارة مرتبطة بحالة لا تقبل فحص لثة جديدًا. راجع الحالة والزيارة من مسارهما الأصلي؛ لم يُغيّر الارتباط.");
    }
  }
  return { currentVisit: { id: visitId, patientId, date: visitPayload.arrivedAt, signedAt: saved.signedAt, caseId: saved.visitCaseId }, doctors, cases };
}
