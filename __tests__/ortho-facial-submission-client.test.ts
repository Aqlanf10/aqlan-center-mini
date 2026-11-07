import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syntheticFace } from './fixtures/ortho-facial-analysis';
import { facialSubmissionHash, verifyFacialSubmissionRecovery } from '../lib/ortho-facial-submission-contract';
import { bootstrapFacialRecovery, cancelFacialAndAcknowledge, fetchFacialRecovery, submitFacialAndAcknowledge, verifyFacialTransition, type FacialSaveExpectation } from '../lib/ortho-facial-submission-client';
const scope={patientId:1,orthoCaseId:2,clinicalCaseId:3},actorId=4;
const command=()=>({schemaVersion:1 as const,clientRequestId:'synthetic_durable_command',documentId:91,expectedHeadId:null,reason:'Synthetic recovery test',content:syntheticFace()});
let active=true;
const deny=vi.fn(()=>{active=false;}),fetchMock=vi.fn();
const context=()=>({scope,actorId,current:()=>active,deny});
const response=(raw:unknown,status=200,cache='private, no-store')=>new Response(JSON.stringify(raw),{status,headers:{'content-type':'application/json','cache-control':cache}});
async function fixtures(){
 const c=command(),identity={id:8,commandId:c.clientRequestId,requestFingerprint:await facialSubmissionHash(c)};
 const expected:FacialSaveExpectation={scope,actorId,previousVersion:0,command:c};
 const results=(await import('../lib/ortho-facial-analysis')).computeFacialResults(c.content);
 const revision={id:12,...scope,documentId:91,version:1,recordedPatientId:1,actorId,createdBy:'Synthetic clinician',createdAt:'2026-11-05T00:00:00.000Z',requestFingerprint:identity.requestFingerprint,contentHash:await facialSubmissionHash({content:c.content,results}),command:c,results};
 return {identity,expected,revision,recovery:{ok:true,scope,actorId,recovery:{state:'pending' as const,identity,expected}},ack:{ok:true,scope,actorId,identity,state:'committed',acknowledged:true}};
}
beforeEach(()=>{active=true;deny.mockClear();fetchMock.mockReset();vi.stubGlobal('fetch',fetchMock);});
afterEach(()=>vi.unstubAllGlobals());
describe('facial recovery strict receipts',()=>{
 it('verifies exact recovered bytes rather than trusting the supplied fingerprint',async()=>{const f=await fixtures();fetchMock.mockResolvedValue(response(f.recovery));await expect(fetchFacialRecovery(context())).resolves.toEqual(f.recovery.recovery);expect(fetchMock.mock.calls[0][1]).toMatchObject({credentials:'same-origin',cache:'no-store'});});
 it.each(['actor','scope','hash','command','version','extra_root','extra_expected','extra_identity','extra_command'] as const)('rejects changed %s in a restored command',async kind=>{
  const f=await fixtures(),raw=structuredClone(f.recovery) as any;
  if(kind==='actor')raw.actorId=5;if(kind==='scope')raw.scope.clinicalCaseId=5;if(kind==='hash')raw.recovery.identity.requestFingerprint='b'.repeat(64);
  if(kind==='command')raw.recovery.expected.command.reason='Changed';if(kind==='version')raw.recovery.expected.previousVersion=1;
  if(kind==='extra_root')raw.extra=1;if(kind==='extra_expected')raw.recovery.expected.extra=1;if(kind==='extra_identity')raw.recovery.identity.extra=1;if(kind==='extra_command')raw.recovery.expected.command.extra=1;
  await expect(verifyFacialSubmissionRecovery(raw,scope,actorId)).rejects.toThrow();
 });
 it('requires no-store and rejects redirected recovery responses',async()=>{const f=await fixtures();fetchMock.mockResolvedValueOnce(response(f.recovery,200,'private'));await expect(fetchFacialRecovery(context())).rejects.toThrow();const redirected=response(f.recovery);Object.defineProperty(redirected,'redirected',{value:true});fetchMock.mockResolvedValueOnce(redirected);await expect(fetchFacialRecovery(context())).rejects.toThrow();});
 it('quarantines authority on forbidden response without reading clinical bytes',async()=>{const text=vi.fn();fetchMock.mockResolvedValue({status:403,text});await expect(fetchFacialRecovery(context())).rejects.toThrow();expect(deny).toHaveBeenCalledOnce();expect(text).not.toHaveBeenCalled();});
 it('does not restore a verified response into a retired owner',async()=>{const f=await fixtures();fetchMock.mockImplementation(async()=>{active=false;return response(f.recovery);});await expect(fetchFacialRecovery(context())).rejects.toThrow();});
 it('rejects clinical payload smuggled into a metadata-only blocked reply',async()=>{const f=await fixtures();await expect(verifyFacialSubmissionRecovery({ok:true,scope,actorId,recovery:{state:'blocked',identity:null,canCancel:false,expected:f.expected}},scope,actorId)).rejects.toThrow();});
});
describe('facial save and acknowledgment protocol',()=>{
 it('sends scope-bound exact bytes, verifies committed revision, then acknowledges matching identity',async()=>{const f=await fixtures();fetchMock.mockResolvedValueOnce(response({ok:true,replayed:false,revision:f.revision},201)).mockResolvedValueOnce(response(f.ack));await expect(submitFacialAndAcknowledge(context(),f.expected,f.identity)).resolves.toEqual(f.revision);expect(fetchMock).toHaveBeenCalledTimes(2);expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({patientId:1,clinicalCaseId:3,actorId,command:f.expected.command});expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({patientId:1,clinicalCaseId:3,actorId,commandId:f.identity.commandId,requestFingerprint:f.identity.requestFingerprint,action:'acknowledge'});});
 it('does not acknowledge an uncertain save',async()=>{const f=await fixtures();fetchMock.mockRejectedValueOnce(Error('lost response'));await expect(submitFacialAndAcknowledge(context(),f.expected)).rejects.toThrow();expect(fetchMock).toHaveBeenCalledOnce();});
 it.each(['actor','version','hash','command'] as const)('does not acknowledge an altered saved %s',async kind=>{const f=await fixtures(),r=structuredClone(f.revision);if(kind==='actor')r.actorId=5;if(kind==='version')r.version=2;if(kind==='hash')r.contentHash='b'.repeat(64);if(kind==='command')r.command.reason='Changed';fetchMock.mockResolvedValueOnce(response({ok:true,replayed:false,revision:r},201));await expect(submitFacialAndAcknowledge(context(),f.expected)).rejects.toThrow();expect(fetchMock).toHaveBeenCalledOnce();});
 it('rejects a mismatched recovery identity before sending anything',async()=>{const f=await fixtures();await expect(submitFacialAndAcknowledge(context(),f.expected,{...f.identity,commandId:'different_synthetic_id'})).rejects.toThrow();expect(fetchMock).not.toHaveBeenCalled();});
 it('does not treat a missing acknowledgement response as completed',async()=>{const f=await fixtures();fetchMock.mockResolvedValueOnce(response({ok:true,replayed:true,revision:f.revision})).mockRejectedValueOnce(Error('ack response lost'));await expect(submitFacialAndAcknowledge(context(),f.expected,f.identity)).rejects.toThrow();expect(fetchMock).toHaveBeenCalledTimes(2);});
 it.each(['actor','scope','id','fingerprint','state','acknowledged','extra'])('rejects changed %s in terminal acknowledgement',async kind=>{const f=await fixtures(),a=structuredClone(f.ack) as any;if(kind==='actor')a.actorId=5;if(kind==='scope')a.scope.patientId=5;if(kind==='id')a.identity.id=99;if(kind==='fingerprint')a.identity.requestFingerprint='b'.repeat(64);if(kind==='state')a.state='cancelled';if(kind==='acknowledged')a.acknowledged=false;if(kind==='extra')a.extra=1;expect(()=>verifyFacialTransition(a,context(),f.identity,'committed',true)).toThrow();});
 it('does not acknowledge after authority is lost during saved receipt parsing',async()=>{const f=await fixtures(),r=response({ok:true,replayed:true,revision:f.revision});const original=r.text.bind(r);r.text=async()=>{const text=await original();active=false;return text;};fetchMock.mockResolvedValueOnce(r);await expect(submitFacialAndAcknowledge(context(),f.expected)).rejects.toThrow();expect(fetchMock).toHaveBeenCalledOnce();});
});
describe('facial safe cancellation',()=>{
 it('cancels an exact absent-or-pending identity then acknowledges the tombstone',async()=>{const f=await fixtures();fetchMock.mockResolvedValueOnce(response({...f.ack,state:'cancelled',acknowledged:false})).mockResolvedValueOnce(response({...f.ack,state:'cancelled'}));await expect(cancelFacialAndAcknowledge(context(),f.identity)).resolves.toEqual(f.identity);expect(fetchMock.mock.calls.map(c=>JSON.parse(c[1].body).action)).toEqual(['cancel','acknowledge']);});
 it('acknowledges an already-cancelled receipt without sending another cancellation',async()=>{const f=await fixtures();fetchMock.mockResolvedValueOnce(response({...f.ack,state:'cancelled'}));await expect(cancelFacialAndAcknowledge(context(),f.identity,true)).resolves.toEqual(f.identity);expect(fetchMock).toHaveBeenCalledOnce();expect(JSON.parse(fetchMock.mock.calls[0][1].body).action).toBe('acknowledge');});
 it('cannot treat an already committed revision as a cancelled request',async()=>{const f=await fixtures();fetchMock.mockResolvedValueOnce(response(f.ack));await expect(cancelFacialAndAcknowledge(context(),f.identity)).rejects.toThrow();expect(fetchMock).toHaveBeenCalledOnce();});
 it('retains uncertainty when another outstanding command prevents cancellation',async()=>{const f=await fixtures();fetchMock.mockResolvedValueOnce(response({code:'facial_submission_unacknowledged'},409));await expect(cancelFacialAndAcknowledge(context(),f.identity)).rejects.toThrow();expect(fetchMock).toHaveBeenCalledOnce();});
});

