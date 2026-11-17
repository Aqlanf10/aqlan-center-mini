import { describe, expect, it } from 'vitest';
import { CORE_LANDMARK_IDS } from '../lib/ceph-core/steiner-core';
import { captureResearchSnapshot, newResearchDraft, reviewMark, setAnterior, setMark, setReference, sourcePixel, workflowProgress } from '../lib/ceph-workflow/research-workflow';
const reference = { start: { column: 100, row: 100 }, end: { column: 200, row: 100 }, lengthMm: 10 };
const calibrated = () => setReference(setAnterior(newResearchDraft(), 'right'), reference);
const complete = () => CORE_LANDMARK_IDS.reduce((d, id, i) => reviewMark(setMark(d, id, { column: 50 + 30 * i, row: 150 + 20 * i }), id), calibrated());
describe('synthetic-only manual research workflow', () => {
  it('starts with no guessed direction, calibration or points', () => { const d = newResearchDraft(); expect(d.anterior).toBeNull(); expect(d.reference).toBeNull(); expect(workflowProgress(d)).toEqual({ marked: 0, reviewed: 0, total: 10, ready: false }); });
  it('cannot place a point before calibration and direction', () => { expect(() => setMark(newResearchDraft(), 'S', { column: 1, row: 1 })).toThrow(); expect(() => setMark(setReference(newResearchDraft(), reference), 'S', { column: 1, row: 1 })).toThrow(); });
  it.each([0, -1, NaN, Infinity])('rejects invalid reference length %s', lengthMm => { expect(() => setReference(calibrated(), { ...reference, lengthMm })).toThrow(); });
  it('rejects coincident reference endpoints and out-of-image reference', () => { expect(() => setReference(calibrated(), { ...reference, end: reference.start })).toThrow(); expect(() => setReference(calibrated(), { ...reference, end: { column: 800, row: 100 } })).toThrow(); });
  it.each([{ column: -1, row: 0 }, { column: 800, row: 0 }, { column: 0, row: 600 }, { column: NaN, row: 10 }, { column: 0, row: Infinity }])('rejects invalid point %j without mutation', point => { const d = calibrated(); expect(() => setMark(d, 'S', point)).toThrow(); expect(d.marks).toEqual({}); });
  it('accepts origin, preserves fractional original coordinates, never clamps', () => { expect(setMark(calibrated(), 'S', { column: 0, row: 0 }).marks.S?.column).toBe(0); expect(sourcePixel(12.125, 35.75)).toEqual({ column: 12.125, row: 35.75 }); expect(sourcePixel(800, 0)).toBeNull(); });
  it('requires explicit review and revokes it when a point changes', () => { const d = complete(); expect(workflowProgress(d).ready).toBe(true); const edited = setMark(d, 'S', { column: 100, row: 100 }); expect(workflowProgress(edited).reviewed).toBe(9); expect(() => captureResearchSnapshot(edited)).toThrow(); expect(d.marks.S?.reviewed).toBe(true); });
  it('changing global direction invalidates all reviews', () => { const d = complete(); expect(workflowProgress(setAnterior(d, 'left')).reviewed).toBe(0); expect(setAnterior(d, 'right')).toBe(d); });
  it('recalibration invalidates all reviews', () => { expect(workflowProgress(setReference(complete(), { ...reference, lengthMm: 20 })).reviewed).toBe(0); });
  it('does not review absent points or create repeated revisions for duplicate review', () => { expect(() => reviewMark(calibrated(), 'S')).toThrow(); const d = complete(); expect(reviewMark(d, 'S')).toBe(d); });
  it('captures immutable independent history with clinical use disabled', () => { const d = complete(), snapshot = captureResearchSnapshot(d); expect(snapshot.mmPerPixel).toBe(0.1); expect(snapshot.clinicalUseAllowed).toBe(false); expect(snapshot.calibrationScope).toBe('synthetic-only'); expect(Object.isFrozen(snapshot.marks.S)).toBe(true); expect(snapshot.marks.S).not.toBe(d.marks.S); expect(setMark(d, 'S', { column: 300, row: 300 }).marks.S).not.toEqual(snapshot.marks.S); expect(snapshot.marks.S?.column).toBe(50); });
});
