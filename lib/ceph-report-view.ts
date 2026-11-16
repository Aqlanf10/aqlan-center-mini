/** Read-only report presentation. This module neither calculates clinical
 * measurements nor verifies/creates approval evidence. The server must supply
 * an already verified completion witness; drafts never substitute for it.
 */
export interface CephReportLandmark {
  code: string;
  x: number;
  y: number;
}

export interface CephReportSavedGeometry {
  analysisId: number;
  recordedPatientId: number;
  image: { documentId: number };
  snapshot: {
    patientId: number;
    documentId: number;
    mmPerPixel: number | null;
    landmarks: readonly CephReportLandmark[];
  };
}

export interface CephReportGeometryInput {
  analysisId: number;
  patientId: number;
  documentId: number;
  status: string;
  draftLandmarks: readonly CephReportLandmark[];
  /** Only pass an upstream-verified witness, never raw submitted JSON. */
  saved: CephReportSavedGeometry | null;
}

export type CephReportTracing = {
  available: true;
  source: "draft" | "sealed";
  points: readonly CephReportLandmark[];
  viewBox: string;
  markSize: number;
} | {
  available: false;
  reason: "unsupported_status" | "unversioned_history" | "source_mismatch"
    | "invalid_landmarks" | "insufficient_landmarks" | "invalid_extent";
};

export const CEPH_REPORT_NOT_TO_SCALE =
  "رسم توضيحي غير صالح للقياس من الورق؛ معايرة الصورة لا تحدد مقياس الطباعة.";
export const CEPH_REPORT_TRACE_UNAVAILABLE =
  "المخطط غير متاح من مصدر موثوق لهذه النسخة؛ لم تُستخدم نقاط مسودة بديلة.";
export const CEPH_REPORT_SAVED_TRACE =
  "رسم توضيحي من إحداثيات لقطة الاعتماد المحفوظة، وليس إعادة حساب للقياسات أو نسخة من صورة الأشعة.";

/** The identity check is an additional presentation guard, not authorization,
 * cryptographic validation or proof of a clinician's visual review. */
export function sameCephReportSource(input: CephReportGeometryInput): boolean {
  const saved = input.saved;
  return !!saved && saved.analysisId === input.analysisId
    && saved.recordedPatientId === input.patientId
    && saved.snapshot.patientId === input.patientId
    && saved.image.documentId === input.documentId
    && saved.snapshot.documentId === input.documentId;
}

export function buildCephReportTracing(input: CephReportGeometryInput): CephReportTracing {
  if (input.status !== "draft" && input.status !== "completed") {
    return { available: false, reason: "unsupported_status" };
  }
  if (input.status === "completed" && input.saved === null) {
    return { available: false, reason: "unversioned_history" };
  }
  if (input.status === "completed" && !sameCephReportSource(input)) {
    return { available: false, reason: "source_mismatch" };
  }
  // Even an empty saved set stays empty: no fallback to today's draft.
  const selected = input.status === "completed" ? input.saved!.snapshot.landmarks : input.draftLandmarks;
  if (!Array.isArray(selected) || selected.length > 256) {
    return { available: false, reason: "invalid_landmarks" };
  }
  const codes = new Set<string>();
  for (const point of selected) {
    if (!point || typeof point.code !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(point.code)
      || codes.has(point.code) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return { available: false, reason: "invalid_landmarks" };
    }
    codes.add(point.code);
  }
  if (selected.length < 4) return { available: false, reason: "insufficient_landmarks" };
  // Clone coordinates: later UI/caller mutations cannot change this projection.
  const points = selected.map(({ code, x, y }) => ({ code, x, y }));
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  const span = Math.max(maxX - minX, maxY - minY);
  if (!Number.isFinite(span) || span <= 0) return { available: false, reason: "invalid_extent" };
  const pad = span * 0.08;
  const box = [minX - pad, minY - pad, Math.max(maxX - minX, pad) + 2 * pad,
    Math.max(maxY - minY, pad) + 2 * pad];
  const markSize = span / 200;
  if (!box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0 || !Number.isFinite(markSize) || markSize <= 0) {
    return { available: false, reason: "invalid_extent" };
  }
  return { available: true, source: input.status === "completed" ? "sealed" : "draft",
    points, viewBox: box.join(" "), markSize };
}

/** Source calibration only. Never a paper scale, and never reciprocal Infinity. */
export function cephReportCalibration(status: string, draftScale: number | null,
  saved: CephReportSavedGeometry | null): string {
  if (status !== "draft" && status !== "completed") return "غير متاح";
  if (status === "completed" && !saved) return "المعايرة التاريخية غير موثّقة";
  const scale = status === "completed" ? saved!.snapshot.mmPerPixel : draftScale;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) {
    return status === "completed" ? "المعايرة التاريخية غير صالحة" : "غير معايَر";
  }
  return `${Number(scale.toPrecision(6))} mm/px`;
}

export interface CephAgeAtAcquisition {
  minimumYears: number;
  maximumYears: number;
  precision: "birth_year_only";
}

/** Strict Gregorian calendar parsing; no Date/clock/timezone fallback.
 * Only a birth year is stored, so an exact age cannot be asserted. */
export function cephAgeAtAcquisition(birthYear: number | null | undefined,
  xrayDate: string | null | undefined): CephAgeAtAcquisition | null {
  if (typeof birthYear !== "number" || !Number.isInteger(birthYear) || birthYear < 1 || birthYear > 9999
    || typeof xrayDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(xrayDate)) return null;
  const [year, month, day] = xrayDate.split("-").map(Number);
  if (year < birthYear || year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]) return null;
  const years = year - birthYear;
  return { minimumYears: Math.max(0, years - 1), maximumYears: years, precision: "birth_year_only" };
}

export function cephReportAgeLabel(age: CephAgeAtAcquisition | null): string {
  if (!age) return "غير متاح: يلزم تاريخ تصوير صالح وسنة ميلاد صالحة";
  return age.minimumYears === age.maximumYears
    ? `${age.maximumYears} سنة تقريبًا (سنة الميلاد فقط)`
    : `${age.minimumYears}–${age.maximumYears} سنة تقريبًا (سنة الميلاد فقط)`;
}
