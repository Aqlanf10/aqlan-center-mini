import { WEBCEPH_RECORD_SLOTS, type PhotoStage, type PhotoView } from "./ortho-photos";

export interface OrthoRecordDocument {
  id: number;
  patientId: number;
  orthoCaseId: number | null;
  title: string;
  isImage: boolean;
  photoStage: string | null;
  photoView: string | null;
  takenOn: string | null;
  uploadedAt: string;
  removedAt: string | null;
}

export interface OrthoRecordStudy {
  id: number;
  patientId: number;
  documentId: number;
  orthoCaseId: number | null;
  phase: string;
  status: "draft" | "completed" | "discarded";
}

export const ORTHO_RECORDS_READ_FAILURE = "تعذّر تحميل سجلات هذه الحالة. هذا لا يعني عدم وجود صور أو تحليلات مسجلة.";
const positiveId = (value: unknown): value is number => typeof value === "number"
  && Number.isSafeInteger(value) && value > 0;
const nullableText = (value: unknown) => value === null || typeof value === "string";
const nullableId = (value: unknown) => value === null || positiveId(value);

/** PostgreSQL BIGSERIAL ceph IDs arrive as decimal strings; PGlite uses numbers. */
export function recordStudyId(value: unknown): number | null {
  const parsed = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  return positiveId(parsed) ? parsed : null;
}

/** These endpoints are patient-wide. Missing links are never inferred from the open case. */
export function decodeOrthoRecordDocuments(payload: unknown, patientId: number): OrthoRecordDocument[] {
  if (!payload || typeof payload !== "object" || !("documents" in payload) || !Array.isArray(payload.documents)) {
    throw new Error(ORTHO_RECORDS_READ_FAILURE);
  }
  const ids = new Set<number>();
  for (const row of payload.documents) {
    if (!row || typeof row !== "object" || !positiveId(row.id) || ids.has(row.id)
      || row.patientId !== patientId || !nullableId(row.orthoCaseId) || typeof row.title !== "string"
      || typeof row.isImage !== "boolean" || !nullableText(row.photoStage) || !nullableText(row.photoView)
      || !nullableText(row.takenOn) || !nullableText(row.removedAt)
      || typeof row.uploadedAt !== "string" || !Number.isFinite(Date.parse(row.uploadedAt))) {
      throw new Error(ORTHO_RECORDS_READ_FAILURE);
    }
    ids.add(row.id);
  }
  return (payload.documents as OrthoRecordDocument[]).filter(row => row.isImage && row.removedAt === null && row.photoStage !== "archived");
}

export function decodeOrthoRecordStudies(payload: unknown, patientId: number): OrthoRecordStudy[] {
  if (!payload || typeof payload !== "object" || !("analyses" in payload) || !Array.isArray(payload.analyses)) {
    throw new Error(ORTHO_RECORDS_READ_FAILURE);
  }
  const ids = new Set<number>();
  const studies: OrthoRecordStudy[] = [];
  for (const row of payload.analyses) {
    const id = row && typeof row === "object" ? recordStudyId(row.id) : null;
    if (!row || typeof row !== "object" || id === null || ids.has(id)
      || row.patientId !== patientId || !positiveId(row.documentId) || !nullableId(row.orthoCaseId)
      || typeof row.phase !== "string" || !["draft", "completed", "discarded"].includes(row.status)) {
      throw new Error(ORTHO_RECORDS_READ_FAILURE);
    }
    ids.add(id);
    if (row.status !== "discarded") studies.push({ ...row, id } as OrthoRecordStudy);
  }
  return studies;
}

/** Preserve the server's newest-first order, but only exact case links can fill slots. */
export function caseRecordSlots(documents: readonly OrthoRecordDocument[], patientId: number,
  orthoCaseId: number, stage: PhotoStage | "all"): Map<PhotoView, OrthoRecordDocument> {
  const slots = new Map<PhotoView, OrthoRecordDocument>();
  for (const doc of documents) {
    if (doc.patientId !== patientId || doc.orthoCaseId !== orthoCaseId || !doc.isImage
      || doc.removedAt !== null || doc.photoStage === "archived"
      || (stage !== "all" && doc.photoStage !== stage)) continue;
    const slot = WEBCEPH_RECORD_SLOTS.find(item => item.key === doc.photoView);
    if (slot && !slots.has(slot.key)) slots.set(slot.key, doc);
  }
  return slots;
}

export function caseRecordStudy(studies: readonly OrthoRecordStudy[], patientId: number,
  orthoCaseId: number, documentId: number): OrthoRecordStudy | undefined {
  return studies.find(study => study.patientId === patientId && study.orthoCaseId === orthoCaseId
    && study.documentId === documentId && study.status !== "discarded");
}
