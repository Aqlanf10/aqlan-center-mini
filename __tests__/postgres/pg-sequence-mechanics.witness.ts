/** PostgreSQL mechanics only: synthetic guarded CI databases are retained. */
import { randomUUID } from 'node:crypto';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client,Pool } from 'pg';
import { expect,it } from 'vitest';
import { validatePostgresTestTarget } from './_safe-target';
import { validateStandaloneWitnessEnvironment } from './_standalone-restore-witness-guard';
import { validateGeneratedDatabaseName,assertPostgres18VersionNum } from '../../scripts/verify-schema-ownership';
import { validateLocalVerificationTarget,validateOperationalVerificationEnvironment } from '../../lib/verification-target-policy.mjs';

type State={last_value:string;is_called:boolean};
const same=(a:State,b:State)=>a.last_value===b.last_value && a.is_called===b.is_called;
const state=async(pool:Pool):Promise<State>=>(await pool.query('SELECT last_value::text,is_called FROM public.synthetic_sequence')).rows[0] as State;

async function fixture() {
  // These are checked before even the maintenance connection; never reuse or
  // reset the service DB. Randomly owned test DBs remain after the case.
  validateStandaloneWitnessEnvironment(process.env);
  validateOperationalVerificationEnvironment(process.env);
  const checked=validatePostgresTestTarget(process.env);
  const admin=new Client({connectionString:checked.maintenanceUrl.toString(),ssl:false});
  let pool:Pool|undefined;
  try {
    await admin.connect();
    assertPostgres18VersionNum((await admin.query("SELECT current_setting('server_version_num') AS n")).rows[0].n);
    const name=`aqlan_schema_ownership_target_${randomUUID().replaceAll('-','')}`;
    validateGeneratedDatabaseName(name);
    if(name.length>63) throw new Error('Synthetic database name too long');
    const url=new URL(checked.testUrl);url.pathname=`/${name}`;
    validateLocalVerificationTarget(url.toString(),process.env,{varName:'OWNED_SYNTHETIC_SEQUENCE',databaseName:name});
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount).toBe(0);
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    const identity=(await admin.query("SELECT oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role FROM pg_database WHERE datname=$1",[name])).rows[0];
    if(!identity) throw new Error('Synthetic database identity missing');
    expect(identity.owner===identity.role).toBe(true);
    // A timeout applies only to future connections to this just-created DB.
    await admin.query(`ALTER DATABASE "${name}" SET statement_timeout = '55s'`);
    pool=new Pool({connectionString:url.toString(),ssl:false,max:2});
    const directory=await mkdtemp(path.join(tmpdir(),'synthetic-pg-sequence-mechanics-'));
    await writeFile(path.join(directory,'identity.json'),JSON.stringify({name,...identity})+'\n');
    async function verify(client:Pool|Client){
      const row=(await client.query("SELECT current_database() AS name,oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role,current_setting('transaction_isolation') AS isolation FROM pg_database WHERE datname=current_database()")).rows[0];
      expect(row?.name===name && row?.oid===identity.oid && row?.owner===identity.owner && row?.role===identity.owner && row?.isolation==='read committed').toBe(true);
    }
    await verify(pool);
    return {admin,pool,url,name,identity,directory,verify,async close(){try{await pool!.end();}finally{await admin.end();}}};
  } catch(error){await pool?.end().catch(()=>{});await admin.end().catch(()=>{});throw error;}
}

async function timeBound<T>(promise:Promise<T>,message:string,ms:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]);}
  finally{if(timer) clearTimeout(timer);}
}

async function unchangedDatabase(f:Awaited<ReturnType<typeof fixture>>){
  const row=(await f.admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[f.name])).rows[0];
  expect(row?.oid===f.identity.oid && row?.owner===f.identity.owner).toBe(true);
}

