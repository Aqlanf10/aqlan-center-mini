import { beforeAll, afterAll, test, expect } from 'vitest';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { validatePostgresTestTarget } from './_safe-target';
import { resetLegacyPassword, type PasswordResetInput } from '../../scripts/security/legacy-password-reset.mjs';
import { staffLifecycleLockKey } from '../../lib/legacy-staff-schema.mjs';
const target=validatePostgresTestTarget(process.env,{allowDatabaseUrlFallback:true});
const pool=new Pool({connectionString:target.testUrl.toString(),ssl:false,max:5});
const schema=`aqlan_identity_${randomBytes(8).toString('hex')}`;
let created=false;
const password='synthetic-password-only';
const hashPassword=async(value:string)=>{const salt=randomBytes(16).toString('hex');return `scrypt:${salt}:${scryptSync(value,salt,64).toString('hex')}`;};
const verifyPassword=async(value:string,hash:string)=>{const [,salt,expected]=hash.split(':');return timingSafeEqual(scryptSync(value,salt,64),Buffer.from(expected,'hex'));};
const input={username:'synthetic',password,hashPassword,verifyPassword};
async function stored(){return (await pool.query(`SELECT password_hash FROM ${schema}.users WHERE id=1`)).rows[0].password_hash as string;}
async function reset(options:PasswordResetInput=input){const c=await pool.connect();try{await resetLegacyPassword(c,options,schema);}finally{c.release();}}
async function blockedBy(waiter:number,holder:number){const until=performance.now()+5000;while(performance.now()<until){const r=await pool.query('SELECT $2=ANY(pg_blocking_pids($1)) AS waiting',[waiter,holder]);if(r.rows[0].waiting)return;await new Promise(r=>setTimeout(r,10));}throw Error('expected exact backend blocking not observed');}
async function pid(c:PoolClient){return (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;}
beforeAll(async()=>{await pool.query(`CREATE SCHEMA ${schema}`);created=true;await pool.query(`CREATE TABLE ${schema}.parties(id integer PRIMARY KEY);CREATE TABLE ${schema}.users(id integer PRIMARY KEY,username text UNIQUE,password_hash text,permissions text);INSERT INTO ${schema}.users VALUES(1,'synthetic','synthetic-old',NULL)`);});
afterAll(async()=>{try{if(created)await pool.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await pool.end();}});
test('marker-free password reset commits verified hash',async()=>{await reset();expect(await verifyPassword(password,await stored())).toBe(true);});
test('qualified SQL ignores caller search_path',async()=>{const c=await pool.connect();try{await c.query('SET search_path TO pg_catalog');await resetLegacyPassword(c,input,schema);expect(await verifyPassword(password,await stored())).toBe(true);}finally{await c.query('RESET search_path');c.release();}});
test('failed verification rolls back hash',async()=>{const old=await stored();await expect(reset({...input,verifyPassword:async()=>false})).rejects.toThrow('VERIFICATION_FAILED');expect(await stored()).toBe(old);});
test.each(['{"revision":1}','{"grants":{},"legacy":true}','{"constructor":1}','{"__proto__":{}}'])('reserved/invalid target envelope held: %s',async permissions=>{const old=await stored();await pool.query(`UPDATE ${schema}.users SET permissions=$1`,[permissions]);try{await expect(reset()).rejects.toThrow('PERMISSION_ENVELOPE_HELD');expect(await stored()).toBe(old);}finally{await pool.query(`UPDATE ${schema}.users SET permissions=NULL`);}});
test('missing permissions column fails closed',async()=>{const old=await stored();await pool.query(`ALTER TABLE ${schema}.users RENAME COLUMN permissions TO saved_permissions`);try{await expect(reset()).rejects.toThrow();expect(await stored()).toBe(old);}finally{await pool.query(`ALTER TABLE ${schema}.users RENAME COLUMN saved_permissions TO permissions`);}});
test.each([
 'CREATE TABLE SCHEMA.staff_authority_control(id integer)',
 "CREATE FUNCTION SCHEMA.staff_subject_identity_immutable() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
 'ALTER TABLE SCHEMA.users ADD COLUMN authorization_epoch bigint',
 'CREATE INDEX users_staff_subject_identity ON SCHEMA.users(id)',
 "CREATE FUNCTION SCHEMA.synthetic_trigger() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'; CREATE TRIGGER staff_identity_current_guard BEFORE UPDATE ON SCHEMA.users FOR EACH ROW EXECUTE FUNCTION SCHEMA.synthetic_trigger()",
])('catalog marker refusal: %s',async ddl=>{
 const own=`aqlan_identity_${randomBytes(8).toString('hex')}`,c=await pool.connect();let made=false;
 try{await c.query(`CREATE SCHEMA ${own}`);made=true;await c.query(`CREATE TABLE ${own}.parties(id integer);CREATE TABLE ${own}.users(id integer,username text,password_hash text,permissions text);INSERT INTO ${own}.users VALUES(1,'synthetic','synthetic-old',NULL)`);await c.query(ddl.replaceAll('SCHEMA',own));await expect(resetLegacyPassword(c,input,own)).rejects.toThrow('AUTHORITY_SCHEMA_HELD');expect((await c.query(`SELECT password_hash FROM ${own}.users`)).rows[0].password_hash).toBe('synthetic-old');}
 finally{try{if(made)await c.query(`DROP SCHEMA ${own} CASCADE`);}finally{c.release();}}
});
test('reset shared fence excludes installer until verification and commit',async()=>{
 const resetClient=await pool.connect(),installer=await pool.connect();let release!:()=>void,entered!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});let pending:Promise<unknown>|undefined,install:Promise<unknown>|undefined;
 try{
  const resetPid=await pid(resetClient),installPid=await pid(installer);
  pending=resetLegacyPassword(resetClient,{...input,verifyPassword:async(value,hash)=>{entered();await gate;return verifyPassword(value,hash);}},schema);
  await Promise.race([ready,pending.then(()=>{throw Error('verification checkpoint not reached');})]);await installer.query('BEGIN');install=installer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[staffLifecycleLockKey(schema)]);
  await blockedBy(installPid,resetPid);release();await pending;await install;expect(await verifyPassword(password,await stored())).toBe(true);
 }finally{release?.();if(pending)await pending.catch(()=>{});await installer.query('ROLLBACK');if(install)await install.catch(()=>{});resetClient.release();installer.release();}
});
test('waiting reset observes installer marker after exclusive commit',async()=>{
 const holder=await pool.connect(),waiter=await pool.connect();let pending:Promise<unknown>|undefined;
 try{
  await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[staffLifecycleLockKey(schema)]);
  const holderPid=await pid(holder),waiterPid=await pid(waiter),old=await stored();pending=resetLegacyPassword(waiter,input,schema).then(()=>null,e=>e);
  await blockedBy(waiterPid,holderPid);await holder.query(`CREATE TABLE ${schema}.staff_identity_state(id integer)`);await holder.query('COMMIT');
  expect(await pending).toMatchObject({message:'LEGACY_STAFF_AUTHORITY_SCHEMA_HELD'});expect(await stored()).toBe(old);
 }finally{await holder.query('ROLLBACK');if(pending)await pending;holder.release();waiter.release();}
});
