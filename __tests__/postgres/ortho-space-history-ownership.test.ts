import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { stagedRestore } from "../../lib/restore/staging";
import { ProtectedOrthoSpaceHistoryError } from "../../lib/clinic-reset";
let f: Awaited<ReturnType<typeof openBackupTimestampFixture>>, db: typeof import("../../lib/db"), directory: string;
let actor: number;
const snapshot = async (pool: typeof f.source) => (await pool.query("SELECT to_jsonb(t)::text value FROM ortho_space_submissions t ORDER BY id")).rows;
async function scope() {
 const patient=(await f.source.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic space ownership') RETURNING id",[randomUUID()])).rows[0].id;
 const ortho=(await f.source.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'synthetic') RETURNING id",[patient])).rows[0].id;
 const clinical=(await f.source.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic',$2,'synthetic') RETURNING id",[patient,ortho])).rows[0].id;
 return {patient,ortho,clinical};
}
beforeAll(async()=>{
 f=await openBackupTimestampFixture(process.env); directory=await mkdtemp(join(tmpdir(),'space-ownership-'));
 vi.stubEnv('DATABASE_URL',f.source.options.connectionString!);vi.stubEnv('SKIP_SEED','true');
 db=await import('../../lib/db');await db.resetPoolForTesting();await db.ensureSchema();
 actor=(await f.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-space-owner','Synthetic','not-real','admin') RETURNING id")).rows[0].id;
});
afterAll(async()=>{try{await db?.resetPoolForTesting();}finally{vi.unstubAllEnvs();await f?.close();if(directory)await rm(directory,{recursive:true,force:true});}});
it.each(['pending','cancelled','acknowledged'] as const)('preserves %s intent on reset and either side of patient merge',async state=>{
 const o=await scope(),other=await scope();
 const row=(await f.source.query(`INSERT INTO ortho_space_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,state,settled_at)
 VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8='pending' THEN NULL ELSE clock_timestamp() END) RETURNING id`,[o.patient,o.ortho,o.clinical,actor,randomUUID(),'a'.repeat(64),state==='pending'?{}:null,state==='pending'?'pending':'cancelled'])).rows[0];
 if(state==='acknowledged')await f.source.query('UPDATE ortho_space_submissions SET acknowledged_at=clock_timestamp() WHERE id=$1',[row.id]);
 let backup=false;await expect(db.resetClinicData({actor:'synthetic',actorRole:'admin'},async()=>{backup=true;return {ok:false,failure:'must not run'};})).rejects.toBeInstanceOf(ProtectedOrthoSpaceHistoryError);expect(backup).toBe(false);
 for(const [source,target] of [[o.patient,other.patient],[other.patient,o.patient]])expect(await db.mergeDuplicatePatient(source,target,{actor:'synthetic',actorRole:'admin'})).toMatchObject({ok:false,reason:'source_has_clinical_command_history',counts:{orthoSpaceHistory:1}});
});
it.each(['sql','archive'] as const)('round trips pending and cancellation tombstones through %s restore',async kind=>{
 const client=await f.source.connect();
 try{
  if(kind==='sql'){let sql='';for await(const line of db.backupSqlLines(client))sql+=line;await writeFile(join(directory,'backup.sql'),sql);}
  else{const blocks:Uint8Array[]=[];for await(const block of fullBackupBlocks({source:client,readDocument:async()=>{throw Error('No files expected');}}))blocks.push(block);await writeFile(join(directory,'backup.tar.gz'),gzipSync(Buffer.concat(blocks)));}
 }finally{client.release();}
 const target=kind==='sql'?f.sqlTarget:f.archiveTarget;
 if(kind==='sql'){
  vi.stubEnv('DATABASE_URL',target.options.connectionString!);await db.resetPoolForTesting();await db.ensureSchema();
  expect((await promisify(execFile)(process.execPath,['scripts/restore.mjs',join(directory,'backup.sql')],{env:{...process.env}})).stdout).toContain('تمت الاستعادة');
 }else{
  await db.resetPoolForTesting();const result=await stagedRestore({archivePath:join(directory,'backup.tar.gz'),targetUrl:target.options.connectionString!,stagingDir:join(directory,'documents')});expect(result.errors).toEqual([]);expect(result.ok).toBe(true);
 }
 expect(await snapshot(target)).toEqual(await snapshot(f.source));
 await expect(target.query('DELETE FROM ortho_space_submissions')).rejects.toMatchObject({code:'55000'});
 vi.stubEnv('DATABASE_URL',f.source.options.connectionString!);await db.resetPoolForTesting();
});
