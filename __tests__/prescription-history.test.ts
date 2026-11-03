import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), party: vi.fn(), access: vi.fn(), patient: vi.fn(), visit: vi.fn(), prints: vi.fn(), history: vi.fn() }));
vi.mock('@/lib/session', () => ({ requireSession: m.session }));
vi.mock('@/lib/patient-access', () => ({ canAccessPatient: m.access }));
vi.mock('@/lib/db', () => ({ findUserByUsername: m.user, getParty: m.party, getPatient: m.patient, getClinicalVisit: m.visit, listSavedPrescriptionPrints: m.prints, listSavedPrescriptionHistory: m.history }));
import { GET } from '../app/api/patients/[id]/prescriptions/saved/route';
const session = { userId: 3, username: 'synthetic-doctor', role: 'doctor' };
const history = { prescriptions: [{ id: 81, visitId: 9, status: 'void', items: [{ name: 'SyntheticRx', instructions: 'تعليمات محفوظة' }], prescribingDoctorName: null }], nextCursor: null };
const read = (query = '') => GET(new Request(`http://localhost/api/patients/7/prescriptions/saved${query}`), { params: Promise.resolve({ id: '7' }) });
beforeEach(() => {
 vi.clearAllMocks(); m.session.mockResolvedValue(session); m.user.mockResolvedValue({ ...session, id: 3, isActive: true, partyId: 5 });
 m.party.mockResolvedValue({ id: 5, kind: 'doctor', isActive: true, name: 'Synthetic Doctor' }); m.access.mockResolvedValue(true);
 m.patient.mockResolvedValue({ id: 7 }); m.visit.mockResolvedValue({ id: 9, patientId: 7, signedAt: '2026-10-31T10:00:00Z' });
 m.prints.mockResolvedValue({ prescriptions: [], nextCursor: null }); m.history.mockResolvedValue(history);
});
it('returns issued and void immutable clinical history to an active linked clinician after completed visit', async () => {
 const response = await read('?visitId=9'); expect(response.status).toBe(200);
 expect(await response.json()).toEqual({ ...history, mode: 'clinical-history' });
 expect(m.history).toHaveBeenCalledWith(7, 9, null); expect(m.prints).not.toHaveBeenCalled();
});
it('does not broaden reception print permission into full clinical history', async () => {
 m.session.mockResolvedValue({ ...session, role: 'reception' }); m.user.mockResolvedValue({ ...session, id: 3, role: 'reception', isActive: true, partyId: 5, permissions: { canPrintSavedPrescriptions: true } });
 expect(await (await read()).json()).toEqual({ prescriptions: [], nextCursor: null }); expect(m.history).not.toHaveBeenCalled();
});
it.each([null, { id: 5, kind: 'doctor', isActive: false }, { id: 5, kind: 'lab', isActive: true }])('does not grant clinical history for invalid linked doctor %j', async party => {
 m.party.mockResolvedValue(party); expect(await (await read()).json()).toEqual({ prescriptions: [], nextCursor: null }); expect(m.history).not.toHaveBeenCalled();
});
it('denies revoked patient scope before either history query', async () => { m.access.mockResolvedValue(false); expect((await read()).status).toBe(403); expect(m.history).not.toHaveBeenCalled(); expect(m.prints).not.toHaveBeenCalled(); });
it('rejects another patient visit without querying history', async () => { m.visit.mockResolvedValue({ id: 9, patientId: 8 }); expect((await read('?visitId=9')).status).toBe(404); expect(m.history).not.toHaveBeenCalled(); });
