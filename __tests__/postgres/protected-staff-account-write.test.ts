import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, sessionCredentialVersion, verifyPassword, type SessionPayload } from '../../lib/auth';
import { ownerContextFromTrustedBinding, type TrustedOwnerContext } from '../../lib/staff-capabilities';
import { parseDoctorPermissions } from '../../lib/doctor-permissions';
import { type StaffAccountProtection } from '../../lib/staff-account-mutation';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { validatePostgresTestTarget } from './_safe-target';

// Explicit safe fixture input only. The existing fixture creates randomly named,
// identity-checked disposable databases; app globals point at its owned source.
validatePostgresTestTarget(process.env);
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db: typeof import('../../lib/db');
let admin: SessionPayload, owner: SessionPayload, other: SessionPayload;
let protection: StaffAccountProtection;
let currentPassword: string, nextPassword: string, serial = 0;
let issued: number[] = [];
const ctx = (s:SessionPayload) => ({ actor:s.username, actorRole:s.role });
const q = <T extends Record<string, unknown>>(sql:string,values:unknown[]=[]) => fixture.source.query<T>(sql,values);
async function makeUser(role:string) {
  const username=`synthetic-staff-writer-${++serial}`;
  const passwordHash=await hashPassword(currentPassword);
  const { rows:[row] }=await q<{id:number}>(
    'INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$1,$2,$3) RETURNING id',
    [username,passwordHash,role]);
  issued.push(row.id);
  return { username, role, userId:row.id, expiresAt:Date.now()+60000, credentialVersion:sessionCredentialVersion(passwordHash) };
}
async function snapshot(id:number) {
  const { rows:[u] }=await q<{ display_name:string; password_hash:string; role:string; is_active:boolean; party_id:number|null }>(
    'SELECT display_name,password_hash,role,is_active,party_id FROM users WHERE id=$1',[id]);
  const { rows:[a] }=await q<{ audit:number }>("SELECT count(*)::int audit FROM audit_log WHERE entity='user' AND entity_id=$1",[String(id)]);
  return { profile:u.display_name, role:u.role, active:u.is_active, party:u.party_id,
    credentialVersion:sessionCredentialVersion(u.password_hash), audit:a.audit };
}
beforeAll(async()=>{
  fixture=await openBackupTimestampFixture({...process.env});
  vi.stubEnv('DATABASE_URL',fixture.source.options.connectionString!);
  vi.stubEnv('SKIP_SEED','true'); vi.stubEnv('DB_POOL_MAX','4');
  vi.stubEnv('SESSION_SECRET',randomBytes(32).toString('hex'));
  db=await import('../../lib/db'); await db.resetPoolForTesting(); await db.ensureSchema();
});
afterAll(async()=>{try { await db?.resetPoolForTesting(); await fixture?.close(); } finally { vi.unstubAllEnvs(); }});
beforeEach(async()=>{
  if(issued.length) await q('UPDATE users SET is_active=false WHERE id=ANY($1::int[])',[issued]);
  issued=[]; currentPassword=randomBytes(20).toString('hex');nextPassword=randomBytes(20).toString('hex');
  owner=await makeUser('admin'); admin=await makeUser('admin'); other=await makeUser('reception');
  const binding=ownerContextFromTrustedBinding({ownerUserId:owner.userId,bindingVersion:'synthetic-writer-v1'});
  protection={mode:'protected',readBinding:async client=>{
    const {rows}=await client.query<{n:string}>('SELECT current_database() AS n');
    expect(rows[0].n).toMatch(/^aqlan_backup_precision_[a-f0-9]{32}$/);
    return binding;
  }};
});

