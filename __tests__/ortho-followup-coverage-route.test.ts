import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({session:vi.fn(),read:vi.fn(),append:vi.fn()}));
vi.mock('../lib/session',()=>({requireSession:mocks.session}));
vi.mock('../lib/ortho-followup-coverage-db',async original=>{
  const actual=await original<typeof import('../lib/ortho-followup-coverage-db')>();
  return {...actual,readFollowupCoverage:mocks.read,appendFollowupCoverage:mocks.append};
});
import {GET,POST} from '../app/api/ortho/[id]/followup-coverage/route';
import {FollowupCoverageError} from '../lib/ortho-followup-coverage-db';
const ctx={params:Promise.resolve({id:'2'})};
const req=(method='GET',body?:unknown)=>new Request('http://localhost/api/ortho/2/followup-coverage?patientId=1',{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue({userId:7,username:'synthetic-admin',role:'admin'});mocks.read.mockResolvedValue({patientId:1,orthoCaseId:2});mocks.append.mockResolvedValue({ok:true,replayed:false,revision:{id:'3'}});});
describe('actual followup coverage HTTP handler boundary (synthetic adapters)',()=>{
 it('refuses unauthenticated and ordinary doctor/reception before exposing case sources',async()=>{
  mocks.session.mockResolvedValue(null);expect((await GET(req(),ctx)).status).toBe(401);
  for(const role of ['doctor','reception','accountant']){mocks.session.mockResolvedValue({username:'synthetic',role});expect((await GET(req(),ctx)).status).toBe(403);expect((await POST(req('POST',{}),ctx)).status).toBe(403);}
  expect(mocks.read).not.toHaveBeenCalled();expect(mocks.append).not.toHaveBeenCalled();
 });
 it('passes the exact admitted actor and URL owner, not body-supplied authority',async()=>{
  const actor={userId:7,username:'synthetic-admin',role:'admin'};mocks.session.mockResolvedValue(actor);
  expect((await POST(req('POST',{actor:'forged',patientId:9}),ctx)).status).toBe(201);
  expect(mocks.append.mock.calls[0][0].session).toBe(actor);expect(mocks.append.mock.calls[0][0]).toMatchObject({patientId:1,orthoCaseId:2,command:{actor:'forged',patientId:9}});
 });
 it('returns stale/source and schema-disabled refusals without claiming a save',async()=>{
  mocks.append.mockRejectedValue(new FollowupCoverageError(409,'source_changed','Synthetic stale source'));expect((await POST(req('POST',{}),ctx)).status).toBe(409);
  mocks.append.mockRejectedValue(new FollowupCoverageError(503,'coverage_not_ready','Synthetic schema not ready'));expect((await POST(req('POST',{}),ctx)).status).toBe(503);
  mocks.append.mockRejectedValue(new Error('Synthetic unknown result'));const r=await POST(req('POST',{}),ctx);expect(r.status).toBe(500);expect((await r.json()).code).toBe('coverage_result_unknown');
 });
});
