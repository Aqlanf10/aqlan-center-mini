import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({session:vi.fn(),access:vi.fn(),found:vi.fn(),close:vi.fn(),phase:vi.fn(),retainer:vi.fn()}));
vi.mock('@/lib/session',()=>({requireSession:mock.session}));
vi.mock('@/lib/patient-access',()=>({canAccessPatient:mock.access}));
vi.mock('@/lib/db',()=>({CLINIC_TIME_ZONE:'Asia/Aden',getOrthoCase:mock.found,closeOrthoCase:mock.close,setOrthoPhase:mock.phase,setRetainer:mock.retainer}));
import { OrthoCloseAuthorityError } from '../lib/ortho-close-authority';
import { PATCH } from '../app/api/ortho/[id]/route';
const session={userId:7,username:'synthetic-doctor',role:'doctor',credentialVersion:'synthetic-current',expiresAt:4102444800000};
const patch=(body:unknown)=>PATCH(new Request('https://synthetic.invalid/api/ortho/41',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{params:Promise.resolve({id:'41'})});
beforeEach(()=>{vi.resetAllMocks();mock.session.mockResolvedValue(session);mock.access.mockResolvedValue(true);mock.found.mockResolvedValue({id:41,patientId:101});mock.close.mockResolvedValue({ok:true});});
describe('case closure HTTP trusted authority boundary',()=>{
 it.each(['completed','discontinued'])('passes current admitted authority for %s, ignoring forged body scope and actor',async status=>{
  const response=await patch({status,note:'Synthetic closure note',actor:'forged',patientId:999,session:{userId:999,role:'admin'},request:{patientId:999,session:{userId:999}}});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true});
  expect(mock.close).toHaveBeenCalledExactlyOnceWith({id:41,status,actor:session.username,note:'Synthetic closure note'},{patientId:101,session});
 });
 it('preserves clinical closure refusal as409 without claiming success',async()=>{
  mock.close.mockResolvedValue({ok:false,message:'Synthetic completion guard'});
  const response=await patch({status:'completed'});expect(response.status).toBe(409);expect(await response.json()).toEqual({message:'Synthetic completion guard'});
 });
 it('does not call closure after current patient denial',async()=>{
  mock.access.mockResolvedValue(false);expect((await patch({status:'completed'})).status).toBe(403);expect(mock.close).not.toHaveBeenCalled();
 });
 it('does not call closure without a session',async()=>{
  mock.session.mockResolvedValue(null);expect((await patch({status:'discontinued'})).status).toBe(401);expect(mock.close).not.toHaveBeenCalled();
 });
 it('does not widen unsupported lifecycle statuses',async()=>{
  expect((await patch({status:'active'})).status).toBe(400);expect(mock.close).not.toHaveBeenCalled();
 });
 it.each([400,401,403,409] as const)('preserves transaction authority error status %s and code',async status=>{
  mock.close.mockRejectedValue(new OrthoCloseAuthorityError(status,'synthetic_close_refusal','Synthetic current authority refusal'));
  const response=await patch({status:'completed'});expect(response.status).toBe(status);
  expect(await response.json()).toEqual({message:'Synthetic current authority refusal',code:'synthetic_close_refusal'});
  expect(mock.close.mock.calls[0][1]).toEqual({patientId:101,session});
 });
 it('keeps unexpected close errors generic',async()=>{
  mock.close.mockRejectedValue(new Error('Private backend detail'));
  const response=await patch({status:'discontinued'});expect(response.status).toBe(500);
  expect(JSON.stringify(await response.json())).not.toContain('Private backend detail');
 });

});
