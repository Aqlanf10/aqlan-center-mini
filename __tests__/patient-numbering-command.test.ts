import { describe, expect, it } from 'vitest';
import { executeNumberingCommand, type NumberingBackend, type AppliedNumbering } from '../lib/patient-numbering-command';
import { ownerContextFromTrustedBinding, resolveStaffCapabilities, type ResolvedStaffAccess } from '../lib/staff-capabilities';
const owner = () => resolveStaffCapabilities({subject:{userId:99,role:'admin',isActive:true,clinicianPartyId:null},permissionDocument:{schemaVersion:1,revision:1,patientScope:'none',appointmentScope:'none',grants:{}}},ownerContextFromTrustedBinding({ownerUserId:99,bindingVersion:'synthetic-v1'}));
const command = {prefix:'a',next:'37',expectedRevision:'r1',requestId:'synthetic-request-0001',reason:'synthetic test'};
/** In-memory serial adapter tests orchestration, NOT PostgreSQL isolation. */
function fixture(access: ResolvedStaffAccess | null = owner(), auditFails = false) {
  let revision='r1', pending=1n, audits=0;
  let queue=Promise.resolve();
  const receipts=new Map<string,{intent:string;result:AppliedNumbering}>();
  const backend:NumberingBackend={transaction(work){
    const run=queue.then(()=>work({owner:async()=>access,replay:async(id,key)=>receipts.get(`${id}:${key}`)??null,
      snapshot:async prefix=>({prefix,revision,pendingNext:pending,allocatedThrough:0n,historicalThrough:0n,historyComplete:true}),
      apply:async input=>{
        if(auditFails) throw new Error('synthetic audit failure');
        const result={prefix:input.prefix,next:input.next,preview:input.preview,revision:'r2'};
        pending=BigInt(input.next);revision='r2';audits++;
        receipts.set(`${input.actorId}:${input.requestId}`,{intent:input.intent,result});return result;
      }}));queue=run.then(()=>undefined,()=>undefined);return run;
  }};
  return {backend,revoke:()=>{access=null;},state:()=>({revision,pending,audits})};
}
describe('inert owner numbering command',()=>{
  it('is closed without an installed backend',async()=>expect(await executeNumberingCommand(command,null)).toEqual({ok:false,reason:'owner-numbering-not-activated'}));
  it('rejects forged owner JSON, no identity, and ordinary admin',async()=>{
    const admin=resolveStaffCapabilities({subject:{userId:1,role:'admin',isActive:true,clinicianPartyId:null},permissionDocument:{schemaVersion:1,revision:1,patientScope:'none',appointmentScope:'none',grants:{}}});
    for(const access of [null,admin,{status:'allowed',isOwner:true,userId:99} as ResolvedStaffAccess]){
      const f=fixture(access);expect(await executeNumberingCommand(command,f.backend)).toEqual({ok:false,reason:'owner-required'});expect(f.state().audits).toBe(0);
    }
  });
  it('serializes repeated requests into one audited operation',async()=>{
    const f=fixture();const results=await Promise.all(Array.from({length:20},()=>executeNumberingCommand(command,f.backend)));
    expect(results.every(r=>r.ok)).toBe(true);expect(results.filter(r=>r.ok&&!r.replay)).toHaveLength(1);expect(f.state().audits).toBe(1);
  });
  it('rejects stale concurrent different commands',async()=>{
    const f=fixture();const results=await Promise.all([executeNumberingCommand(command,f.backend),executeNumberingCommand({...command,requestId:'synthetic-request-0002',next:'38'},f.backend)]);
    expect(results[1]).toEqual({ok:false,reason:'stale-preview'});expect(f.state().audits).toBe(1);
  });
  it('rejects reuse of idempotency key with different content',async()=>{
    const f=fixture();await executeNumberingCommand(command,f.backend);
    expect(await executeNumberingCommand({...command,next:'38'},f.backend)).toEqual({ok:false,reason:'idempotency-conflict'});
  });
  it('reauthorizes before replay, so revoked owner cannot retrieve success',async()=>{
    const f=fixture();await executeNumberingCommand(command,f.backend);f.revoke();
    expect(await executeNumberingCommand(command,f.backend)).toEqual({ok:false,reason:'owner-required'});expect(f.state().audits).toBe(1);
  });
  it('denies audit failure without presenting success',async()=>{
    const f=fixture(owner(),true);expect(await executeNumberingCommand(command,f.backend)).toEqual({ok:false,reason:'numbering-transaction-failed'});expect(f.state()).toEqual({revision:'r1',pending:1n,audits:0});
  });
  it('validates bounds and requires explicit reason and request identity',async()=>{
    const f=fixture();for(const change of [{reason:''},{requestId:'bad'},{expectedRevision:''},{next:37}]) expect((await executeNumberingCommand({...command,...change},f.backend)).ok).toBe(false);
    expect(f.state().audits).toBe(0);
  });
});
