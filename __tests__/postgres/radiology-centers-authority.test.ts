/** Synthetic owned native PG fixture: protected settings authority/audit, no live data. */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { loadMigrationFiles,migrate } from '../../lib/migrations';
import { sessionCredentialVersion,type SessionPayload } from '../../lib/auth';
import { RADIOLOGY_CENTERS_KEY as KEY } from '../../lib/radiology-centers';
vi.mock('next/headers',()=>({headers:async()=>new Headers(),cookies:async()=>({get:()=>undefined})}));
let fixture:Awaited<ReturnType<typeof openBackupTimestampFixture>>,db:typeof import('../../lib/db');
const priorUrl=process.env.DATABASE_URL,priorSeed=process.env.SKIP_SEED;
beforeAll(async()=>{fixture=await openBackupTimestampFixture(process.env);await migrate(fixture.source,{apply:true,files:await loadMigrationFiles()});process.env.DATABASE_URL=fixture.source.options.connectionString!;process.env.SKIP_SEED='true';db=await import('../../lib/db');await db.resetPoolForTesting();await db.ensureSchema();});
afterAll(async()=>{try{await db?.resetPoolForTesting();}finally{if(priorUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=priorUrl;if(priorSeed===undefined)delete process.env.SKIP_SEED;else process.env.SKIP_SEED=priorSeed;await fixture?.close();}});
const q=(sql:string,values:unknown[]=[])=>fixture.source.query(sql,values);
async function setup(){
 const username=`center-owner-${randomUUID()}`;
 const {rows:[user]}=await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES($1,'Synthetic center owner','synthetic-center-hash','admin',true) RETURNING id",[username]);
 const session:SessionPayload={userId:user.id,username,role:'admin',credentialVersion:sessionCredentialVersion('synthetic-center-hash'),expiresAt:Date.now()+60000};
 const center={id:randomUUID(),name:'Synthetic center',address:'Synthetic address',active:true};
 await q("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[KEY,JSON.stringify([center])]);
 const expected:Record<string,string|null>=Object.fromEntries((await q("SELECT key,updated_at FROM settings WHERE key=ANY($1::text[])",[[KEY,'clinic.name']])).rows.map(row=>[row.key,row.updated_at.toISOString()]));
 if(!('clinic.name'in expected))expected['clinic.name']=null;
 const values={[KEY]:JSON.stringify([{...center,address:'Synthetic changed address'}])};
 return {session,center,expected,values,actor:username,actorRole:'admin' as const};
}
const snapshot=async()=>({rows:(await q("SELECT key,value,updated_at::text FROM settings WHERE key=ANY($1::text[]) ORDER BY key",[[KEY,'clinic.name']])).rows,audits:(await q("SELECT id,actor,entity_id FROM audit_log WHERE entity='clinic_setting' AND entity_id=ANY($1::text[]) ORDER BY id",[[KEY,'clinic.name']])).rows});
function handled<T>(promise:Promise<T>){return promise.then(value=>({ok:true as const,value}),error=>({ok:false as const,message:error instanceof Error?error.message:'unknown'}));}
async function blockedBy(pid:number,kind:'advisory'|'audit'){
 await expect.poll(async()=>{const {rows:[r]}=await q(kind==='advisory'?`
 SELECT EXISTS(SELECT 1 FROM pg_locks waiting JOIN pg_locks held ON held.pid=$1
  AND held.locktype='advisory' AND held.granted AND waiting.locktype=held.locktype
  AND waiting.database=held.database AND waiting.classid=held.classid AND waiting.objid=held.objid AND waiting.objsubid=held.objsubid
  WHERE NOT waiting.granted AND $1=ANY(pg_blocking_pids(waiting.pid))) AS blocked`:
 `SELECT EXISTS(SELECT 1 FROM pg_locks waiting WHERE waiting.relation='public.audit_log'::regclass
  AND NOT waiting.granted AND $1=ANY(pg_blocking_pids(waiting.pid))) AS blocked`,[pid]);return r.blocked;},{timeout:5000,interval:25}).toBe(true);
}
it.each(['role','credential','expiry'] as const)('revalidates %s after the exact settings advisory wait and leaves no write/audit',async kind=>{
 const f=await setup(),before=await snapshot();const blocker=new Client({connectionString:fixture.source.options.connectionString,ssl:false});let writing:ReturnType<typeof handled<Awaited<ReturnType<typeof db.saveSettingsAudited>>>>|undefined;let restoreClock:(()=>void)|undefined;
 let connected=false;try{await blocker.connect();connected=true;await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtext('clinic-setting:' || $1))",[KEY]);const pid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  writing=handled(db.saveSettingsAudited(f));await blockedBy(pid,'advisory');
  if(kind==='role')await q("UPDATE users SET role='doctor' WHERE id=$1",[f.session.userId]);
  else if(kind==='credential')await q("UPDATE users SET password_hash='synthetic-revoked' WHERE id=$1",[f.session.userId]);
  else {const clock=vi.spyOn(Date,'now').mockReturnValue(f.session.expiresAt+1);restoreClock=()=>clock.mockRestore();}
  await blocker.query('ROLLBACK');expect(await writing).toEqual({ok:false,message:'RADIOLOGY_CENTERS_AUTHORITY_REQUIRED'});
 }finally{if(connected)await blocker.query('ROLLBACK').catch(()=>{});await writing;restoreClock?.();await blocker.end();}
 expect(await snapshot()).toEqual(before);
});
it('audit failure rolls back the entire protected mixed batch, including preceding audit entries',async()=>{
 const f=await setup(),before=await snapshot();
 await q(`CREATE FUNCTION synthetic_centers_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id='clinical.radiology_centers' THEN RAISE EXCEPTION 'SYNTHETIC_CENTERS_AUDIT_FAILURE'; END IF; RETURN NEW; END $$`);
 await q('CREATE TRIGGER synthetic_centers_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_centers_audit_fail()');
 try{await expect(db.saveSettingsAudited({...f,values:{'clinic.name':'Synthetic mixed clinic',...f.values}})).rejects.toThrow('SYNTHETIC_CENTERS_AUDIT_FAILURE');expect(await snapshot()).toEqual(before);}
 finally{await q('DROP TRIGGER synthetic_centers_audit_fail ON audit_log');await q('DROP FUNCTION synthetic_centers_audit_fail()');}
});
it('expiry while the atomic audit waits rolls back settings and audit before commit',async()=>{
 const f=await setup(),before=await snapshot();const blocker=new Client({connectionString:fixture.source.options.connectionString,ssl:false});let writing:ReturnType<typeof handled<Awaited<ReturnType<typeof db.saveSettingsAudited>>>>|undefined;let restoreClock:(()=>void)|undefined;
 let connected=false;try{await blocker.connect();connected=true;await blocker.query('BEGIN');await blocker.query('LOCK TABLE audit_log IN SHARE MODE');const pid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  writing=handled(db.saveSettingsAudited(f));await blockedBy(pid,'audit');const clock=vi.spyOn(Date,'now').mockReturnValue(f.session.expiresAt+1);restoreClock=()=>clock.mockRestore();await blocker.query('ROLLBACK');expect(await writing).toEqual({ok:false,message:'RADIOLOGY_CENTERS_SESSION_EXPIRED'});
 }finally{if(connected)await blocker.query('ROLLBACK').catch(()=>{});await writing;restoreClock?.();await blocker.end();}
 expect(await snapshot()).toEqual(before);
});
it('enforces actor, CAS and audited-only entry while allowing a valid protected mixed batch',async()=>{
 const f=await setup(),before=await snapshot();
 await expect(db.saveSettingsAudited({...f,actor:'another-admin'})).rejects.toThrow('RADIOLOGY_CENTERS_AUTHORITY_REQUIRED');
 await expect(db.saveSettingsAudited({...f,session:undefined})).rejects.toThrow('RADIOLOGY_CENTERS_AUTHORITY_REQUIRED');
 await expect(db.saveSettings(f.values)).rejects.toThrow('RADIOLOGY_CENTERS_AUDITED_WRITE_REQUIRED');expect(await snapshot()).toEqual(before);
 expect(await db.saveSettingsAudited({...f,expected:{...f.expected,[KEY]:null}})).toMatchObject({ok:false,conflict:{key:KEY}});expect(await snapshot()).toEqual(before);
 expect(await db.saveSettingsAudited({...f,values:{...f.values,'clinic.name':'Synthetic committed clinic'}})).toMatchObject({ok:true,changed:expect.arrayContaining([KEY,'clinic.name'])});
 expect((await q("SELECT actor,entity_id FROM audit_log WHERE actor=$1 ORDER BY entity_id",[f.actor])).rows).toEqual([{actor:f.actor,entity_id:'clinic.name'},{actor:f.actor,entity_id:KEY}]);
});

// Future composition gate: real database atomicity when BOTH protected keys change.
const CATALOG='clinical.medication_catalog';
async function combinedSetup(){
 const f=await setup();
 const entry={id:randomUUID(),revision:1,enabled:true,name:'Synthetic medicine',arabicName:'',form:'tablet',strength:'1 mg',population:'adult',amount:'',frequency:'',duration:'',instructionsAr:'',instructionsEn:'',indication:'Synthetic only',cautions:'',sourceUrl:''};
 await q("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[CATALOG,JSON.stringify({schemaVersion:1,entries:[entry]})]);
 const stamp=(await q('SELECT updated_at FROM settings WHERE key=$1',[CATALOG])).rows[0].updated_at.toISOString();
 return {...f,reason:'Synthetic combined review',expected:{...f.expected,[CATALOG]:stamp},values:{...f.values,[CATALOG]:JSON.stringify({schemaVersion:1,entries:[{...entry,enabled:false,revision:2}]})}};
}
const combinedSnapshot=async()=>({rows:(await q('SELECT key,value,updated_at::text FROM settings WHERE key=ANY($1::text[]) ORDER BY key',[[KEY,CATALOG]])).rows,audits:(await q("SELECT id,actor,entity_id FROM audit_log WHERE entity='clinic_setting' AND entity_id=ANY($1::text[]) ORDER BY id",[[KEY,CATALOG]])).rows});
it.each([KEY,CATALOG])('combined protected command refuses a missing version for %s without either write',async key=>{
 const f=await combinedSetup(),before=await combinedSnapshot();const expected:Record<string,string|null>={...f.expected};delete expected[key];
 await expect(db.saveSettingsAudited({...f,expected})).rejects.toThrow(key===KEY?'RADIOLOGY_CENTERS_AUTHORITY_REQUIRED':'MEDICATION_CATALOG_AUTHORITY_REQUIRED');expect(await combinedSnapshot()).toEqual(before);
});
it.each([KEY,CATALOG])('combined protected command rolls back both values on stale CAS for %s',async key=>{
 const f=await combinedSetup(),before=await combinedSnapshot();expect(await db.saveSettingsAudited({...f,expected:{...f.expected,[key]:null}})).toMatchObject({ok:false,conflict:{key}});expect(await combinedSnapshot()).toEqual(before);
});
it('invalid centers cannot mutate a valid combined catalogue revision',async()=>{
 const f=await combinedSetup(),before=await combinedSnapshot();expect(await db.saveSettingsAudited({...f,values:{...f.values,[KEY]:'invalid-centers'}})).toMatchObject({ok:false});expect(await combinedSnapshot()).toEqual(before);
});
it('failure in the second protected audit rolls back BOTH setting values and the first audit',async()=>{
 const f=await combinedSetup(),before=await combinedSnapshot();
 await q("CREATE FUNCTION synthetic_combined_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id='clinical.radiology_centers' THEN RAISE EXCEPTION 'SYNTHETIC_COMBINED_AUDIT_FAILURE'; END IF; RETURN NEW; END $$");
 await q('CREATE TRIGGER synthetic_combined_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_combined_audit_fail()');
 try{await expect(db.saveSettingsAudited({...f,values:{[CATALOG]:f.values[CATALOG],[KEY]:f.values[KEY]}})).rejects.toThrow('SYNTHETIC_COMBINED_AUDIT_FAILURE');expect(await combinedSnapshot()).toEqual(before);}
 finally{await q('DROP TRIGGER synthetic_combined_audit_fail ON audit_log');await q('DROP FUNCTION synthetic_combined_audit_fail()');}
});
it('valid combined command commits both protected values with one audit each under the canonical actor',async()=>{
 const f=await combinedSetup();expect(await db.saveSettingsAudited(f)).toMatchObject({ok:true,changed:expect.arrayContaining([KEY,CATALOG])});
 expect((await q("SELECT actor,entity_id FROM audit_log WHERE actor=$1 ORDER BY entity_id",[f.actor])).rows).toEqual([{actor:f.actor,entity_id:CATALOG},{actor:f.actor,entity_id:KEY}]);
});
