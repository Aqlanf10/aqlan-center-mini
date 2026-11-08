import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../app/api/ortho/[id]/facial-analysis/recovery/route';
import { POST as SAVE } from '../app/api/ortho/[id]/facial-analysis/route';
const state = vi.hoisted(() => ({ session: { username: 'synthetic', role: 'doctor' } as {username: string; role: string} | null, access: true, get: vi.fn(), transition: vi.fn(), save: vi.fn() }));
vi.mock('../lib/session', () => ({ requireSession: async () => state.session }));
vi.mock('../lib/patient-access', () => ({ canAccessPatient: async () => state.access }));
vi.mock('../lib/ortho-facial-submission-store', () => ({ getFacialSubmissionRecovery: state.get, transitionFacialSubmission: state.transition, saveJournaledFacial: state.save }));
vi.mock('../lib/ortho-facial-store', () => ({getFacialAnalysis: vi.fn()}));
const context = { params: Promise.resolve({ id: '2' }) };
const body = { patientId: 1, clinicalCaseId: 3, actorId: 4, commandId: 'synthetic-command-1234', requestFingerprint: 'a'.repeat(64), action: 'cancel' };
const request = (value: unknown = body, suffix = '') => new Request(`http://localhost/api/ortho/2/facial-analysis/recovery${suffix}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(value)});
beforeEach(() => { state.session = {username: 'synthetic', role: 'doctor'}; state.access = true; state.get.mockReset().mockResolvedValue({ok: true, recovery: null}); state.save.mockReset().mockResolvedValue({ok: true, replayed: true}); state.transition.mockReset().mockResolvedValue({ok: true, state: 'cancelled'}); });
describe('facial durable recovery route admission', () => {
  it('does not expose recovery to a signed-out caller', async () => { state.session = null; const result = await GET(new Request('http://localhost/?patientId=1'), context); expect(result.status).toBe(401); expect(state.get).not.toHaveBeenCalled(); expect(result.headers.get('cache-control')).toContain('no-store'); });
  it('does not mutate on a signed-out caller', async () => { state.session = null; expect((await POST(request(), context)).status).toBe(401); expect(state.transition).not.toHaveBeenCalled(); });
  it('rejects reception writes before touching the journal', async () => { state.session!.role = 'reception'; expect((await POST(request(), context)).status).toBe(403); expect(state.transition).not.toHaveBeenCalled(); });
  it('rejects a patient access denial for reads and writes', async () => { state.access = false; expect((await GET(new Request('http://localhost/?patientId=1'), context)).status).toBe(403); expect((await POST(request(), context)).status).toBe(403); expect(state.get).not.toHaveBeenCalled(); expect(state.transition).not.toHaveBeenCalled(); });
  it.each(['?patientId=1&patientId=2', '?patientId=1&documentId=4', '?patientId=0', '?patientId=1e0'])('rejects ambiguous recovery query %s', async suffix => { expect((await GET(new Request(`http://localhost/${suffix}`), context)).status).toBe(400); expect(state.get).not.toHaveBeenCalled(); });
  it.each([{...body, session: {role: 'admin'}}, {...body, orthoCaseId: 8}, {...body, patientId: '1'}, {...body, commandId: {}}, []])('rejects injected or malformed transition body %#', async value => { expect((await POST(request(value), context)).status).toBe(400); expect(state.transition).not.toHaveBeenCalled(); });
  it('rejects query parameters on a transition', async () => { expect((await POST(request(body, '?patientId=2'), context)).status).toBe(400); expect(state.transition).not.toHaveBeenCalled(); });
  it('passes verified route ownership and uses private no-store responses', async () => { const result = await POST(request(), context); expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toContain('no-store'); expect(state.transition).toHaveBeenCalledWith(expect.objectContaining({...body, orthoCaseId: 2, session: state.session})); });
  it('uses the path case rather than any caller-selected alternate case', async () => { const result = await GET(new Request('http://localhost/?patientId=1'), context); expect(result.status).toBe(200); expect(state.get).toHaveBeenCalledWith(expect.objectContaining({patientId:1, orthoCaseId:2, session:state.session})); });
});

describe('facial journaled save route binding', () => {
 it.each([{patientId:1,command:{}}, {patientId:1,actorId:4,clinicalCaseId:3,command:{},session:{role:'admin'}}, {patientId:1,actorId:'4',clinicalCaseId:3,command:{}}])('rejects legacy and malformed command scope %#', async value => {expect((await SAVE(request(value),context)).status).toBe(400);expect(state.save).not.toHaveBeenCalled();});
 it('uses journaled writer with authenticated route identity', async () => {const value={patientId:1,actorId:4,clinicalCaseId:3,command:{synthetic:true}};expect((await SAVE(request(value),context)).status).toBe(200);expect(state.save).toHaveBeenCalledWith(expect.objectContaining({...value,orthoCaseId:2,session:state.session}));});
 it('rejects patient denial before reservation', async()=>{state.access=false;expect((await SAVE(request({patientId:1,actorId:4,clinicalCaseId:3,command:{}}),context)).status).toBe(403);expect(state.save).not.toHaveBeenCalled();});
});
