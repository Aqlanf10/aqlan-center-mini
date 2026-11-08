import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ requireSession: vi.fn(), canAccessPatient: vi.fn(), getClinicalVisit: vi.fn(), signAuthorizedClinicalVisit: vi.fn(), recordAudit: vi.fn(), saveClinicalNotes: vi.fn(), setVisitProcedures: vi.fn() }));
vi.mock('@/lib/session', () => ({ requireSession: mock.requireSession }));
vi.mock('@/lib/patient-access', () => ({ canAccessPatient: mock.canAccessPatient }));
vi.mock('@/lib/db', () => ({ ...mock, getSettings: vi.fn(), addVisitAddendum: vi.fn(), CLINIC_TIME_ZONE: 'Asia/Aden', ClinicalPlanConflict: class extends Error {}, ProcedurePriceRejected: class extends Error {}, InventoryShortage: class extends Error {} }));
import { POST } from '../app/api/visits/[id]/clinical/route';
import { isClinicalSignResult } from '../lib/clinical-sign-result';
const draft = { caseId: 41, upperWire: '', lowerWire: '', elasticNote: '', done: 'Synthetic current work', nextWeeks: 4 };
const visit = { id: 201, patientId: 101, doctorId: 7, status: 'open', procedures: [] };
const post = (orthoSession: unknown) => POST(new Request('https://synthetic.invalid/api/visits/201/clinical', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sign', orthoSession }) }), { params: Promise.resolve({ id: '201' }) });
beforeEach(() => {
  vi.resetAllMocks(); mock.requireSession.mockResolvedValue({ userId: 7, username: 'synthetic-doctor', role: 'doctor', partyId: 7 });
  mock.canAccessPatient.mockResolvedValue(true); mock.getClinicalVisit.mockResolvedValue(visit);
  // Signer/transactions are mocked. This suite proves HTTP admission and DTO compatibility, not persistence or invoice counts.
  mock.signAuthorizedClinicalVisit.mockResolvedValue({ reason: null, visit: { ...visit, status: 'signed', invoiceId: null }, invoiceId: null, invoiceCurrency: null, duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null, labOrdersCreated: 0, materialsDeducted: 0 });
});
describe('clinical sign enum HTTP authoring admission', () => {
  for (const field of ['phase', 'elastics'] as const) {
    it.each(['', ' ', 'unknown', 'constructor', 'toString', '__proto__', 'hasOwnProperty', ' none ', ' aligning ', true, false, 0, [], ['none'], {}])(`refuses explicit malformed ${field} %j before signer`, async value => {
      const response = await post({ ...draft, [field]: value }); expect(response.status).toBe(400);
      expect(isClinicalSignResult(await response.json(), 201, 101)).toBe(false);
      expect(mock.signAuthorizedClinicalVisit).not.toHaveBeenCalled(); expect(mock.recordAudit).not.toHaveBeenCalled();
      expect(mock.saveClinicalNotes).not.toHaveBeenCalled(); expect(mock.setVisitProcedures).not.toHaveBeenCalled();
    });
  }
  it.each([undefined, null])('preserves absent/null enum compatibility %j', async value => {
    const response = await post({ ...draft, phase: value, elastics: value }); expect(response.status).toBe(200);
    expect(mock.signAuthorizedClinicalVisit.mock.calls[0][0].orthoSession).toMatchObject({ phase: null, elastics: 'none' });
    expect(isClinicalSignResult(await response.json(), 201, 101)).toBe(true);
  });
  it.each(['assessment', 'aligning', 'working', 'finishing', 'retention'])('passes exact known phase %s to unchanged transactional validation', async phase => {
    // Acceptance here is parser/route propagation only. The real writer may reject
    // assessment as a new-session phase; mocked success does not widen that rule.
    const response = await post({ ...draft, phase, elastics: 'none' }); expect(response.status).toBe(200);
    expect(mock.signAuthorizedClinicalVisit).toHaveBeenCalledWith(expect.objectContaining({ visitId: 201, orthoSession: expect.objectContaining({ caseId: 41, phase }) }), expect.objectContaining({ patientId: 101 }));
  });
  it.each(['none', 'class_ii', 'class_iii', 'vertical', 'triangle', 'cross'])('passes exact known elastic class %s unchanged', async elastics => {
    const response = await post({ ...draft, phase: 'aligning', elastics }); expect(response.status).toBe(200);
    expect(mock.signAuthorizedClinicalVisit.mock.calls[0][0].orthoSession.elastics).toBe(elastics);
    expect(isClinicalSignResult(await response.json(), 201, 101)).toBe(true);
  });
  it.each([undefined, null])('retains no staged session %j', async session => {
    expect((await post(session)).status).toBe(200); expect(mock.signAuthorizedClinicalVisit.mock.calls[0][0].orthoSession).toBeNull();
  });
  it('retains current patient authority before enum admission', async () => {
    mock.canAccessPatient.mockResolvedValue(false); expect((await post({ ...draft, elastics: 'none' })).status).toBe(403); expect(mock.signAuthorizedClinicalVisit).not.toHaveBeenCalled();
  });
});
