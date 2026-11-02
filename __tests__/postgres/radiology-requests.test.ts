/** Native PostgreSQL only. Synthetic isolated DBs; no application/live data. */
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { migrate, loadMigrationFiles } from '../../lib/migrations';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { stagedRestore } from '../../lib/restore/staging';
import { sessionCredentialVersion } from '../../lib/auth';
import { issueRadiologyRequest, recoverRadiologyRequest, readRadiologyRequest } from '../../lib/radiology-request-service';
import { assertNoRadiologyRequestHistory } from '../../lib/clinic-reset';
vi.mock('next/headers',()=>({headers:async()=>new Headers(),cookies:async()=>({get:()=>undefined})}));
let fixture:Awaited<ReturnType<typeof openBackupTimestampFixture>>,db:typeof import('../../lib/db'),directory:string;
const priorUrl=process.env.DATABASE_URL,priorSeed=process.env.SKIP_SEED;
beforeAll(async()=>{fixture=await openBackupTimestampFixture(process.env);directory=await mkdtemp(join(tmpdir(),'radiology-native-'));await migrate(fixture.source,{apply:true,files:await loadMigrationFiles()});process.env.DATABASE_URL=fixture.source.options.connectionString!;process.env.SKIP_SEED='true';vi.stubEnv('SESSION_SECRET','synthetic-radiology-native-secret-at-least-32-characters');db=await import('../../lib/db');await db.resetPoolForTesting();await db.ensureSchema();});
afterAll(async()=>{await db?.resetPoolForTesting();if(priorUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=priorUrl;if(priorSeed===undefined)delete process.env.SKIP_SEED;else process.env.SKIP_SEED=priorSeed;vi.unstubAllEnvs();await fixture?.close();if(directory)await rm(directory,{recursive:true,force:true});});
const query=(sql:string,values:unknown[]=[])=>fixture.source.query(sql,values);
async function setup(){
 const username=`radiology-${randomUUID()}`;
 const {rows:[doctor]}=await query("INSERT INTO parties(name,kind) VALUES('Synthetic imaging doctor','doctor') RETURNING id");
 const {rows:[user]}=await query("INSERT INTO users(username,display_name,password_hash,role,is_active,party_id,permissions) VALUES($1,'Synthetic clinician','synthetic-radiology-hash','doctor',true,$2,'{\"canViewAllPatients\":true}') RETURNING id",[username,doctor.id]);
 const {rows:[patient]}=await query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic imaging patient') RETURNING id",[`RAD-${randomUUID()}`]);
 const {rows:[visit]}=await query("INSERT INTO visits(patient_id,patient_name,doctor_id) VALUES($1,'Synthetic visit',$2) RETURNING id",[patient.id,doctor.id]);
 const centerId=randomUUID();await query("INSERT INTO settings(key,value) VALUES('clinical.radiology_centers',$1),('clinic.name','Synthetic clinic') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify([{id:centerId,name:'Original synthetic center',address:'Original synthetic address',active:true}])]);
 return {key:randomUUID(),draft:{patientId:patient.id as number,visitId:visit.id as number,centerId,examination:'Synthetic examination',region:'Synthetic area',notes:'Synthetic request notes'},session:{userId:user.id as number,username,role:'doctor',expiresAt:Date.now()+60000,credentialVersion:sessionCredentialVersion('synthetic-radiology-hash')}};
}
it('one committed receipt/audit survives concurrent same-key delivery and center edits',async()=>{
 const f=await setup();const results=await Promise.all([issueRadiologyRequest(f.session,f.key,f.draft),issueRadiologyRequest(f.session,f.key,f.draft)]);expect(results.map(x=>x.replayed).sort()).toEqual([false,true]);
 await query("UPDATE settings SET value='[]' WHERE key='clinical.radiology_centers'");expect((await recoverRadiologyRequest(f.session,f.key,f.draft.patientId,f.draft.visitId))).toMatchObject({state:'completed',snapshot:{centerName:'Original synthetic center',centerAddress:'Original synthetic address'}});
 expect((await query('SELECT count(*)::int n FROM radiology_requests WHERE command_key=$1',[f.key])).rows[0].n).toBe(1);expect((await query("SELECT count(*)::int n FROM audit_log WHERE action='radiology_request.create' AND actor=$1",[f.session.username])).rows[0].n).toBe(1);
 await expect(issueRadiologyRequest(f.session,f.key,{...f.draft,notes:'changed'})).rejects.toMatchObject({status:409});
 await expect(query('UPDATE radiology_requests SET snapshot=snapshot WHERE command_key=$1',[f.key])).rejects.toThrow('HISTORY_RETAINED');await expect(query('DELETE FROM radiology_requests WHERE command_key=$1',[f.key])).rejects.toThrow('HISTORY_RETAINED');await expect(query('TRUNCATE radiology_requests')).rejects.toThrow('HISTORY_RETAINED');
 const client=await fixture.source.connect();try{await client.query('BEGIN');await expect(assertNoRadiologyRequestHistory(client)).rejects.toThrow();}finally{await client.query('ROLLBACK');client.release();}
 expect(await db.deleteVisit(f.draft.visitId,{actor:f.session.username})).toMatchObject({ok:false,reason:'has_radiology_history'});
});
it.each(['patients','visits'] as const)('writer-first %s row lock rolls back issuance; same key succeeds after lock release',async table=>{
 const f=await setup(),blocker=await db.getPool().connect();try{await blocker.query('BEGIN');await blocker.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`,[table==='patients'?f.draft.patientId:f.draft.visitId]);await expect(issueRadiologyRequest(f.session,f.key,f.draft)).rejects.toMatchObject({code:'55P03'});expect((await query('SELECT command_key FROM radiology_requests WHERE command_key=$1',[f.key])).rows).toEqual([]);}finally{await blocker.query('ROLLBACK');blocker.release();}expect(await issueRadiologyRequest(f.session,f.key,f.draft)).toMatchObject({id:f.key,replayed:false});
});
async function blocked(pattern:string){const deadline=Date.now()+5000;while(Date.now()<deadline){const {rows:[row]}=await query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE $1) AS blocked",[pattern]);if(row.blocked)return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Expected native lock wait not observed');}
it.each(['delete','merge','relink','reset'] as const)('issuance-first holds locks until audit commits; actual %s writer then refuses',async kind=>{
 // Reset reserves backup + transaction connections; the default app pool has three.
 // Keep the synthetic audit blocker outside that pool so the writer reaches its SQL fence.
 const f=await setup(),blocker=new Client({connectionString:fixture.source.options.connectionString,ssl:false});
 const {rows:[target]}=await query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic race target') RETURNING id",[`RAD-RACE-${randomUUID()}`]);
 const backup=vi.fn(async()=>({ok:true as const,backupId:null}));
 let issued:ReturnType<typeof issueRadiologyRequest>|undefined,writer:Promise<unknown>|undefined;
 await blocker.connect();
 try{await blocker.query('BEGIN');await blocker.query('LOCK TABLE audit_log IN SHARE MODE');issued=issueRadiologyRequest(f.session,f.key,f.draft);await blocked('%INSERT INTO audit_log%');
  writer=kind==='delete'?db.deleteVisit(f.draft.visitId,{actor:f.session.username}):kind==='merge'?db.mergeDuplicatePatient(f.draft.patientId,target.id,{actor:f.session.username}):kind==='relink'?db.linkVisitToPatient(f.draft.visitId,target.id):db.resetClinicData({actor:'synthetic-reset-race',actorRole:'admin'},backup).catch(error=>({protectedError:error.name}));
  await blocked(kind==='reset'?'%LOCK TABLE radiology_requests IN EXCLUSIVE MODE%':kind==='merge'?'%FROM patients%FOR UPDATE%':'%FROM visits%FOR UPDATE%');
 }finally{await blocker.query('ROLLBACK');await blocker.end();}
 expect(await issued).toMatchObject({id:f.key});expect(await writer).toMatchObject(kind==='reset'?{protectedError:'ProtectedRadiologyHistoryError'}:{ok:false});expect(backup).not.toHaveBeenCalled();
 expect((await query('SELECT patient_id,visit_id FROM radiology_requests WHERE command_key=$1',[f.key])).rows[0]).toEqual({patient_id:f.draft.patientId,visit_id:f.draft.visitId});
});
it('official SQL and fullarchive restore preserve issued receipt byte identity and replay without duplicate',async()=>{
 const f=await setup();await issueRadiologyRequest(f.session,f.key,f.draft);
 const before=(await query('SELECT to_jsonb(r)::text AS row FROM radiology_requests r ORDER BY command_key')).rows;
 const client=await fixture.source.connect();let sql='';const blocks:Uint8Array[]=[];
 try{for await(const line of db.backupSqlLines(client))sql+=line;for await(const b of fullBackupBlocks({source:client,readDocument:async()=>{throw new Error('No synthetic documents');}}))blocks.push(b);}finally{client.release();}
 const sqlPath=join(directory,'backup.sql'),archivePath=join(directory,'backup.tar.gz');await writeFile(sqlPath,sql);await writeFile(archivePath,gzipSync(Buffer.concat(blocks)));
 process.env.DATABASE_URL=fixture.sqlTarget.options.connectionString!;await db.resetPoolForTesting();await db.ensureSchema();const restored=await promisify(execFile)(process.execPath,['scripts/restore.mjs',sqlPath],{env:{...process.env}});expect(restored.stdout).toContain('تمت الاستعادة');
 const result=await stagedRestore({archivePath,targetUrl:fixture.archiveTarget.options.connectionString!,stagingDir:join(directory,'documents')});expect(result.errors).toEqual([]);expect(result.readyForCutover).toBe(true);
 for(const target of [fixture.sqlTarget,fixture.archiveTarget]){expect((await target.query('SELECT to_jsonb(r)::text AS row FROM radiology_requests r ORDER BY command_key')).rows).toEqual(before);process.env.DATABASE_URL=target.options.connectionString!;await db.resetPoolForTesting();expect(await issueRadiologyRequest({...f.session,expiresAt:Date.now()+60000},f.key,f.draft)).toMatchObject({id:f.key,replayed:true});expect((await readRadiologyRequest({...f.session,expiresAt:Date.now()+60000},f.key,f.draft.patientId)).snapshot.centerAddress).toBe('Original synthetic address');}
 process.env.DATABASE_URL=fixture.source.options.connectionString!;await db.resetPoolForTesting();
},180000);

it.each(['merge','relink'] as const)('receipt-bearing %s refuses without changing historical scope',async kind=>{
 const f=await setup();await issueRadiologyRequest(f.session,f.key,f.draft);const {rows:[target]}=await query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic target') RETURNING id",[`RAD-TARGET-${randomUUID()}`]);
 const result=kind==='merge'?await db.mergeDuplicatePatient(f.draft.patientId,target.id,{actor:f.session.username}):await db.linkVisitToPatient(f.draft.visitId,target.id);
 expect(result).toMatchObject({ok:false});expect((await query('SELECT patient_id,visit_id FROM radiology_requests WHERE command_key=$1',[f.key])).rows[0]).toEqual({patient_id:f.draft.patientId,visit_id:f.draft.visitId});expect((await query('SELECT patient_id FROM visits WHERE id=$1',[f.draft.visitId])).rows[0].patient_id).toBe(f.draft.patientId);
});
it('reset refuses before backup or wipe when radiology history exists',async()=>{const backup=vi.fn(async()=>({ok:true as const,backupId:null}));await expect(db.resetClinicData({actor:'synthetic-reset',actorRole:'admin'},backup)).rejects.toMatchObject({name:'ProtectedRadiologyHistoryError'});expect(backup).not.toHaveBeenCalled();});
it.each(['trigger','index','function','registry','snapshot_check'] as const)('native catalog %s tamper is refused without adopting it',async kind=>{
 const {validateRadiologyRequestMigration,RADIOLOGY_REQUEST_MIGRATIONS}=await import('../../lib/radiology-request-migration');const client=await fixture.source.connect();
 try{await client.query('BEGIN');if(kind==='trigger')await client.query('ALTER TABLE radiology_requests DISABLE TRIGGER radiology_request_immutable');if(kind==='index')await client.query('DROP INDEX radiology_requests_patient_history');if(kind==='function')await client.query("CREATE OR REPLACE FUNCTION aqlan_radiology_request_truncate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");if(kind==='registry')await client.query("UPDATE schema_migrations SET checksum=$1 WHERE version='0094'",['0'.repeat(64)]);if(kind==='snapshot_check')await client.query('ALTER TABLE radiology_requests DROP CONSTRAINT radiology_snapshot_valid');const {rows:applied}=await client.query('SELECT version,name,checksum,adopted FROM schema_migrations');await expect(validateRadiologyRequestMigration(client,RADIOLOGY_REQUEST_MIGRATIONS,applied)).rejects.toThrow('CATALOG_MISMATCH');}finally{await client.query('ROLLBACK');client.release();}
});
