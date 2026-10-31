import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {loadMigrationFiles} from '../lib/migration-files';
import {loadRestoreMigrationChecksums} from '../lib/restore/migration-provenance.mjs';
import {prepareBackupSql} from '../lib/restore/sql.mjs';

it('plain-Node restore provenance exactly matches the canonical migration loader',async()=>{
 const canonical=(await loadMigrationFiles()).map(({version,checksum})=>({version,checksum}));
 expect((await loadRestoreMigrationChecksums()).sort((a,b)=>a.version.localeCompare(b.version))).toEqual(canonical);
});
it('refuses missing baseline or duplicate version source files',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-restore-migration-source-'));
 try{
  const url=pathToFileURL(directory+'/');
  await expect(loadRestoreMigrationChecksums(url)).rejects.toThrow('provenance unavailable');
  await writeFile(join(directory,'0001_baseline.sql'),'-- synthetic baseline\n');
  await writeFile(join(directory,'0001_duplicate.sql'),'-- synthetic duplicate\n');
  await expect(loadRestoreMigrationChecksums(url)).rejects.toThrow('Duplicate');
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('the composed Rx chain accepts historical booking0090 and separately rejects unknown versions and wrong hashes',async()=>{
 const migrationFiles=await loadRestoreMigrationChecksums();
 const historical=migrationFiles.find(file=>file.version==='0090');
 expect(historical?.checksum).toBe('608eeee37b44a59cb4d26e915bd0b2610cf619103905be1fca0c2abe77c52e25');
 const record=(version:string,checksum:string)=>`BEGIN; INSERT INTO schema_migrations (version,name,checksum) VALUES ('${version}','booking_request_preferences','${checksum}'); COMMIT;`;
 const accepted=prepareBackupSql(record('0090',historical!.checksum),{migrationFiles});
 expect(accepted.skippedMigrationRecordLines).toBe(1);
 expect(accepted.sql).not.toContain('INSERT INTO schema_migrations');
 expect(()=>prepareBackupSql(record('0090','0'.repeat(64)),{migrationFiles})).toThrow('Archived migration checksum mismatch: 0090');
 expect(()=>prepareBackupSql(record('9999',historical!.checksum),{migrationFiles})).toThrow('Unknown archived migration version: 9999');
});
