import { expect, it } from 'vitest';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { openPeriodontalFixture } from './_periodontal-fixture';
it('upgrades populated0124 with no fabricated closure events or changed legacy facts',async()=>{
 const f=await openPeriodontalFixture(process.env,{pristine:true});
 try{
  const files=await loadMigrationFiles();await migrate(f.pool,{apply:true,files:files.filter(x=>x.version<'0125')});
  const patient=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-REOPEN-UPGRADE','Synthetic upgrade') RETURNING id")).rows[0].id;
  await f.pool.query("INSERT INTO ortho_cases(patient_id,status,closed_at,closed_by,closed_note,created_by) VALUES($1,'completed',NULL,NULL,'Exact historical note','synthetic')",[patient]);
  const before=(await f.pool.query('SELECT to_jsonb(o)::text row FROM ortho_cases o ORDER BY id')).rows;
  await migrate(f.pool,{apply:true,files});
  expect((await f.pool.query("SELECT (to_jsonb(o)-'lifecycle_version')::text row FROM ortho_cases o ORDER BY id")).rows).toEqual(before);
  expect((await f.pool.query('SELECT * FROM ortho_case_reopen_events')).rows).toEqual([]);
  expect((await f.pool.query('SELECT lifecycle_version FROM ortho_cases')).rows).toEqual([{lifecycle_version:0}]);
  await migrate(f.pool,{apply:true,files});expect((await f.pool.query("SELECT version FROM schema_migrations WHERE version='0125'")).rows).toEqual([{version:'0125'}]);
 }finally{await f.close();}
});
