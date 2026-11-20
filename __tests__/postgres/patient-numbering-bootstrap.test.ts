import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {validatePostgresTestTarget} from './_safe-target';
import {NumberingPgFixture} from './fixtures/patient-numbering-adapter';
import {prepareLegacyFixture,bootstrapLegacyFixture,captureFixtureCheckpoint,admitRestoredFixture} from './fixtures/patient-numbering-bootstrap';
const target=validatePostgresTestTarget(process.env);const run=promisify(execFile);
let pool:Pool,f:NumberingPgFixture,restored:Pool|undefined,restoreName:string|undefined,temp:string|undefined;
let restoreIdentity:{oid:string;owner:string}|undefined;
const identitySql="SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1";
beforeEach(async()=>{pool=new Pool({connectionString:target.testUrl.toString(),ssl:false});f=new NumberingPgFixture(pool,`numbering_fixture_${randomUUID().replaceAll('-','')}`,async()=>null);await f.initialize();});
afterEach(async()=>{
  const failures:unknown[]=[];
  try{await restored?.end();}catch(error){failures.push(error);}
  try{
    if(restoreName&&restoreIdentity&&/^aqlan_numbering_restore_[a-f0-9]{32}$/.test(restoreName)){
      for(let attempt=0;;attempt++){
        const current=(await pool.query(identitySql,[restoreName])).rows;
        if(current.length!==1||JSON.stringify(current[0])!==JSON.stringify(restoreIdentity)){
          throw new Error('Owned restore database identity changed; cleanup refused');
        }
        try{await pool.query(`DROP DATABASE ${restoreName}`);break;}
        catch(error){if((error as {code?:string}).code!=='55006'||attempt===4)throw error;await delay(100);}
      }
    }
  }catch(error){failures.push(error);}
  try{await f?.dispose();}catch(error){failures.push(error);}
  try{await pool?.end();}catch(error){failures.push(error);}
  try{if(temp)await rm(temp,{recursive:true,force:true});}catch(error){failures.push(error);}
  restored=undefined;restoreName=undefined;restoreIdentity=undefined;temp=undefined;
  if(failures.length)throw new AggregateError(failures,'Synthetic bootstrap cleanup failed');
});
async function dumpRestore(publicOnly=false,afterDump?:()=>Promise<void>){
  const bin=process.env.NUMBERING_PG_BIN;if(!bin)throw new Error('NUMBERING_PG_BIN required for actual pg_dump/pg_restore witness');
  temp=await mkdtemp(join(tmpdir(),'synthetic-numbering-dump-'));const archive=join(temp,'fixture.dump');
  await run(join(bin,'pg_dump'),['--dbname',target.testUrl.toString(),'--format=custom','--no-owner','--schema',publicOnly?'public':f.schema,'--file',archive],{env:{PATH:process.env.PATH,PGCONNECT_TIMEOUT:'5',NODE_ENV:'test'}});
  await afterDump?.();restoreName=`aqlan_numbering_restore_${randomUUID().replaceAll('-','')}`;await pool.query(`CREATE DATABASE ${restoreName}`);
  restoreIdentity=(await pool.query<{oid:string;owner:string}>(identitySql,[restoreName])).rows[0];
  if(!restoreIdentity)throw new Error('Synthetic restore ownership unavailable');
  const url=new URL(target.testUrl);url.pathname=`/${restoreName}`;
  restored=new Pool({connectionString:url.toString(),ssl:false});
  if(publicOnly)await restored.query('DROP SCHEMA public'); // empty, freshly owned target only
  await run(join(bin,'pg_restore'),['--dbname',url.toString(),'--no-owner','--exit-on-error',archive],{env:{PATH:process.env.PATH,PGCONNECT_TIMEOUT:'5',NODE_ENV:'test'}});
  return new NumberingPgFixture(restored,f.schema,async()=>null);
}
describe('synthetic bootstrap and actual dump/restore witnesses',()=>{
  it.each([['37',false,'P-00037'],['900000',true,'P-900001']] as const)('preserves legacy %s called=%s and repeated bootstrap',async(last,called,next)=>{
    await prepareLegacyFixture(f,last,called,['P-00012']);await bootstrapLegacyFixture(f);await bootstrapLegacyFixture(f);
    expect((await pool.query(`SELECT last_value::text,is_called FROM ${f.schema}.seq_p`)).rows[0]).toEqual({last_value:last,is_called:called});expect(await f.issue()).toBe(next);
    await bootstrapLegacyFixture(f);expect(await f.issue()).not.toBe(next);
  });
  it('canonical history advances only its own prefix; ambiguous history aborts atomically',async()=>{
    await prepareLegacyFixture(f,'37',false,['P-00050','A-900000']);await bootstrapLegacyFixture(f);expect(await f.issue()).toBe('P-00051');expect((await f.preview('A')).allocatedThrough).toBe(900000n);
  });
  it('ambiguous stored ID refuses bootstrap without modifying pending counters',async()=>{
    await prepareLegacyFixture(f,'37',false,['A-1']);await expect(bootstrapLegacyFixture(f)).rejects.toThrow('Ambiguous legacy identifier');expect((await f.preview('P')).pendingNext).toBe(7000n);
  });
  it.each([['37',false,'P-00037'],['900000',true,'P-900001']] as const)('actual namespace dump/restore preserves %s called=%s',async(last,called,next)=>{
    await prepareLegacyFixture(f,last,called,['P-00012']);await bootstrapLegacyFixture(f);
    const checkpoint=await captureFixtureCheckpoint(f),r=await dumpRestore();await admitRestoredFixture(r,checkpoint);expect(await r.issue()).toBe(next);
  });
  it('old dump refuses issuance admission against newer external high water',async()=>{
    await prepareLegacyFixture(f,'37',false);await bootstrapLegacyFixture(f);
    const r=await dumpRestore(false,async()=>{expect(await f.issue()).toBe('P-00037');});
    await expect(admitRestoredFixture(r,await captureFixtureCheckpoint(f))).rejects.toThrow('Restored state behind trusted checkpoint');
    await expect(admitRestoredFixture(r,null)).rejects.toThrow('Trusted external checkpoint required');
  });
  it('public-only dump omits namespace and cannot pass restore admission',async()=>{
    await prepareLegacyFixture(f,'37',false);await bootstrapLegacyFixture(f);const checkpoint=await captureFixtureCheckpoint(f),r=await dumpRestore(true);
    await expect(admitRestoredFixture(r,checkpoint)).rejects.toThrow();
  });
});
