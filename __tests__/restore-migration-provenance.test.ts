import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {loadMigrationFiles} from '../lib/migration-files';
import {loadRestoreMigrationChecksums} from '../lib/restore/migration-provenance.mjs';

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
