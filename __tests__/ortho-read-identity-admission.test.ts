import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/session', () => ({ requireSession: vi.fn() }));
vi.mock('@/lib/patient-access', () => ({ canAccessPatient: vi.fn() }));
vi.mock('@/lib/db', () => ({ CLINIC_TIME_ZONE: 'Asia/Aden', listPatientOrthoCases: vi.fn(), listOrthoCases: vi.fn(), recordAudit: vi.fn() }));
import { GET } from '@/app/api/ortho/route';
import { requireSession } from '@/lib/session';
import { canAccessPatient } from '@/lib/patient-access';
import { listPatientOrthoCases, listOrthoCases } from '@/lib/db';
const send = (query = '') => GET(new Request(`https://synthetic.invalid/api/ortho${query}`));
beforeEach(() => {
 vi.resetAllMocks();
 vi.mocked(requireSession).mockResolvedValue({ username: 'synthetic', role: 'admin' } as never);
 vi.mocked(canAccessPatient).mockResolvedValue(true);
 vi.mocked(listPatientOrthoCases).mockResolvedValue([]);
 vi.mocked(listOrthoCases).mockResolvedValue([]);
});
it.each(['2147483648', '9007199254740991', '9007199254740992', '0', '-1', '', '01', '1.0', '1e1', '+1', ' 1', '1 ', 'NaN', 'Infinity'])('rejects invalid filter %j before any downstream lookup', async value => {
 expect((await send(`?patientId=${encodeURIComponent(value)}`)).status).toBe(400);
 expect(canAccessPatient).not.toHaveBeenCalled();
 expect(listPatientOrthoCases).not.toHaveBeenCalled();
 expect(listOrthoCases).not.toHaveBeenCalled();
});
it.each(['?patientId=1&patientId=1', '?patientId=1&patientId=2'])('rejects repeated filters %s', async query => {
 expect((await send(query)).status).toBe(400);
 expect(canAccessPatient).not.toHaveBeenCalled();
 expect(listPatientOrthoCases).not.toHaveBeenCalled();
 expect(listOrthoCases).not.toHaveBeenCalled();
});
it.each([1, 2147483647])('admits canonical int4 boundary %i', async id => {
 expect((await send(`?patientId=${id}`)).status).toBe(200);
 expect(canAccessPatient).toHaveBeenCalledWith(expect.anything(), id);
 expect(listPatientOrthoCases).toHaveBeenCalledWith(id, expect.any(String));
 expect(listOrthoCases).not.toHaveBeenCalled();
});
it('preserves patient denial before reader', async () => {
 vi.mocked(canAccessPatient).mockResolvedValue(false);
 expect((await send('?patientId=1')).status).toBe(403);
 expect(listPatientOrthoCases).not.toHaveBeenCalled();
});
it('preserves unfiltered visibility and independent photo permission', async () => {
 const rows = [1, 2, 3].map(patientId => ({ id: patientId, patientId, note: 'clinical', adjustments: [{ id: 9, photos: [{ id: 8 }] }] }));
 vi.mocked(listOrthoCases).mockResolvedValue(rows as never);
 vi.mocked(canAccessPatient).mockImplementation(async (_session, id, permission) => id !== 2 && (!permission || id === 3));
 const response = await send();
 expect(response.status).toBe(200);
 expect((await response.json()).cases).toEqual([
  { ...rows[0], photosVisible: false, adjustments: [{ id: 9, photos: [] }] },
  { ...rows[2], photosVisible: true },
 ]);
 expect(listPatientOrthoCases).not.toHaveBeenCalled();
});
it('requires a session even for an invalid filter', async () => {
 vi.mocked(requireSession).mockResolvedValue(null);
 expect((await send('?patientId=2147483648')).status).toBe(401);
 expect(canAccessPatient).not.toHaveBeenCalled();
});