it('confirms baseline setval is not rolled back',async()=>{
  const f=await fixture();let client:Client|undefined;
  try {
    await f.pool.query('CREATE SEQUENCE public.synthetic_sequence START WITH 1 CACHE 1');
    await f.verify(f.pool);await f.pool.query("SELECT setval('public.synthetic_sequence',100000,false)");
    client=new Client({connectionString:f.url.toString(),ssl:false});await client.connect();await f.verify(client);
    await client.query('BEGIN');await client.query("SELECT setval('public.synthetic_sequence',75000,true)");await client.query('ROLLBACK');
    const observed=await state(f.pool);
    expect(observed.last_value==='75000' && observed.is_called===true).toBe(true);
    console.log('SYNTHETIC_BASELINE_SETVAL_SURVIVED_ROLLBACK');
    await unchangedDatabase(f);
  } finally {if(client){await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{});}await f.close();}
},90000);

it.each([false,true])('checks same-increment rewrite and rollback with is_called=%s',async called=>{
  const f=await fixture();let client:Client|undefined;
  try {
    await f.pool.query('CREATE SEQUENCE public.synthetic_sequence START WITH 1 CACHE 1');
    await f.verify(f.pool);await f.pool.query("SELECT setval('public.synthetic_sequence',100000,$1)",[called]);
    const before=await state(f.pool);
    expect(before.last_value==='100000' && before.is_called===called).toBe(true);
    client=new Client({connectionString:f.url.toString(),ssl:false});await client.connect();await f.verify(client);
    await client.query('BEGIN');
    await client.query('ALTER SEQUENCE public.synthetic_sequence INCREMENT BY 1');
    await client.query("SELECT setval('public.synthetic_sequence',75000,true)");
    expect((await client.query("SELECT nextval('public.synthetic_sequence')::text AS n")).rows[0].n==='75001').toBe(true);
    await client.query('ROLLBACK');
    const after=await state(f.pool);
    console.log(same(before,after)?'SYNTHETIC_ALTER_ROLLBACK_STATE_PRESERVED':'SYNTHETIC_ALTER_ROLLBACK_STATE_CHANGED');
    expect(same(before,after)).toBe(true);
    await unchangedDatabase(f);
  } finally {if(client){await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{});}await f.close();}
},90000);

it.each([false,true])('checks restored state after same-increment rewrite and commit with is_called=%s',async called=>{
  const f=await fixture();let client:Client|undefined;
  try {
    await f.pool.query('CREATE SEQUENCE public.synthetic_sequence START WITH 1 CACHE 1');
    await f.verify(f.pool);await f.pool.query("SELECT setval('public.synthetic_sequence',100000,$1)",[called]);
    const before=await state(f.pool);
    client=new Client({connectionString:f.url.toString(),ssl:false});await client.connect();await f.verify(client);
    await client.query('BEGIN');await client.query('ALTER SEQUENCE public.synthetic_sequence INCREMENT BY 1');
    await client.query("SELECT setval('public.synthetic_sequence',75000,true)");
    await client.query("SELECT setval('public.synthetic_sequence',100000,$1)",[called]);
    await client.query('COMMIT');
    expect(same(before,await state(f.pool))).toBe(true);
    const next=(await f.pool.query("SELECT nextval('public.synthetic_sequence')::text AS n")).rows[0].n;
    expect(next===(called?'100001':'100000')).toBe(true);
    console.log('SYNTHETIC_ALTER_COMMIT_STATE_AND_NEXT_VERIFIED');
    await unchangedDatabase(f);
  } finally {if(client){await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{});}await f.close();}
},90000);

