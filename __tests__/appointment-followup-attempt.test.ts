import { afterEach, expect, it, vi } from 'vitest';
import { followupAttemptKey, readFollowupAttempt, removeOwnedFollowupAttempt, withFollowupAttemptLock } from '../lib/appointment-followup-attempt';
const command={appointmentId:2,expectedPatientId:3,expectedActorUserId:1,sourceCreatedAt:'1.123456',generation:'a'.repeat(32),requestId:'synthetic-attempt-001',expectedRevision:0,assigneeUserId:1,dueAt:'2090-01-01T00:00:00.000Z',status:'open',outcome:'pending',nextStep:'call'};
function storage(raw:string|null){return {getItem:vi.fn(()=>raw),removeItem:vi.fn()};}
afterEach(()=>vi.unstubAllGlobals());
it('separates actors and sources, preserves malformed/foreign evidence',()=>{
 expect(followupAttemptKey(1,3,2)).not.toBe(followupAttemptKey(2,3,2));
 for(const raw of ['{',JSON.stringify({...command,expectedPatientId:4})]){
  const s=storage(raw);expect(()=>readFollowupAttempt(s,'key',3,2,1)).toThrow();expect(s.removeItem).not.toHaveBeenCalled();
 }
});
it('deletes only the exact owned bytes after caller has verified its receipt',()=>{
 const raw=JSON.stringify(command); const s=storage(raw);
 expect(readFollowupAttempt(s,'key',3,2,1)?.command).toEqual(command);
 expect(removeOwnedFollowupAttempt(s,'key','another')).toBe(false);expect(s.removeItem).not.toHaveBeenCalled();
 expect(removeOwnedFollowupAttempt(s,'key',raw)).toBe(true);expect(s.removeItem).toHaveBeenCalledWith('key');
});
it('fails closed without browser coordination; does not fall back to localStorage locking',async()=>{
 vi.stubGlobal('navigator',{});const write=vi.fn();
 await expect(withFollowupAttemptLock('key',write)).rejects.toThrow('Web Locks');expect(write).not.toHaveBeenCalled();
});
it('busy origin lock never queues or executes a stale save',async()=>{
 const request=vi.fn(async(_key,_options,work)=>work(null));vi.stubGlobal('navigator',{locks:{request}});
 const write=vi.fn();expect(await withFollowupAttemptLock('key',write)).toBe(false);expect(write).not.toHaveBeenCalled();
 expect(request).toHaveBeenCalledWith('key',{mode:'exclusive',ifAvailable:true},expect.any(Function));
});

it('binds legacy evidence to its slot owner without rewriting or erasing the stored bytes',()=>{
 const {expectedActorUserId:_actor,...legacy}=command;
 const raw=JSON.stringify(legacy);const s=storage(raw);
 expect(readFollowupAttempt(s,'key',3,2,1)).toEqual({raw,command});
 expect(s.removeItem).not.toHaveBeenCalled();
 expect(()=>readFollowupAttempt(storage(JSON.stringify(command)),'key',3,2,2)).toThrow();
});
