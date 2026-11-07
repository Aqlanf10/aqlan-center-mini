import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), study: vi.fn(), complete: vi.fn(), duplicate: vi.fn(), discard: vi.fn(), landmarks: vi.fn(), calibration: vi.fn(), diagnosis: vi.fn() }));
vi.mock('../lib/session', () => ({ requireSession: m.session }));
vi.mock('../lib/patient-access', () => ({ canAccessPatient: m.access }));
vi.mock('../lib/db', () => ({ getCephStudy: m.study, completeCephAnalysis: m.complete, duplicateCephAnalysis: m.duplicate, discardAuthorizedCephAnalysis: m.discard, updateAuthorizedCephLandmarks: m.landmarks, updateAuthorizedCephCalibration: m.calibration, updateAuthorizedCephDiagnosis: m.diagnosis }));
import { POST as complete } from '../app/api/ceph/[id]/complete/route';
import { PATCH } from '../app/api/ceph/[id]/route';
import { HTTP_PERMISSIONS } from '../lib/http-permissions';
const writers = () => [m.complete, m.duplicate, m.discard, m.landmarks, m.calibration, m.diagnosis];
const routes = [
  { name: 'completion', path: '/api/ceph/[id]/complete', method: 'POST', handler: complete, body: { expectedSnapshot: { patientId: 11, documentId: 22, refSet: 'builtin_default', calibration: null, mmPerPixel: null, landmarks: [], diagnosis: null } }, status: 200 },
  { name: 'landmark review', path: '/api/ceph/[id]', method: 'PATCH', handler: PATCH, body: { landmarks: [{ code: 'S', x: 10, y: 20, source: 'manual' }], expectedLandmarks: [] }, status: 200 },
  { name: 'calibration', path: '/api/ceph/[id]', method: 'PATCH', handler: PATCH, body: { calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, expectedCalibration: { calibration: null, mmPerPixel: null } }, status: 200 },
  { name: 'diagnosis', path: '/api/ceph/[id]', method: 'PATCH', handler: PATCH, body: { diagnosis: { finalDx: 'Synthetic clinician text' }, expectedDiagnosis: null }, status: 200 },
] as const;
beforeEach(() => { vi.clearAllMocks(); m.session.mockResolvedValue({ userId: 1, username: 'synthetic-doctor', role: 'doctor' }); m.access.mockResolvedValue(true); m.study.mockResolvedValue({ analysis: { patientId: 11, documentId: 22 } }); for (const w of writers()) w.mockResolvedValue({ ok: true, id: 72, mmPerPixel: 0.1, count: 1, removedCount: 0, measurements: [] }); });
describe.each(routes)('$name clinical-write admission', (r) => {
  const call = (id = '71') => r.handler(new Request('http://localhost/api/ceph/' + id, { method: r.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) }), { params: Promise.resolve({ id }) });
  it.each(['reception', 'assistant', 'cashier', 'accountant', undefined])('denies role %s even when image access is granted, before any clinical read or write', async role => {
    m.session.mockResolvedValue({ username: 'synthetic-denied', role });
    expect((await call()).status).toBe(403); expect(m.study).not.toHaveBeenCalled(); for (const w of writers()) expect(w).not.toHaveBeenCalled();
  });
  it.each(['admin', 'doctor'])('retains scoped clinical writer %s', async role => { m.session.mockResolvedValue({ username: 'synthetic-writer', role }); expect((await call()).status).toBe(r.status); expect(m.access).toHaveBeenCalledWith(expect.objectContaining({ role }), 11, 'canUploadXrays'); });
  it('denies absent session', async () => { m.session.mockResolvedValue(null); expect((await call()).status).toBe(401); expect(m.study).not.toHaveBeenCalled(); });
  it('denies a doctor without patient/imaging-write permission', async () => { m.access.mockResolvedValue(false); expect((await call()).status).toBe(403); for (const w of writers()) expect(w).not.toHaveBeenCalled(); });
  it('fails closed if current patient permission lookup fails', async () => { m.access.mockRejectedValue(new Error('synthetic permission unavailable')); expect((await call()).status).toBe(403); for (const w of writers()) expect(w).not.toHaveBeenCalled(); });
  it('rejects an unsafe integer ID before clinical lookup', async () => { expect((await call('9007199254740993')).status).toBe(400); expect(m.study).not.toHaveBeenCalled(); });
  it('keeps the HTTP registry aligned with the clinical role gate', () => { expect(HTTP_PERMISSIONS[r.path][r.method]).toEqual(['admin', 'doctor']); });
});