describe('actual shared account writer (synthetic disposable PostgreSQL)',()=>{
  it('refuses a whole mixed owner patch including credential, role and profile before writing',async()=>{
    const before=await snapshot(owner.userId), hash=await hashPassword(nextPassword);
    await expect(db.updateUser(owner.userId,{displayName:'Synthetic blocked change',passwordHash:hash,role:'reception',isActive:false},ctx(admin),{session:admin,protection}))
      .rejects.toMatchObject({reason:'owner-account-protected'});
    await expect(db.linkUserDoctor(owner.userId,null,ctx(admin),{session:admin,protection}))
      .rejects.toMatchObject({reason:'owner-account-protected'});
    expect(await snapshot(owner.userId)).toEqual(before);
  });
  it('refuses null, copied or exception binding without falling back to unconfigured writes',async()=>{
    const before=await snapshot(other.userId);
    const real=ownerContextFromTrustedBinding({ownerUserId:owner.userId,bindingVersion:'synthetic-writer-v1'});
    for(const load of [async()=>null,async()=>({...real} as TrustedOwnerContext),async()=>{throw new Error('Synthetic binding offline');}]) {
      await expect(db.updateUser(other.userId,{displayName:'Synthetic blocked change'},ctx(admin),{session:admin,protection:{mode:'protected',readBinding:load}}))
        .rejects.toMatchObject({reason:'owner-protection-unverified'});
    }
    await expect(db.changeOwnStaffPassword(owner,currentPassword,nextPassword,{mode:'protected',readBinding:async()=>null}))
      .rejects.toMatchObject({reason:'owner-protection-unverified'});
    expect(await snapshot(other.userId)).toEqual(before);
  });
  it('allows the same current legacy admin to write a non-owner and preserves unconfigured behavior',async()=>{
    const before=await snapshot(other.userId);
    const saved=await db.updateUser(other.userId,{displayName:'Synthetic permitted'},ctx(admin),{session:admin,protection});
    expect(saved).toMatchObject({displayName:'Synthetic permitted'});expect(saved).not.toHaveProperty('passwordHash');
    expect((await snapshot(other.userId)).audit).toBe(before.audit+1);
    const unconfigured=await db.updateUser(other.userId,{displayName:'Synthetic legacy default'},ctx(admin),{session:admin});
    expect(unconfigured).toMatchObject({displayName:'Synthetic legacy default'});
  });
  it('rejects outdated admitted credentials and nonadmins without mutation',async()=>{
    const before=await snapshot(other.userId);
    for(const s of [other,{...admin,expiresAt:1},{...admin,credentialVersion:'revoked-synthetic'}]) {
      await expect(db.updateUser(other.userId,{displayName:'Synthetic blocked'},ctx(s),{session:s,protection}))
        .rejects.toMatchObject({reason:'staff-authority-stale'});
    }
    expect(await snapshot(other.userId)).toEqual(before);
  });
  it('serializes competing reductions and keeps the last active administrator',async()=>{
    const [a,b]=await Promise.allSettled([db.updateUser(owner.userId,{isActive:false}),db.updateUser(admin.userId,{role:'reception'})]);
    const results=[a,b];expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{reason:'last-active-admin'}});
    expect(await db.countActiveAdmins()).toBe(1);
  });
  it('checks doctor eligibility in transaction and audits an allowed link',async()=>{
    const {rows:[doctor]}=await q<{id:number}>("INSERT INTO parties(name,kind,is_active) VALUES('Synthetic permitted doctor','doctor',true) RETURNING id");
    const {rows:[inactive]}=await q<{id:number}>("INSERT INTO parties(name,kind,is_active) VALUES('Synthetic disabled doctor','doctor',false) RETURNING id");
    const before=await snapshot(other.userId);
    await expect(db.linkUserDoctor(other.userId,inactive.id,ctx(admin),{session:admin,protection})).rejects.toMatchObject({reason:'invalid-doctor-link'});
    expect(await snapshot(other.userId)).toEqual(before);
    expect(await db.linkUserDoctor(other.userId,doctor.id,ctx(admin),{session:admin,protection})).toMatchObject({partyId:doctor.id,partyName:'Synthetic permitted doctor'});
    expect((await snapshot(other.userId)).audit).toBe(before.audit+1);
  });
  it('commits one verified owner self-password, refuses the second stale request and rotates old credentials',async()=>{
    const before=await snapshot(owner.userId);
    expect(await db.changeOwnStaffPassword(owner,'not-current-synthetic',nextPassword,protection)).toEqual({ok:false,reason:'wrong-password'});
    const result=await Promise.all([db.changeOwnStaffPassword(owner,currentPassword,nextPassword,protection),db.changeOwnStaffPassword(owner,currentPassword,nextPassword,protection)]);
    expect(result.filter(v=>v.ok)).toHaveLength(1); expect(result.filter(v=>!v.ok)).toEqual([{ok:false,reason:'stale-session'}]);
    const win=result.find(v=>v.ok); expect(win?.user).not.toHaveProperty('passwordHash');
    const after=await snapshot(owner.userId);
    expect(after.audit).toBe(before.audit+1); expect(after.credentialVersion).not.toBe(before.credentialVersion);
    const current=(await db.findUserByUsername(owner.username))!;
    expect(await verifyPassword(nextPassword,current.passwordHash)).toBe(true);
  });
  it('rolls generic and owner self-password mutations back when the mandatory audit fails',async()=>{
    const a=await snapshot(other.userId), b=await snapshot(owner.userId);
    await q("ALTER TABLE audit_log ADD CONSTRAINT synthetic_stf_audit_reject CHECK(action <> 'user.update') NOT VALID");
    try {
      await expect(db.updateUser(other.userId,{displayName:'Synthetic must roll back'},ctx(admin),{session:admin,protection})).rejects.toThrow();
      await expect(db.changeOwnStaffPassword(owner,currentPassword,nextPassword,protection)).rejects.toThrow();
      expect(await snapshot(other.userId)).toEqual(a); expect(await snapshot(owner.userId)).toEqual(b);
    } finally { await q('ALTER TABLE audit_log DROP CONSTRAINT synthetic_stf_audit_reject'); }
  });
  it('rolls a mixed profile write back if detailed companion commission or permission audit fails',async()=>{
    const before=await snapshot(other.userId);
    const cases=[
      { action:'doctor.commission.update', patch:{clearCommissionConfig:true} },
      { action:'doctor.permissions.update', patch:{permissions:parseDoctorPermissions({},'reception')} },
    ] as const;
    for (const {action,patch} of cases) {
      // Fixed synthetic strings only; never an external action value.
      await q(`ALTER TABLE audit_log ADD CONSTRAINT synthetic_stf_detail_reject CHECK(action <> '${action}') NOT VALID`);
      try {
        await expect(db.updateUser(other.userId,{...patch,displayName:'Synthetic rollback'},ctx(admin),{session:admin,protection})).rejects.toThrow();
        expect(await snapshot(other.userId)).toEqual(before);
      } finally { await q('ALTER TABLE audit_log DROP CONSTRAINT synthetic_stf_detail_reject'); }
    }
  });

  it('rolls account mutation back if session expires while mandatory audit is blocked',async()=>{
    const before=await snapshot(other.userId),lock=await db.getPool().connect();
    const expiring={...admin,expiresAt:Date.now()+1500};
    let operation:Promise<unknown>|undefined;
    try {
      await lock.query('BEGIN'); await lock.query('LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE');
      const {rows:[held]}=await lock.query<{pid:number}>('SELECT pg_backend_pid() AS pid');
      operation=db.updateUser(other.userId,{displayName:'Synthetic expiry rollback'},ctx(expiring),{session:expiring,protection}).catch(error=>error);
      let observed=false;
      const deadline=Date.now()+1000;
      while(Date.now()<deadline) {
        const {rows:[r]}=await lock.query<{blocked:boolean}>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',[held.pid]);
        if(r.blocked){observed=true;break;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(observed).toBe(true);
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiring.expiresAt-Date.now())+30));
      await lock.query('COMMIT');
      expect(await operation).toMatchObject({reason:'staff-authority-stale'});
    } finally { await lock.query('ROLLBACK');lock.release();await operation; }
    expect(await snapshot(other.userId)).toEqual(before);
  });

});
