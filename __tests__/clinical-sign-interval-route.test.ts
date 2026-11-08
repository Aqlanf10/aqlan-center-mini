import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ requireSession: vi.fn(), canAccessPatient: vi.fn(), getClinicalVisit: vi.fn(), signAuthorizedClinicalVisit: vi.fn(), recordAudit: vi.fn(), saveClinicalNotes: vi.fn(), setVisitProcedures: vi.fn() }));
vi.mock('@/lib/session', () => ({ requireSession: mock.requireSession }));
vi.mock('@/lib/patient-access', () => ({ canAccessPatient: mock.canAccessPatient }));
vi.mock('@/lib/db', () => ({ ...mock, getSettings: vi.fn(), addVisitAddendum: vi.fn(), CLINIC_TIME_ZONE: 'Asia/Aden', ClinicalPlanConflict: class extends Error {}, ProcedurePriceRejected: class extends Error {}, InventoryShortage: class extends Error {} }));
import { POST } from '../app/api/visits/[id]/clinical/route';
import { isClinicalSignResult } from '../lib/clinical-sign-result';
const draft = { caseId: 41, upperWire: '', lowerWire: '', elastics: 'none', elasticNote: '', done: 'Synthetic current work' };
const visit = { id: 201, patientId: 101, doctorId: 7, status: 'open', procedures: [] };
const post = (orthoSession: unknown) => POST(new Request('https://synthetic.invalid/api/visits/201/clinical', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sign', orthoSession }) }), { params: Promise.resolve({ id: '201' }) });
beforeEach(() => {
  vi.resetAllMocks(); mock.requireSession.mockResolvedValue({ userId: 7, username: 'synthetic-doctor', role: 'doctor', partyId: 7 });
  mock.canAccessPatient.mockResolvedValue(true); mock.getClinicalVisit.mockResolvedValue(visit);
  // Signer/transactions are mocked. This suite proves HTTP admission and DTO compatibility, not persistence or invoice counts.
  mock.signAuthorizedClinicalVisit.mockResolvedValue({ reason: null, visit: { ...visit, status: 'signed', invoiceId: null }, invoiceId: null, invoiceCurrency: null, duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null, labOrdersCreated: 0, materialsDeducted: 0 });
});
describe('clinical sign interval HTTP admission and client receipt', () => {
  it.each([1.5, -1, 0, 53, true, false, [], [4], {}, '', 'bad', 'Infinity', '1.0', '1e0', '+1', '1.0000000000000001', '52.000000000000001'])('refuses explicit invalid interval %j before signer or clinical writes', async nextWeeks => {
    const response = await post({ ...draft, nextWeeks }); expect(response.status).toBe(400);
    expect(isClinicalSignResult(await response.json(), 201, 101)).toBe(false);
    expect(mock.signAuthorizedClinicalVisit).not.toHaveBeenCalled(); expect(mock.recordAudit).not.toHaveBeenCalled();
    expect(mock.saveClinicalNotes).not.toHaveBeenCalled(); expect(mock.setVisitProcedures).not.toHaveBeenCalled();
  });
  it.each([undefined, null])('preserves omitted/null interval %j default four', async nextWeeks => {
    const response = await post({ ...draft, nextWeeks }); expect(response.status).toBe(200);
    expect(mock.signAuthorizedClinicalVisit.mock.calls[0][0].orthoSession.nextWeeks).toBe(4);
    expect(isClinicalSignResult(await response.json(), 201, 101)).toBe(true);
  });
  it.each([1, 4, 52])('passes valid integer %j unchanged to exact visit and patient scope', async nextWeeks => {
    const response = await post({ ...draft, nextWeeks }); expect(response.status).toBe(200);
    expect(mock.signAuthorizedClinicalVisit).toHaveBeenCalledWith(expect.objectContaining({ visitId: 201, orthoSession: expect.objectContaining({ caseId: 41, nextWeeks }), outsideContractDecision: null }), expect.objectContaining({ patientId: 101, session: expect.objectContaining({ userId: 7 }) }));
    expect(isClinicalSignResult(await response.json(), 201, 101)).toBe(true);
  });
  it.each(['1', '01', ' 4 ', '52'])('preserves exact digit-string compatibility %j', async nextWeeks => {
    const response = await post({ ...draft, nextWeeks }); expect(response.status).toBe(200);
    expect(mock.signAuthorizedClinicalVisit.mock.calls[0][0].orthoSession.nextWeeks).toBe(Number(nextWeeks));
    expect(isClinicalSignResult(await response.json(), 201, 101)).toBe(true);
  });
  it.each([undefined, null])('retains ordinary signing with no staged session %j', async session => {
    expect((await post(session)).status).toBe(200); expect(mock.signAuthorizedClinicalVisit.mock.calls[0][0].orthoSession).toBeNull();
  });
  it('preserves valid already-signed retry conflict rather than manufacturing a replay receipt', async () => {
    mock.getClinicalVisit.mockResolvedValue({ ...visit, status: 'signed' }); mock.signAuthorizedClinicalVisit.mockResolvedValue({ reason: 'already_signed' });
    const response = await post({ ...draft, nextWeeks: 4 }); expect(response.status).toBe(409);
    expect(mock.signAuthorizedClinicalVisit).toHaveBeenCalledOnce(); expect(isClinicalSignResult(await response.json(), 201, 101)).toBe(false);
  });
  it('rejects invalid already-signed request before calling signer', async () => {
    mock.getClinicalVisit.mockResolvedValue({ ...visit, status: 'signed' });
    const response = await post({ ...draft, nextWeeks: 1.5 }); expect(response.status).toBe(400);
    expect(mock.signAuthorizedClinicalVisit).not.toHaveBeenCalled(); expect(isClinicalSignResult(await response.json(), 201, 101)).toBe(false);
  });
  it('keeps current patient authority ahead of signing', async () => {
    mock.canAccessPatient.mockResolvedValue(false); expect((await post({ ...draft, nextWeeks: 4 })).status).toBe(403); expect(mock.signAuthorizedClinicalVisit).not.toHaveBeenCalled();
  });
});
