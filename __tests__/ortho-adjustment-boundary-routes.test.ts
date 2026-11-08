import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({session:vi.fn(),access:vi.fn(),query:vi.fn(),decide:vi.fn(),remove:vi.fn(),visit:vi.fn()}));
vi.mock('@/lib/session',()=>({requireSession:m.session}));
vi.mock('@/lib/patient-access',()=>({canAccessPatient:m.access}));
vi.mock('@/lib/operational-access',()=>({authorizeVisit:m.visit,authorizeVisitLink:vi.fn()}));
vi.mock('@/lib/db',()=>({getPool:()=>({query:m.query}),decideOrthoAdjustmentBilling:m.decide,deleteVisit:m.remove,
 callVisitAgain:vi.fn(),callVisitGated:vi.fn(),clearVisit:vi.fn(),deferVisitPayment:vi.fn(),finishVisit:vi.fn(),linkVisitToPatient:vi.fn(),openVisitPatientFile:vi.fn(),recordAudit:vi.fn(),returnVisitToWaiting:vi.fn(),seatVisitGated:vi.fn()}));
import {POST} from '../app/api/ortho/adjustments/[id]/billing-decision/route';
import {DELETE} from '../app/api/visits/[id]/route';
const session={userId:7,username:'synthetic-admin',role:'admin',expiresAt:4102444800000};
const context={params:Promise.resolve({id:'41'})};
const request=(method:string,body:unknown)=>new Request('https://synthetic.invalid/api/fixture/41',{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.resetAllMocks();m.session.mockResolvedValue(session);m.access.mockResolvedValue(true);m.query.mockResolvedValue({rows:[{patient_id:101,responsible_doctor_id:11}]});m.decide.mockResolvedValue({ok:true,decision:'no_charge'});m.visit.mockResolvedValue({ok:true,patientId:101});m.remove.mockResolvedValue({ok:true});});
describe('server-bound adjustment decision authority',()=>{
 it('passes admitted identity and server-owned patient, not body authority',async()=>{
  const response=await POST(request('POST',{decision:'no_charge',reason:'Synthetic reason',patientId:999,session:{userId:999},actor:'forged'}),context);
  expect(response.status).toBe(200);
  expect(m.decide).toHaveBeenCalledExactlyOnceWith({adjustmentId:41,decision:'no_charge',reason:'Synthetic reason',invoiceNumber:null,actor:session.username,actorRole:'admin'},{patientId:101,session});
 });
 it.each([401,403,409])('preserves transactional decision refusal %s',async status=>{
  m.decide.mockResolvedValue({ok:false,status,message:'Synthetic refusal'});
  const response=await POST(request('POST',{decision:'no_charge',reason:'Synthetic reason'}),context);
  expect(response.status).toBe(status);expect(await response.json()).toEqual({message:'Synthetic refusal'});
 });
 it.each([['reception','no_charge'],['doctor','billed'],['assistant','no_charge']])('keeps %s excluded from %s decisions',async(role,decision)=>{
  m.session.mockResolvedValue({...session,role});expect((await POST(request('POST',{decision,reason:'Synthetic reason',invoiceNumber:'SYNTHETIC'}),context)).status).toBe(403);expect(m.decide).not.toHaveBeenCalled();
 });
});
describe('server-bound visit deletion authority',()=>{
 it.each([101,null])('preserves admitted patient %s including walk-ins',async patientId=>{
  m.visit.mockResolvedValue({ok:true,patientId});const response=await DELETE(request('DELETE',{reason:'Synthetic duplicate',patientId:999,session:{userId:999},actor:'forged'}),context);
  expect(response.status).toBe(200);expect(m.remove).toHaveBeenCalledExactlyOnceWith(41,{session,patientId,reason:'Synthetic duplicate'});
 });
 it.each([['session_expired',401],['forbidden',403],['scope_changed',409],['protected_reference',409],['signed',409],['invoiced',409],['not_found',404]] as const)('maps %s without claiming deletion',async(reason,status)=>{
  m.remove.mockResolvedValue({ok:false,reason});expect((await DELETE(request('DELETE',{}),context)).status).toBe(status);
 });
 it('requires an admitted admin independently of body role',async()=>{
  m.session.mockResolvedValue({...session,role:'doctor'});expect((await DELETE(request('DELETE',{session:{role:'admin'}}),context)).status).toBe(403);expect(m.remove).not.toHaveBeenCalled();expect(m.visit).not.toHaveBeenCalled();
 });
});
