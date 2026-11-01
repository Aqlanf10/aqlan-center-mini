import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';import {join} from 'node:path';import {gzipSync} from 'node:zlib';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {openBackupTimestampFixture} from './_backup-timestamp-fixture';
import {migrate,loadMigrationFiles,applyRuntimeMigrationFiles} from '../../lib/migrations';
import {PRESCRIPTION_LINEAGE_MIGRATIONS as lineage} from '../../lib/prescription-migration-lineage';
import {fullBackupBlocks} from '../../lib/fullBackup';import {stagedRestore} from '../../lib/restore/staging';
vi.mock('next/headers',()=>({headers:async()=>new Headers(),cookies:async()=>({get:()=>undefined})}));
let fixture:Awaited<ReturnType<typeof openBackupTimestampFixture>>,directory:string;
const priorUrl=process.env.DATABASE_URL,priorSeed=process.env.SKIP_SEED;
let db:typeof import('../../lib/db');
beforeEach(async()=>{fixture=await openBackupTimestampFixture(process.env);directory=await mkdtemp(join(tmpdir(),'rx-lineage-restore-'));db=await import('../../lib/db');});
afterEach(async()=>{await db?.resetPoolForTesting();if(priorUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=priorUrl;if(priorSeed===undefined)delete process.env.SKIP_SEED;else process.env.SKIP_SEED=priorSeed;await fixture?.close();if(directory)await rm(directory,{recursive:true,force:true});});
it.each([false,true])('SQL and full archive restore known0090 with populated booking table=%s; target owns compatible lineage',async populated=>{
 const files=await loadMigrationFiles();await migrate(fixture.source,{apply:true,files:files.filter(f=>f.version<'0090')});
 await applyRuntimeMigrationFiles(fixture.source,[lineage[0]]);
 if(populated)await fixture.source.query("INSERT INTO booking_requests(full_name,phone,request_key,request_hash,preferences) VALUES('Synthetic booking','000000000','fixture-key','fixture-hash','{\"fixture\":true}')");
 const {rows:[patient]}=await fixture.source.query("INSERT INTO patients(patient_number,full_name) VALUES('RX-RESTORE-SYNTHETIC','Synthetic legacy patient') RETURNING id");
 await fixture.source.query("INSERT INTO prescriptions(patient_id,items,created_by) VALUES($1,'[{\"name\":\"SyntheticLegacyRx\"}]','synthetic-original-actor')",[patient.id]);
 const sourceRegistry=(await fixture.source.query('SELECT to_jsonb(r)::text AS row FROM schema_migrations r ORDER BY version')).rows;
 const expected=(await fixture.source.query('SELECT to_jsonb(b)::text AS row FROM booking_requests b ORDER BY id')).rows;
 const client=await fixture.source.connect();let sql='',archive:Buffer;
 try{for await(const line of db.backupSqlLines(client))sql+=line;const blocks:Uint8Array[]=[];for await(const b of fullBackupBlocks({source:client,readDocument:async()=>{throw new Error('No documents in synthetic fixture');}}))blocks.push(b);archive=gzipSync(Buffer.concat(blocks));}finally{client.release();}
 await writeFile(join(directory,'backup.sql'),sql);await writeFile(join(directory,'backup.tar.gz'),archive!);
 process.env.DATABASE_URL=fixture.sqlTarget.options.connectionString!;process.env.SKIP_SEED='true';await db.resetPoolForTesting();await db.ensureSchema();
 const restored=await promisify(execFile)(process.execPath,['scripts/restore.mjs',join(directory,'backup.sql')],{env:{...process.env}});expect(restored.stdout).toContain('تمت الاستعادة');
 const result=await stagedRestore({archivePath:join(directory,'backup.tar.gz'),targetUrl:fixture.archiveTarget.options.connectionString!,stagingDir:join(directory,'documents')});expect(result.errors).toEqual([]);expect(result.readyForCutover).toBe(true);
 for(const target of [fixture.sqlTarget,fixture.archiveTarget]){
  expect((await target.query('SELECT to_jsonb(b)::text AS row FROM booking_requests b ORDER BY id')).rows).toEqual(expected);
  expect((await target.query("SELECT version,name,checksum,adopted FROM schema_migrations WHERE version>='0090' ORDER BY version")).rows).toEqual(lineage.map(({version,name,checksum})=>({version,name,checksum,adopted:false})));
  expect((await target.query('SELECT items,created_by,prescribing_doctor_name,prescribing_doctor_party_id FROM prescriptions')).rows).toEqual([{items:[{name:'SyntheticLegacyRx'}],created_by:'synthetic-original-actor',prescribing_doctor_name:null,prescribing_doctor_party_id:null}]);
  expect(await applyRuntimeMigrationFiles(target,lineage)).toEqual([]);
 }
 expect((await fixture.source.query('SELECT to_jsonb(r)::text AS row FROM schema_migrations r ORDER BY version')).rows).toEqual(sourceRegistry);
},120_000);

it.each(['wrong_checksum','former_rx0090'])('both restore entrypoints reject %s before connecting to an unavailable target',async kind=>{
 const files=await loadMigrationFiles();await migrate(fixture.source,{apply:true,files:files.filter(f=>f.version<'0090')});
 await applyRuntimeMigrationFiles(fixture.source,[lineage[0]]);
 await fixture.source.query("UPDATE schema_migrations SET checksum=$1,name=$2 WHERE version='0090'",[kind==='former_rx0090'?lineage[2].checksum:'0'.repeat(64),kind==='former_rx0090'?'prescribing_doctor_snapshot':lineage[0].name]);
 const client=await fixture.source.connect();let sql='';const blocks:Uint8Array[]=[];
 try{for await(const line of db.backupSqlLines(client))sql+=line;for await(const block of fullBackupBlocks({source:client,readDocument:async()=>{throw new Error('No fixture documents');}}))blocks.push(block);}finally{client.release();}
 const sqlPath=join(directory,'refused.sql'),archivePath=join(directory,'refused.tar.gz');
 await writeFile(sqlPath,sql);await writeFile(archivePath,gzipSync(Buffer.concat(blocks)));
 const unreachable=new URL(fixture.sqlTarget.options.connectionString!);unreachable.port='1';
 await expect(promisify(execFile)(process.execPath,['scripts/restore.mjs',sqlPath],{env:{...process.env,DATABASE_URL:unreachable.toString(),SKIP_SEED:'true'}})).rejects.toMatchObject({stderr:expect.stringContaining('Archived migration checksum mismatch: 0090')});
 const result=await stagedRestore({archivePath,targetUrl:unreachable.toString(),stagingDir:join(directory,'refused-documents')});
 expect(result.readyForCutover).toBe(false);expect(result.errors).toEqual([expect.stringContaining('Archived migration checksum mismatch: 0090')]);
 expect(result.migrationsApplied).toEqual([]);expect(result.documentsRestored).toBe(0);
});
