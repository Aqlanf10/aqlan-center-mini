import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionPayload } from '../lib/auth';
import type { Role } from '../lib/roles';
import { apiRouteVerdict, HTTP_PERMISSIONS } from '../lib/http-permissions';
const s = vi.hoisted(() => ({ session: null as SessionPayload | null, access: true, read: vi.fn(), write: vi.fn(), query: vi.fn() }));
vi.mock('../lib/session', () => ({ requireSession: async () => s.session }));
vi.mock('../lib/patient-access', () => ({ canAccessPatient: async () => s.access }));
vi.mock('../lib/db', () => ({ ensureSchema: async () => {}, getPool: () => ({ query: s.query }) }));
vi.mock('../lib/ortho-assessment-store', () => ({ getOrthoAssessment: s.read, appendOrthoAssessment: s.write }));
import { GET, POST } from '../app/api/ortho/[id]/assessment/route';
const canary = 'SYNTHETIC-PRIVATE-MEDICAL-HISTORY', context = { params: Promise.resolve({ id: '17' }) };
const request = (query = '?acceptSchema=1,2') => new Request(`http://localhost/api/ortho/17/assessment${query}`);
beforeEach(() => {
 s.session = { userId: 7, username: 'synthetic-clinician', role: 'doctor', expiresAt: Date.now() + 60000 };
 s.access = true; s.query.mockReset().mockResolvedValue({ rows: [{ patient_id: 5 }] });
 s.read.mockReset().mockResolvedValue({ ok: true, revision: { medicalHistory: canary } });
 s.write.mockReset().mockResolvedValue({ ok: true });
});
it.each(['reception', 'assistant', 'cashier', 'accountant'] as Role[])('denies %s direct current/historical GET and POST before case lookup or clinical storage', async role => {
 s.session!.role = role;
 for (const query of ['?acceptSchema=1,2', '?acceptSchema=1,2&revisionId=42']) {
  const response = await GET(request(query), context); expect(response.status).toBe(403);
  expect(await response.text()).not.toContain(canary); expect(response.headers.get('cache-control')).toBe('private, no-store');
 }
 const response = await POST(new Request(request(), { method: 'POST', body: '{}' }), context);
 expect(response.status).toBe(403); expect(s.query).not.toHaveBeenCalled(); expect(s.read).not.toHaveBeenCalled(); expect(s.write).not.toHaveBeenCalled();
});
it.each(['admin', 'doctor'] as Role[])('preserves admitted %s reads but still checks current patient access', async role => {
 s.session!.role = role; const response = await GET(request(), context);
 expect(response.status).toBe(200); expect(await response.text()).toContain(canary);
 expect(s.read).toHaveBeenCalledWith(expect.objectContaining({ patientId: 5, orthoCaseId: 17, session: s.session }));
 s.read.mockClear(); s.access = false;
 expect((await GET(request(), context)).status).toBe(403); expect(s.read).not.toHaveBeenCalled();
});
it('requires a staff session and never returns canary data anonymously', async () => {
 s.session = null; const response = await GET(request(), context); expect(response.status).toBe(401);
 expect(s.read).not.toHaveBeenCalled(); expect(s.query).not.toHaveBeenCalled();
});
it('registers assessment GET/HEAD/POST as clinical while preserving exact appointment and financial role sets', () => {
 expect(HTTP_PERMISSIONS['/api/ortho/[id]/assessment']).toEqual({ GET: ['admin', 'doctor'], POST: ['admin', 'doctor'] });
 expect(apiRouteVerdict('/api/ortho/17/assessment', 'HEAD')).toMatchObject({ kind: 'registered', access: ['admin', 'doctor'] });
 expect(HTTP_PERMISSIONS['/api/appointments']).toEqual({ GET: ['admin', 'reception', 'doctor'], POST: ['admin', 'reception', 'doctor'] });
 expect(HTTP_PERMISSIONS['/api/patients/[id]/ledger']).toEqual({ GET: ['admin', 'reception', 'doctor', 'cashier', 'accountant'] });
});
