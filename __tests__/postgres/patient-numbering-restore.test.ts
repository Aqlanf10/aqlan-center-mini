import {afterAll,beforeAll,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {gzipSync} from "node:zlib";
import {Client,Pool} from "pg";
import type {SessionPayload} from "../../lib/auth";
import {assertRealPostgresUrl,dropPublicSchema,stubPostgresEnv} from "./_setup";
import {validatePostgresTestTarget} from "./_safe-target";
import {validateGeneratedDatabaseName} from "../../scripts/verify-schema-ownership";
import {validateLocalVerificationTarget} from "../../lib/verification-target-policy.mjs";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db");
const auth=await import("../../lib/auth");
const numbering=await import("../../lib/patient-numbering-db");
const {loadMigrationFiles,migrate}=await import("../../lib/migrations");
const {fullBackupBlocks}=await import("../../lib/fullBackup");
const {parseTarBytes}=await import("../../lib/restore/archive");
const {validateBackupArchive}=await import("../../lib/restore/validate");
const {prepareBackupSql}=await import("../../lib/restore/sql.mjs");
const {stagedRestore}=await import("../../lib/restore/staging");
let session:SessionPayload;
beforeAll(async()=>{
 await dropPublicSchema(process.env.DATABASE_URL!);await db.ensureSchema();
 const hash=await auth.hashPassword("synthetic-numbering-restore");
 const user=(await db.getPool().query("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('numbering-restore','Synthetic restore',$1,'admin',true) RETURNING id",[hash])).rows[0];
 session={userId:user.id,username:"numbering-restore",role:"admin",credentialVersion:auth.sessionCredentialVersion(hash),expiresAt:Date.now()+3600000};
 const p=await db.createPatient({fullName:"Synthetic retained identity",phone:null,altPhone:null,gender:"unknown",birthYear:null,address:null,medicalAlert:null,note:null});
 // Synthetic historical0080 fixture only; application editing is now deferred.
 // Preserve recovery coverage for evidence that can exist in historical backups.
 await db.getPool().query("UPDATE patients SET patient_number='P-00123' WHERE id=$1",[p.id]);
 await db.getPool().query("INSERT INTO invoices(invoice_number,patient_id,total_minor) VALUES('SYN-NUMBER-RESTORE',$1,100)",[p.id]);
 const preview=await numbering.readNumberingPreview(session);
 await numbering.changeNumberingFloor(session,{minimumNext:"8000",expectedVersion:preview.version,expectedNextNumber:preview.nextNumber,reason:"Synthetic future numbering"});
 await db.getPool().query("SELECT setval('patient_number_seq',9000,true)");
});
afterAll(async()=>{await db.resetPoolForTesting();});
it("official SQL and full-archive payload replay preserves identity, retired aliases, policy, audit and high-water",async()=>{
 const checked=validatePostgresTestTarget(process.env);
 const name=`aqlan_schema_ownership_num_${randomUUID().replaceAll("-","")}`;
 validateGeneratedDatabaseName(name);
 if(name.length>63)throw new Error("Synthetic target name exceeds PostgreSQL identifier limit");
 const url=new URL(checked.testUrl);url.pathname=`/${name}`;
 validateLocalVerificationTarget(url.toString(),process.env,{varName:"OWNED_NUMBERING_RESTORE_TARGET",databaseName:name});
 const admin=new Client({connectionString:checked.maintenanceUrl.toString(),ssl:false});
 let target:Pool|undefined, owned:{oid:string;owner:string}|undefined;
 const failures:unknown[]=[];
 const directory=await mkdtemp(join(tmpdir(),"synthetic-numbering-restore-"));
 await admin.connect();
 try{
  expect((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1",[name])).rows).toEqual([]);
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  owned=(await admin.query<{oid:string;owner:string}>("SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1",[name])).rows[0];
  if(!owned)throw new Error("New synthetic target identity was not established");
  target=new Pool({connectionString:url.toString(),ssl:false,max:1});
  expect((await target.query("SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()")).rows[0]).toEqual(owned);
  const source=await db.getPool().connect();let sql:string;let archiveSql:string;
  try{
   const lines:string[]=[];for await(const line of db.backupSqlLines(source))lines.push(line);sql=lines.join("");
   const blocks:Uint8Array[]=[];for await(const block of fullBackupBlocks({source,readDocument:async()=>{throw new Error("No real documents may be read by this synthetic test");}}))blocks.push(block);
   const archiveBytes=Buffer.concat(blocks.map(block=>Buffer.from(block)));
   await writeFile(join(directory,"synthetic.tar.gz"),gzipSync(archiveBytes));
   const archive=parseTarBytes(archiveBytes);
   const validated=validateBackupArchive(archive,{documentsDir:"/tmp/synthetic-numbering-restore-no-documents"});
   expect(validated.ok).toBe(true);if(!validated.ok)throw new Error(validated.errors.join(";"));
   archiveSql=Buffer.from(validated.sql).toString("utf8");
  }finally{source.release();}
  const tables=["patients","invoices","retired_patient_numbers","patient_numbering_policy","audit_log"];
  const snapshots=new Map<string,unknown>();
  for(const table of tables)snapshots.set(table,(await db.getPool().query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS data FROM ${table} t`)).rows[0].data);
  for(const payload of [sql,archiveSql]){
   // Reuse precisely this newly owned target; never drop or clear a pre-existing DB.
   await target.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
   await migrate(target,{apply:true,files:await loadMigrationFiles()});
   expect(payload.indexOf("-- patients (")).toBeLessThan(payload.indexOf("-- retired_patient_numbers ("));
   await target.query(prepareBackupSql(payload).sql);
   for(const table of tables)expect((await target.query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS data FROM ${table} t`)).rows[0].data,table).toEqual(snapshots.get(table));
   expect((await target.query("SELECT last_value::text,is_called FROM patient_number_seq")).rows[0]).toEqual({last_value:"9000",is_called:true});
   expect((await target.query("SELECT aqlan_allocate_patient_number() AS number")).rows[0].number).toBe("P-09001");
   await expect(target.query("INSERT INTO patients(patient_number,full_name) VALUES('P-07000','Synthetic forbidden reuse')")).rejects.toMatchObject({code:"23505"});
  }
  // Replay must not attach a live alias to a different historical identity.
  // Same-owner overlap is valid for spelling-only edits such as P-123 -> P-00123.
  const current=(await db.getPool().query("SELECT id,patient_number FROM patients ORDER BY id LIMIT 1")).rows[0];
  for(const sameOwner of [false,true]){
   await target.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
   await migrate(target,{apply:true,files:await loadMigrationFiles()});
   const replay=sql.replace(/COMMIT;\s*$/,`INSERT INTO retired_patient_numbers(patient_number,patient_id) VALUES('P-00000123',${Number(current.id)+(sameOwner?0:1000)});\nCOMMIT;\n`);
   expect(replay).not.toBe(sql);
   if(sameOwner){
    await target.query(prepareBackupSql(replay).sql);
    expect((await target.query("SELECT patient_id::text FROM retired_patient_numbers WHERE patient_number='P-00000123'")).rows).toEqual([{patient_id:String(current.id)}]);
   }else{
    await expect(target.query(prepareBackupSql(replay).sql)).rejects.toMatchObject({code:"23505"});
    await target.query("ROLLBACK");
    expect((await target.query("SELECT count(*)::int AS n FROM patients")).rows[0].n).toBe(0);
    expect((await target.query("SELECT count(*)::int AS n FROM retired_patient_numbers")).rows[0].n).toBe(0);
   }
  }
  // Exercise the official staged full-archive path, not merely its SQL parser.
  await target.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  const restored=await stagedRestore({archivePath:join(directory,"synthetic.tar.gz"),targetUrl:url.toString(),stagingDir:join(directory,"documents")});
  expect(restored).toMatchObject({ok:true,errors:[],validationErrors:[],readyForCutover:true});
  expect(restored.migrationsApplied).toContain("0080");
  for(const table of tables)expect((await target.query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS data FROM ${table} t`)).rows[0].data,table).toEqual(snapshots.get(table));
  expect((await target.query("SELECT last_value::text,is_called FROM patient_number_seq")).rows[0]).toEqual({last_value:"9000",is_called:true});
 }catch(error){failures.push(error);}
 finally{
  try{await target?.end();}catch(error){failures.push(error);}
  try{
   if(owned){
    const current=(await admin.query("SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1",[name])).rows;
    if(current.length!==1 || current[0].oid!==owned.oid || current[0].owner!==owned.owner) failures.push(new Error("Synthetic target identity changed; cleanup refused"));
    else await admin.query(`DROP DATABASE "${name}"`);
   }
  }catch(error){failures.push(error);}
  try{await admin.end();}catch(error){failures.push(error);}
  try{await rm(directory,{recursive:true,force:true});}catch(error){failures.push(error);}
 }
 if(failures.length)throw new AggregateError(failures,"Synthetic numbered-file restore or verified cleanup failed");
});
