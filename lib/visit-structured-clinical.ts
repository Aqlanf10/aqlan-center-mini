import { ENDO_STAGES, type EndoStage } from "./endodontics";
import { isValidTooth } from "./dental";

/** Read-only saved record references. No draft, plan, invoice or copied narrative. */
interface SavedRecord {
  id: number; visitId: number; patientId: number; caseId: number | null;
  doctorId: number | null; doctorName: string | null;
  recordedAt: string; updatedAt: string | null;
}
export interface VisitEndoReference extends SavedRecord {
  treatmentId: number; caseId: number; toothCode: number; version: number; stage: EndoStage;
  canalCount: number; measuredCanalCount: number; obturatedCanalCount: number;
}
export interface VisitPerioReference extends SavedRecord {
  doctorId: number; revision: number; siteCount: number; toothCount: number;
  recordedDepthSites: number; recordedBleedingSites: number;
}
export type VisitStructuredClinical = {
  status: "ready"; visitId: number; patientId: number; visitCaseId: number | null;
  /** Signature belongs to the canonical visit, never to a second specialty engine. */
  signedAt: string | null; signedBy: string | null;
  endodontics: VisitEndoReference[]; periodontics: VisitPerioReference[];
} | { status: "unavailable"; visitId: number; patientId: number | null };

export const unavailableStructuredClinical = (visitId: number, patientId: number | null): VisitStructuredClinical =>
  ({ status: "unavailable", visitId, patientId });

/** A failed, stale, mismatched or malformed response is never interpreted as an empty record. */
export function readStructuredClinical(value: unknown, visitId: number, patientId: number): VisitStructuredClinical {
  const unavailable = unavailableStructuredClinical(visitId, patientId);
  if (!value || typeof value !== "object") return unavailable;
  const input = value as Record<string, unknown>;
  if (input.status !== "ready" || input.visitId !== visitId || input.patientId !== patientId) return unavailable;
  const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
  const textOrNull = (value: unknown) => value === null || typeof value === "string";
  const base = (row: unknown): row is Record<string, unknown> => {
    if (!row || typeof row !== "object") return false;
    const record = row as Record<string, unknown>;
    return id(record.id) && record.visitId === visitId && record.patientId === patientId
      && (record.caseId === null || id(record.caseId)) && (record.doctorId === null || id(record.doctorId))
      && textOrNull(record.doctorName) && timestamp(record.recordedAt)
      && (record.updatedAt === null || timestamp(record.updatedAt));
  };
  if (!(input.visitCaseId === null || id(input.visitCaseId))
    || !(input.signedAt === null || timestamp(input.signedAt)) || !textOrNull(input.signedBy)
    || !Array.isArray(input.endodontics) || !Array.isArray(input.periodontics)) return unavailable;
  if (!input.endodontics.every((row: unknown) => base(row) && id(row.treatmentId) && id(row.caseId)
    && id(row.version) && typeof row.toothCode === "number" && isValidTooth(row.toothCode)
    && ENDO_STAGES.includes(row.stage as EndoStage) && count(row.canalCount)
    && count(row.measuredCanalCount) && row.measuredCanalCount <= row.canalCount
    && count(row.obturatedCanalCount) && row.obturatedCanalCount <= row.canalCount)) return unavailable;
  if (!input.periodontics.every((row: unknown) => base(row) && id(row.doctorId) && id(row.revision)
    && (input.visitCaseId === null || row.caseId === input.visitCaseId)
    && count(row.siteCount) && count(row.toothCount) && row.toothCount <= row.siteCount
    && count(row.recordedDepthSites) && row.recordedDepthSites <= row.siteCount
    && count(row.recordedBleedingSites) && row.recordedBleedingSites <= row.siteCount)) return unavailable;
  const saved = (row: SavedRecord): SavedRecord => ({
    id: row.id, visitId: row.visitId, patientId: row.patientId, caseId: row.caseId,
    doctorId: row.doctorId, doctorName: row.doctorName, recordedAt: row.recordedAt, updatedAt: row.updatedAt,
  });
  // Allowlist the wire shape too: future source fields cannot expand this clinical projection.
  return { status: "ready", visitId, patientId, visitCaseId: input.visitCaseId as number | null,
    signedAt: input.signedAt as string | null, signedBy: input.signedBy as string | null,
    endodontics: (input.endodontics as VisitEndoReference[]).map((row) => ({ ...saved(row),
      caseId: row.caseId, treatmentId: row.treatmentId, toothCode: row.toothCode, version: row.version,
      stage: row.stage, canalCount: row.canalCount, measuredCanalCount: row.measuredCanalCount, obturatedCanalCount: row.obturatedCanalCount })),
    periodontics: (input.periodontics as VisitPerioReference[]).map((row) => ({ ...saved(row),
      doctorId: row.doctorId, revision: row.revision, siteCount: row.siteCount, toothCount: row.toothCount,
      recordedDepthSites: row.recordedDepthSites, recordedBleedingSites: row.recordedBleedingSites })),
  };
}
