import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionPayload } from '../lib/auth';
import type { DbClient } from '../lib/db';
const deps=vi.hoisted(()=>({owner:vi.fn(),user:vi.fn()}));
vi.mock('../lib/db',()=>({doctorOwnsPatient:deps.owner,findUserByUsername:deps.user,patientHasVisitToday:vi.fn()}));
import { canAccessPatient } from '../lib/patient-access';
const session={userId:3,username:'synthetic-doctor',role:'doctor',partyId:9,expiresAt:Date.now()+60_000} as SessionPayload;
const client={} as DbClient;
beforeEach(()=>{vi.clearAllMocks();deps.user.mockResolvedValue({isActive:true,partyId:9,permissions:{}});deps.owner.mockResolvedValue(true);});
it('preserves existing ownership call shapes without opting into NOWAIT',async()=>{
  expect(await canAccessPatient(session,7)).toBe(true);expect(deps.owner).toHaveBeenLastCalledWith(9,7);
  expect(await canAccessPatient(session,7,undefined,client)).toBe(true);expect(deps.owner).toHaveBeenLastCalledWith(9,7,client);
});
it('passes the optional ownership lock mode only for the composed writer',async()=>{
  expect(await canAccessPatient(session,7,undefined,client,'nowait')).toBe(true);expect(deps.owner).toHaveBeenCalledWith(9,7,client,'nowait');
});
it('propagates opted-in lock contention so the writer rolls back instead of swallowing it',async()=>{
  const error=Object.assign(new Error('synthetic contention'),{code:'55P03'});deps.owner.mockRejectedValue(error);
  expect(await canAccessPatient(session,7,undefined,client)).toBe(false);
  await expect(canAccessPatient(session,7,undefined,client,'nowait')).rejects.toBe(error);
});
it('continues to fail closed for other ownership read failures',async()=>{
  deps.owner.mockRejectedValue(new Error('synthetic database failure'));
  expect(await canAccessPatient(session,7,undefined,client,'nowait')).toBe(false);
});
