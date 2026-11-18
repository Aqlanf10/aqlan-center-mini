/**
 * The clinical inputs sealed at completion, read from the saved draft (never from the request body).
 * Ported from #530 `ceph-completion-snapshot`. Strict: finite numbers, known landmark codes, no duplicates,
 * bounded text. Landmark order is canonical (by code). A landmark's source (manual / suggested) is kept as saved:
 * this record does not add a new approval gate, it states what was approved.
 */
import { isCephLandmarkCode, LANDMARKS, type LandmarkCode } from "../ceph";

export interface CephSnapshotDiagnosis {
  readonly skeletal: string | null; readonly dental: string | null; readonly softTissue: string | null;
  readonly note: string | null; readonly finalDx: string;
}
export interface CephCompletionSnapshot {
  readonly patientId: number;
  readonly documentId: number;
  readonly orthoCaseId: number | null;
  readonly refSet: string;
  readonly calibration: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly mm: number } | null;
  readonly mmPerPixel: number | null;
  readonly landmarks: readonly { readonly code: LandmarkCode; readonly x: number; readonly y: number; readonly source: "manual" | "suggested" }[];
  readonly diagnosis: CephSnapshotDiagnosis | null;
}

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positiveId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const text = (v: unknown): v is string | null => v === null || (typeof v === "string" && v.length <= 2000);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

const SNAPSHOT_KEYS = ["patientId", "documentId", "orthoCaseId", "refSet", "calibration", "mmPerPixel", "landmarks", "diagnosis"] as const;

export function parseCephCompletionSnapshot(value: unknown): CephCompletionSnapshot | null {
  if (!record(value) || !exactKeys(value, SNAPSHOT_KEYS) || !positiveId(value.patientId) || !positiveId(value.documentId)
    || !(value.orthoCaseId === null || positiveId(value.orthoCaseId))
    || typeof value.refSet !== "string" || !value.refSet || value.refSet.length > 200
    || !(value.mmPerPixel === null || (finite(value.mmPerPixel) && value.mmPerPixel > 0))
    || !Array.isArray(value.landmarks) || value.landmarks.length > LANDMARKS.length) return null;
  let calibration: CephCompletionSnapshot["calibration"] = null;
  if (value.calibration !== null) {
    const c = value.calibration;
    if (!record(c) || !exactKeys(c, ["x1", "y1", "x2", "y2", "mm"]) || ![c.x1, c.y1, c.x2, c.y2, c.mm].every(finite) || (c.mm as number) <= 0) return null;
    calibration = { x1: c.x1 as number, y1: c.y1 as number, x2: c.x2 as number, y2: c.y2 as number, mm: c.mm as number };
  }
  const seen = new Set<string>();
  const landmarks: { code: LandmarkCode; x: number; y: number; source: "manual" | "suggested" }[] = [];
  for (const p of value.landmarks) {
    if (!record(p) || !exactKeys(p, ["code", "x", "y", "source"]) || !isCephLandmarkCode(p.code) || seen.has(p.code)
      || !finite(p.x) || !finite(p.y) || (p.source !== "manual" && p.source !== "suggested")) return null;
    seen.add(p.code);
    landmarks.push({ code: p.code, x: p.x, y: p.y, source: p.source });
  }
  landmarks.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  let diagnosis: CephSnapshotDiagnosis | null = null;
  if (value.diagnosis !== null) {
    const d = value.diagnosis;
    if (!record(d) || !exactKeys(d, ["skeletal", "dental", "softTissue", "note", "finalDx"]) || !text(d.skeletal) || !text(d.dental)
      || !text(d.softTissue) || !text(d.note) || typeof d.finalDx !== "string" || !d.finalDx.trim() || d.finalDx.length > 2000) return null;
    diagnosis = { skeletal: d.skeletal, dental: d.dental, softTissue: d.softTissue, note: d.note, finalDx: d.finalDx };
  }
  return { patientId: value.patientId, documentId: value.documentId, orthoCaseId: value.orthoCaseId, refSet: value.refSet,
    calibration, mmPerPixel: value.mmPerPixel, landmarks, diagnosis };
}