it.each(['ROLLBACK','COMMIT'] as const)('checks same-increment rewrite blocks concurrent nextval through %s',async end=>{
  const f=await fixture();
  const writer=new Client({connectionString:f.url.toString(),ssl:false});
  const allocator=new Client({connectionString:f.url.toString(),ssl:false});
  let inTransaction=false;
  try {
    await f.pool.query('CREATE SEQUENCE public.synthetic_sequence START WITH 1 CACHE 1');
    await f.verify(f.pool);await f.pool.query("SELECT setval('public.synthetic_sequence',100000,false)");
    await writer.connect();await allocator.connect();await f.verify(writer);await f.verify(allocator);
    await writer.query('BEGIN');inTransaction=true;
    await writer.query('ALTER SEQUENCE public.synthetic_sequence INCREMENT BY 1');
    await writer.query("SELECT setval('public.synthetic_sequence',100500,false)");
    let completed=false;
    const allocated=allocator.query("SELECT nextval('public.synthetic_sequence')::text AS n")
      .then(result=>({kind:'value' as const,value:result.rows[0].n as string}),()=>({kind:'error' as const}));
    void allocated.then(()=>{completed=true;});
    const until=Date.now()+15000;let blocked=false;
    while(!completed){
      const row=(await f.pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='relation' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND relation='public.synthetic_sequence'::regclass AND NOT granted) AS waiting")).rows[0];
      if(row.waiting){blocked=true;break;}
      if(Date.now()>until)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    // Release before waiting for nextval: a successful lock must never deadlock
    // this test. An unexpected non-lock result is reported only afterwards.
    await writer.query(end);inTransaction=false;
    const result=await timeBound(allocated,'SYNTHETIC_ALLOCATION_COMPLETION_TIMEOUT',20000);
    expect(blocked,'synthetic allocation did not wait for the sequence lock').toBe(true);
    expect(result.kind==='value').toBe(true);
    if(result.kind!=='value') throw new Error('SYNTHETIC_ALLOCATION_FAILED');
    expect(result.value===(end==='ROLLBACK'?'100000':'100500')).toBe(true);
    const after=await state(f.pool);
    expect(after.last_value===result.value && after.is_called===true).toBe(true);
    console.log(end==='ROLLBACK'?'SYNTHETIC_LOCK_ROLLBACK_VERIFIED':'SYNTHETIC_LOCK_COMMIT_VERIFIED');
    await unchangedDatabase(f);
  } finally {
    if(inTransaction) await writer.query('ROLLBACK').catch(()=>{});
    await writer.end().catch(()=>{});await allocator.end().catch(()=>{});await f.close();
  }
},90000);

it('classifies prior backend cache after same-increment rewrite without assuming outcome',async()=>{
  const f=await fixture();
  const writer=new Client({connectionString:f.url.toString(),ssl:false});
  const cached=new Client({connectionString:f.url.toString(),ssl:false});
  let inTransaction=false;
  try {
    await f.pool.query('CREATE SEQUENCE public.synthetic_sequence START WITH 1 CACHE 10');
    await writer.connect();await cached.connect();await f.verify(writer);await f.verify(cached);
    const first=(await cached.query("SELECT nextval('public.synthetic_sequence')::text AS n")).rows[0].n as string;
    const reserved=(await state(f.pool)).last_value;
    expect(BigInt(reserved)>BigInt(first)).toBe(true);
    await writer.query('BEGIN');inTransaction=true;
    await writer.query('ALTER SEQUENCE public.synthetic_sequence INCREMENT BY 1 CACHE 1');
    await writer.query('COMMIT');inTransaction=false;
    const second=(await cached.query("SELECT nextval('public.synthetic_sequence')::text AS n")).rows[0].n as string;
    expect(BigInt(second)>BigInt(first)).toBe(true);
    console.log(BigInt(second)<=BigInt(reserved)?'SYNTHETIC_PRIOR_CACHE_VALUE_OBSERVED':'SYNTHETIC_PRIOR_CACHE_NOT_OBSERVED');
    const settings=(await f.pool.query("SELECT seqcache::text AS cache FROM pg_sequence WHERE seqrelid='public.synthetic_sequence'::regclass")).rows[0];
    expect(settings.cache==='1').toBe(true);
    await unchangedDatabase(f);
  } finally {
    if(inTransaction) await writer.query('ROLLBACK').catch(()=>{});
    await writer.end().catch(()=>{});await cached.end().catch(()=>{});await f.close();
  }
},90000);