describe('metadata-first facial binding bootstrap',()=>{
 it('bootstraps positive actor and clinical bridge only from a verified endpoint envelope',async()=>{const f=await fixtures();fetchMock.mockResolvedValueOnce(response(f.recovery));await expect(bootstrapFacialRecovery({patientId:1,orthoCaseId:2},context())).resolves.toEqual(f.recovery);expect(fetchMock.mock.calls[0][0]).toBe('/api/ortho/2/facial-analysis/recovery?patientId=1');});
 it.each(['patient','case','actor_zero','actor_string','clinical_zero','clinical_string','extra_scope','extra_root'] as const)('rejects invalid bootstrap %s before returning a binding',async kind=>{const f=await fixtures(),raw=structuredClone(f.recovery) as any;if(kind==='patient')raw.scope.patientId=9;if(kind==='case')raw.scope.orthoCaseId=9;if(kind==='actor_zero')raw.actorId=0;if(kind==='actor_string')raw.actorId='4';if(kind==='clinical_zero')raw.scope.clinicalCaseId=0;if(kind==='clinical_string')raw.scope.clinicalCaseId='3';if(kind==='extra_scope')raw.scope.extra=1;if(kind==='extra_root')raw.extra=1;fetchMock.mockResolvedValueOnce(response(raw));await expect(bootstrapFacialRecovery({patientId:1,orthoCaseId:2},context())).rejects.toThrow();});
});
