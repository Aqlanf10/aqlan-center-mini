import { CORE_LANDMARK_IDS, type CoreLandmarkId } from '../ceph-core/steiner-core';
import { isotropicScaleFromReference } from '../ceph-core/geometry';

// Deliberately synthetic-only: no image URL, record ID, persistence or clinical adapter.
export const SYNTHETIC_IMAGE = Object.freeze({ id: 'synthetic-grid-v1', width: 800, height: 600 });
export type Pixel = Readonly<{ column: number; row: number }>;
export type Mark = Pixel & Readonly<{ reviewed: boolean }>;
export type Reference = Readonly<{ start: Pixel; end: Pixel; lengthMm: number }>;
export interface ResearchDraft {
  readonly revision: number;
  readonly anterior: 'left' | 'right' | null;
  readonly reference: Reference | null;
  readonly marks: Readonly<Partial<Record<CoreLandmarkId, Mark>>>;
}
export interface ResearchSnapshot extends ResearchDraft {
  readonly imageId: typeof SYNTHETIC_IMAGE.id;
  readonly clinicalUseAllowed: false;
  readonly calibrationScope: 'synthetic-only';
  readonly mmPerPixel: number;
}
export const newResearchDraft = (): ResearchDraft => ({ revision: 1, anterior: null, reference: null, marks: {} });
export function validPixel(p: Pixel): boolean {
  return Number.isFinite(p.column) && Number.isFinite(p.row) && p.column >= 0 && p.column < SYNTHETIC_IMAGE.width && p.row >= 0 && p.row < SYNTHETIC_IMAGE.height;
}
function assertPixel(p: Pixel) { if (!validPixel(p)) throw new Error('النقطة خارج حدود الرسم الاصطناعي.'); }
const unreview = (marks: ResearchDraft['marks']) => Object.fromEntries(Object.entries(marks).map(([id, p]) => [id, { ...p, reviewed: false }]));
export function setAnterior(d: ResearchDraft, anterior: 'left' | 'right'): ResearchDraft {
  if (anterior !== 'left' && anterior !== 'right') throw new Error('اختر اتجاه الأمام.');
  if (d.anterior === anterior) return d;
  return { ...d, revision: d.revision + 1, anterior, marks: unreview(d.marks) };
}
export function setReference(d: ResearchDraft, reference: Reference): ResearchDraft {
  assertPixel(reference.start); assertPixel(reference.end);
  isotropicScaleFromReference({ x: reference.start.column, y: reference.start.row }, { x: reference.end.column, y: reference.end.row }, reference.lengthMm);
  return { ...d, revision: d.revision + 1, reference: { start: { ...reference.start }, end: { ...reference.end }, lengthMm: reference.lengthMm }, marks: unreview(d.marks) };
}
export function setMark(d: ResearchDraft, id: CoreLandmarkId, p: Pixel): ResearchDraft {
  if (!CORE_LANDMARK_IDS.includes(id)) throw new Error('معرّف النقطة غير معروف.');
  if (!d.reference || !d.anterior) throw new Error('أكمل الاتجاه والمعايرة أولًا.');
  assertPixel(p);
  return { ...d, revision: d.revision + 1, marks: { ...d.marks, [id]: { ...p, reviewed: false } } };
}
export function reviewMark(d: ResearchDraft, id: CoreLandmarkId): ResearchDraft {
  const p = d.marks[id];
  if (!p) throw new Error('حدد النقطة قبل مراجعتها.');
  if (p.reviewed) return d;
  return { ...d, revision: d.revision + 1, marks: { ...d.marks, [id]: { ...p, reviewed: true } } };
}
export function workflowProgress(d: ResearchDraft) {
  const marked = CORE_LANDMARK_IDS.filter(id => d.marks[id]).length;
  const reviewed = CORE_LANDMARK_IDS.filter(id => d.marks[id]?.reviewed).length;
  return { marked, reviewed, total: CORE_LANDMARK_IDS.length, ready: !!d.reference && !!d.anterior && reviewed === CORE_LANDMARK_IDS.length };
}
export function captureResearchSnapshot(d: ResearchDraft): ResearchSnapshot {
  if (!workflowProgress(d).ready || !d.reference) throw new Error('أكمل معايرة الرسم ومراجعة كل النقاط.');
  const mmPerPixel = isotropicScaleFromReference({ x: d.reference.start.column, y: d.reference.start.row }, { x: d.reference.end.column, y: d.reference.end.row }, d.reference.lengthMm);
  const marks = Object.fromEntries(Object.entries(d.marks).map(([id, p]) => [id, Object.freeze({ ...p })]));
  return Object.freeze({ ...d, marks: Object.freeze(marks), reference: Object.freeze({ start: Object.freeze({ ...d.reference.start }), end: Object.freeze({ ...d.reference.end }), lengthMm: d.reference.lengthMm }), imageId: SYNTHETIC_IMAGE.id, mmPerPixel, calibrationScope: 'synthetic-only', clinicalUseAllowed: false });
}
// Convert a responsive SVG's client point through its inverse screen matrix in the UI.
// This helper validates the resulting original-image coordinate, never clamps it.
export function sourcePixel(column: number, row: number): Pixel | null {
  const p = { column, row }; return validPixel(p) ? p : null;
}
