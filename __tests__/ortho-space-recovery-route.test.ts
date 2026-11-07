import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../app/api/ortho/[id]/space-ledger/recovery/route';
const state = vi.hoisted(() => ({session:{username:'synthetic',role:'doctor'} as {username:string;role:string}|null,access:vi.fn(),get:vi.fn(),transition:vi.fn()}));
vi.mock('../lib/session',()=>({requireSession:async()=>state.session}));
vi.mock('../lib/patient-access',()=>({canAccessPatient:state.access}));
vi.mock('../lib/ortho-space-submission-store',()=>({getSpaceSubmissionRecovery:state.get,transitionSpaceSubmission:state.transition}));
const context={params:Promise.resolve({id:'2'})};
const body={patientId:1,clinicalCaseId:3,actorId:7,commandId:'synthetic-command-1234',requestFingerprint:'a'.repeat(64),action:'cancel'};
const read=(query='?patientId=1')=>new Request(`http://localhost/api/ortho/2/space-ledger/recovery${query}`);
const write=(value:unknown=body,query='')=>new Request(`http://localhost/api/ortho/2/space-ledger/recovery${query}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
function privateResponse(r:Response){expect(r.headers.get('cache-control')).toBe('private, no-store');}
beforeEach(()=>{state.session={username:'synthetic',role:'doctor'};state.access.mockReset().mockResolvedValue(true);state.get.mockReset().mockResolvedValue({ok:true,recovery:null});state.transition.mockReset().mockResolvedValue({ok:true,state:'cancelled'});});
describe('space-source recovery route admission',()=>{
 it('authenticates before parsing untrusted malformed transition bodies',async()=>{
  state.session=null; const r=await POST(new Request('http://localhost/',{method:'POST',body:'{'}),context);expect(r.status).toBe(401);privateResponse(r);expect(state.access).not.toHaveBeenCalled();expect(state.transition).not.toHaveBeenCalled();
 });
 it('does not expose recovery when signed out',async()=>{state.session=null;const r=await GET(read(),context);expect(r.status).toBe(401);privateResponse(r);expect(state.get).not.toHaveBeenCalled();});
 it.each(['reception','accountant','nurse'])('refuses %s transitions',async role=>{state.session!.role=role;expect((await POST(write(),context)).status).toBe(403);expect(state.transition).not.toHaveBeenCalled();});
 it.each(['','?patientId=0','?patientId=01','?patientId=1&patientId=2','?patientId=1&actorId=7','?patientId=1&commandId=other'])('rejects ambiguous recovery query %s',async query=>{expect((await GET(read(query),context)).status).toBe(400);expect(state.get).not.toHaveBeenCalled();});
 it.each([null,[],{...body,command:{}},{...body,session:{role:'admin'}},{...body,orthoCaseId:99},{...body,commandId:{}},{...body,requestFingerprint:{}},{...body,action:[]}])('rejects injection/malformed envelope %#',async value=>{expect((await POST(write(value),context)).status).toBe(400);expect(state.transition).not.toHaveBeenCalled();});
 it('rejects query parameters on a transition',async()=>{expect((await POST(write(body,'?patientId=99'),context)).status).toBe(400);expect(state.transition).not.toHaveBeenCalled();});
 it('refuses patient access denial for recovery and transition',async()=>{state.access.mockResolvedValue(false);for(const r of [await GET(read(),context),await POST(write(),context)]){expect(r.status).toBe(403);privateResponse(r);}expect(state.get).not.toHaveBeenCalled();expect(state.transition).not.toHaveBeenCalled();});
 it('fails closed when access service throws',async()=>{state.access.mockRejectedValue(new Error('synthetic'));expect((await GET(read(),context)).status).toBe(403);expect((await POST(write(),context)).status).toBe(403);expect(state.get).not.toHaveBeenCalled();expect(state.transition).not.toHaveBeenCalled();});
 it('passes exact authenticated route identity for metadata-only cancellation',async()=>{const r=await POST(write(),context);expect(r.status).toBe(200);privateResponse(r);expect(state.transition).toHaveBeenCalledWith({ok:true,session:state.session,orthoCaseId:2,...body});});
 it('binds recovery scope to route and current authenticated session',async()=>{const r=await GET(read(),context);expect(r.status).toBe(200);privateResponse(r);expect(state.get).toHaveBeenCalledWith({ok:true,session:state.session,patientId:1,orthoCaseId:2});});
 it('passes acknowledgement without pretending it creates a clinical record',async()=>{const r=await POST(write({...body,action:'acknowledge'}),context);expect(r.status).toBe(200);expect(state.transition).toHaveBeenCalledWith(expect.objectContaining({action:'acknowledge',commandId:body.commandId}));});
 it('preserves pending/committed conflict outcomes',async()=>{state.transition.mockResolvedValue({ok:false,status:409,code:'space_submission_committed'});const r=await POST(write(),context);expect(r.status).toBe(409);privateResponse(r);expect(await r.json()).toMatchObject({ok:false,code:'space_submission_committed'});});
 it('does not replace failed recovery with an empty successful journal',async()=>{state.get.mockRejectedValue(new Error('synthetic internal'));const r=await GET(read(),context);expect(r.status).toBe(500);privateResponse(r);expect(await r.json()).toMatchObject({ok:false,code:'read_failed'});});
 it('keeps uncertain transition failures private',async()=>{state.transition.mockRejectedValue(new Error('synthetic internal'));const r=await POST(write(),context);expect(r.status).toBe(500);privateResponse(r);const text=await r.text();expect(text).toContain('write_unconfirmed');expect(text).not.toContain('synthetic internal');});
 it('bounds cancellation metadata payloads',async()=>{const r=await POST(write({...body,commandId:'x'.repeat(5000)}),context);expect(r.status).toBe(413);privateResponse(r);expect(state.transition).not.toHaveBeenCalled();});
});
