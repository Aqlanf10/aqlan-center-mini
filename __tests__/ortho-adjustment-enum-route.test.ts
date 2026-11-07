// This suite executes server routes in Node, outside Next's server-module resolver.
// Keep the production server-only marker; supply only its server-context test stub.
vi.mock("server-only", () => ({}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({session:vi.fn(),access:vi.fn(),found:vi.fn(),write:vi.fn()}));
vi.mock('@/lib/session',()=>({requireSession:mocks.session}));
vi.mock('@/lib/patient-access',()=>({canAccessPatient:mocks.access}));
vi.mock('@/lib/db',()=>({CLINIC_TIME_ZONE:'Asia/Aden',getOrthoCase:mocks.found,recordAdjustment:mocks.write}));
import { POST } from '../app/api/ortho/[id]/route';
import { adjustmentCommandStorageKey, readAdjustmentCommand, isAdjustmentReceipt, completeAdjustmentCommand, type AdjustmentCommand } from '../lib/ortho-adjustment-command';
const actor={userId:7,username:'synthetic-doctor',role:'doctor',expiresAt:4_102_444_800_000};
const scope={patientId:101,caseId:41,authority:'synthetic-immutable-actor-7'};
const body={doneOn:'2026-10-02',upperWire:'wire',lowerWire:'wire',elastics:'none',elasticNote:'',done:'Synthetic procedure',nextWeeks:4};
const legacyKey='synthetic-legacy-adjustment-001';
const freshKey='synthetic-new-adjustment-001';
let acceptedNewWrites=0;
const storage=()=>{const map=new Map<string,string>();return{getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value);},removeItem:(key:string)=>{map.delete(key);}};};
const call=(key:string,raw:string)=>POST(new Request('https://synthetic.invalid/api/ortho/41',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:raw}),{params:Promise.resolve({id:'41'})});
beforeEach(()=>{
 vi.resetAllMocks();acceptedNewWrites=0;mocks.session.mockResolvedValue(actor);mocks.access.mockResolvedValue(true);mocks.found.mockResolvedValue({id:41,patientId:101});
 // The writer boundary is mocked, not a persistence proof. Real journal matching,
 // invoice counts and locking belong to the separate PostgreSQL regression.
 mocks.write.mockImplementation(async(input:{request:{key:string;newTextAdmissionError?:string|null;newEnumAdmissionError?:string|null}})=>{
  if(input.request.key===legacyKey)return{ok:true,id:501,created:false,replayed:true,visitId:null,attachedToToday:false};
  if(input.request.newEnumAdmissionError)return{ok:false,status:400,code:'invalid_adjustment_enum',message:input.request.newEnumAdmissionError};
  if(input.request.newTextAdmissionError)return{ok:false,status:400,code:'invalid_adjustment_text',message:input.request.newTextAdmissionError};
  acceptedNewWrites++;return{ok:true,id:502,created:true,visitId:null,attachedToToday:false};
 });
});
describe('standalone adjustment trusted enum admission', () => {
 for (const field of ['phase','elastics'] as const) {
  it.each(['',' ','unknown','constructor','toString','__proto__',true,0,[],{}])(`refuses new invalid ${field} %j and ignores forged admission bypass`, async value => {
   const response=await call(freshKey,JSON.stringify({...body,[field]:value,newEnumAdmissionError:null,request:{newEnumAdmissionError:null}}));
   expect(response.status).toBe(400);expect(acceptedNewWrites).toBe(0);
   expect(mocks.write.mock.calls[0][0].request.newEnumAdmissionError).toEqual(expect.any(String));
   expect(isAdjustmentReceipt(await response.json(),{version:1,scope,key:freshKey,body:JSON.stringify(body),receipt:null})).toBe(false);
  });
 }
 it.each([undefined,null])('preserves omitted/null defaults %j despite forged refusal',async value=>{
  const response=await call(freshKey,JSON.stringify({...body,phase:value,elastics:value,newEnumAdmissionError:'forged',request:{newEnumAdmissionError:'forged'}}));
  expect(response.status).toBe(201);expect(mocks.write.mock.calls[0][0]).toMatchObject({phase:null,elastics:'none',request:{newEnumAdmissionError:null}});
 });
 it.each(['assessment','aligning','working','finishing','retention'])('forwards own phase %s unchanged',async phase=>{
  // Mocked writer acceptance is not proof assessment is an allowed new-session phase.
  expect((await call(freshKey,JSON.stringify({...body,phase}))).status).toBe(201);
  expect(mocks.write.mock.calls[0][0]).toMatchObject({phase,request:{newEnumAdmissionError:null}});
 });
 it.each(['none','class_ii','class_iii','vertical','triangle','cross'])('forwards own elastic class %s unchanged',async elastics=>{
  expect((await call(freshKey,JSON.stringify({...body,elastics}))).status).toBe(201);
  expect(mocks.write.mock.calls[0][0]).toMatchObject({elastics,request:{newEnumAdmissionError:null}});
 });
 it.each(['phase','elastics'] as const)('keeps historical normalized %s args for replay without accepting a new write',async field=>{
  const raw=JSON.stringify({...body,[field]:'unknown'});
  const response=await call(legacyKey,raw);expect(response.status).toBe(200);expect(acceptedNewWrites).toBe(0);
  expect(mocks.write.mock.calls[0][0][field]).toBe(field==='phase'?null:'none');
  expect(mocks.write.mock.calls[0][0].request.newEnumAdmissionError).toEqual(expect.any(String));
  // Legacy-key replay is mocked here; full hash/scope matching is the PG suite's responsibility.
 });
 it('keeps inherited elastic token normalization unchanged for historical hashing',async()=>{
  expect((await call(legacyKey,JSON.stringify({...body,elastics:'constructor'}))).status).toBe(200);
  expect(mocks.write.mock.calls[0][0].elastics).toBe('constructor');
  expect(mocks.write.mock.calls[0][0].request.newEnumAdmissionError).toEqual(expect.any(String));
 });
 it('preserves a valid frozen client body/key when acknowledging the actual route receipt',async()=>{
  const store=storage();const command:AdjustmentCommand={version:1,scope,key:legacyKey,body:JSON.stringify(body),receipt:null};
  store.setItem(adjustmentCommandStorageKey(scope),JSON.stringify(command));const recovered=readAdjustmentCommand(store,scope)!;
  const response=await call(recovered.key,recovered.body);const receipt=await response.json();expect(isAdjustmentReceipt(receipt,recovered)).toBe(true);
  const complete=completeAdjustmentCommand(store,recovered,receipt);expect(complete.body).toBe(command.body);expect(complete.key).toBe(command.key);
 });
 it('does not invent invalid enum support in the frozen client reader',()=>{
  const store=storage();store.setItem(adjustmentCommandStorageKey(scope),JSON.stringify({version:1,scope,key:legacyKey,body:JSON.stringify({...body,elastics:'unknown'}),receipt:null}));
  expect(()=>readAdjustmentCommand(store,scope)).toThrow();
 });
});
