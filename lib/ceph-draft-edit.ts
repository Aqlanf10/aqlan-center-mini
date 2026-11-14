import { isCephDiagnosisWriteInput } from "./ceph-diagnosis-write-input";
import { parseCephCalibrationState, parseCephCompletionDiagnosis, type CephCalibrationState, type CephCompletionDiagnosis } from "./ceph-completion-snapshot";
import type { CephDraftWriteRequest } from "./ceph-draft-authority";
import { isCephLandmarkCode } from "./ceph";
import {
  updateAuthorizedCephCalibration, updateAuthorizedCephDiagnosis, updateAuthorizedCephLandmarks,
  type CephCalibrationInput, type CephLandmarkInput,
} from "./db";

/**
 * One observed-draft edit (calibration, landmarks or diagnosis), shared by the legacy route and
 * the canonical command so both admit exactly the same body and call the same protected writer.
 * Every field is validated before the first write; one category per request.
 */
export type CephDraftEdit =
  | { kind: "calibration"; calibration: CephCalibrationInput; expected: CephCalibrationState }
  | { kind: "landmarks"; points: CephLandmarkInput[]; removeCodes: CephLandmarkInput["code"][]; expected: CephLandmarkInput[] }
  | { kind: "diagnosis"; diagnosis: Parameters<typeof updateAuthorizedCephDiagnosis>[1]; expected: CephCompletionDiagnosis | null }
  /** Historical behaviour kept: a body naming no category is acknowledged without any write. */
  | { kind: "none" };

const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function parseCephDraftEdit(body: unknown): { ok: true; edit: CephDraftEdit } | { ok: false; message: string } {
  const invalid = (message = "طلب غير صالح.") => ({ ok: false as const, message });
  if (!record(body)) return invalid();
  const source = body;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(source, key);
  // Each category owns a separate domain transaction; do not partially commit mixed requests.
  const categories = [has("calibration"), has("landmarks") || has("removeLandmarks"), has("diagnosis")];
  if (categories.filter(Boolean).length > 1) return invalid("أرسل تعديل المعايرة أو المعالم أو التشخيص في طلب مستقل.");
  const parsePoints = (value: unknown): CephLandmarkInput[] | null => {
    if (!Array.isArray(value)) return null;
    const parsed: CephLandmarkInput[] = [];
    for (const raw of value) {
      if (!record(raw) || !isCephLandmarkCode(raw.code) || num(raw.x) === null || num(raw.y) === null
        || (raw.source !== undefined && raw.source !== "manual" && raw.source !== "suggested")) return null;
      parsed.push({ code: raw.code, x: raw.x as number, y: raw.y as number, source: raw.source === "suggested" ? "suggested" : "manual" });
    }
    return new Set(parsed.map((pt) => pt.code)).size === parsed.length ? parsed : null;
  };
  // As before: a malformed observed landmark list refuses any request that carries it.
  if (has("expectedLandmarks") && parsePoints(source.expectedLandmarks) === null) return invalid("إزالة المعلم تحتاج موضعه المحفوظ للتحقق من عدم تغيّره.");
  if (categories.filter(Boolean).length === 0) return { ok: true, edit: { kind: "none" } };

  if (has("calibration")) {
    if (!record(source.calibration)) return invalid();
    const c = source.calibration;
    const x1 = num(c.x1), y1 = num(c.y1), x2 = num(c.x2), y2 = num(c.y2), mm = num(c.mm);
    if (x1 === null || y1 === null || x2 === null || y2 === null || mm === null || mm <= 0
      || !Number.isFinite(Math.hypot(x2 - x1, y2 - y1)) || Math.hypot(x2 - x1, y2 - y1) <= 0) {
      return invalid("المعايرة تحتاج نقطتين مختلفتين ومسافة حقيقية بالمليمتر.");
    }
    const scale = mm / Math.hypot(x2 - x1, y2 - y1);
    if (!Number.isFinite(scale) || scale <= 0) return invalid("مقياس المعايرة غير صالح.");
    const expected = parseCephCalibrationState(source.expectedCalibration);
    if (!expected) return invalid("حفظ المعايرة يحتاج نسخة المعايرة السابقة التي راجعتها.");
    return { ok: true, edit: { kind: "calibration", calibration: { x1, y1, x2, y2, mm }, expected } };
  }
  if (has("landmarks") || has("removeLandmarks")) {
    const points = has("landmarks") ? parsePoints(source.landmarks) : [];
    if (points === null) return invalid("المعالم تحتاج رموزًا فريدة وإحداثيات رقمية صالحة.");
    const removeCodes = has("removeLandmarks") ? source.removeLandmarks : [];
    if (!Array.isArray(removeCodes) || !removeCodes.every(isCephLandmarkCode)
      || new Set(removeCodes).size !== removeCodes.length || points.some((pt) => removeCodes.includes(pt.code))) {
      return invalid("رموز المعالم المراد إزالتها غير صالحة أو متكررة.");
    }
    if (!Array.isArray(source.expectedLandmarks)) {
      return invalid("حفظ المعالم يحتاج مواضعها السابقة التي راجعتها؛ أرسل قائمة صريحة ولو كانت فارغة.");
    }
    const expected = parsePoints(source.expectedLandmarks);
    if (expected === null || removeCodes.some((code) => !expected.some((pt) => pt.code === code))) {
      return invalid("إزالة المعلم تحتاج موضعه المحفوظ للتحقق من عدم تغيّره.");
    }
    return { ok: true, edit: { kind: "landmarks", points, removeCodes, expected } };
  }
  const d = source.diagnosis;
  if (!isCephDiagnosisWriteInput(d)) {
    return invalid("حقول التشخيص يجب أن تكون نصًا أو فارغة؛ الحد 2000 حرف لكل حقل والاستنتاج مطلوب.");
  }
  const expected = source.expectedDiagnosis === null ? null : parseCephCompletionDiagnosis(source.expectedDiagnosis);
  if (source.expectedDiagnosis !== null && !expected) return invalid("حفظ التشخيص يحتاج نسخته السابقة التي راجعتها.");
  return { ok: true, edit: { kind: "diagnosis", expected, diagnosis: {
    skeletal: typeof d.skeletal === "string" ? d.skeletal : null,
    dental: typeof d.dental === "string" ? d.dental : null,
    softTissue: typeof d.softTissue === "string" ? d.softTissue : null,
    note: typeof d.note === "string" ? d.note : null,
    finalDx: d.finalDx,
  } } };
}

/** The writer records the admitted actor (legacy session or canonical admission), never `by` from the body. */
export async function applyCephDraftEdit(id: number, edit: CephDraftEdit, authority: CephDraftWriteRequest):
  Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; message: string }> {
  if (edit.kind === "none") return { ok: true, body: { ok: true } };
  if (edit.kind === "calibration") {
    const done = await updateAuthorizedCephCalibration(id, edit.calibration, edit.expected, authority);
    return done.ok ? { ok: true, body: { ok: true, mmPerPixel: done.mmPerPixel, calibration: done.calibration } } : done;
  }
  if (edit.kind === "landmarks") {
    const done = await updateAuthorizedCephLandmarks(id, edit.points, edit.removeCodes, edit.expected, authority);
    return done.ok ? { ok: true, body: { ok: true } } : done;
  }
  const done = await updateAuthorizedCephDiagnosis(id, edit.diagnosis, edit.expected, authority);
  return done.ok ? { ok: true, body: { ok: true, diagnosis: done.diagnosis } } : done;
}
