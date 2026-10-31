import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {gzipSync} from "node:zlib";
import {expect,it} from "vitest";
import {openBackupTimestampFixture} from "./_backup-timestamp-fixture";
import {loadMigrationFiles,migrate} from "../../lib/migrations";
import {fullBackupBlocks} from "../../lib/fullBackup";
import {stagedRestore} from "../../lib/restore/staging";

it("refuses exact historical0090 archives before target mutation, for populated and empty booking metadata",async()=>{
 const fixture=await openBackupTimestampFixture(process.env);
 const directory=await mkdtemp(join(tmpdir(),"synthetic-numbering-residue-restore-"));
 try{
  await migrate(fixture.source,{apply:true,files:await loadMigrationFiles()});
  const residue=await readFile(new URL("../fixtures/patient-numbering/cancelled-booking-0090.sql",import.meta.url),"utf8");
  const checksum=createHash("sha256").update(residue).digest("hex");
  expect(checksum).toBe("608eeee37b44a59cb4d26e915bd0b2610cf619103905be1fca0c2abe77c52e25");
  await fixture.source.query(residue);
  await fixture.source.query("INSERT INTO schema_migrations(version,name,checksum,adopted) VALUES('0090','booking_request_preferences',$1,false)",[checksum]);
  await fixture.source.query("INSERT INTO patients(patient_number,full_name) VALUES('P-00042','Synthetic unchanged restore identity')");
  await fixture.source.query("INSERT INTO booking_requests(full_name,phone,request_key) VALUES('Synthetic residue booking','777000111','synthetic-residue-restore')");
  for(const [populated,target] of [[true,fixture.sqlTarget],[false,fixture.archiveTarget]] as const){
   if(!populated)await fixture.source.query("DELETE FROM booking_requests WHERE request_key='synthetic-residue-restore'");
   const source=await fixture.source.connect();
   let bytes:Buffer;
   try{
    const blocks:Buffer[]=[];
    for await(const block of fullBackupBlocks({source,readDocument:async()=>{throw new Error("No document fixture expected");}}))blocks.push(Buffer.from(block));
    bytes=Buffer.concat(blocks);
   }finally{source.release();}
   const archivePath=join(directory,`${populated?"populated":"empty"}.tar.gz`);
   await writeFile(archivePath,gzipSync(bytes));
   const result=await stagedRestore({archivePath,targetUrl:target.options.connectionString!,stagingDir:join(directory,populated?"populated-documents":"empty-documents")});
   expect(result).toMatchObject({ok:false,readyForCutover:false,migrationsApplied:[],documentsRestored:0});
   expect(result.errors.join(" ")).toContain('Unknown archived migration version: 0090');
   expect((await target.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows).toEqual([{n:0}]);
   await expect(stat(join(directory,populated?"populated-documents":"empty-documents"))).rejects.toMatchObject({code:'ENOENT'});
   expect((await fixture.source.query("SELECT checksum FROM schema_migrations WHERE version='0090'")).rows).toEqual([{checksum}]);
  }
 }finally{await fixture.close();await rm(directory,{recursive:true,force:true});}
});
