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
 mocks.write.mockImplementation(async(input:{request:{key:string;newTextAdmissionError?:string|null}})=>{
  if(input.request.key===legacyKey)return{ok:true,id:501,created:false,replayed:true,visitId:null,attachedToToday:false};
  if(input.request.newTextAdmissionError)return{ok:false,status:400,code:'invalid_adjustment_text',message:input.request.newTextAdmissionError};
  acceptedNewWrites++;return{ok:true,id:502,created:true,visitId:null,attachedToToday:false};
 });
});
describe('real adjustment route response to frozen client command compatibility',()=>{
 it.each([['upperWire',40],['lowerWire',40],['elasticNote',120],['done',400]] as const)('accepts legacy oversized %s receipt without rewriting the frozen body',async(field,limit)=>{
  const store=storage();const command:AdjustmentCommand={version:1,scope,key:legacyKey,body:JSON.stringify({...body,[field]:'  '+'ع'.repeat(limit+1)+'  '}),receipt:null};
  store.setItem(adjustmentCommandStorageKey(scope),JSON.stringify(command));const recovered=readAdjustmentCommand(store,scope)!;
  const response=await call(recovered.key,recovered.body);expect(response.status).toBe(200);const receipt=await response.json();expect(isAdjustmentReceipt(receipt,recovered)).toBe(true);
  const saved=completeAdjustmentCommand(store,recovered,receipt);expect(saved.body).toBe(command.body);expect(saved.key).toBe(command.key);expect(readAdjustmentCommand(store,scope)?.receipt?.id).toBe(501);
  expect(mocks.write.mock.calls[0][0][field]).toBe('ع'.repeat(limit));expect(acceptedNewWrites).toBe(0);
  const repeated=await call(recovered.key,recovered.body);expect(repeated.status).toBe(200);expect(await repeated.json()).toEqual(receipt);expect(acceptedNewWrites).toBe(0);
 });
 it.each([['upperWire',40],['lowerWire',40],['elasticNote',120],['done',400],['note',300]] as const)('refuses new oversized %s and cannot acknowledge or mutate an unrelated frozen command',async(field,limit)=>{
  const store=storage();const command:AdjustmentCommand={version:1,scope,key:freshKey,body:JSON.stringify(body),receipt:null};const frozen=JSON.stringify(command);store.setItem(adjustmentCommandStorageKey(scope),frozen);
  const raw=JSON.stringify({...body,[field]:'x'.repeat(limit+1),newTextAdmissionError:null,request:{newTextAdmissionError:null}});
  const response=await call(freshKey,raw);expect(response.status).toBe(400);const refusal=await response.json();expect(isAdjustmentReceipt(refusal,command)).toBe(false);expect(()=>completeAdjustmentCommand(store,command,refusal)).toThrow();
  expect(store.getItem(adjustmentCommandStorageKey(scope))).toBe(frozen);expect(acceptedNewWrites).toBe(0);expect(mocks.write.mock.calls[0][0].request.newTextAdmissionError).toEqual(expect.any(String));
 });
 it.each(['upperWire','lowerWire','elasticNote','done','note'])('refuses malformed new %s rather than silently normalizing it to null',async field=>{
  const response=await call(freshKey,JSON.stringify({...body,[field]:{text:'wrong type'}}));expect(response.status).toBe(400);expect(await response.json()).toMatchObject({code:'invalid_adjustment_text'});expect(acceptedNewWrites).toBe(0);
 });
 it('preserves a valid boundary receipt and ignores a forged body admission error',async()=>{
  const command:AdjustmentCommand={version:1,scope,key:freshKey,body:JSON.stringify({...body,done:'x'.repeat(400)}),receipt:null};
  const response=await call(command.key,JSON.stringify({...JSON.parse(command.body),request:{newTextAdmissionError:'forged'},newTextAdmissionError:'forged'}));expect(response.status).toBe(201);const receipt=await response.json();expect(isAdjustmentReceipt(receipt,command)).toBe(true);expect(acceptedNewWrites).toBe(1);
 });
 it('cannot use the old key to bypass current patient authority',async()=>{
  mocks.access.mockResolvedValue(false);expect((await call(legacyKey,JSON.stringify({...body,done:'x'.repeat(401)}))).status).toBe(403);expect(mocks.write).not.toHaveBeenCalled();
 });
});
