import { describe, expect, it } from 'vitest';
import { ownerContextFromTrustedBinding, resolveStaffCapabilities, staffAuthorizationFingerprint, validateStaffAccountControl, validateStaffAccountControlBatch, type ResolvedStaffAccess } from '../lib/staff-capabilities';
const context=ownerContextFromTrustedBinding({ownerUserId:99,bindingVersion:'synthetic-v1'});
const resolve=(userId:number, revision=1,binding=context)=>resolveStaffCapabilities({subject:{userId,role:'admin',isActive:true,clinicianPartyId:null},permissionDocument:{schemaVersion:1,revision,patientScope:'none',appointmentScope:'none',grants:{}}},binding);
const input=(actor=resolve(99),target=resolve(10))=>({actor,target,expectedActorFingerprint:staffAuthorizationFingerprint(actor)??'',expectedTargetFingerprint:staffAuthorizationFingerprint(target)??'',operations:['credentials.reset']});
describe('inactive staff account-control preflight',()=>{
  it('admits only trusted owner controlling a different non-owner subject',()=>expect(validateStaffAccountControl(input())).toEqual({ok:true}));
  it('never treats generic admin or forged JSON as owner',()=>{
    expect(validateStaffAccountControl(input(resolve(1))).ok).toBe(false);
    expect(validateStaffAccountControl(input({isOwner:true,userId:99,status:'allowed'} as ResolvedStaffAccess)).ok).toBe(false);
  });
  it.each(['credentials.reset','username.change','role.change','clinician-link.change','account.disable','permissions.change'])('protects owner from %s, including self admin action',operation=>{
    expect(validateStaffAccountControl({...input(resolve(99),resolve(99)),operations:[operation]})).toEqual({ok:false,reason:'protected-owner'});
    expect(validateStaffAccountControl({...input(resolve(10),resolve(99)),operations:[operation]})).toEqual({ok:false,reason:'protected-owner'});
  });
  it('rejects mismatched binding versions and same ID with stale authority',()=>{
    const other=ownerContextFromTrustedBinding({ownerUserId:99,bindingVersion:'synthetic-v2'});
    expect(validateStaffAccountControl(input(resolve(99),resolve(10,1,other))).ok).toBe(false);
    const before=input();expect(validateStaffAccountControl({...before,actor:resolve(99,2)})).toEqual({ok:false,reason:'stale-authority'});
    expect(validateStaffAccountControl({...before,target:resolve(10,2)})).toEqual({ok:false,reason:'stale-authority'});
  });
  it('rejects unknown mixed fields and empty batches before any operation',()=>{
    expect(validateStaffAccountControl({...input(),operations:['credentials.reset','delete.database']} ).ok).toBe(false);
    expect(validateStaffAccountControlBatch([]).ok).toBe(false);
    expect(validateStaffAccountControlBatch([input(),input(resolve(99),resolve(99))])).toEqual({ok:false,reason:'protected-owner'});
  });
  it('rejects duplicate targets or authority changes within a bulk request',()=>{
    expect(validateStaffAccountControlBatch([input(),input()]).ok).toBe(false);
    expect(validateStaffAccountControlBatch([input(),input(resolve(99,2),resolve(11))]).ok).toBe(false);
  });
  it('admits a synthetic all-valid batch without changing any authority',()=>{
    const a=input(),b=input(resolve(99),resolve(11));expect(validateStaffAccountControlBatch([a,b])).toEqual({ok:true});
    expect(staffAuthorizationFingerprint(a.actor)).toBe(a.expectedActorFingerprint);
  });
});
