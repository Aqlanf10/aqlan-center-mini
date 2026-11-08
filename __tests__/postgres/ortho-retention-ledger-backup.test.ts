import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {beforeAll,afterAll,expect,it,vi} from 'vitest';
import {openBackupTimestampFixture} from './_backup-timestamp-fixture';
import {journeyContentHash} from '../../lib/ortho-case-journey-hash';
import {fullBackupBlocks} from '../../lib/fullBackup';
import {stagedRestore} from '../../lib/restore/staging';
import {ProtectedOrthoRetentionHistoryError} from '../../lib/clinic-reset';
import type {RetentionEvent} from '../../lib/ortho-retention-events';
let f:Awaited<ReturnType<typeof openBackupTimestampFixture>>,db:typeof import('../../lib/db'),directory:string;
let patient:number,ortho:number,bridge:number,actor:number;
let delivery:number,review:number,correction:number;
const snapshot=async(pool:typeof f.source)=>({
 entries:(await pool.query('SELECT to_jsonb(t)::text value FROM ortho_retention_entries t ORDER BY id')).rows,
 submissions:(await pool.query('SELECT to_jsonb(t)::text value FROM ortho_retention_submissions t ORDER BY id')).rows,
});
const occurrence={occurredOn:null,dateProvenance:'unknown' as const,sourceNote:''};
const reviewPayload=(deviceId:number,expectedDeviceRevisionId:number):RetentionEvent=>({kind:'device_review',device:{deviceId,expectedDeviceRevisionId},occurrence,note:'Synthetic review',documentIds:[],observations:Object.fromEntries(['fit','breakage','loss','hygiene','adherence','relapse'].map(k=>[k,{state:'unknown',note:''}])) as Extract<RetentionEvent,{kind:'device_review'}>['observations']});
async function record(payload:RetentionEvent,version:number,predecessor:number|null,supersedes:number|null=null,acknowledge=true,arch='upper',archCorrectionReason:string|null=null){
 const client=await f.source.connect();
 try{
  await client.query('BEGIN');
  const command={schemaVersion:2,clientRequestId:randomUUID(),expectedHeadId:predecessor,reason:'Synthetic documented event',arch,supersedesEntryId:supersedes,archCorrectionReason,content:payload,expectedDocuments:[]};
  const content={savedVersion:2,arch,supersedesEntryId:supersedes,archCorrectionReason,payload,documentWitnesses:[]};
  const device='device' in payload?payload.device:null,replaces=payload.kind==='device_replacement'?payload.replaces:null;
  const j=(await client.query("INSERT INTO ortho_retention_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,state) VALUES($1,$1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id",[patient,ortho,bridge,actor,command.clientRequestId,journeyContentHash(command),command])).rows[0].id;
  const id=(await client.query(`INSERT INTO ortho_retention_entries(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,version,predecessor_id,actor_user_id,created_by,reason,recording_context,case_status_at_capture,command_id,request_fingerprint,content_sha256,content,arch,entry_kind,supersedes_entry_id,device_entry_id,replaces_device_id,expected_device_revision_id)
   VALUES($1,$1,$2,$3,$4,$5,$6,'Synthetic recorder',$7,'current','active',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,[patient,ortho,bridge,version,predecessor,actor,command.reason,command.clientRequestId,journeyContentHash(command),journeyContentHash(content),content,arch,payload.kind,supersedes,device?.deviceId??null,replaces?.deviceId??null,device?.expectedDeviceRevisionId??replaces?.expectedDeviceRevisionId??null])).rows[0].id;
  await client.query("UPDATE ortho_retention_submissions SET state='committed',entry_id=$2,settled_at=clock_timestamp() WHERE id=$1",[j,id]);
  if(acknowledge)await client.query('UPDATE ortho_retention_submissions SET acknowledged_at=clock_timestamp(),command=NULL WHERE id=$1',[j]);
  await client.query('COMMIT');return id as number;
 }finally{await client.query('ROLLBACK');client.release();}
}
beforeAll(async()=>{
 f=await openBackupTimestampFixture(process.env);directory=await mkdtemp(join(tmpdir(),'retention-ledger-restore-'));
 vi.stubEnv('DATABASE_URL',f.source.options.connectionString!);vi.stubEnv('SKIP_SEED','true');
 db=await import('../../lib/db');await db.resetPoolForTesting();await db.ensureSchema();
 patient=(await f.source.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic retention restore') RETURNING id",[randomUUID()])).rows[0].id;
 actor=(await f.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic recorder','synthetic','admin') RETURNING id",[randomUUID()])).rows[0].id;
 ortho=(await f.source.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'active','synthetic') RETURNING id",[patient])).rows[0].id;
 bridge=(await f.source.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id",[patient,ortho])).rows[0].id;
 delivery=await record({kind:'device_delivery',deviceType:'removable',description:'Synthetic device',extent:'Synthetic extent',labOrderId:null,occurrence,note:'',documentIds:[]},1,null);
 review=await record(reviewPayload(delivery,delivery),2,delivery);
 correction=await record({...reviewPayload(delivery,review),note:'Synthetic corrected review'},3,review,review);
 // Reverse physical order forces child-before-parent restoration, with triggers enabled.
 await f.source.query('CREATE INDEX synthetic_retention_reverse ON ortho_retention_entries(id DESC); CLUSTER ortho_retention_entries USING synthetic_retention_reverse; DROP INDEX synthetic_retention_reverse; CREATE INDEX synthetic_retention_journal_reverse ON ortho_retention_submissions(id DESC); CLUSTER ortho_retention_submissions USING synthetic_retention_journal_reverse; DROP INDEX synthetic_retention_journal_reverse');
 expect((await f.source.query('SELECT id FROM ortho_retention_entries')).rows.map(r=>r.id)).toEqual([correction,review,delivery]);
 const client=await f.source.connect();try{
  let sql='';for await(const line of db.backupSqlLines(client))sql+=line;await writeFile(join(directory,'backup.sql'),sql);
  const blocks:Uint8Array[]=[];for await(const block of fullBackupBlocks({source:client,readDocument:async()=>{throw Error('No documents in synthetic fixture');}}))blocks.push(block);await writeFile(join(directory,'backup.tar.gz'),gzipSync(Buffer.concat(blocks)));
 }finally{client.release();}
});
afterAll(async()=>{try{await db?.resetPoolForTesting();}finally{vi.unstubAllEnvs();await f?.close();if(directory)await rm(directory,{recursive:true,force:true});}});
it.each(['sql','archive'] as const)('restores exact delivery, review, correction and scrubbed receipts through %s',async kind=>{
 const target=kind==='sql'?f.sqlTarget:f.archiveTarget;
 if(kind==='sql'){
  vi.stubEnv('DATABASE_URL',target.options.connectionString!);await db.resetPoolForTesting();await db.ensureSchema();
  expect((await promisify(execFile)(process.execPath,['scripts/restore.mjs',join(directory,'backup.sql')],{env:{...process.env}})).stdout).toContain('تمت الاستعادة');
 }else{
  await db.resetPoolForTesting();const restored=await stagedRestore({archivePath:join(directory,'backup.tar.gz'),targetUrl:target.options.connectionString!,stagingDir:join(directory,'documents')});expect(restored.errors).toEqual([]);expect(restored.ok).toBe(true);
 }
 expect(await snapshot(target)).toEqual(await snapshot(f.source));
 await expect(target.query("UPDATE ortho_retention_entries SET reason='changed'")).rejects.toMatchObject({code:'55000'});
 await expect(target.query('DELETE FROM ortho_retention_submissions')).rejects.toMatchObject({code:'55000'});
 await expect(target.query('TRUNCATE ortho_retention_entries CASCADE')).rejects.toThrow();
 vi.stubEnv('DATABASE_URL',f.source.options.connectionString!);await db.resetPoolForTesting();
});
it('refuses reset and merge on either side of committed retention history',async()=>{
 const other=(await f.source.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic other') RETURNING id",[randomUUID()])).rows[0].id;
 let backup=false;await expect(db.resetClinicData({actor:'synthetic',actorRole:'admin'},async()=>{backup=true;return {ok:false,failure:'must not run'};})).rejects.toBeInstanceOf(ProtectedOrthoRetentionHistoryError);expect(backup).toBe(false);
 for(const [source,target] of [[patient,other],[other,patient]])expect(await db.mergeDuplicatePatient(source,target,{actor:'synthetic',actorRole:'admin'})).toMatchObject({ok:false,reason:'source_has_clinical_command_history',counts:{orthoRetentionHistory:6}});
});
it('rejects stale device heads and correction arch changes without reasons',async()=>{
 await expect(record(reviewPayload(delivery,review),4,correction)).rejects.toThrow(/latest event/);
 await expect(record({...reviewPayload(delivery,correction),note:'arch mismatch'},4,correction,correction,true,'lower')).rejects.toThrow(/lineage/);
});
it('enforces replacement roots, correction targets and version-order device ancestry',async()=>{
 const replacementPayload:RetentionEvent={kind:'device_replacement',deviceType:'removable',description:'Synthetic replacement',extent:'Synthetic extent',labOrderId:null,occurrence,note:'',documentIds:[],replaces:{deviceId:delivery,expectedDeviceRevisionId:correction}};
 const replacement=await record(replacementPayload,4,correction);
 const correctedReplacement=await record({...replacementPayload,note:'Corrected replacement description',replaces:{deviceId:delivery,expectedDeviceRevisionId:replacement}},5,replacement,replacement);
 await expect(record({...replacementPayload,replaces:{deviceId:delivery,expectedDeviceRevisionId:correctedReplacement}},6,correctedReplacement)).rejects.toThrow(/already has a replacement/);
 await expect(record(reviewPayload(replacement,correctedReplacement),6,correctedReplacement,correction)).rejects.toThrow(/lineage/);
 // Sequence order is not case chronology. Synthetic fixture only; normal inserts
 // continue to use version/predecessor and the expected event, not numeric IDs.
 await f.source.query("SELECT setval('ortho_retention_entries_id_seq',10000)");
 const newDelivery=await record({kind:'device_delivery',deviceType:'fixed',description:'Synthetic second device',extent:'Synthetic extent',labOrderId:null,occurrence,note:'',documentIds:[]},6,correctedReplacement);
 await f.source.query("SELECT setval('ortho_retention_entries_id_seq',500)");
 const lowerIdReview=await record(reviewPayload(newDelivery,newDelivery),7,newDelivery);
 expect(lowerIdReview).toBeLessThan(newDelivery);
 const next=await record(reviewPayload(newDelivery,lowerIdReview),8,lowerIdReview);
 expect((await f.source.query('SELECT version FROM ortho_retention_entries WHERE id=$1',[next])).rows[0].version).toBe(8);
});
