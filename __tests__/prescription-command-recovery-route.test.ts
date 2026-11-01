import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ readSessionPayload: vi.fn(), requireSession: vi.fn(() => { throw new Error('Schema-initializing authentication forbidden'); }), recover: vi.fn() }));
vi.mock('@/lib/session', () => ({ readSessionPayload: mocks.readSessionPayload, requireSession: mocks.requireSession }));
vi.mock('@/lib/prescription-issuance', () => ({ recoverPrescriptionCommand: mocks.recover }));
import { GET } from '../app/api/prescriptions/commands/[key]/route';
const key = '11111111-1111-4111-8111-111111111111';
const read = () => GET(new Request('http://localhost/api/prescriptions/commands/test?patientId=7&visitId=9&prescribingDoctorPartyId=5'), { params: Promise.resolve({ key }) });
beforeEach(() => { vi.clearAllMocks(); mocks.readSessionPayload.mockResolvedValue({ userId: 3, username: 'synthetic', role: 'doctor', credentialVersion: 'synthetic-signed' }); mocks.recover.mockResolvedValue(new Response(JSON.stringify({ state: 'unknown' }), { status: 202 })); });
it('uses signature-only admission then the transactional recovery authority path, never schema-initializing auth', async () => {
 const response = await read(); expect(response.status).toBe(202); expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(mocks.requireSession).not.toHaveBeenCalled();
 expect(mocks.recover).toHaveBeenCalledWith(expect.objectContaining({ credentialVersion: 'synthetic-signed' }), key, { patientId: 7, visitId: 9, prescribingDoctorPartyId: 5 });
});
it.each([null, { userId: 3 }])('rejects missing signed credential without querying recovery', async payload => { mocks.readSessionPayload.mockResolvedValue(payload); expect((await read()).status).toBe(401); expect(mocks.recover).not.toHaveBeenCalled(); });

it('denies reception before parsing scope without schema-initializing auth or receipt lookup', async () => {
 mocks.readSessionPayload.mockResolvedValue({ userId: 4, role: 'reception', credentialVersion: 'signed' });
 const response = await GET(new Request('http://localhost/api/prescriptions/commands/invalid'), { params: Promise.resolve({ key: 'invalid' }) });
 expect(response.status).toBe(403); expect(mocks.recover).not.toHaveBeenCalled(); expect(mocks.requireSession).not.toHaveBeenCalled();
});
