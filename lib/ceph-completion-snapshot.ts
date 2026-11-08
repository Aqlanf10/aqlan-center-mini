import { isCephLandmarkCode, LANDMARKS, type LandmarkCode } from "./ceph";

export interface CephCompletionDiagnosis {
  skeletal: string | null; dental: string | null; softTissue: string | null;
  note: string | null; finalDx: string;
}
export interface CephCompletionSnapshot {
  patientId: number;
  documentId: number;
  refSet: string;
  calibration: { x1: number; y1: number; x2: number; y2: number; mm: number } | null;
  mmPerPixel: number | null;
  landmarks: { code: LandmarkCode; x: number; y: number; source: "manual" | "suggested" }[];
  diagnosis: CephCompletionDiagnosis | null;
}

export type CephCalibrationState = Pick<CephCompletionSnapshot, "calibration" | "mmPerPixel">;

/** The same normalization used when saving clinician-authored diagnosis fields.
 * Return it to the editor on acknowledgment; never normalize an unseen snapshot
 * at completion to make mismatched displayed and stored text appear equivalent. */
export function normalizeCephDiagnosis(input: {
  skeletal?: string | null; dental?: string | null; softTissue?: string | null; note?: string | null; finalDx: string;
}): CephCompletionDiagnosis {
  const clean = (text: string | null | undefined) => text?.trim().slice(0, 2000) || null;
  return { skeletal: clean(input.skeletal), dental: clean(input.dental), softTissue: clean(input.softTissue),
    note: clean(input.note), finalDx: input.finalDx.trim().slice(0, 2000) };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string | null => value === null || (typeof value === "string" && value.length <= 2000);

/** Validate a successful diagnosis-save acknowledgment without rewriting it. */
export function parseCephCompletionDiagnosis(value: unknown): CephCompletionDiagnosis | null {
  const d = value;
  if (!record(d) || !text(d.skeletal) || !text(d.dental) || !text(d.softTissue) || !text(d.note)
      || typeof d.finalDx !== "string" || d.finalDx.length > 2000 || !d.finalDx.trim()) return null;
  return { skeletal: d.skeletal, dental: d.dental, softTissue: d.softTissue, note: d.note, finalDx: d.finalDx };
}

/** Ruler endpoints and derived scale are one acknowledged state. Nulls describe
 * an uncalibrated draft, not permission to replace an already calibrated one. */
export function parseCephCalibrationState(value: unknown): CephCalibrationState | null {
  if (!record(value) || (value.mmPerPixel !== null && !finite(value.mmPerPixel))) return null;
  let calibration: CephCalibrationState["calibration"] = null;
  if (value.calibration !== null) {
    const c = value.calibration;
    if (!record(c) || !finite(c.x1) || !finite(c.y1) || !finite(c.x2) || !finite(c.y2) || !finite(c.mm)) return null;
    calibration = { x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, mm: c.mm };
  }
  return { calibration, mmPerPixel: value.mmPerPixel };
}

export function sameCephCalibrationState(a: unknown, b: unknown): boolean {
  const left = parseCephCalibrationState(a), right = parseCephCalibrationState(b);
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

/** Strict finite, bounded, explicit snapshot. Null calibration/scale/diagnosis
 * describe an unready draft truthfully; they never waive completion's guards. */
export function parseCephCompletionSnapshot(value: unknown): CephCompletionSnapshot | null {
  if (!record(value) || !id(value.patientId) || !id(value.documentId) || typeof value.refSet !== "string"
      || value.refSet.length === 0 || value.refSet.length > 200
      || (value.mmPerPixel !== null && !finite(value.mmPerPixel))
      || !Array.isArray(value.landmarks) || value.landmarks.length > LANDMARKS.length) return null;
  const ruler = parseCephCalibrationState(value);
  if (!ruler) return null;
  const { calibration } = ruler;
  const landmarks: CephCompletionSnapshot["landmarks"] = [];
  const codes = new Set<string>();
  for (const p of value.landmarks) {
    if (!record(p) || !isCephLandmarkCode(p.code) || codes.has(p.code) || !finite(p.x) || !finite(p.y)
        || (p.source !== "manual" && p.source !== "suggested")) return null;
    codes.add(p.code); landmarks.push({ code: p.code, x: p.x, y: p.y, source: p.source });
  }
  landmarks.sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  let diagnosis: CephCompletionDiagnosis | null = null;
  if (value.diagnosis !== null) {
    diagnosis = parseCephCompletionDiagnosis(value.diagnosis);
    if (!diagnosis) return null;
  }
  return { patientId: value.patientId, documentId: value.documentId, refSet: value.refSet,
    calibration, mmPerPixel: value.mmPerPixel, landmarks, diagnosis };
}

/** Both sides must parse: malformed stored legacy data cannot match by accident.
 * This checks visible state equality, not a revision counter (same-state ABA is
 * indistinguishable without adding a persistent revision). */
export function sameCephCompletionSnapshot(a: unknown, b: unknown): boolean {
  const left = parseCephCompletionSnapshot(a), right = parseCephCompletionSnapshot(b);
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}
