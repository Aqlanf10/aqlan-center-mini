import { expect, it } from 'vitest';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { openPeriodontalFixture } from './_periodontal-fixture';
it('adds an empty export archive to populated0122 without rewriting patient or study data',async()=>{
 const f=await openPeriodontalFixture(process.env,{pristine:true});
 try{
  const files=await loadMigrationFiles();await migrate(f.pool,{apply:true,files:files.filter(x=>x.version<'0123')});
  await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-ARCHIVE-UPGRADE','Synthetic upgrade canary')");
  const before=(await f.pool.query('SELECT to_jsonb(p)::text row FROM patients p ORDER BY id')).rows;
  await migrate(f.pool,{apply:true,files});
  expect((await f.pool.query('SELECT to_jsonb(p)::text row FROM patients p ORDER BY id')).rows).toEqual(before);
  expect((await f.pool.query('SELECT * FROM ortho_study_export_jobs')).rows).toEqual([]);
  expect((await f.pool.query('SELECT * FROM ortho_study_export_artifacts')).rows).toEqual([]);
  await migrate(f.pool,{apply:true,files});
  expect((await f.pool.query("SELECT version FROM schema_migrations WHERE version='0123'")).rows).toEqual([{version:'0123'}]);
 }finally{await f.close();}
});
it('refuses an unregistered archive table collision without replacing its data',async()=>{
 const f=await openPeriodontalFixture(process.env,{pristine:true});
 try{
  const files=await loadMigrationFiles();await migrate(f.pool,{apply:true,files:files.filter(x=>x.version<'0123')});
  await f.pool.query("CREATE TABLE ortho_study_export_jobs(id integer,marker text);INSERT INTO ortho_study_export_jobs VALUES(1,'synthetic canary')");
  await expect(migrate(f.pool,{apply:true,files})).rejects.toThrow();
  expect((await f.pool.query('SELECT * FROM ortho_study_export_jobs')).rows).toEqual([{id:1,marker:'synthetic canary'}]);
 }finally{await f.close();}
});
