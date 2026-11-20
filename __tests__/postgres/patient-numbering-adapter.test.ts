import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach,beforeEach,describe,it,expect } from 'vitest';
import { validatePostgresTestTarget } from './_safe-target';
import { NumberingPgFixture } from './fixtures/patient-numbering-adapter';
import { executeNumberingCommand } from '../../lib/patient-numbering-command';
import { ownerContextFromTrustedBinding,resolveStaffCapabilities } from '../../lib/staff-capabilities';
const target=validatePostgresTestTarget(process.env); // before any connection, no ambient fallback
const owner=()=>resolveStaffCapabilities({subject:{userId:99,role:'admin',isActive:true,clinicianPartyId:null},permissionDocument:{schemaVersion: 2, confirmation: "owner", revision:1,patientScope:'none',appointmentScope:'none',grants:{}}},ownerContextFromTrustedBinding({ownerUserId:99,bindingVersion:'synthetic-only'}));
let pool:Pool,f:NumberingPgFixture;
beforeEach(async()=>{pool=new Pool({connectionString:target.testUrl.toString(),max:12,ssl:false});f=new NumberingPgFixture(pool,`numbering_fixture_${randomUUID().replaceAll('-','')}`,async()=>owner());await f.initialize();});
afterEach(async()=>{try{await f?.dispose();}finally{await pool?.end();}});
const command=async(prefix='A',next='37',reason='synthetic test')=>({prefix,next,reason,requestId:`synthetic_${randomUUID()}`,expectedRevision:(await f.preview(prefix)).revision});
describe('owned PG18 numbering fixture, not production integration',()=>{
  it('atomically commits config, audit and receipt with exact next number',async()=>{
    const c=await command();expect((await executeNumberingCommand(c,f)).ok).toBe(true);expect(await f.issue()).toBe('A-00037');
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.audit`)).rows[0].n).toBe(1);
    expect((await executeNumberingCommand(c,f))).toMatchObject({ok:true,replay:true});expect(await f.issue()).toBe('A-00038');
  });
  it('concurrent same command commits one audit and returns durable replays',async()=>{
    const c=await command();const results=await Promise.all(Array.from({length:20},()=>executeNumberingCommand(c,f)));
    expect(results.every(r=>r.ok)).toBe(true);expect(results.filter(r=>r.ok&&!r.replay)).toHaveLength(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.audit`)).rows[0].n).toBe(1);
  });
  it('concurrent different commands reject stale global configuration',async()=>{
    const a=await command('A','37'),b=await command('B','12');const r=await Promise.all([executeNumberingCommand(a,f),executeNumberingCommand(b,f)]);
    expect(r.filter(x=>x.ok)).toHaveLength(1);expect(r.filter(x=>!x.ok&&x.reason==='stale-preview')).toHaveLength(1);
  });
  it('audit failure rolls back restart and active prefix and receipt',async()=>{
    const c=await command('A','37','SYNTHETIC_AUDIT_FAIL');expect(await executeNumberingCommand(c,f)).toEqual({ok:false,reason:'numbering-transaction-failed'});
    expect((await f.preview('A')).pendingNext).toBe(1n);expect(await f.issue()).toBe('P-07000');
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.receipts`)).rows[0].n).toBe(0);
  });
  it('rollback consumes allocated number and makes old preview stale',async()=>{
    const c=await command('P','7000');await expect(f.issue(true)).rejects.toThrow('SYNTHETIC_ISSUE_ROLLBACK');
    expect(await executeNumberingCommand(c,f)).toEqual({ok:false,reason:'stale-preview'});expect(await f.issue()).toBe('P-07001');
  });
  it('concurrent issue and configuration cannot duplicate or rewind',async()=>{
    const c=await command('P','7000');const results=await Promise.all([f.issue(),executeNumberingCommand(c,f)]);
    expect(results[0]).toBe('P-07000');expect(await f.issue()).toBe('P-07001');
  });
  it('connection restart retains pending selection and used-prefix high water',async()=>{
    expect((await executeNumberingCommand(await command('A','37'),f)).ok).toBe(true);
    const schema=f.schema;await pool.end();pool=new Pool({connectionString:target.testUrl.toString(),ssl:false});f=new NumberingPgFixture(pool,schema,async()=>owner());
    expect(await f.issue()).toBe('A-00037');expect((await executeNumberingCommand(await command('B','1'),f)).ok).toBe(true);expect(await f.issue()).toBe('B-00001');
    expect((await executeNumberingCommand(await command('A','1'),f))).toEqual({ok:false,reason:'would-reuse-or-rewind'});
  });
  it('canonical history blocks reuse and incomplete history blocks fresh claim',async()=>{
    await pool.query(`UPDATE ${f.schema}.history SET historical=50 WHERE prefix='A'`);
    expect((await executeNumberingCommand(await command('A','37'),f)).ok).toBe(false);
    await pool.query(`UPDATE ${f.schema}.history SET complete=false WHERE prefix='B'`);
    expect(await executeNumberingCommand(await command('B','1'),f)).toEqual({ok:false,reason:'history-unverified'});
  });
  it('concurrent allocations are unique and durable with no lost increment',async()=>{
    expect((await executeNumberingCommand(await command('A','37'),f)).ok).toBe(true);
    const issued=await Promise.all(Array.from({length:50},()=>f.issue()));
    expect(new Set(issued).size).toBe(50);expect(await f.issue()).toBe('A-00087');
  });
  it('used high P survives missing rows, but genuinely fresh B can start at one',async()=>{
    await pool.query(`SELECT setval('${f.schema}.seq_p',900000,true)`);
    expect((await executeNumberingCommand(await command('P','7000'),f)).ok).toBe(false);
    expect(await f.issue()).toBe('P-900001');
    expect((await executeNumberingCommand(await command('B','1'),f)).ok).toBe(true);expect(await f.issue()).toBe('B-00001');
  });
  it('durable same-key different intent is refused without a second audit',async()=>{
    const c=await command();expect((await executeNumberingCommand(c,f)).ok).toBe(true);
    expect(await executeNumberingCommand({...c,next:'38'},f)).toEqual({ok:false,reason:'idempotency-conflict'});
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.audit`)).rows[0].n).toBe(1);
  });

  it('allocation callback cannot be used after its transaction ends',async()=>{
    let leaked:(()=>Promise<string>)|undefined;
    await f.withAllocationTransaction(async(_c,allocate)=>{leaked=allocate;});
    await expect(leaked!()).rejects.toThrow('Allocation scope expired');
    expect(await f.issue()).toBe('P-07000');
  });
  it('refuses a pool/autocommit before consuming a number',async()=>{
    await expect(f.allocateInExistingTransaction(pool)).rejects.toThrow('Existing allocator transaction required');
    expect((await f.preview('P')).pendingNext).toBe(7000n);
    expect(await f.issue()).toBe('P-07000');
  });
  it('missing configuration fails closed instead of allocating legacy',async()=>{
    await pool.query(`DELETE FROM ${f.schema}.config`);
    await expect(f.issue()).rejects.toThrow('Numbering configuration missing');
    expect(await executeNumberingCommand({prefix:'A',next:'1',reason:'synthetic',requestId:'synthetic_missing_config',expectedRevision:'r1'},f)).toEqual({ok:false,reason:'numbering-transaction-failed'});
  });

});
