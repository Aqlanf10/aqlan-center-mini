import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../app/api/ortho/[id]/space-ledger/route';

const state = vi.hoisted(() => ({
  session: { username: 'synthetic', role: 'doctor' } as { username: string; role: string } | null,
  access: vi.fn(), get: vi.fn(), append: vi.fn(),
}));
vi.mock('../lib/session', () => ({ requireSession: async () => state.session }));
vi.mock('../lib/patient-access', () => ({ canAccessPatient: state.access }));
vi.mock('../lib/ortho-space-store', () => ({ getOrthoSpaceLedger: state.get }));
vi.mock('../lib/ortho-space-submission-store', () => ({ saveJournaledSpace: state.append }));
const context = { params: Promise.resolve({ id: '2' }) };
const command = { schemaVersion:1,clientRequestId:'synthetic_space_route',expectedHeadId:null,reason:'Synthetic plan',content:{kind:'plan',arch:'upper',strategyRevisionId:1,baseline:{kind:'assessment_analysis',id:1,member:'synthetic',version:`sha256:${'a'.repeat(64)}`},gains:[],uses:[],contacts:[],rationale:'Synthetic plan',alternatives:'Synthetic alternatives'} };
const body = { patientId: 1, clinicalCaseId: 3, actorId: 7, command };
const read = (query = '?patientId=1') => new Request(`http://localhost/api/ortho/2/space-ledger${query}`);
const write = (value: unknown = body, query = '') => new Request(`http://localhost/api/ortho/2/space-ledger${query}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
});
function privateResponse(response: Response) { expect(response.headers.get('cache-control')).toBe('private, no-store'); }
beforeEach(() => {
  state.session = { username: 'synthetic', role: 'doctor' };
  state.access.mockReset().mockResolvedValue(true);
  state.get.mockReset().mockResolvedValue({ ok: true, candidates: [], reviews: [], spaces: [] });
  state.append.mockReset().mockResolvedValue({ ok: true, replayed: false });
});
describe('space-source route admission and ownership', () => {
  it('authenticates before malformed body parsing or patient access', async () => {
    state.session = null;
    const request = new Request('http://localhost/api/ortho/2/space-ledger', { method: 'POST', body: '{' });
    const response = await POST(request, context);
    expect(response.status).toBe(401); privateResponse(response);
    expect(state.access).not.toHaveBeenCalled(); expect(state.append).not.toHaveBeenCalled();
  });
  it('refuses signed-out reads without querying clinical content', async () => {
    state.session = null; const response = await GET(read(), context);
    expect(response.status).toBe(401); privateResponse(response); expect(state.get).not.toHaveBeenCalled();
  });
  it.each(['reception', 'nurse', 'accountant'])('refuses %s writes', async role => {
    state.session!.role = role; expect((await POST(write(), context)).status).toBe(403);
    expect(state.append).not.toHaveBeenCalled(); expect(state.access).not.toHaveBeenCalled();
  });
  it('refuses unsupported read roles', async () => {
    state.session!.role = 'accountant'; expect((await GET(read(), context)).status).toBe(403); expect(state.get).not.toHaveBeenCalled();
  });
  it('passes reception reads to the separately authorizing store', async () => {
    state.session!.role = 'reception'; expect((await GET(read(), context)).status).toBe(200); expect(state.get).toHaveBeenCalledOnce();
  });
  it.each(['', '?patientId=0', '?patientId=-1', '?patientId=1e0', '?patientId=01', '?patientId=1&patientId=2', '?patientId=1&actorId=99'])('rejects ambiguous read scope %s', async query => {
    const response = await GET(read(query), context); expect(response.status).toBe(400); privateResponse(response); expect(state.get).not.toHaveBeenCalled();
  });
  it.each([[], null, { ...body, session: { role: 'admin' } }, { ...body, orthoCaseId: 99 }, { ...body, patientId: '1' }, { patientId: 1 }, {patientId:1,command}, {...body,actorId:"7"}, {...body,clinicalCaseId:0}])('rejects injected or malformed write envelope %#', async value => {
    expect((await POST(write(value), context)).status).toBe(400); expect(state.append).not.toHaveBeenCalled();
  });
  it('rejects write query scope rather than mixing it with the body', async () => {
    expect((await POST(write(body, '?patientId=9'), context)).status).toBe(400); expect(state.append).not.toHaveBeenCalled();
  });
  it('refuses denied patient scope on both read and write', async () => {
    state.access.mockResolvedValue(false);
    for (const response of [await GET(read(), context), await POST(write(), context)]) { expect(response.status).toBe(403); privateResponse(response); }
    expect(state.get).not.toHaveBeenCalled(); expect(state.append).not.toHaveBeenCalled();
  });
  it('fails closed on patient-access service error', async () => {
    state.access.mockRejectedValue(new Error('synthetic access error'));
    expect((await GET(read(), context)).status).toBe(403); expect((await POST(write(), context)).status).toBe(403);
    expect(state.get).not.toHaveBeenCalled(); expect(state.append).not.toHaveBeenCalled();
  });
  it('binds the store request to the path and authenticated session', async () => {
    const response = await POST(write(), context); expect(response.status).toBe(201); privateResponse(response);
    expect(state.append).toHaveBeenCalledWith({ ok: true, session: state.session, patientId: 1, orthoCaseId: 2, clinicalCaseId: 3, actorId: 7, command });
    const response2 = await GET(read(), context); expect(response2.status).toBe(200); privateResponse(response2);
    expect(state.get).toHaveBeenCalledWith({ ok: true, session: state.session, patientId: 1, orthoCaseId: 2 });
  });
  it('distinguishes confirmed duplicate replay from a new write', async () => {
    state.append.mockResolvedValue({ ok: true, replayed: true }); const response = await POST(write(), context);
    expect(response.status).toBe(200); privateResponse(response);
  });
  it('preserves source-conflict refusal and does not turn it into success', async () => {
    state.append.mockResolvedValue({ ok: false, status: 409, code: 'space_source_changed' });
    const response = await POST(write(), context); expect(response.status).toBe(409); privateResponse(response);
    expect(await response.json()).toMatchObject({ ok: false, code: 'space_source_changed' });
  });
  it('reports an exception as an uncertain write without disclosing internal details', async () => {
    state.append.mockRejectedValue(new Error('synthetic secret')); const response = await POST(write(), context);
    expect(response.status).toBe(500); privateResponse(response);
    const value = await response.text(); expect(value).toContain('write_unconfirmed'); expect(value).not.toContain('synthetic secret');
  });
  it('bounds clinical command bodies before passing them to the store', async () => { const response=await POST(write({...body,command:{...command,reason:'x'.repeat(300000)}}),context); expect(response.status).toBe(413); privateResponse(response); expect(state.append).not.toHaveBeenCalled(); });
  it.each([{synthetic:true},{...command,extra:true},{...command,schemaVersion:2},{...command,content:{kind:'ipr'}}])('refuses malformed or unwitnessed command %#', async invalid => { expect((await POST(write({...body,command:invalid}),context)).status).toBe(400);expect(state.append).not.toHaveBeenCalled(); });
  it('does not turn a failed read into an empty clinical list', async () => {
    state.get.mockRejectedValue(new Error('synthetic secret')); const response = await GET(read(), context);
    expect(response.status).toBe(500); privateResponse(response);
    expect(await response.json()).toMatchObject({ ok: false, code: 'read_failed' });
  });
});
