import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({session:vi.fn(),status:vi.fn()}));
vi.mock('../lib/session',()=>({requireSession:mocks.session}));
vi.mock('../lib/ortho-followup-coverage-db',async original=>({...await original<typeof import('../lib/ortho-followup-coverage-db')>(),readFollowupCoverageCommandStatus:mocks.status}));
import {PUT} from '../app/api/ortho/[id]/followup-coverage/route';
import {FollowupCoverageError} from '../lib/ortho-followup-coverage-db';
const context={params:Promise.resolve({id:'2'})};
const request=(body:unknown)=>new Request('http://localhost/api/ortho/2/followup-coverage?patientId=1',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue({userId:7,username:'synthetic',role:'admin'});});
describe('exact coverage status route',()=>{
 it('authenticates before recovery and passes original scope with exact command body',async()=>{
  mocks.session.mockResolvedValue(null);expect((await PUT(request({}),context)).status).toBe(401);expect(mocks.status).not.toHaveBeenCalled();
  mocks.session.mockResolvedValue({role:'doctor'});expect((await PUT(request({}),context)).status).toBe(403);
  mocks.session.mockResolvedValue({userId:7,username:'synthetic',role:'admin'});mocks.status.mockResolvedValue({state:'unresolved'});
  const response=await PUT(request({commandId:'exact'}),context);
  expect(response.status).toBe(200);expect(await response.json()).toEqual({state:'unresolved'});
  expect(mocks.status).toHaveBeenCalledWith(expect.objectContaining({patientId:1,orthoCaseId:2,command:{commandId:'exact'}}));
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
 });
 it('does not convert unknown or command conflict into terminal refusal',async()=>{
  mocks.status.mockRejectedValue(new Error('transport'));const unknown=await PUT(request({}),context);expect(unknown.status).toBe(500);expect(await unknown.json()).not.toHaveProperty('rejection');
  mocks.status.mockRejectedValue(new FollowupCoverageError(409,'command_conflict','different body'));const conflict=await PUT(request({}),context);expect(conflict.status).toBe(409);expect(await conflict.json()).not.toHaveProperty('rejection');
 });
 it('returns only stored status receipt unchanged',async()=>{
  const receipt={state:'rejected',rejection:{commandId:'exact',actor:'synthetic',terminal:true,patientId:1,orthoCaseId:2,command:{exact:'body'}}};
  mocks.status.mockResolvedValue(receipt);const response=await PUT(request({}),context);expect(response.status).toBe(200);expect(await response.json()).toEqual(receipt);
 });
});
