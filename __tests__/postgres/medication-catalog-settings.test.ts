import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from './_setup';
import { sessionCredentialVersion } from '../../lib/auth';
import { MEDICATION_CATALOG_KEY as KEY } from '../../lib/medication-catalog';
assertRealPostgresUrl();stubPostgresEnv();process.env.SESSION_SECRET='synthetic-catalogue-test-secret-over-32-characters';
const {ensureSchema,getPool,resetPoolForTesting,saveSettingsAudited,saveSettings}=await import('../../lib/db');
let id:number;
const entry={id:'11111111-1111-4111-8111-111111111111',revision:1,enabled:true,name:'Synthetic medicine',arabicName:'',form:'tablet',strength:'1 mg',population:'adult',amount:'',frequency:'',duration:'',instructionsAr:'',instructionsEn:'',indication:'Synthetic only',cautions:'',sourceUrl:''};
const value=()=>JSON.stringify({schemaVersion:1,entries:[entry]});
const session=()=>({userId:id,username:'catalog-test-admin',role:'admin',expiresAt:Date.now()+60000,credentialVersion:sessionCredentialVersion('synthetic-password-hash')});
const write=(v=value(),expected:string|null=null)=>saveSettingsAudited({values:{[KEY]:v},expected:{[KEY]:expected},actor:'catalog-test-admin',actorRole:'admin',reason:'Synthetic test',session:session()});
beforeAll(async()=>{await dropPublicSchema(process.env.DATABASE_URL!);await ensureSchema();id=(await getPool().query<{id:number}>("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('catalog-test-admin','Synthetic','synthetic-password-hash','admin',true) RETURNING id")).rows[0].id;});
beforeEach(async()=>{await getPool().query('DELETE FROM settings WHERE key=$1',[KEY]);await getPool().query("UPDATE users SET role='admin',is_active=true WHERE id=$1",[id]);});
afterAll(async()=>{await resetPoolForTesting();});
it('requires authenticated audited path, rejecting generic direct and missing-session writes',async()=>{await expect(saveSettings({[KEY]:value()})).rejects.toThrow('MEDICATION_CATALOG_AUDITED_WRITE_REQUIRED');await expect(saveSettingsAudited({values:{[KEY]:value()},expected:{[KEY]:null},actor:'catalog-test-admin',actorRole:'admin',reason:'test'})).rejects.toThrow('MEDICATION_CATALOG_AUTHORITY_REQUIRED');expect((await getPool().query('SELECT key FROM settings WHERE key=$1',[KEY])).rows).toHaveLength(0);});
it('serializes two initial writers and records one atomic audit',async()=>{const before=Number((await getPool().query("SELECT count(*) c FROM audit_log WHERE entity='clinic_setting' AND entity_id=$1",[KEY])).rows[0].c);const results=await Promise.all([write(),write()]);expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.filter(r=>!r.ok)).toHaveLength(1);expect(Number((await getPool().query("SELECT count(*) c FROM audit_log WHERE entity='clinic_setting' AND entity_id=$1",[KEY])).rows[0].c)).toBe(before+1);});
it('rejects revoked actor and deletion, permits revisioned disable',async()=>{await getPool().query("UPDATE users SET role='doctor' WHERE id=$1",[id]);await expect(write()).rejects.toThrow('MEDICATION_CATALOG_AUTHORITY_REQUIRED');await getPool().query("UPDATE users SET role='admin' WHERE id=$1",[id]);expect((await write()).ok).toBe(true);const version=(await getPool().query<{updated_at:Date}>('SELECT updated_at FROM settings WHERE key=$1',[KEY])).rows[0].updated_at.toISOString();expect(await write(JSON.stringify({schemaVersion:1,entries:[]}),version)).toMatchObject({ok:false});expect(await write(JSON.stringify({schemaVersion:1,entries:[{...entry,enabled:false,revision:2}]}),version)).toMatchObject({ok:true});});
it('rolls catalogue update back when audit insertion fails',async()=>{
 await getPool().query("CREATE FUNCTION synthetic_catalog_audit_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id='clinical.medication_catalog' THEN RAISE EXCEPTION 'synthetic audit refusal'; END IF; RETURN NEW; END $$");
 await getPool().query('CREATE TRIGGER synthetic_catalog_audit_refusal BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_catalog_audit_refusal()');
 try{await expect(write()).rejects.toThrow('synthetic audit refusal');expect((await getPool().query('SELECT key FROM settings WHERE key=$1',[KEY])).rows).toHaveLength(0);}finally{await getPool().query('DROP TRIGGER synthetic_catalog_audit_refusal ON audit_log');await getPool().query('DROP FUNCTION synthetic_catalog_audit_refusal()');}
});
it('revalidates role after waiting for the catalogue lock and writes no stale authority',async()=>{
 const blocker=await getPool().connect();await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtext('clinic-setting:' || $1))",[KEY]);
 const blockerPid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;
 const attempt=write().then(value=>({value,error:null as unknown}),error=>({value:null,error}));
 try {
  let waiting=false;
  for(let i=0;i<100;i++){waiting=(await getPool().query<{waiting:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND NOT l.granted AND $1=ANY(pg_blocking_pids(l.pid)) AND a.query=$2) waiting",[blockerPid,"SELECT pg_advisory_xact_lock(hashtext('clinic-setting:' || $1))"])).rows[0].waiting;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));}
  expect(waiting).toBe(true);
  await getPool().query("UPDATE users SET role='doctor' WHERE id=$1",[id]);await blocker.query('COMMIT');
  const result=await attempt;expect(String(result.error)).toContain('MEDICATION_CATALOG_AUTHORITY_REQUIRED');expect((await getPool().query('SELECT key FROM settings WHERE key=$1',[KEY])).rows).toHaveLength(0);
 } finally {await blocker.query('ROLLBACK').catch(()=>{});blocker.release();await attempt;}
});
